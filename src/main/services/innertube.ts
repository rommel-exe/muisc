// src/main/services/innertube.ts
//
// Hybrid InnerTube resolver — fast path via youtubei.js with normalized output.
// Falls through to yt-dlp (via MediaResolver) when something goes wrong.
//
// youtubei.js runs in pure JS — zero Python boot overhead.
// Cold resolves typically complete in 400–800ms vs 2–3s for yt-dlp.

import { Innertube } from 'youtubei.js'
import type Format from 'youtubei.js/dist/src/parser/classes/misc/Format.js'

// ── LRU Search Cache ──
// Prevents redundant YouTube searches during Spotify playlist import
// (same query often hits from different tracks in the same playlist).

interface CacheEntry {
  results: InnertubeSearchResult[]
  timestamp: number
}

const SEARCH_CACHE = new Map<string, CacheEntry>()
const CACHE_MAX_SIZE = 500
const CACHE_TTL_MS = 600_000

/** Clear the search result cache. Useful when the user explicitly requests a fresh search. */
export function clearSearchCache(): void {
  SEARCH_CACHE.clear()
}

// ── Multi-Instance Search Pool ──
// Rate limits are per-session, not per-IP. Multiple sessions multiply throughput.
const SEARCH_INSTANCE_COUNT = 1
let _searchInstances: Innertube[] = []
let _searchInitPromise: Promise<void> | null = null
let _rrIndex = 0

async function ensureSearchInstances(): Promise<void> {
  if (_searchInstances.length === SEARCH_INSTANCE_COUNT) return
  if (_searchInitPromise) return _searchInitPromise
  _searchInitPromise = (async () => {
    const results = await Promise.allSettled(
      Array.from({ length: SEARCH_INSTANCE_COUNT }, () =>
        Innertube.create({ enable_safety_mode: false })
      )
    )
    _searchInstances = results
      .filter((r): r is PromiseFulfilledResult<Innertube> => r.status === 'fulfilled')
      .map((r) => r.value)
    if (_searchInstances.length === 0) {
      _searchInitPromise = null
      throw new Error('Failed to create any Innertube search instance')
    }
    if (_searchInstances.length < SEARCH_INSTANCE_COUNT) {
      console.warn(`[Innertube] Only ${_searchInstances.length}/${SEARCH_INSTANCE_COUNT} search instances created`)
    }
  })()
  return _searchInitPromise
}

function getSearchInstance(): Innertube {
  const idx = _rrIndex % _searchInstances.length
  _rrIndex++
  return _searchInstances[idx]
}

let _inflightSearches = 0
const MAX_CONCURRENT_SEARCHES = 10

async function acquireSearchSlot(signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) return
    if (_inflightSearches < MAX_CONCURRENT_SEARCHES) {
      _inflightSearches++
      return
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

function releaseSearchSlot(): void {
  _inflightSearches = Math.max(0, _inflightSearches - 1)
}

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
  /** View count for popularity-based ranking */
  viewCount?: number
}

// ── yt-dlp search fallback ──

/**
 * Search YouTube via yt-dlp flat JSON.
 * Used as a fallback when the Innertube API returns 403.
 */
async function searchYouTubeViaYtDlp(
  query: string,
  limit: number = 10
): Promise<InnertubeSearchResult[]> {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process')
    const count = Math.min(Math.max(limit, 3), 30)
    const args = [`ytsearch${count}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings']
    execFile('yt-dlp', args, { timeout: 15000 }, (err: any, stdout: string, _stderr: string) => {
      if (err) {
        reject(new Error(`yt-dlp search failed: ${err.message}`))
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      const results: InnertubeSearchResult[] = []
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          const videoId: string = item.id || ''
          const title: string = item.title || ''
          const duration: number = Math.round(item.duration || 0)
          const uploader: string = item.uploader || item.channel || item.creator || ''
          const thumbnail: string = item.thumbnail || ''
          const viewCount: number | undefined = typeof item.view_count === 'number' ? item.view_count : undefined

          if (!videoId || !title) continue

          results.push({
            videoId,
            title,
            artist: uploader,
            duration,
            thumbnail,
            channelType: uploader.toLowerCase().includes('topic') ? 'verified_topic' : 'user_upload',
            viewCount,
          })
        } catch {
          // Skip malformed lines
        }
      }
      resolve(results)
    })
  })
}

// ── Search ──

/**
 * Search YouTube for videos matching a query.
 * Returns normalized search results (no streaming URLs).
 * Filters out non-video results (channels, playlists, etc.).
 *
 * Attempts Innertube API first with retry on rate limit (403).
 * Falls back to yt-dlp on persistent failure.
 */
export async function searchYouTube(
  query: string,
  signal?: AbortSignal
): Promise<InnertubeSearchResult[]> {
  if (signal?.aborted) return []

  // ── LRU cache hit? ──
  const cached = SEARCH_CACHE.get(query)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results
  }

  // ── Primary: Innertube API (with 403 retry) ──
  // Retry delays escalate so rate limits cool down between attempts.
  const RETRY_DELAYS_MS = [1000, 3000]

  // Ensure search instances are ready
  await ensureSearchInstances()

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (signal?.aborted) return []

    await acquireSearchSlot(signal)
    if (signal?.aborted) return []

    try {
      const yt = getSearchInstance()
      if (signal?.aborted) return []

      const results = await yt.search(query)

      if (!results?.results) throw new Error('Empty results from Innertube')

      const tracks: InnertubeSearchResult[] = []
      for (const item of results.results) {
        if (signal?.aborted) return []
        if (item.type !== 'Video') continue

        const video = item as any
        const rawTitle: string = video.title?.text ?? ''
        const durationText: string = video.length_text?.text ?? '0:00'

        // Extract view count (varies by API version: view_count, views.text, or short_view_count)
        let viewCount: number | undefined
        if (typeof video.view_count === 'number') {
          viewCount = video.view_count
        } else if (video.views?.text) {
          viewCount = parseViewCount(video.views.text)
        } else if (video.short_view_count?.text) {
          viewCount = parseViewCount(video.short_view_count.text)
        }

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
          viewCount,
        })
      }

      if (tracks.length === 0) throw new Error('No video results from Innertube')

      // Filter & rank: remove non-song results, sort by quality
      const finalResults = filterAndRankResults(tracks)

      // Cache for subsequent identical queries (Innertube path only — not yt-dlp fallback)
      if (SEARCH_CACHE.size >= CACHE_MAX_SIZE) {
        const oldest = SEARCH_CACHE.keys().next().value
        if (oldest !== undefined) SEARCH_CACHE.delete(oldest)
      }
      SEARCH_CACHE.set(query, { results: finalResults, timestamp: Date.now() })

      return finalResults
    } catch (err: any) {
      if (err.name === 'AbortError' || signal?.aborted) return []

      // Detect rate limit (403) — retry with backoff before falling to yt-dlp
      const errMsg = err.message ?? ''
      const isRateLimit = errMsg.includes('403') || errMsg.includes('status code 403') || errMsg.includes('Too Many Requests') || errMsg.includes('429')

      if (isRateLimit && attempt < RETRY_DELAYS_MS.length) {
        console.warn(
          `[Innertube] Rate limited (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}), ` +
          `retrying "${query.substring(0, 50)}" in ${RETRY_DELAYS_MS[attempt]}ms...`
        )
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        continue
      }

      console.warn('[Innertube] Innertube search failed, falling back to yt-dlp:', errMsg)
      break
    } finally {
      releaseSearchSlot()
    }
  }

  // ── Fallback: yt-dlp ──
  try {
    console.log('[Innertube] Searching via yt-dlp fallback:', query.substring(0, 60))
    const tracks = await searchYouTubeViaYtDlp(query)
    if (signal?.aborted) return []
    if (tracks.length === 0) return []
    return filterAndRankResults(tracks)
  } catch (err: any) {
    console.warn('[Innertube] yt-dlp fallback also failed:', err.message)
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
  /\bband\s+version\b/i,
  /\(band\s+version\)/i,
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

/**
 * Detect whether a result's title indicates it is NOT the original studio recording
 * (i.e., a music video, lyric video, or official audio upload).
 *
 * Returns a penalty score (negative points) applied in the ranking algorithm.
 * Studio recordings (bare "Artist - Title") get 0 penalty.
 */
function getVersionPenalty(title: string): number {
  const t = title.toLowerCase()

  // Music video annotations — these are visual-first versions, not pure audio
  if (
    /\(official\s+(music\s+)?video\)/i.test(t) ||
    /\(music\s+video\)/i.test(t) ||
    /\(mv\)/i.test(t) ||
    /\[mv\]/i.test(t) ||
    /\(video\s+clip\)/i.test(t)
  ) return -35

  // Lyric video annotations — not the original recording
  if (
    /\(official\s+lyric\s+video\)/i.test(t) ||
    /\(lyric\s+video\)/i.test(t) ||
    /\(lyrics?\)/i.test(t)
  ) return -25

  // Visualizer — not the original audio recording
  if (
    /\(visualizer\)/i.test(t) ||
    /\(official\s+visualizer\)/i.test(t)
  ) return -20

  // "Official Audio" or bare "(Audio)" — still the actual recording, mild penalty
  if (
    /\(official\s+audio\)/i.test(t) ||
    /\(audio\)/i.test(t)
  ) return -10

  return 0
}

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
  const maxViews = Math.max(...pool.map(r => r.viewCount ?? 0), 1)
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

    // 3e. Popularity (0-30 points)
    //     Logarithmic scale so 1B views beats 10M, but 10M doesn't crush 1M.
    const views = r.viewCount ?? 0
    const popularityPoints = views > 0
      ? (Math.log10(views) / Math.log10(maxViews)) * 30
      : 0

    // 3f. Channel type bonus (0-40 points)
    //     Topic channels are the gold standard for studio recordings (YouTube auto-generates
    //     these from label-delivered content). Verified artist channels are good but many host
    //     music videos rather than the pure audio.
    const channelBonus = r.channelType === 'verified_topic' ? 40
      : r.channelType === 'verified_artist' ? 15
      : 0

    // 3g. Version penalty (0 to -35 points)
    //     Penalize titles that explicitly denote a non-studio version (music video, lyric video,
    //     visualizer, official audio). Topic channel results rarely have these annotations.
    const versionPenalty = getVersionPenalty(r.title)

    return {
      result: r,
      score: clusterPoints + titleStructurePoints + artistPoints + lengthPoints + popularityPoints + channelBonus + versionPenalty,
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

/** Parse view count strings like "1,234,567 views" or "1.2M views" to number */
function parseViewCount(text: string): number | undefined {
  const cleaned = text.replace(/[,.\s]/g, '').toLowerCase()
  const match = cleaned.match(/(\d+[km]?)\s*views?/)
  if (!match) return undefined
  let num = parseInt(match[1], 10)
  if (match[1].endsWith('k')) num = parseInt(match[1], 10) * 1000
  if (match[1].endsWith('m')) num = parseInt(match[1], 10) * 1000000
  return isNaN(num) ? undefined : num
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
