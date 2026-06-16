// src/main/services/yt-dlp.ts

import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import fs from 'node:fs'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

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
 */
export async function getVideoInfo(
  videoId: string,
  timeoutMs: number = 15000,
  signal?: AbortSignal
): Promise<YTDlpInfo> {
  const binary = await findYTDlp()

  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        '-f',
        'bestaudio[ext=m4a]/bestaudio/best',
        '--no-playlist',
        '-j',
        videoId,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal }
    )

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
    if (err.killed && err.signal === 'SIGTERM' && !signal?.aborted) {
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
