// ── Layer 2: Search Strategy Engine ──
// Generates 20–30 dynamic search queries for a given track, ordered by
// specificity (most specific first). Pure function — no async, no side effects,
// no SearchEngine imports (avoids circular dependency with TrackIdentityEngine).

import type { SpotifyTrack, NormalizedMetadata } from '../types'

// ── Internal helpers (no SearchEngine dependency) ──

/** Strip version markers that affect search precision */
function cleanTitle(title: string): string {
  let result = title
  const patterns = [
    /\s*\(remix\)\s*/gi,
    /\s*\(radio edit\)\s*/gi,
    /\s*\(extended mix\)\s*/gi,
    /\s*\(acoustic\)\s*\)?$/gi,
    /\s*\(instrumental\)\s*/gi,
    /\s*\(live\)\s*/gi,
    /\s*\(bonus track\)\s*/gi,
    /\s*\(explicit\)\s*/gi,
    /\s*\(clean\)\s*/gi,
    /\s*-\s*remix\s*/gi,
    /\s*-\s*radio edit\s*/gi,
  ]
  for (const p of patterns) {
    result = result.replace(p, '')
  }
  return result.trim()
}

/** Check if title contains variant markers */
function hasVariantMarker(title: string): boolean {
  return /\b(remix|edit|acoustic|instrumental|live|reprise|version)\b/i.test(title)
}

/** Check if artist string suggests a collaboration */
function isCollabArtist(artist: string): boolean {
  return /[&,]|\s(with|vs\.?|x\s)/i.test(artist)
}

/** Extract individual artist names from a collab string */
function splitCollabArtists(artist: string): string[] {
  return artist
    .split(/[&,]|\s+(?:with|vs\.?|x)\s+/i)
    .map((a) => a?.trim() ?? '')
    .filter((a) => a.length > 0)
}

/** Check if a query is too long for YouTube (vanity check) */
function isTooLong(query: string): boolean {
  return query.length > 100
}

/** Check if title has feat. markers */
function hasFeatMarker(title: string): boolean {
  return /\(\s*(feat|ft)\.?\s/i.test(title)
}

/** Strip feat. clause from title */
function stripFeat(title: string): string {
  return title.replace(/\(\s*(feat|ft)\.?\s+[^)]*\)/gi, '').trim()
}

// ── Main query generation ──

export function generateSearchQueries(
  track: SpotifyTrack,
  normalized?: NormalizedMetadata
): string[] {
  // Resolve working values from normalized metadata or raw track
  const rawTitle: string = normalized?.rawTitle ?? track.title
  const canonicalTitle: string = normalized?.canonicalTitle ?? cleanTitle(track.title)
  const artist: string = normalized?.primaryArtist ?? track.artist.toLowerCase()
  const album: string = normalized?.album ?? (track.album?.toLowerCase() ?? '')
  const explicit: boolean = normalized?.explicit ?? track.explicit ?? false
  const duration: number = normalized?.duration ?? track.duration
  const featuring: string[] = normalized?.featuring ?? []
  const hasAlbum: boolean = album.length > 0
  const isShort: boolean = duration < 90
  const hasVariant: boolean = hasVariantMarker(rawTitle)
  const hasFeat: boolean = hasFeatMarker(rawTitle) || featuring.length > 0
  const collabArtists: string[] = isCollabArtist(artist) ? splitCollabArtists(artist) : []
  const longTitle: boolean = canonicalTitle.length > 50

  const queries: string[] = []

  // Helper: push query if not too long
  function add(q: string): void {
    if (!isTooLong(q)) queries.push(q)
  }

  // ── Tier 1: Exact / Primary ──
  add(`${artist} ${canonicalTitle}`)
  add(`${artist} ${canonicalTitle} official audio`)
  add(`${artist} ${canonicalTitle} topic`)
  add(`${artist} ${canonicalTitle} official`)

  // If track has variant markers, push raw title early
  if (hasVariant) {
    add(`${artist} ${rawTitle}`)
  } else {
    add(`${artist} ${canonicalTitle}`) // already added above, dedup will handle
    add(`${artist} ${rawTitle}`)
  }

  // ── Adaptive: push explicit query higher if track is explicit ──
  if (explicit && !isShort) {
    add(`${artist} ${canonicalTitle} explicit`)
  }

  // ── Tier 2: Presentation Qualifiers ──
  add(`${artist} ${rawTitle} official audio`)
  add(`${artist} ${canonicalTitle} lyrics`)
  add(`${artist} ${canonicalTitle} video`)
  if (!longTitle) {
    add(`${artist} ${canonicalTitle} audio`)
  }

  // ── Tier 3: Contextual ──
  if (hasAlbum) {
    add(`${artist} ${album} ${canonicalTitle}`)
  }
  add(`${canonicalTitle} ${artist}`)
  add(`${canonicalTitle}`)
  add(`${artist} ${canonicalTitle} provided to youtube`)
  add(`${artist} ${canonicalTitle} - topic`)

  // ── Tier 4: Variant-Specific (skip remix/extended/HD/4k for short tracks) ──
  if (!isShort) {
    add(`${artist} ${canonicalTitle} remaster`)
    add(`${artist} ${canonicalTitle} explicit`)
    add(`${artist} ${canonicalTitle} clean`)
    add(`${artist} ${canonicalTitle} HD`)
    add(`${artist} ${canonicalTitle} 4k`)
  }

  // ── Tier 5: Deep Recovery ──
  if (hasAlbum) {
    add(`${album} ${canonicalTitle}`)
  }
  add(`${rawTitle}`)

  if (hasAlbum) {
    add(`${artist} ${album}`)
  }
  add(`${artist} ${canonicalTitle} version`)
  add(`${canonicalTitle} audio`)
  add(`${artist} ${canonicalTitle} music`)

  // ── Collab-specific: queries with individual artists ──
  if (collabArtists.length > 0) {
    for (const singleArtist of collabArtists) {
      add(`${singleArtist} ${canonicalTitle}`)
      // Skip duplicate if it matches the primary query
    }
  }

  // ── Feat. variants: with and without feat. text ──
  if (hasFeat) {
    const withoutFeat = stripFeat(rawTitle)
    if (withoutFeat && withoutFeat !== rawTitle) {
      add(`${artist} ${withoutFeat}`)
    }
  }

  // ── Featuring artist queries (if we know the featuring artists) ──
  for (const featArtist of featuring) {
    add(`${featArtist} ${canonicalTitle}`)
  }

  // Deduplicate and cap
  return [...new Set(queries)].slice(0, 30)
}

/** Return only tier-1 (primary) queries — used for cache pre-fetching */
export function getPrimarySearchQueries(track: SpotifyTrack): string[] {
  const rawTitle = track.title
  const clean = cleanTitle(track.title)
  const artist = track.artist.toLowerCase()
  const hasVariant = hasVariantMarker(rawTitle)

  const queries: string[] = [
    `${artist} ${clean}`,
    `${artist} ${clean} official audio`,
    `${artist} ${clean} topic`,
    `${artist} ${clean} official`,
  ]

  if (hasVariant) {
    queries.push(`${artist} ${rawTitle}`)
  } else {
    queries.push(`${artist} ${rawTitle}`)
  }

  return [...new Set(queries)]
}

/** Check if additional variant queries should be generated based on title */
export function shouldGenerateVariants(cleanTitle_: string): boolean {
  return hasVariantMarker(cleanTitle_)
}
