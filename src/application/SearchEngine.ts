import type { Track } from '../shared/types'

// ── Types ──

interface RawInnertubeVideo {
  videoRenderer?: {
    videoId?: string
    title?: { runs?: Array<{ text?: string }> }
    lengthText?: { simpleText?: string }
    thumbnail?: { thumbnails?: Array<{ url?: string }> }
    [key: string]: unknown
  }
  [key: string]: unknown
}

// ── Title Normalization ──

/**
 * Shared annotation patterns used to clean YouTube titles.
 * Exported so TrackIdentityEngine can reuse them instead of duplicating.
 */
export const ANNOTATION_PATTERNS: RegExp[] = [
  /\(Official\s+(Audio|Video|Music\s*Video|Lyric\s*Video|4K\s*Remaster|HD)\)/gi,
  /\(Official\)/gi,
  /\(Lyrics?\s*(Video)?\)/gi,
  /\(Audio\s*Only\)/gi,
  /\(Visualizer\)/gi,
  /\(4K\s*(Remaster)?\)/gi,
  /\(HD\)/gi,
  /\[Official\s+(Audio|Video|Music\s*Video)\]/gi,
  /\[HD\]/gi,
  /\[4K\]/gi,
  /\[Lyrics?\]/gi,
  /\s*-\s*(Topic)\s*$/gi,
  /\(ft\.?\s+.*?\)/gi,
  /\(feat\.?\s+.*?\)/gi,
  /\(with\s+.*?\)/gi,
  // Version/edit markers — strip suffixes that aren't the core title.
  // Handles both " - Remix" and " - Seeb Remix" (with qualifier).
  /\s*[-–—]\s*(.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*$/gi,
  /\s*[-–—]\s*.+?\s+Version\s*$/gi,
  /\s*[-–—]\s*Studio\s+Recording\s+from\s+.+?Performance\s*$/gi,
  /\s*[-–—]\s*(Bonus\s+Track|From\s+.+?)\s*$/gi,
  // Also handle parenthesized version markers: "(Remix)" and "(Seeb Remix)"
  /\((.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*\)/gi,
  /\s{2,}/g,
]

/**
 * Strip common annotations from a YouTube title.
 * e.g. "Linkin Park - Numb (Official Video) [HD]" → "Numb"
 */
export function cleanTitle(rawTitle: string): string {
  let title = rawTitle.trim()

  // Remove artist prefix from YouTube titles: "Artist - Title" → "Title"
  const artistSeparator = title.match(/^(.+?)\s*[-–—]\s*(.+)/)
  if (artistSeparator) {
    title = artistSeparator[2]
  }

  // Strip annotations
  for (const pattern of ANNOTATION_PATTERNS) {
    title = title.replace(pattern, '')
  }

  return title.trim()
}

/**
 * Strip annotations from a title WITHOUT removing the artist prefix.
 * Use this for Spotify/import target titles where the artist is already
 * a separate field, so "- Remix" or "- Radio Edit" won't be mistaken
 * for an artist separator.
 */
export function cleanTrackTitle(rawTitle: string): string {
  let title = rawTitle.trim()

  // Strip annotations only (no artist prefix removal)
  for (const pattern of ANNOTATION_PATTERNS) {
    title = title.replace(pattern, '')
  }

  return title.trim()
}

/** @deprecated Use cleanTitle instead */
function normalizeTitle(rawTitle: string): string {
  return cleanTitle(rawTitle)
}

// ── Duration Parsing ──

function parseDuration(text: string): number {
  // Handle "3:07" format
  const parts = text.split(':')
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
  }
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
  }
  return parseInt(text, 10) || 0
}

// ── Normalize a single raw Innertube result row ──

function normalizeRow(raw: RawInnertubeVideo): Track | null {
  const renderer = raw.videoRenderer
  if (!renderer?.videoId) return null

  const videoId = renderer.videoId
  const rawTitle = renderer.title?.runs?.[0]?.text ?? 'Unknown'
  const title = normalizeTitle(rawTitle)
  const durationText = renderer.lengthText?.simpleText ?? '0:00'
  const duration = parseDuration(durationText)
  const thumbnailUrl = renderer.thumbnail?.thumbnails?.[0]?.url ?? ''

  // Extract channelType from owner badges if available
  const ownerBadges = renderer['ownerBadges'] as Array<{ metadataBadgeRenderer?: { style?: string; tooltip?: string } }> | undefined
  const channelType = ownerBadges?.some(
    (b) => b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED_ARTIST'
  )
    ? 'verified_artist'
    : extractArtist(rawTitle, title).toLowerCase().endsWith(' - topic')
      ? 'verified_topic'
      : undefined

  return {
    id: videoId,
    title,
    artist: extractArtist(rawTitle, title),
    duration,
    thumbnailUrl,
    source: 'youtube',
    sourceId: videoId,
    channelType,
  }
}

/**
 * Extract artist name from raw title by looking at the part before the separator.
 */
function extractArtist(rawTitle: string, _normalizedTitle: string): string {
  const match = rawTitle.match(/^(.+?)\s*[-–—]\s*(.+)/)
  if (match) {
    return match[1].trim()
  }
  return 'Unknown Artist'
}

// ── Search Function Injection ──

/**
 * The production search function is injected at startup by the main process.
 * Tests can mock SearchEngine directly via vi.mock.
 */
let _searchFn: ((query: string) => Promise<Track[]>) | null = null

/**
 * Set the production search function (called once at app startup).
 * Accepts a query string and returns normalized Track[].
 */
export function setSearchFunction(fn: (query: string) => Promise<Track[]>): void {
  _searchFn = fn
}

/**
 * Search YouTube for tracks matching a query.
 * Returns normalized Track[] suitable for QueueEngine.
 *
 * In production, the search function is injected via setSearchFunction().
 * In test environments, this module is mocked via vi.mock.
 */
async function search(query: string): Promise<Track[]> {
  if (!_searchFn) {
    throw new Error(
      'SearchEngine not initialized. Call setSearchFunction() at app startup ' +
      'with the production search implementation.'
    )
  }
  return _searchFn(query)
}

/**
 * Get search suggestions for autocomplete.
 */
async function getSuggestions(_query: string): Promise<string[]> {
  // Mocked in tests. Production implementation would call Innertube.
  return []
}

// ── Exported Singleton ──

export const SearchEngine = {
  search,
  getSuggestions,
  normalizeRow,
  setSearchFunction,
}
