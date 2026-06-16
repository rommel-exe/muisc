// src/main/services/yt-dlp.ts

import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

// Environment with Deno on PATH for yt-dlp JS runtime support
function getYtDlpEnv(): NodeJS.ProcessEnv {
  const denoDir = path.join(os.homedir(), '.deno', 'bin')
  const currentPath = process.env.PATH || ''
  // Only extend PATH if Deno isn't already on it
  if (!currentPath.includes(denoDir)) {
    return { ...process.env, PATH: `${denoDir}:${currentPath}` }
  }
  return process.env
}

// Find yt-dlp on PATH. Try common locations if not found.
const YT_DLP_PATHS = [
  'yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/yt-dlp',
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
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Detect yt-dlp binary location. Caches result after first successful find.
 * Tries common paths, then falls back to `which yt-dlp`.
 */
export async function findYTDlp(): Promise<string> {
  if (ytDlpPath) return ytDlpPath

  // Try explicit paths first (skip 'yt-dlp' which relies on PATH)
  for (const candidate of YT_DLP_PATHS) {
    try {
      // For explicit paths, check if file exists and is executable first
      if (candidate !== 'yt-dlp' && !isExecutable(candidate)) {
        continue
      }
      await execFileAsync(candidate, ['--version'], { timeout: 5000 })
      ytDlpPath = candidate
      return candidate
    } catch {
      continue
    }
  }

  // Fallback: use `which yt-dlp` to find it on PATH
  try {
    const { stdout } = await execAsync('which yt-dlp', { timeout: 5000 })
    const foundPath = stdout.trim()
    if (foundPath && isExecutable(foundPath)) {
      await execFileAsync(foundPath, ['--version'], { timeout: 5000 })
      ytDlpPath = foundPath
      return foundPath
    }
  } catch {
    // Fall through to error
  }

  throw new YTDlpError(
    'yt-dlp not found. Install it: pip install yt-dlp',
    'NOT_FOUND'
  )
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
 *   Foreground mode uses android+web player client for fastest extraction.
 *   Background mode uses the same flags (all metadata is already in -j output).
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
      // 🏎️ Foreground: mobile client — fastest path to the stream URL
      // Avoids heavy webpage parsing, chapters/metadata are still in -j JSON
      args.push(
        '--extractor-args', 'youtube:player_client=android,web',
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

    const { stdout } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer,
      signal,
      killSignal: 'SIGKILL',
      env: getYtDlpEnv(),
    })

    const info = JSON.parse(stdout) as YTDlpInfo
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
