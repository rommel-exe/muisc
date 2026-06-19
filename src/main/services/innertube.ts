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
    // Disable safety mode so explicit/mature content appears in search results.
    // Default is true for anonymous sessions, which blocks explicit music from imports.
    enable_safety_mode: false,
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
  /** YouTube channel type: 'verified_topic' for auto-generated Topic channels */
  channelType: string
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

      // Detect channel type from author info
      const authorName: string = video.author?.name ?? ''
      const badges: Array<{ type?: string }> = video.author?.badges ?? []
      const badgeTypes = badges.map((b) => b.type ?? '')
      const channelType =
        authorName.toLowerCase().endsWith(' - topic')
          ? 'verified_topic'
          : badgeTypes.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST')
            ? 'verified_artist'
            : 'user_upload'

      tracks.push({
        videoId: video.video_id,
        title: rawTitle,
        artist: authorName,
        duration: parseDurationText(durationText),
        thumbnail: video.thumbnails?.[0]?.url ?? '',
        channelType,
      })
    }

    // Filter & rank: remove non-song results, sort by quality
    return filterAndRankResults(tracks)
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

// ── Search Result Filtering & Ranking ──

/**
 * Patterns that indicate content is NOT the original studio recording.
 * These match the RAW title (including annotations) so "Linkin Park - Numb
 * (Live in Texas)" is caught even though "Live" is in an annotation.
 *
 * IMPORTANT: The patterns below avoid false-matching song titles that naturally
 * contain these words (e.g. "Piano Man", "Live and Let Die"). We use compound
 * patterns like "live in/at/from" rather than bare /\blive\b/i.
 */
const NON_SONG_PATTERNS: RegExp[] = [
  // Live/concert — catch "(live)", "[live]", "live in/at/from ...", "live @", "live aid", etc.
  /\(live\)/i, /\[live\]/i,
  /[\[\(].*\blive\b.*[\]\)]/i,  // "(Live - 2009)", "[Live at Wembley]", "(Live 2005)"
  /\(live (in|at|from|concert|performance|session|recording|cover|version)\)/i,
  /\[live (in|at|from|concert|performance|session|recording|cover|version)\]/i,
  /\blive (in|at|from|concert|performance|session|recording|version|aid|video|show|awards|event|broadcast)\b/i,
  /\blive @/i,
  /\blive[\s-]?\d/i,  // "Live 8", "Live 2005", "Live-2009", "Live 06.06.2004"
  /\bconcert\b/i, /\btour\b/i, /\bperformance\b/i,

  // Not the original recording
  /\bcover\b/i, /\binstrumental\b/i, /\bkaraoke\b/i, /\bacapella\b/i,
  /\breaction\b/i, /\btutorial\b/i, /\blesson\b/i, /\bhow to play\b/i,
  /\bsung by\b/i, /\bperformed by\b/i, /\btribute\b/i, /\bcast\b/i,
  /\bpiano (version|cover|remix|tutorial)\b/i,
  /\bguitar (version|cover|remix|tutorial)\b/i,
  /\bacoustic (version|cover)\b/i,

  // Audio-effect versions
  /\bbass boosted\b/i, /\bnightcore\b/i, /\bslowed\b/i, /\breverb\b/i,
  /\bsped up\b/i, /\b8d audio\b/i, /\bloop\b/i, /\bmashup\b/i,

  // Event/show performances
  /\bhalftime\b/i, /\bsuper bowl\b/i, /\bacademy awards\b/i,
  /\boscars\b/i, /\bflashmob\b/i, /\baudience\b/i,
  /\bfortnite\b/i, /\bmovie scene\b/i,
  /\bclean version\b/i,
  /\brockschool\b/i, /\bmuppets?\b/i,

  // Talk shows & TV
  /\btonight show\b/i, /\blate night\b/i, /\btalk show\b/i,
  /\bchoreography\b/i, /\blooping station\b/i,
  /\baudition\b/i, /\bthe voice\b/i, /\btalent show\b/i,

  // BBC/event broadcasts
  /\bbbc\b/i, /\bopening act\b/i,

  // Extended/remix versions — NOTE: remix/rework/etc are NOT filtered here
  // because our multi-query search + confidence scoring handles version
  // matching precisely. The pre-filter would block tracks like "Sunflower - Remix"
  // from finding their corresponding YouTube upload.
]

interface ScoredResult {
  result: InnertubeSearchResult
  score: number
}

/**
 * Filter and rank search results to surface only the original studio recording.
 *
 * Strategy:
 * 1. **Filter**: Remove clear non-song results (live, cover, remix, etc.)
 *    and duration outliers (<30s shorts or >15min mixes).
 * 2. **Duration cluster**: Group remaining results by duration (±3s window).
 *    The largest cluster is almost certainly the official song length
 *    (Topic auto-generated videos + official upload all share it).
 * 3. **Score**: cluster proximity (strongest) + title quality + artist match.
 * 4. **Sort**: descending by score so the best match appears first.
 */
function filterAndRankResults(results: InnertubeSearchResult[]): InnertubeSearchResult[] {
  if (results.length === 0) return results

  // ── Step 1: Filter ──
  const filtered = results.filter((r) => {
    // Duration sanity: skip <30s (YouTube Shorts/clips) and >15min (compilations/podcasts)
    if (r.duration < 30 || r.duration > 900) return false

    const titleLower = r.title.toLowerCase()
    const searchable = titleLower + ' ' + r.artist.toLowerCase()

    for (const pattern of NON_SONG_PATTERNS) {
      if (pattern.test(searchable)) return false
    }

    return true
  })

  // If filtering removed everything, fall back to original (minus very short/long)
  const pool = filtered.length >= 3
    ? filtered
    : results.filter((r) => r.duration >= 30 && r.duration <= 900)

  // ── Step 2: Duration clustering ──
  // For each duration, count how many other results are within 3s of it.
  const clusterWeight = new Map<number, number>()
  for (const r of pool) {
    let count = 0
    for (const other of pool) {
      if (Math.abs(r.duration - other.duration) <= 3) count++
    }
    clusterWeight.set(r.duration, count)
  }
  const maxCluster = Math.max(...clusterWeight.values(), 1)

  // ── Step 3: Score each result ──
  const scored: ScoredResult[] = pool.map((r) => {
    // 3a. Duration cluster proximity (0-50 points)
    //     Results near the most common song length get a big boost.
    const rawCluster = clusterWeight.get(r.duration) ?? 1
    const clusterPoints = (rawCluster / maxCluster) * 50

    // 3b. Title structure (0-25 points)
    //     "Artist - Title" pattern is the standard for proper uploads.
    const hasTypicalPattern = /^.+?\s*[-–—]\s*/.test(r.title)
    const titleStructurePoints = hasTypicalPattern ? 25 : 0

    // 3c. Artist-name presence (0-15 points)
    //     If the uploader/artist name appears in the title (or its first word
    //     for multi-word channels like "Queen Official" → "Queen"), it's likely
    //     the right artist's channel (vs. a fan upload).
    const artistName = r.artist.toLowerCase()
    const titleLower = r.title.toLowerCase()
    const artistFirstWord = artistName.split(/\s+/)[0]
    const artistInTitle = artistName !== 'unknown' && (
      titleLower.includes(artistName) ||
      (artistFirstWord.length > 2 && titleLower.includes(artistFirstWord))
    )
    const artistPoints = artistInTitle ? 15 : 0

    // 3d. Reasonable song-length bonus (0-10 points)
    //     Most songs are 2-7 minutes. Penalize very short or very long.
    const lengthPoints = (r.duration >= 120 && r.duration <= 420) ? 10
      : r.duration < 60 ? 3
      : 6

    return {
      result: r,
      score: clusterPoints + titleStructurePoints + artistPoints + lengthPoints,
    }
  })

  // ── Step 4: Sort descending by score ──
  scored.sort((a, b) => b.score - a.score)

  return scored.map((s) => s.result)
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
