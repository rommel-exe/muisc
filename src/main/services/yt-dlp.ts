// src/main/services/yt-dlp.ts

import { spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Build yt-dlp subprocess env once — Deno on PATH for JS runtime support
const ytDlpEnv: NodeJS.ProcessEnv = (() => {
  const denoDir = path.join(os.homedir(), '.deno', 'bin')
  const currentPath = process.env.PATH || ''
  if (!currentPath.includes(denoDir)) {
    return { ...process.env, PATH: `${denoDir}:${currentPath}` }
  }
  return process.env
})()

// Find yt-dlp on PATH. Try common locations if not found.
// Ordered by likelihood — absolute paths first to avoid shell/which overhead
const YT_DLP_PATHS = [
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/yt-dlp',
  '/Library/Frameworks/Python.framework/Versions/3.11/bin/yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  'yt-dlp', // bare name — relies on PATH (slow, checked last)
]

// Patterns that indicate a video is unavailable
const UNAVAILABLE_PATTERNS = [
  'Video unavailable',
  'Private video',
  'This video is not available',
  'This video has been removed',
  'Video id not found',
  'is not a valid video ID',
  'is not a valid URL',
  'HTTP Error 404',
]

export interface YTDlpInfo {
  id: string
  title: string
  duration: number // seconds
  thumbnail: string
  formats: Array<{
    format_id: string
    ext: string
    acodec: string
    url: string
    abr?: number // audio bitrate
  }>
  // Rich metadata (available from -j JSON output — no extra flags needed)
  chapters?: Array<{
    title: string
    start_time: number
    end_time: number
  }>
  uploader?: string
  channel?: string
  artist?: string
  track?: string
  album?: string
  thumbnails?: Array<{
    url: string
    height?: number
    width?: number
  }>
}

export interface ExtractionOptions {
  /** Extraction tier hint (default: 'foreground') */
  mode?: 'foreground' | 'background'
  /** Process timeout in ms (default: 15000) */
  timeoutMs?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

export class YTDlpError extends Error {
  constructor(
    message: string,
    public code:
      | 'NOT_FOUND'
      | 'TIMEOUT'
      | 'INVALID_VIDEO'
      | 'PARSE_ERROR'
      | 'ABORTED'
      | 'DAEMON_CRASH'
      | 'DAEMON_ERROR'
      | 'RESOLVE_FAILED',
    public cause?: Error
  ) {
    super(message)
    this.name = 'YTDlpError'
  }
}

let ytDlpPath: string | null = null

/**
 * Detect yt-dlp binary location. Caches result on first successful find.
 *
 * Absolute paths checked with fs.existsSync (zero subprocess spawns).
 * Bare 'yt-dlp' is the last resort (requires shell, slower in Electron).
 */
export async function findYTDlp(): Promise<string> {
  if (ytDlpPath) return ytDlpPath

  // Absolute paths — just check the file exists, no subprocess spawn
  for (const candidate of YT_DLP_PATHS) {
    if (candidate === 'yt-dlp') break // bare name, handle below
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      ytDlpPath = candidate
      return candidate
    } catch { continue }
  }

  // Last resort: bare 'yt-dlp' via execFile with extended PATH
  try {
    const pathEnv = `${process.env.PATH || ''}:/Library/Frameworks/Python.framework/Versions/3.12/bin:/opt/homebrew/bin:/usr/local/bin`
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('yt-dlp', ['--version'], {
      timeout: 5000,
      env: { ...process.env, PATH: pathEnv },
    })
    ytDlpPath = 'yt-dlp'
    return 'yt-dlp'
  } catch {
    throw new YTDlpError(
      'yt-dlp not found. Install it: pip install yt-dlp',
      'NOT_FOUND'
    )
  }
}

/**
 * Pre-warm yt-dlp by running a quick version check.
 * This caches Python bytecode and plugin modules so the first
 * cold resolve doesn't pay Python startup overhead.
 *
 * Uses detached spawn to isolate from Electron's process tree
 * (GPU crash cascade can send SIGTERM to child processes otherwise).
 */
let warmPromise: Promise<void> | null = null

export async function warmYtdlp(): Promise<void> {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    try {
      const binary = await findYTDlp()
      await spawnAndCollect(binary, ['--version'], { timeoutMs: 15000 })
      console.log('[yt-dlp] Pre-warmed')
    } catch (err) { console.error('[yt-dlp] Pre-warm failed:', (err as Error).message) }
  })()
  return warmPromise
}

/**
 * Spawn yt-dlp with detached=true to isolate from Electron's
 * process tree, collect stdout, and return parsed JSON.
 */
function spawnAndCollect(
  binary: string,
  args: string[],
  options?: ExtractionOptions & { maxBuffer?: number }
): Promise<string> {
  const { timeoutMs = 15000, signal, maxBuffer = 1024 * 1024 } = options ?? {}

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      detached: true, // 🛡️ Isolate from Electron's process tree (prevents SIGTERM cascade)
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ytDlpEnv,
      killSignal: 'SIGKILL',
      timeout: timeoutMs,
    })

    // Allow the parent to exit without waiting for this child
    child.unref()

    let stdout = ''
    let stderr = ''
    let aborted = false
    /** Set to true when WE kill the child (abort signal or our timeout).
     *  Distinguishes our intentional kill from an external SIGTERM/SIGKILL
     *  sent by the OS (e.g. GPU crash cascade on macOS). */
    let wasKilledByUs = false
    /** Registered abort listener (nullable — set only when signal is provided).
     *  Declared at Promise scope so close/error handlers can remove it,
     *  preventing the closure from leaking until the signal is aborted. */
    let onAbort: (() => void) | undefined

    const cleanUp = () => {
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
    }

    // Abort signal support
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGKILL')
        cleanUp()
        return reject(new YTDlpError('yt-dlp aborted', 'ABORTED'))
      }
      onAbort = () => {
        aborted = true
        wasKilledByUs = true
        child.kill('SIGKILL')
        cleanUp()
        reject(new YTDlpError('yt-dlp aborted', 'ABORTED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // Collect stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      // Trim to maxBuffer to avoid OOM
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer)
      }
    })
    child.stdout?.on('error', () => {
      // Suppress unhandled stream errors (EPIPE on abnormal child termination).
      // Without this, Node.js throws an uncaught exception that can crash Electron.
    })

    // Collect stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer)
      }
    })
    child.stderr?.on('error', () => {
      // Suppress unhandled stream errors (same reason as stdout).
    })

    // Handle completion
    child.on('close', (code, sig) => {
      cleanUp()
      // Remove the signal listener so the onAbort closure doesn't
      // leak (child, reject, etc.) until the signal is eventually aborted.
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      if (aborted) return // already rejected by abort handler

      // Check for explicit abort signal
      if (signal?.aborted) {
        return reject(new YTDlpError(`yt-dlp aborted for video`, 'ABORTED'))
      }

      // Timeout: process killed by our timeout (SIGKILL from Node's killSignal)
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && wasKilledByUs)) {
        return reject(new YTDlpError(
          `yt-dlp timed out after ${timeoutMs}ms`,
          'TIMEOUT'
        ))
      }
      // External SIGTERM (e.g. macOS GPU crash cascade) — not our timeout
      if (sig === 'SIGTERM') {
        return reject(new YTDlpError(
          `yt-dlp terminated by external signal: ${sig}`,
          'PARSE_ERROR'
        ))
      }

      // Non-zero exit
      if (code !== 0) {
        // Video unavailable
        if (stderr && isVideoUnavailable(stderr)) {
          return reject(new YTDlpError('Video unavailable', 'INVALID_VIDEO'))
        }
        return reject(new YTDlpError(
          `yt-dlp exited with code ${code}: ${stderr.slice(0, 200)}`,
          'PARSE_ERROR'
        ))
      }

      // Success: return stdout
      resolve(stdout)
    })

    // Handle spawn error (binary not found, etc.)
    child.on('error', (err) => {
      cleanUp()
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      if (signal?.aborted || aborted) {
        return reject(new YTDlpError('yt-dlp aborted', 'ABORTED'))
      }
      reject(new YTDlpError(
        `yt-dlp failed to spawn: ${err.message}`,
        'NOT_FOUND',
        err
      ))
    })
  })
}

/**
 * Check if an error message indicates the video is unavailable.
 */
function isVideoUnavailable(stderr: string): boolean {
  return UNAVAILABLE_PATTERNS.some((pattern) =>
    stderr.toLowerCase().includes(pattern.toLowerCase())
  )
}

/**
 * Extract just the audio stream URL for a video ID.
 * Uses --get-url (much lighter than -j — no metadata, just the URL).
 * This is the primary path for the proxy stream handler.
 *
 * @param videoId - YouTube video ID
 * @param options - Extraction options
 * @returns The direct CDN stream URL
 */
export async function getStreamUrl(
  videoId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<string> {
  const { timeoutMs = 15000, signal } = options ?? {}
  const binary = await findYTDlp()

  // 🏎️ Minimal flags: --get-url outputs only the URL (no JSON parsing overhead).
  // No -f filter needed: with player_client=android,web the only format
  // available is 18 (360p mp4 with AAC audio), which works fine as an
  // audio-only stream in HTMLAudioElement.
  const args: string[] = [
    '--get-url',
    '--no-playlist',
    '--skip-download',
    '--no-check-certificates',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,js,configs,initial_data;youtube_include_dash_manifest=False;youtube_include_hls_manifest=False',
    '--no-add-chapters',
    '--no-embed-metadata',
    '--',
    videoId,
  ]

  const tBefore = Date.now()
  const stdout = await spawnAndCollect(binary, args, {
    timeoutMs,
    signal,
    maxBuffer: 1024 * 1024,
  })
  const elapsed = Date.now() - tBefore

  // --get-url returns the URL as the first line of stdout
  const url = stdout.split('\n')[0]?.trim()
  if (!url || !url.startsWith('http')) {
    throw new YTDlpError('No stream URL returned from yt-dlp', 'PARSE_ERROR')
  }

  console.log(`[yt-dlp] ${videoId} url: ${elapsed}ms`)
  return url
}

/**
 * Extract full video metadata and stream info from a YouTube video ID.
 * Uses yt-dlp -j for JSON output (heavier than --get-url).
 * Use this when you need metadata (title, duration, thumbnail).
 *
 * @param videoId - YouTube video ID
 * @param options - Extraction mode, timeout, and abort signal
 *   Foreground mode uses android+web + player_skip to bypass ad-serving paths
 *   and skip unnecessary network requests (webpage, js, configs, initial_data).
 *   Background mode uses default args (richer data, more network requests).
 *   The mode is primarily a scheduling/tracking hint for the caller.
 */
export async function getVideoInfo(
  videoId: string,
  options?: ExtractionOptions
): Promise<YTDlpInfo> {
  const { mode = 'foreground', signal } = options ?? {}
  const timeoutMs = options?.timeoutMs ?? (mode === 'foreground' ? 15000 : 30000)
  const binary = await findYTDlp()

  // Base flags required for any stream resolution
  const args: string[] = [
    '--no-playlist',
    '-j',
    '--skip-download',
    '--no-check-certificates',
    '--no-warnings',
  ]

  if (mode === 'foreground') {
    // 🏎️ Foreground: android+web client with player_skip to bypass
    // ad-serving paths and skip unnecessary network requests.
    // player_skip=webpage,js,configs,initial_data cuts resolve time
    // from ~7s to ~4s and avoids preroll ad processing entirely.
    args.push(
      '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,js,configs,initial_data;youtube_include_dash_manifest=False;youtube_include_hls_manifest=False',
      '--no-add-chapters',
      '--no-embed-metadata',
    )
  } else {
    // 🎛️  Background: default web client (richer data extraction)
    // All metadata (chapters, thumbnails, uploader, etc.) is in -j JSON
    // Note: --write-thumbnail / --embed-metadata are file-only flags
    // and don't apply to JSON-only (-j) extraction.
  }

  args.push('--', videoId)

  // Background payload includes richer metadata (larger JSON)
  const maxBuffer = mode === 'foreground' ? 1024 * 1024 : 10 * 1024 * 1024

  const tBefore = Date.now()
  const stdout = await spawnAndCollect(binary, args, {
    timeoutMs,
    signal,
    maxBuffer,
  })
  const tAfterExec = Date.now()

  let info: YTDlpInfo
  try {
    info = JSON.parse(stdout) as YTDlpInfo
  } catch (parseErr) {
    throw new YTDlpError(
      `Failed to parse yt-dlp JSON output: ${(parseErr as Error).message}`,
      'PARSE_ERROR',
      parseErr as Error
    )
  }
  const tAfterParse = Date.now()
  console.log(`[yt-dlp] ${videoId}: exec=${tAfterExec - tBefore}ms parse=${tAfterParse - tAfterExec}ms`)
  return info
}
