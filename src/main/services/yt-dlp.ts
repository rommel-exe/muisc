// src/main/services/yt-dlp.ts

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Find yt-dlp on PATH. Try common locations if not found.
const YT_DLP_PATHS = [
  'yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/yt-dlp',
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
 * Detect yt-dlp binary location. Caches result after first successful find.
 */
export async function findYTDlp(): Promise<string> {
  if (ytDlpPath) return ytDlpPath

  for (const candidate of YT_DLP_PATHS) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5000 })
      ytDlpPath = candidate
      return candidate
    } catch {
      continue
    }
  }

  throw new YTDlpError(
    'yt-dlp not found. Install it: pip install yt-dlp',
    'NOT_FOUND'
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
    if (err.name === 'AbortError' || err.killed || err.signal === 'SIGTERM') {
      throw new YTDlpError(
        `yt-dlp aborted for video ${videoId}`,
        'ABORTED',
        err
      )
    }
    if (err.stderr?.includes('Video unavailable')) {
      throw new YTDlpError(`Video unavailable: ${videoId}`, 'INVALID_VIDEO', err)
    }
    throw new YTDlpError(
      `yt-dlp failed for video ${videoId}: ${err.message}`,
      'PARSE_ERROR',
      err
    )
  }
}
