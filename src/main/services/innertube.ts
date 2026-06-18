// src/main/services/innertube.ts
//
// Hybrid InnerTube resolver — fast path via youtubei.js with normalized output.
// Falls through to yt-dlp (via MediaResolver) when something goes wrong.
//
// youtubei.js runs in pure JS — zero Python boot overhead.
// Cold resolves typically complete in 400–800ms vs 2–3s for yt-dlp.

import { Innertube } from 'youtubei.js'
import type Format from 'youtubei.js/dist/src/parser/classes/misc/Format.js'

// ── Singleton ──

let instance: Innertube | null = null
let instancePromise: Promise<Innertube> | null = null

/**
 * Pre-warm the InnerTube singleton at app startup so the first
 * cold resolve doesn't wait for session initialization.
 * Safe to call multiple times; idempotent after first success.
 */
export async function warmInnerTube(): Promise<void> {
  try {
    await getInstance()
    console.log('[Innertube] Session warmed')
  } catch (err) {
    console.warn('[Innertube] Warm failed, will retry on first resolve:', err)
  }
}

async function getInstance(): Promise<Innertube> {
  if (instance) return instance
  if (instancePromise) return instancePromise

  instancePromise = Innertube.create({
    // Use defaults: no cache, no special config.
    // The session handles cookies and client context automatically.
  }).catch((err) => {
    // Reset on failure so next caller retries
    instancePromise = null
    throw err
  })

  instance = await instancePromise
  return instance
}

// ── Normalized output ──

export interface InnertubeResult {
  videoId: string
  title: string
  duration: number
  thumbnail: string
  /** Direct CDN streaming URL (already deciphered by youtubei.js) */
  streamingUrl: string
  /** MIME type of the selected audio format (e.g. "audio/mp4") */
  contentType: string
}

/** Search result item (no streaming URL — lightweight) */
export interface InnertubeSearchResult {
  videoId: string
  title: string
  artist: string
  duration: number
  thumbnail: string
}

// ── Search ──

/**
 * Search YouTube for videos matching a query.
 * Returns normalized search results (no streaming URLs).
 * Filters out non-video results (channels, playlists, etc.).
 */
export async function searchYouTube(
  query: string,
  signal?: AbortSignal
): Promise<InnertubeSearchResult[]> {
  try {
    if (signal?.aborted) return []

    const yt = await getInstance()
    if (signal?.aborted) return []

    const results = await yt.search(query)

    if (!results?.results) return []

    const tracks: InnertubeSearchResult[] = []
    for (const item of results.results) {
      if (signal?.aborted) return []
      if (item.type !== 'Video') continue

      const video = item as any
      const rawTitle: string = video.title?.text ?? ''
      const durationText: string = video.length_text?.text ?? '0:00'

      tracks.push({
        videoId: video.video_id,
        title: rawTitle,
        artist: video.author?.name ?? 'Unknown',
        duration: parseDurationText(durationText),
        thumbnail: video.thumbnails?.[0]?.url ?? '',
      })
    }

    return tracks
  } catch (err: any) {
    if (err.name === 'AbortError' || signal?.aborted) return []
    console.warn('[Innertube] Search failed:', err.message)
    return []
  }
}

/**
 * Get search suggestions for autocomplete.
 */
export async function getSearchSuggestions(
  query: string
): Promise<string[]> {
  try {
    const yt = await getInstance()
    const suggestions = await yt.getSearchSuggestions(query)
    return suggestions?.map((s: any) => (typeof s === 'string' ? s : s.query ?? '')) ?? []
  } catch {
    return []
  }
}

/** Parse a duration string like "3:39" or "1:02:15" to seconds */
function parseDurationText(text: string): number {
  const parts = text.split(':')
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
  }
  return parseInt(text, 10) || 0
}

// ── Resolver ──

/**
 * Resolve a YouTube video ID via InnerTube (youtubei.js).
 *
 * Returns null when the video can't be resolved, so the caller
 * (MediaResolver) can fall through to yt-dlp as a safety net.
 */
export async function resolveViaInnerTube(
  videoId: string,
  signal?: AbortSignal
): Promise<InnertubeResult | null> {
  try {
    // Quick abort check before any work
    if (signal?.aborted) return null

    const yt = await getInstance()

    // Check again after instance init (it might have taken time)
    if (signal?.aborted) return null

    // getBasicInfo is the lightweight path — just player response + basic metadata.
    // No watch-next feed, comments, or heavy parsing.
    // Note: youtubei.js GetVideoInfoOptions doesn't accept AbortSignal, so we
    // can't abort mid-flight. The caller's Promise.race handles coordination.
    const info = await yt.getBasicInfo(videoId)

    // Bail if the video doesn't exist
    if (!info.basic_info?.id) return null

    // Prefer a dedicated audio format (opus/m4a) over video+audio
    const format: Format | undefined = info.chooseFormat({
      type: 'audio',
      quality: 'best',
    })

    if (!format?.url) {
      // Fall back to best format with audio (some edge cases return no url)
      return null
    }

    return {
      videoId: info.basic_info.id,
      title: info.basic_info.title ?? 'Unknown',
      duration: info.basic_info.duration ?? 0,
      thumbnail: info.basic_info.thumbnail?.[0]?.url ?? '',
      streamingUrl: format.url,
      contentType: format.mime_type ?? 'audio/mp4',
    }
  } catch (err: any) {
    // Abort is intentional — don't log as warning
    if (err.name === 'AbortError' || signal?.aborted) return null

    console.warn(`[Innertube] Failed to resolve ${videoId}:`, err.message)
    return null
  }
}
