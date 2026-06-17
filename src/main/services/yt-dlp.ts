// src/main/services/yt-dlp.ts

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

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
    public code: 'NOT_FOUND' | 'TIMEOUT' | 'INVALID_VIDEO' | 'PARSE_ERROR' | 'ABORTED',
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
 */
let warmPromise: Promise<void> | null = null

export async function warmYtdlp(): Promise<void> {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    try {
      const binary = await findYTDlp()
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
      await execFileAsync(binary, ['--version'], { timeout: 5000, env: ytDlpEnv })
      console.log('[yt-dlp] Pre-warmed')
    } catch (err) { console.warn('[yt-dlp] Pre-warm failed:', err) }
  })()
  return warmPromise
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
 * Extract video metadata and stream info from a YouTube video ID.
 * Uses yt-dlp -j for JSON output.
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
  // Background extraction needs more time (full client, richer data)
  const timeoutMs = options?.timeoutMs ?? (mode === 'foreground' ? 15000 : 30000)
  const binary = await findYTDlp()

  try {
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
        '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,js,configs,initial_data',
        '--no-add-chapters',
        '--no-embed-metadata',
      )
    } else {
      // 🎛️  Background: default web client (richer data extraction)
      // All metadata (chapters, thumbnails, uploader, etc.) is in -j JSON
      // Note: --write-thumbnail / --embed-metadata are file-only flags
      // and don't apply to JSON-only (-j) extraction.
    }

    args.push(videoId)

    // Background payload includes richer metadata (larger JSON)
    const maxBuffer = mode === 'foreground' ? 1024 * 1024 : 10 * 1024 * 1024

    const tBefore = Date.now()
    const { stdout } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer,
      signal,
      killSignal: 'SIGKILL',
      env: ytDlpEnv,
    })
    const tAfterExec = Date.now()

    const info = JSON.parse(stdout) as YTDlpInfo
    const tAfterParse = Date.now()
    console.log(`[yt-dlp] ${videoId}: exec=${tAfterExec - tBefore}ms parse=${tAfterParse - tAfterExec}ms`)
    return info
  } catch (err: any) {
    // Check for explicit abort signal first
    if (signal?.aborted || err.name === 'AbortError') {
      throw new YTDlpError(
        `yt-dlp aborted for video ${videoId}`,
        'ABORTED',
        err
      )
    }

    // Timeout: process was killed by execFile timeout (not by abort signal)
    // killSignal changed to SIGKILL, so check for any kill signal
    if (err.killed && err.signal && !signal?.aborted) {
      throw new YTDlpError(
        `yt-dlp timed out after ${timeoutMs}ms for video ${videoId}`,
        'TIMEOUT',
        err
      )
    }

    // Video unavailable
    if (err.stderr && isVideoUnavailable(err.stderr)) {
      throw new YTDlpError(`Video unavailable: ${videoId}`, 'INVALID_VIDEO', err)
    }

    // Parse error (JSON parsing failed or other)
    throw new YTDlpError(
      `yt-dlp failed for video ${videoId}: ${err.message}`,
      'PARSE_ERROR',
      err
    )
  }
}
