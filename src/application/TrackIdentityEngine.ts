import { SearchEngine, cleanTitle, cleanTrackTitle } from './SearchEngine'
import type { Track } from '../shared/types'

// ── Types ──

interface SpotifyTrack {
  title: string
  artist: string
  duration: number
  album?: string
  explicit?: boolean
}

// ── Unicode Normalization ──

/**
 * Normalize Unicode characters for matching: lowercases, NFD-decomposes
 * (splits accented chars into base + combining), then strips combining marks.
 * This lets "JAŸ-Z" match "Jay-Z", "Beyoncé" match "Beyonce", etc.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .replace(/[^a-z0-9\s\-'._]/g, '') // keep only letters, digits, basic punctuation
    .trim()
}

// ── Search Strategies ──

/**
 * Generate multiple search queries for a track, tried in order until
 * a candidate meets the confidence threshold.
 *
 * Exported so tests can use the same strategy list.
 */
export function generateSearchQueries(track: SpotifyTrack): string[] {
  const { artist, title, explicit } = track
  const clean = cleanTrackTitle(title)
  const queries: string[] = [
    // 1. Standard: artist + cleaned title
    `${artist} ${clean}`,
    // 2. With "official" to surface official uploads
    `${artist} ${clean} official`,
  ]

  // 3. For explicit tracks, try explicit-specific search
  if (explicit) {
    queries.push(`${artist} ${clean} explicit`)
  }

  // 4. Original title (with - Remix etc.) — important for variant versions
  if (title !== clean) {
    queries.push(`${artist} ${title}`)
  }

  // 5. If the original title has version markers (Remix, Radio Edit, etc.),
  // also try searching with the version keyword appended to the clean title.
  // This catches tracks where YouTube has the remix upload separately.
  const hasRemixMarker = /[-–—]\s*(.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic|Bonus\s+Track)\s*$/i.test(title)
    || /\((.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*\)/i.test(title)
  if (hasRemixMarker) {
    queries.push(`${artist} ${clean} remix audio`)
  }

  // 6. Try with the parenthetical version keyword (e.g. "Taylor's Version")
  // if the title has parenthetical suffixes beyond just annotations
  const parenMatch = title.match(/\(([^)]+)\)/)
  if (parenMatch && !clean.includes(parenMatch[1].toLowerCase().trim())) {
    const parenContent = parenMatch[1].trim()
    queries.push(`${artist} ${clean} ${parenContent}`)
  }

  // 7. Topic channel fallback — auto-generated YouTube Music uploads
  queries.push(`${artist} ${clean} topic`)

  // 8. Last-resort: just the raw title alone (for titles that Innertube search
  //    sometimes misses with artist prefix, like "Castle on the Hill")
  if (clean.length > 3) {
    queries.push(clean)
  }

  // 9. Raw artist + raw title (no cleanup)
  queries.push(`${artist} ${title}`)

  // Deduplicate while preserving order
  return [...new Set(queries)]
}

// ── Annotation Category ──

type AnnotationCategory = 'official_canonical' | 'official_alternate' | 'remix_edit' | 'live_performance' | 'alternate_version' | 'derivative' | 'unmarked'

// ── Version Marker Detection ──

/**
 * Version markers detected in RAW YouTube titles that indicate a recording
 * is NOT the canonical/original version of a track.
 *
 * Markers are checked in priority order — the FIRST match wins. This ensures
 * that ambiguous titles like "Song (Live Remix)" are classified as remix_edit
 * (the more significant alteration) rather than live_performance.
 *
 * Each entry maps a regex pattern to the AnnotationCategory it implies.
 */
interface VersionMarkerEntry {
  pattern: RegExp
  category: AnnotationCategory
  description: string
}

const VERSION_MARKERS: VersionMarkerEntry[] = [
  // ── Remix/Bootleg (most severe — definitively NOT the original) ──
  {
    pattern: /\b(Remix|Bootleg)\b/i,
    category: 'remix_edit',
    description: 'Remix or bootleg — alternative version by another producer',
  },
  // ── Nightcore / Sped Up (pitched-up fan edits) ──
  {
    pattern: /\b(Nightcore|Sped\s*Up)\b/i,
    category: 'derivative',
    description: 'Pitched-up fan edit — not the original recording',
  },
  // ── Slowed / Reverb (pitch/tempo modified) ──
  {
    pattern: /\b(Slowed|Reverb)\b/i,
    category: 'derivative',
    description: 'Tempo or pitch modified version',
  },
  // ── Loop (extended looped version) ──
  {
    pattern: /\b(Loop|10\s*Hours?|1\s*Hour)\b/i,
    category: 'derivative',
    description: 'Looped or extended duration version',
  },
  // ── Radio Edit / Extended Mix / Video Edit ──
  {
    pattern: /\b(Radio\s*Edit|Extended\s*(Mix|Version)|Video\s*Edit|Club\s*Mix|Dub\s*Mix|Original\s*Mix)\b/i,
    category: 'remix_edit',
    description: 'Edited version for radio, extended for clubs, or alternative mix',
  },
  // ── Live performance markers ──
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
  // ── Alternate version markers (Taylor's Version, Anniversary, Re-recorded) ──
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
  // ── Teaser / Preview (short snippet, not full track) ──
  {
    pattern: /\b(Teaser|Preview|Snippet)\b/i,
    category: 'alternate_version',
    description: 'Short preview or teaser — not the full track',
  },
  // ── Derivative (lyrics, instrumental, cover, karaoke, audio-only) ──
  {
    pattern: /\b(Lyrics?\s*(Video)?)\b/i,
    category: 'derivative',
    description: 'Lyrics video — not the actual recording',
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
]

/**
 * Detect version markers in a RAW YouTube title.
 * Returns the annotation category and severity, or null if no marker matches.
 * The FIRST matching marker wins (priority order).
 */
export function detectVersionMarkers(rawTitle: string): AnnotationCategory | null {
  for (const entry of VERSION_MARKERS) {
    if (entry.pattern.test(rawTitle)) {
      return entry.category
    }
  }
  return null
}

/**
 * Get the version-marker penalty for a given annotation category.
 * This is the "distance from canonical" — higher magnitude = farther from original.
 * Used by rankByCanonicalness as a secondary scoring signal.
 */
export function getVersionPenalty(category: AnnotationCategory): number {
  switch (category) {
    case 'remix_edit':          return 0.25  // Definitively not the original
    case 'live_performance':    return 0.20  // Live alter ego of the track
    case 'alternate_version':   return 0.10  // Remaster/re-record — sonically different
    case 'derivative':          return 0.20  // Lyrics/cover — not the original at all
    case 'official_alternate':  return 0.03  // Slight chance it's not canonical
    default:                    return 0     // No penalty
  }
}

/**
 * Classify a YouTube video's annotation type by examining its raw title
 * (before any cleanup) and channel type.
 *
 * This is the tiebreaker that lets us distinguish "Eminem - Without Me
 * (Official Video)" from "Eminem - Without Me (Remix)" — both clean to
 * "Without Me", but their raw titles tell different stories.
 *
 * Detection order (FIRST match wins):
 *   1. Version markers (remix, live, edit, etc.) — checked against raw title
 *   2. Official signals (official annotations, topic/verified channels)
 *   3. Derivative signals (explicit lyrics/cover/karaoke not caught by version markers)
 *   4. Default: unmarked
 */
export function getAnnotationCategory(rawTitle: string, channelType?: string): AnnotationCategory {
  // ── Step 1: Version marker check (highest priority) ──
  // If the raw title contains markers like "Remix", "Live", "Edit", etc.,
  // classify by the marker regardless of channel type.
  // This ensures "Song (Remix)" on a verified_artist channel is still
  // classified as remix_edit, not official_canonical.
  const marker = detectVersionMarkers(rawTitle)
  if (marker) return marker

  // ── Step 2: Official signals ──
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
    // Verified artist without version markers or official annotation.
    // Check for parenthetical qualifiers suggesting alternate version
    // (e.g. "Song (Audio)", "Song (HD)", "Song (Visualizer)").
    // Skip feat./with/& markers — standard collab versions.
    const parenMatches = rawTitle.match(/\(([^)]+)\)/g)
    if (parenMatches && parenMatches.length > 0) {
      const hasFeatureMarker = parenMatches.some(p => /\b(feat\.?|with|&|and)\b/i.test(p))
      if (!hasFeatureMarker) {
        return 'official_alternate'
      }
    }
    return 'official_canonical'
  }

  // ── Step 3: Derivative signals (catch any missed by version markers) ──
  const lower = rawTitle.toLowerCase()
  const hasDerivative = /\b(cover|tribute|karaoke|acapella)\b/i.test(lower)
  if (hasDerivative) return 'derivative'

  return 'unmarked'
}

/**
 * Check whether a candidate's annotation category is acceptable for matching.
 *
 * Acceptable: official_canonical, official_alternate, unmarked
 * Rejected: remix_edit, live_performance, derivative, alternate_version
 *
 * "alternate_version" is rejected because remasters/re-recordings/bonus tracks
 * are sonically different from the original studio recording.
 */
export function isAcceptableVersion(rawTitle: string, channelType?: string): boolean {
  const category = getAnnotationCategory(rawTitle, channelType)
  return category === 'official_canonical'
    || category === 'official_alternate'
    || category === 'unmarked'
}

// ── Confidence Scoring ──

/**
 * Calculate how closely a candidate result matches the target track.
 * Returns a confidence score between 0.0 and 1.0.
 *
 * PHASE 1: Duration is the primary gatekeeper with graduated scoring.
 * PHASE 2: After duration filtering, rankByCanonicalness provides
 * sophisticated post-duration sorting.
 *
 * Scoring breakdown:
 *   Duration (graduated):   0.00 - 0.50   (primary gate)
 *   Title match:            0.00 - 0.20   (confirmatory)
 *   Artist/channel:         0.00 - 0.20   (confirmatory)
 *   Annotation quality:     -0.15 to +0.10 (contextual)
 *   ─────────────────────────────
 *   Max possible:           1.00
 *   Threshold:              0.65
 */
export function calculateConfidence(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string }
): number {
  let score = 0

  const deltaT = Math.abs(target.duration - candidate.duration)

  // ═══ 1. Graduated Duration Score (gatekeeper — 0.00 to 0.50) ═══
  //
  // Graduated scoring: exact matches get the maximum, small deviations
  // get partial credit, but anything beyond 5s gets zero from duration.
  // This is more nuanced than the old ±1s binary gate — a remix that's
  // 2s off from the original still gets partial duration credit, but rankByCanonicalness
  // will rank the exact-match official version above it.
  if (deltaT <= 0) {
    score += 0.50  // Exact match — the same recording
  } else if (deltaT <= 1) {
    score += 0.40  // Within 1s — very likely the same recording
  } else if (deltaT <= 2) {
    score += 0.25  // Within 2s — could be a slightly different master
  } else if (deltaT <= 3) {
    score += 0.15  // Within 3s — possibly a different version
  } else if (deltaT <= 5) {
    score += 0.05  // Within 5s — marginal chance
  }

  // ═══ 2. Title Match (0.00 to 0.20) ═══
  const targetTitle = cleanTrackTitle(target.title).toLowerCase()
  const candidateTitle = cleanTitle(candidate.title).toLowerCase()
  const targetNorm = normalizeForMatch(target.title)
  const candidateNorm = normalizeForMatch(candidate.title)

  if (targetTitle === candidateTitle) {
    score += 0.20
  } else if (targetNorm === candidateNorm) {
    score += 0.18
  } else if (targetTitle.includes(candidateTitle) || candidateTitle.includes(targetTitle)) {
    score += 0.15
  } else if (targetNorm.includes(candidateNorm) || candidateNorm.includes(targetNorm)) {
    score += 0.12
  } else {
    const targetWords = targetNorm.split(/\s+/).filter(Boolean)
    const candidateWords = candidateNorm.split(/\s+/).filter(Boolean)
    const commonWords = targetWords.filter(w => candidateWords.includes(w))
    if (commonWords.length > 0) {
      const overlap = commonWords.length / Math.max(targetWords.length, candidateWords.length)
      score += 0.10 * Math.min(1, overlap)
    }
  }

  // ═══ 3. Artist / Channel Match (0.00 to 0.20) ═══
  const targetArtist = normalizeForMatch(target.artist)
  const candidateLower = normalizeForMatch(candidate.title)

  if (candidate.channelType === 'verified_topic') {
    score += 0.20
  } else if (candidateLower.includes(targetArtist)) {
    score += 0.15
  } else if (targetArtist) {
    const artistParts = targetArtist.split(/\s+/).filter(Boolean)
    const artistMatch = artistParts.filter(p => candidateLower.includes(p)).length
    if (artistMatch > 0) {
      score += 0.10 * (artistMatch / artistParts.length)
    }
  }

  // ═══ 4. Annotation Quality Score (contextual: -0.15 to +0.10) ═══
  const annotationCat = getAnnotationCategory(candidate.title, candidate.channelType)
  switch (annotationCat) {
    case 'official_canonical':  score += 0.10; break
    case 'official_alternate':  score += 0.04; break
    case 'unmarked':            score += 0.00; break
    case 'alternate_version':   score -= 0.02; break
    case 'live_performance':    score -= 0.05; break
    case 'remix_edit':          score -= 0.08; break
    case 'derivative':          score -= 0.15; break
  }

  return Math.max(0, Math.min(1, score))
}

// ── Canonical Ranking (Phase 2 Post-Duration Sorting) ──

/**
 * Calculate how "canonical" a candidate is — i.e. how close to the original
 * studio recording. This is the Phase 2 sorting function applied AFTER
 * duration-based confidence scoring has filtered candidates.
 *
 * The canonical score is ADDITIVE to the base confidence score for RANKING
 * purposes only. It ranges from -0.4 to +0.4.
 *
 * Factors:
 *   Version marker penalty:     -0.25 to 0.00   (remix/live/edit detected in raw title)
 *   Channel type bonus:          -0.02 to +0.10  (topic > verified > user)
 *   Title purity:                0.00 to +0.08   (no extra annotations in raw title)
 *   Duration precision:          0.00 to +0.04   (exact Δt=0 is best)
 *   Annotation category:         -0.15 to +0.06  (official_canonical > unmarked > derivative)
 *   ──────────────────────────────────
 *   Total range:                 -0.40 to +0.40
 */
export function rankByCanonicalness(
  target: { title: string; artist: string; duration: number },
  candidates: Array<{ baseScore: number; title: string; duration: number; channelType?: string }>
): Array<{ baseScore: number; canonicalScore: number; combinedScore: number }> {
  return candidates.map((c) => {
    let canonicalScore = 0

    const deltaT = Math.abs(target.duration - c.duration)
    const annotationCat = getAnnotationCategory(c.title, c.channelType)

    // 1. Version marker penalty (-0.25 to 0.00)
    const markerPenalty = getVersionPenalty(annotationCat)
    canonicalScore -= markerPenalty

    // 2. Channel type bonus (-0.02 to +0.10)
    if (c.channelType === 'verified_topic') {
      canonicalScore += 0.10
    } else if (c.channelType === 'verified_artist') {
      canonicalScore += 0.03
    } else {
      canonicalScore -= 0.02
    }

    // 3. Title purity (0.00 to +0.08)
    // If the raw title, after stripping "Artist - " prefix, has NO remaining
    // annotation markers (parentheticals, brackets), it's "pure" — just the
    // track name. Pure titles are more likely canonical.
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

    // 4. Duration precision (0.00 to +0.04)
    if (deltaT <= 0) {
      canonicalScore += 0.04
    } else if (deltaT <= 1) {
      canonicalScore += 0.02
    }

    // 5. Annotation category bonus/penalty (-0.15 to +0.06)
    switch (annotationCat) {
      case 'official_canonical':  canonicalScore += 0.06; break
      case 'unmarked':            canonicalScore += 0.00; break
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

/**
 * Escape special regex characters in a string for use in RegExp constructor.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Check whether a target title (from Spotify/incoming track) and a YouTube
 * candidate title refer to the same track after normalization.
 *
 * Both annotations ("(Official Video)", "(Remix)") and artist prefixes
 * ("Artist - ") are stripped before comparing. Unicode is NFD-normalized
 * so "Beyoncé" matches "Beyonce" and "JAŸ-Z" matches "Jay-Z".
 */
function titlesMatch(targetTitle: string, candidateTitle: string): boolean {
  const targetClean = cleanTrackTitle(targetTitle).toLowerCase()
  const candidateClean = cleanTitle(candidateTitle).toLowerCase()
  const targetNorm = normalizeForMatch(targetTitle)
  const candidateNorm = normalizeForMatch(candidateTitle)

  return targetClean === candidateClean
    || targetNorm === candidateNorm
    || targetClean.includes(candidateClean)
    || candidateClean.includes(targetClean)
}

// ── Canonical Score (Phase 1 Primary Ranking) ──

/**
 * Score how "canonical" a candidate is — how close to the original studio recording.
 * This is a 0.0–1.0 primary ranking score used AFTER strict duration gating.
 *
 * Unlike rankByCanonicalness (which produces an additive -0.4 to +0.4 bonus),
 * this function produces a standalone 0.0–1.0 score, making it suitable as
 * the PRIMARY differentiator among duration-gated candidates.
 *
 * Factors:
 *   Channel type:         0.00 to +0.30  (topic > verified > user)
 *   Title purity:         0.00 to +0.10  (no extra annotations in raw title)
 *   Official annotation:  0.00 to +0.10  (explicit "Official" keyword in title)
 *   Category penalty:    -0.30 to +0.00  (remix/live/edit/derivative penalty)
 *   Duration precision:   0.00 to +0.10  (exact Δt=0 is best)
 *   Base:                 0.40
 *   ──────────────────────────────
 *   Total range:          0.00 to 1.00
 */
export function calculateCanonicalScore(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string }
): number {
  let score = 0.40

  const deltaT = Math.abs(target.duration - candidate.duration)
  const annotationCat = getAnnotationCategory(candidate.title, candidate.channelType)

  // 1. Channel type (0.00 to +0.30)
  if (candidate.channelType === 'verified_topic') {
    score += 0.30
  } else if (candidate.channelType === 'verified_artist') {
    score += 0.15
  }

  // 2. Title purity (0.00 to +0.10)
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

  // 3. Official annotation present (0.00 to +0.10)
  const hasOfficialAnnotation = /\(official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\)/i.test(candidate.title)
    || /\[official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\]/i.test(candidate.title)
    || /\(official\)/i.test(candidate.title)
    || /\[official\]/i.test(candidate.title)
  if (hasOfficialAnnotation) {
    score += 0.10
  }

  // 4. Annotation category penalty (-0.30 to 0.00)
  switch (annotationCat) {
    case 'official_canonical':  score += 0.00; break
    case 'official_alternate':  score -= 0.03; break
    case 'unmarked':            score -= 0.05; break
    case 'alternate_version':   score -= 0.10; break
    case 'live_performance':    score -= 0.20; break
    case 'remix_edit':          score -= 0.30; break
    case 'derivative':          score -= 0.25; break
  }

  // 5. Duration precision (0.00 to +0.10)
  if (deltaT <= 0) {
    score += 0.10
  } else if (deltaT <= 1) {
    score += 0.05
  }

  return Math.max(0, Math.min(1, score))
}

// ── Resolve from Candidate Pool ──

interface ResolvedMatchResult {
  id: string
  title: string
  artist: string
  duration: number
  thumbnailUrl: string
  source: string
  sourceId: string
  confidenceScore: number
}

interface MockCandidate {
  youtubeId: string
  title: string
  duration: number
  channelType: string
  fingerprintHash: string
}

/**
 * Resolve a Spotify track to the best YouTube match from a pool of candidates.
 * Used in tests with mock search results; in production the pool comes from SearchEngine.
 *
 * STRICT MATCHING:
 *   - Duration must be within ±2s (absolute gate, no fallback)
 *   - Version must be acceptable (official_canonical, official_alternate, or unmarked)
 *   - Remixes, live performances, covers, derivatives are always rejected
 *   - Among acceptable candidates, canonical score is the primary differentiator
 */
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

      if (bestCanon.canonicalScore >= 0.60 && bestCanon.confidenceScore >= 0.50) {
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

      if (bestCanon.canonicalScore >= 0.50 && bestCanon.confidenceScore >= 0.65) {
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
  }

  throw new Error(
    `No acceptable match for "${incomingTrack.artist} — ${incomingTrack.title}"` +
    ` (${scored.length} candidates, ${acceptable.length} within ±2s & acceptable version)`
  )
}

/**
 * Search YouTube and try multiple query strategies until a match is found.
 *
 * STRICT MATCHING:
 *   Fast-path: Topic channel candidate with exact duration AND exact title
 *              match — return immediately (canonical YouTube Music upload).
 *   Phase 1:   Strict ±2s duration gate + acceptable version filter.
 *              Only official_canonical, official_alternate, or unmarked pass.
 *              Remixes, live, covers, derivatives are always rejected.
 *   No fallback: If no candidates pass both gates, throw.
 *
 * @param incomingTrack - The Spotify track to match
 * @param threshold - Minimum confidence score (0-1). Default 0.65.
 */
async function resolveIdentity(incomingTrack: SpotifyTrack, threshold = 0.65): Promise<Track> {
  const queries = generateSearchQueries(incomingTrack)
  const seen = new Set<string>()
  const allCandidates: Array<{ track: Track; score: number }> = []

  for (const query of queries) {
    const results = await SearchEngine.search(query)
    if (!results || results.length === 0) continue

    for (const track of results) {
      if (seen.has(track.id)) continue
      seen.add(track.id)

      const score = calculateConfidence(
        { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
        { title: track.title, duration: track.duration, channelType: track.channelType }
      )
      allCandidates.push({ track, score })
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      `No match for "${incomingTrack.artist} — ${incomingTrack.title}" (no candidates)`
    )
  }

  // Fast-path: Topic channel with exact duration + exact title match
  // This is always the canonical YouTube Music auto-upload.
  const targetClean = cleanTrackTitle(incomingTrack.title).toLowerCase()
  for (const c of allCandidates) {
    if (
      c.track.channelType === 'verified_topic' &&
      Math.abs(c.track.duration - incomingTrack.duration) <= 1 &&
      cleanTitle(c.track.title).toLowerCase() === targetClean
    ) {
      return c.track
    }
  }

  // Strict filter: ±2s duration AND acceptable version
  const DURATION_GATE_S = 2
  const acceptable = allCandidates.filter(
    (c) => Math.abs(c.track.duration - incomingTrack.duration) <= DURATION_GATE_S
      && isAcceptableVersion(c.track.title, c.track.channelType)
  )

  if (acceptable.length > 0) {
    const canonScored = acceptable.map((c) => ({
      track: c.track,
      baseScore: c.score,
      canonicalScore: calculateCanonicalScore(
        { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
        { title: c.track.title, duration: c.track.duration, channelType: c.track.channelType }
      ),
    }))

    const titleMatched = canonScored.filter((c) =>
      titlesMatch(incomingTrack.title, c.track.title)
    )

    if (titleMatched.length > 0) {
      titleMatched.sort((a, b) => b.canonicalScore - a.canonicalScore)
      const bestCanon = titleMatched[0]

      if (bestCanon.canonicalScore >= 0.60 && bestCanon.baseScore >= 0.50) {
        return bestCanon.track
      }

      if (bestCanon.canonicalScore >= 0.50 && bestCanon.baseScore >= threshold) {
        return bestCanon.track
      }
    }
  }

  throw new Error(
    `No acceptable match for "${incomingTrack.artist} — ${incomingTrack.title}"` +
    ` (${allCandidates.length} candidates, ${acceptable.length} within ±2s & acceptable version)`
  )
}

// ── Exported Singleton ──

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
