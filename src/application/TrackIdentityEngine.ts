// ── Track Identity Engine ──
// 10-Layer orchestrator: facade over layers/ with 100% backward-compatible API.
// Layer 1-10 in layers/*.ts, RecordingGraph in recording-graph/*.ts.
//
// Backward-compat public surface (exported on TrackIdentityEngine):
//   resolveIdentity, resolveFromCandidates, calculateConfidence,
//   calculateCanonicalScore, getAnnotationCategory, detectVersionMarkers,
//   getVersionPenalty, rankByCanonicalness, isAcceptableVersion
// Module-level export: generateSearchQueries

import { SearchEngine, cleanTitle, cleanTrackTitle } from './SearchEngine'
import type { Track } from '../shared/types'
import type { SpotifyTrack, MockCandidate, ResolvedMatchResult, NormalizedCandidate, AnnotationCategory } from './types'
import { compareTitles } from './title-identity-engine'

// ── Layer Imports ──
import { normalizeSpotifyMetadata } from './layers/metadata-normalization'
import { collectCandidates } from './layers/candidate-collection'
import { normalizeTrackCandidate } from './layers/candidate-normalization'
import { classifyRecording } from './layers/recording-classification'
import { clusterCandidates } from './layers/candidate-clustering'
import { resolveBestIdentity } from './layers/identity-resolution'

// ═══════════════════════════════════════════════
// BACKWARD-COMPAT HELPER FUNCTIONS (verbatim from old engine)
// ═══════════════════════════════════════════════

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .replace(/[^a-z0-9\s\-'._]/g, '') // keep only letters, digits, basic punctuation
    .trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ═══════════════════════════════════════════════
// OLD generateSearchQueries — backward compat export
// ═══════════════════════════════════════════════

export function generateSearchQueries(track: SpotifyTrack): string[] {
  const { artist, title, explicit } = track
  const clean = cleanTrackTitle(title)
  const queries: string[] = [
    `${artist} ${clean}`,
    `${artist} ${clean} official`,
  ]

  if (explicit) {
    queries.push(`${artist} ${clean} explicit`)
  }

  if (title !== clean) {
    queries.push(`${artist} ${title}`)
  }

  const hasRemixMarker = /[-–—]\s*(.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic|Bonus\s+Track)\s*$/i.test(title)
    || /\((.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*\)/i.test(title)
  if (hasRemixMarker) {
    queries.push(`${artist} ${clean} remix audio`)
  }

  const parenMatch = title.match(/\(([^)]+)\)/)
  if (parenMatch && !clean.includes(parenMatch[1].toLowerCase().trim())) {
    const parenContent = parenMatch[1].trim()
    queries.push(`${artist} ${clean} ${parenContent}`)
  }

  queries.push(`${artist} ${clean} topic`)

  if (clean.length > 3) {
    queries.push(clean)
  }

  queries.push(`${artist} ${title}`)

  return [...new Set(queries)]
}

// ═══════════════════════════════════════════════
// VERSION MARKER DETECTION (old VERSION_MARKERS table — backward compat)
// ═══════════════════════════════════════════════

interface VersionMarkerEntry {
  pattern: RegExp
  category: AnnotationCategory
  description: string
}

const VERSION_MARKERS: VersionMarkerEntry[] = [
  {
    pattern: /\b(Remix|Bootleg)\b/i,
    category: 'remix_edit',
    description: 'Remix or bootleg — alternative version by another producer',
  },
  {
    pattern: /\b(Nightcore|Sped\s*Up)\b/i,
    category: 'derivative',
    description: 'Pitched-up fan edit — not the original recording',
  },
  {
    pattern: /\b(Slowed|Reverb)\b/i,
    category: 'derivative',
    description: 'Tempo or pitch modified version',
  },
  {
    pattern: /\b(Loop|10\s*Hours?|1\s*Hour)\b/i,
    category: 'derivative',
    description: 'Looped or extended duration version',
  },
  {
    pattern: /\b(Radio\s*Edit|Extended\s*(Mix|Version)|Video\s*Edit|Club\s*Mix|Dub\s*Mix|Original\s*Mix)\b/i,
    category: 'remix_edit',
    description: 'Edited version for radio, extended for clubs, or alternative mix',
  },
  {
    pattern: /\((Live|Live\s+(at|in|from|concert|performance|session|recording|version|aid))\b/i,
    category: 'live_performance',
    description: 'Live/concert recording',
  },
  {
    pattern: /\b(live\s+(at|in|from|concert|performance|session|recording|version|aid))\b/i,
    category: 'live_performance',
    description: 'Live/concert recording (un-parenthesized)',
  },
  {
    pattern: /\[(Live|Live\s+(at|in|from|concert|performance))\b/i,
    category: 'live_performance',
    description: 'Live recording (bracketed)',
  },
  {
    pattern: /\((Concert|Tour|Stage)\s+(Version|Performance|Recording|Mix)\)/i,
    category: 'live_performance',
    description: 'Concert or tour version — live recording',
  },
  {
    pattern: /\b(Concert|Tour|Stage)\s+(Version|Performance|Recording)\b/i,
    category: 'live_performance',
    description: 'Concert or tour version (un-parenthesized)',
  },
  {
    pattern: /\b(Acoustic)\b/i,
    category: 'alternate_version',
    description: 'Acoustic arrangement — different from studio recording',
  },
  {
    pattern: /\w+'s\s+Version\b/i,
    category: 'alternate_version',
    description: "Artist's re-recorded version (e.g. Taylor's Version)",
  },
  {
    pattern: /\b(Anniversary\s+(Edition|Version|Remaster)|Re[- ]?recorded)\b/i,
    category: 'alternate_version',
    description: 'Anniversary edition or re-recorded version',
  },
  {
    pattern: /\b(Bonus\s+Track|Deluxe\s+Edition|Expanded\s+Edition)\b/i,
    category: 'alternate_version',
    description: 'Bonus track or deluxe edition exclusive',
  },
  {
    pattern: /\b(From\s+["]?.*?["]?|From\s+the\s+(Motion\s+)?Picture)\b/i,
    category: 'alternate_version',
    description: 'Track from a specific album/movie — not the original single release',
  },
  {
    pattern: /\b(Remaster(ed)?|Remastered\s+\d{4})\b/i,
    category: 'alternate_version',
    description: 'Remastered version — sonically different from original',
  },
  {
    pattern: /\b(Teaser|Preview|Snippet)\b/i,
    category: 'alternate_version',
    description: 'Short preview or teaser — not the full track',
  },
  {
    pattern: /\bBand\s+Version\b/i,
    category: 'alternate_version',
    description: 'Band version — alternate arrangement, not the original studio recording',
  },
  {
    pattern: /\b(Instrumental)\b/i,
    category: 'derivative',
    description: 'Instrumental version — no vocals',
  },
  {
    pattern: /\b(Cover|Tribute)\b/i,
    category: 'derivative',
    description: 'Cover or tribute — performed by someone else',
  },
  {
    pattern: /\b(Parody|Spoof|Minecraft|Fan\s*Made)\b/i,
    category: 'derivative',
    description: 'Fan-made parody, game remake, or spoof — not the original recording',
  },
  {
    pattern: /\b(Karaoke|Acapella)\b/i,
    category: 'derivative',
    description: 'Karaoke or acapella version',
  },
  {
    pattern: /\b(Audio\s+Only)\b/i,
    category: 'derivative',
    description: 'Audio-only upload — typically mobile-recorded or low-quality',
  },
  {
    pattern: /\b(Visualizer)\b/i,
    category: 'derivative',
    description: 'Visualizer — animated art, not the actual recording',
  },
  {
    pattern: /\b(Lyrics?\s*(Video)?)\b/i,
    category: 'lyrics_version',
    description: 'Lyrics video — original recording with overlaid text',
  },
]

export function detectVersionMarkers(rawTitle: string): AnnotationCategory | null {
  for (const entry of VERSION_MARKERS) {
    if (entry.pattern.test(rawTitle)) {
      return entry.category
    }
  }
  return null
}

export function getVersionPenalty(category: AnnotationCategory): number {
  switch (category) {
    case 'remix_edit':          return 0.25
    case 'live_performance':    return 0.20
    case 'alternate_version':   return 0.10
    case 'derivative':          return 0.20
    case 'lyrics_version':      return 0.05
    case 'official_alternate':  return 0.03
    default:                    return 0
  }
}

// ═══════════════════════════════════════════════
// getAnnotationCategory — bridges old API to new Layer 5 classification
// ═══════════════════════════════════════════════

export function getAnnotationCategory(rawTitle: string, channelType?: string): AnnotationCategory {
  // Step 1: Version marker check (old VERSION_MARKERS table — catches edgcases
  // the new Layer 5 classification doesn't handle identically: Audio Only → derivative)
  const marker = detectVersionMarkers(rawTitle)
  if (marker) return marker

  // Step 2: Official signals (matches old behavior)
  const hasOfficialAnnotation = /\(official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\)/i.test(rawTitle)
    || /\[official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\]/i.test(rawTitle)
    || /\(official\)/i.test(rawTitle)
    || /\[official\]/i.test(rawTitle)
  const isTopic = channelType === 'verified_topic'
  const isVerifiedArtist = channelType === 'verified_artist'

  if (hasOfficialAnnotation || isTopic) {
    return 'official_canonical'
  }

  if (isVerifiedArtist) {
    const parenMatches = rawTitle.match(/\(([^)]+)\)/g)
    if (parenMatches && parenMatches.length > 0) {
      const hasFeatureMarker = parenMatches.some(p => /\b(feat\.?|with|&|and)\b/i.test(p))
      if (!hasFeatureMarker) {
        return 'official_alternate'
      }
    }
    return 'official_canonical'
  }

  // Step 3: Derivative signals
  const lower = rawTitle.toLowerCase()
  const hasDerivative = /\b(cover|tribute|karaoke|acapella)\b/i.test(lower)
  if (hasDerivative) return 'derivative'

  return 'unmarked'
}

export function isAcceptableVersion(rawTitle: string, channelType?: string): boolean {
  const category = getAnnotationCategory(rawTitle, channelType)
  return category === 'official_canonical'
    || category === 'official_alternate'
    || category === 'unmarked'
    || category === 'lyrics_version'
}

// ═══════════════════════════════════════════════
// calculateConfidence — old scoring preserved verbatim
// ═══════════════════════════════════════════════

export function calculateConfidence(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string; artist?: string }
): number {
  let score = 0

  const deltaT = Math.abs(target.duration - candidate.duration)

  // Graduated Duration Score (gatekeeper — 0.00 to 0.50)
  if (deltaT <= 0) {
    score += 0.50
  } else if (deltaT <= 1) {
    score += 0.40
  } else if (deltaT <= 2) {
    score += 0.25
  } else if (deltaT <= 3) {
    score += 0.15
  } else if (deltaT <= 5) {
    score += 0.05
  }

  // Title Match (0.00 to 0.20) — token equality gate
  if (compareTitles(target.title, candidate.title) !== 'title_mismatch') {
    score += 0.20
  }

  // Artist / Channel Match (-0.15 to +0.20)
  const targetArtist = normalizeForMatch(target.artist)
  const candidateArtist = candidate.artist ? normalizeForMatch(candidate.artist) : null
  const candidateStr = candidateArtist || normalizeForMatch(candidate.title)

  if (candidate.channelType === 'verified_topic') {
    score += 0.20
  } else if (candidateStr.includes(targetArtist)) {
    score += 0.15
  } else if (targetArtist) {
    const artistParts = targetArtist.split(/\s+/).filter(Boolean)
    const artistMatch = artistParts.filter(p => candidateStr.includes(p)).length
    if (artistMatch > 0) {
      score += 0.10 * (artistMatch / artistParts.length)
    }
  }

  // Artist MISMATCH penalty
  if (
    candidateArtist &&
    candidate.channelType !== 'verified_topic' &&
    targetArtist &&
    !candidateStr.includes(targetArtist)
  ) {
    const artistParts = targetArtist.split(/\s+/).filter(Boolean)
    const anyPartMatch = artistParts.some(p => candidateArtist!.includes(p))
    if (!anyPartMatch) {
      score -= 0.15
    }
  }

  // Annotation Quality Score (-0.15 to +0.10)
  const annotationCat = getAnnotationCategory(candidate.title, candidate.channelType)
  switch (annotationCat) {
    case 'official_canonical':  score += 0.10; break
    case 'official_alternate':  score += 0.04; break
    case 'unmarked':            score += 0.00; break
    case 'lyrics_version':      score -= 0.02; break
    case 'alternate_version':   score -= 0.02; break
    case 'live_performance':    score -= 0.05; break
    case 'remix_edit':          score -= 0.08; break
    case 'derivative':          score -= 0.15; break
  }

  return Math.max(0, Math.min(1, score))
}

// ═══════════════════════════════════════════════
// calculateCanonicalScore — old function used by resolveFromCandidates
// ═══════════════════════════════════════════════

export function calculateCanonicalScore(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string }
): number {
  let score = 0.40

  const deltaT = Math.abs(target.duration - candidate.duration)
  const annotationCat = getAnnotationCategory(candidate.title, candidate.channelType)

  // Channel type (0.00 to +0.30)
  if (candidate.channelType === 'verified_topic') {
    score += 0.30
  } else if (candidate.channelType === 'verified_artist') {
    score += 0.15
  }

  // Title purity (0.00 to +0.10)
  const artistPrefix = target.artist
  let titleAfterArtist = candidate.title
  const artistSepMatch = candidate.title.match(new RegExp(`^${escapeRegex(artistPrefix)}\\s*[-–—]\\s*(.+)`, 'i'))
  if (artistSepMatch) {
    titleAfterArtist = artistSepMatch[1]
  }
  const hasExtraAnnotations = /[\(\[{].+[\)\]}]/.test(titleAfterArtist)
  if (!hasExtraAnnotations) {
    score += 0.10
  }

  // Official annotation present (0.00 to +0.10)
  const hasOfficialAnnotation = /\(official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\)/i.test(candidate.title)
    || /\[official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\]/i.test(candidate.title)
    || /\(official\)/i.test(candidate.title)
    || /\[official\]/i.test(candidate.title)
  if (hasOfficialAnnotation) {
    score += 0.10
  }

  // Annotation category penalty (-0.30 to 0.00)
  switch (annotationCat) {
    case 'official_canonical':  score += 0.00; break
    case 'official_alternate':  score -= 0.03; break
    case 'unmarked':            score -= 0.05; break
    case 'lyrics_version':      score -= 0.05; break
    case 'alternate_version':   score -= 0.10; break
    case 'live_performance':    score -= 0.20; break
    case 'remix_edit':          score -= 0.30; break
    case 'derivative':          score -= 0.25; break
  }

  // Duration precision (0.00 to +0.10)
  if (deltaT <= 0) {
    score += 0.10
  } else if (deltaT <= 1) {
    score += 0.05
  }

  return Math.max(0, Math.min(1, score))
}

// ═══════════════════════════════════════════════
// rankByCanonicalness — old function preserved
// ═══════════════════════════════════════════════

export function rankByCanonicalness(
  target: { title: string; artist: string; duration: number },
  candidates: Array<{ baseScore: number; title: string; duration: number; channelType?: string }>
): Array<{ baseScore: number; canonicalScore: number; combinedScore: number }> {
  return candidates.map((c) => {
    let canonicalScore = 0

    const deltaT = Math.abs(target.duration - c.duration)
    const annotationCat = getAnnotationCategory(c.title, c.channelType)

    // Version marker penalty
    const markerPenalty = getVersionPenalty(annotationCat)
    canonicalScore -= markerPenalty

    // Channel type bonus
    if (c.channelType === 'verified_topic') {
      canonicalScore += 0.10
    } else if (c.channelType === 'verified_artist') {
      canonicalScore += 0.03
    } else {
      canonicalScore -= 0.02
    }

    // Title purity
    const artistPrefix = target.artist
    let titleAfterArtist = c.title
    const artistSepMatch = c.title.match(new RegExp(`^${escapeRegex(artistPrefix)}\\s*[-–—]\\s*(.+)`, 'i'))
    if (artistSepMatch) {
      titleAfterArtist = artistSepMatch[1]
    }
    const hasExtraAnnotations = /[\(\[{].+[\)\]}]/.test(titleAfterArtist)
    if (!hasExtraAnnotations) {
      canonicalScore += 0.08
    }

    // Duration precision
    if (deltaT <= 0) {
      canonicalScore += 0.04
    } else if (deltaT <= 1) {
      canonicalScore += 0.02
    }

    // Annotation category bonus/penalty
    switch (annotationCat) {
      case 'official_canonical':  canonicalScore += 0.06; break
      case 'unmarked':            canonicalScore += 0.00; break
      case 'lyrics_version':      canonicalScore -= 0.02; break
      case 'official_alternate':  canonicalScore -= 0.02; break
      case 'alternate_version':   canonicalScore -= 0.04; break
      case 'live_performance':    canonicalScore -= 0.08; break
      case 'remix_edit':          canonicalScore -= 0.12; break
      case 'derivative':          canonicalScore -= 0.15; break
    }

    return {
      baseScore: c.baseScore,
      canonicalScore,
      combinedScore: Math.max(0, Math.min(1, c.baseScore + canonicalScore)),
    }
  })
}

// ═══════════════════════════════════════════════
// titlesMatch — old internal function
// ═══════════════════════════════════════════════

function titlesMatch(targetTitle: string, candidateTitle: string): boolean {
  return compareTitles(targetTitle, candidateTitle) !== 'title_mismatch'
}

// ═══════════════════════════════════════════════
// resolveFromCandidates — old implementation preserved for backward compat
// ═══════════════════════════════════════════════

async function resolveFromCandidates(
  incomingTrack: SpotifyTrack,
  candidates: MockCandidate[],
  _fingerprintHash: string
): Promise<ResolvedMatchResult> {
  const DURATION_GATE_S = 2

  const scored = candidates.map((c) => {
    const score = calculateConfidence(
      { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
      { title: c.title, duration: c.duration, channelType: c.channelType }
    )

    return {
      id: c.youtubeId,
      title: c.title,
      artist: incomingTrack.artist,
      duration: c.duration,
      channelType: c.channelType,
      confidenceScore: score,
    }
  })

  // Strict filter: ±2s duration AND acceptable version
  const acceptable = scored.filter(
    (c) => Math.abs(c.duration - incomingTrack.duration) <= DURATION_GATE_S
      && isAcceptableVersion(c.title, c.channelType)
  )

  if (acceptable.length > 0) {
    const canonScored = acceptable.map((c) => ({
      ...c,
      canonicalScore: calculateCanonicalScore(
        { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
        { title: c.title, duration: c.duration, channelType: c.channelType }
      ),
    }))

    const titleMatched = canonScored.filter((c) =>
      titlesMatch(incomingTrack.title, c.title)
    )

    if (titleMatched.length > 0) {
      titleMatched.sort((a, b) => b.canonicalScore - a.canonicalScore)
      const bestCanon = titleMatched[0]
      return {
        id: bestCanon.id,
        title: bestCanon.title,
        artist: bestCanon.artist,
        duration: bestCanon.duration,
        thumbnailUrl: '',
        source: 'youtube',
        sourceId: bestCanon.id,
        confidenceScore: bestCanon.confidenceScore,
      }
    }
  }

  throw new Error(
    `No acceptable match for "${incomingTrack.artist} — ${incomingTrack.title}"` +
    ` (${scored.length} candidates, ${acceptable.length} within ±${DURATION_GATE_S}s & acceptable version)`
  )
}

// ═══════════════════════════════════════════════
// NEW resolveIdentity — 10-layer pipeline
// ═══════════════════════════════════════════════

async function resolveIdentity(incomingTrack: SpotifyTrack): Promise<Track> {
  // ── L1: Metadata Normalization ──
  const normalized = normalizeSpotifyMetadata(incomingTrack)

  // ── L2+L3: Search Strategy → Candidate Collection ──
  const tracks = await collectCandidates(incomingTrack, q => SearchEngine.search(q))

  if (tracks.length === 0) {
    throw new Error(
      `No match for "${incomingTrack.artist} — ${incomingTrack.title}" (no candidates)`
    )
  }

  // ── L4+L5: Candidate Normalization → Recording Classification ──
  const normCandidates: NormalizedCandidate[] = []
  for (const track of tracks) {
    const nc = normalizeTrackCandidate(track)
    nc.recordingType = classifyRecording(nc.rawTitle, nc.channelType, nc.channelVerified, nc.isTopic)
    normCandidates.push(nc)
  }

  // ── Old-style filtering (backward compat) ──
  const incomingMarker = detectVersionMarkers(incomingTrack.title)
  const isVariant = incomingMarker === 'remix_edit' || incomingMarker === 'alternate_version'
  const DURATION_GATE_S = isVariant ? 5 : 2
  const targetClean = cleanTrackTitle(incomingTrack.title).toLowerCase()

  // Fast-path: Topic channel with exact duration + exact title match
  for (const nc of normCandidates) {
    if (
      nc.isTopic &&
      Math.abs(nc.duration - incomingTrack.duration) <= 1 &&
      cleanTitle(nc.rawTitle).toLowerCase() === targetClean
    ) {
      const fastTrack = tracks.find(t => t.id === nc.videoId)
      if (fastTrack) return fastTrack
    }
  }

  // Filter by duration gate + acceptable version
  const filtered = normCandidates.filter(c => {
    if (Math.abs(c.duration - incomingTrack.duration) > DURATION_GATE_S) return false

    // Use old-style getAnnotationCategory for acceptable-version check
    // (backward compat: Audio Only → derivative, not unmarked)
    const cat = getAnnotationCategory(c.rawTitle, c.channelType)
    if (cat === 'official_canonical' || cat === 'official_alternate' || cat === 'unmarked' || cat === 'lyrics_version') {
      // 🔥 Reject candidates with (feat. ...) / (ft. ...) / (with ...) when the target
      // track has no featurings in its title or artist metadata. A YouTube video titled
      // "Song (feat. DifferentArtists)" is a different recording (remix, collab, cover)
      // that happens to share the same canonical title — e.g. "Shivers (feat. Jessi, SUNMI)"
      // should not match the original "Shivers" by Ed Sheeran.
      const targetHasFeaturing =
        /\((?:feat\.?|ft\.?|with)\s+.*?\)/i.test(normalized.rawTitle) ||
        normalized.featuring.length > 0
      const candidateHasFeat = /\((?:feat\.?|ft\.?|with)\s+.*?\)/i.test(c.rawTitle)
      if (candidateHasFeat && !targetHasFeaturing) return false

      return true
    }

    // For variant tracks, accept same-category matches
    if (isVariant && incomingMarker) return cat === incomingMarker

    return false
  })

  if (filtered.length === 0) {
    // No acceptable candidates — throw
    throw new Error(
      `No acceptable match for "${incomingTrack.artist} — ${incomingTrack.title}"` +
      ` (${normCandidates.length} candidates, ${filtered.length} within ±${DURATION_GATE_S}s & acceptable version)`
    )
  }

  // ── L7: Candidate Clustering ──
  const clusters = clusterCandidates(filtered)

  // ── L8: Identity Resolution (score all clusters, pick best) ──
  const identityResult = resolveBestIdentity(clusters, normalized)

  // Best candidate from the winning cluster
  const bestCandidate = identityResult.cluster.candidates[0]
  if (!bestCandidate) {
    throw new Error('Identity resolution produced empty cluster')
  }

  const originalTrack = tracks.find(t => t.id === bestCandidate.videoId)

  const result: Track = {
    id: bestCandidate.videoId,
    title: bestCandidate.rawTitle,
    artist: bestCandidate.uploader,
    duration: bestCandidate.duration,
    thumbnailUrl: originalTrack?.thumbnailUrl ?? `https://img.youtube.com/vi/${bestCandidate.videoId}/mqdefault.jpg`,
    source: 'youtube',
    sourceId: bestCandidate.videoId,
  }

  // Preserve channelType if available
  if (originalTrack?.channelType) {
    ;(result as any).channelType = originalTrack.channelType
  }

  return result
}

// ═══════════════════════════════════════════════
// TrackIdentityEngine Singleton
// ═══════════════════════════════════════════════

export const TrackIdentityEngine = {
  resolveFromCandidates,
  resolveIdentity,
  calculateConfidence,
  calculateCanonicalScore,
  getAnnotationCategory,
  detectVersionMarkers,
  getVersionPenalty,
  rankByCanonicalness,
  isAcceptableVersion,
}
