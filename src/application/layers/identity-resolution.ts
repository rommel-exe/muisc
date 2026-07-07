// ── Layer 8: Identity Resolution ──
import type { NormalizedMetadata, CandidateCluster, IdentityResult, NormalizedCandidate, RecordingClass } from '../types'
import { areRecordingClassesCompatible } from './recording-classification'
import { compareTitles } from '../title-identity-engine'

/**
 * Generic/short titles that occur across many artists.
 * These require stronger artist evidence before accepting a candidate.
 */
export const GENERIC_TITLES = new Set([
  'stay', 'home', 'hello', 'believer', 'enemy', 'monster',
  'alive', 'hero', 'lost', 'run', 'fire', 'broken',
])

/**
 * Extract the artist name from a candidate title that follows
 * "Artist - Song Title" format (separable prefix).
 * Returns the prefix before " — ", " – ", or " - ", lowercased and trimmed.
 * Returns null if no separator is found.
 */
export function extractArtistFromTitle(title: string): string | null {
  const match = title.match(/^(.+?)\s*[-–—]\s*(.+)/)
  if (match) return match[1].trim().toLowerCase()
  return null
}

/**
 * Check whether a single candidate has a contradictory artist.
 * A candidate is contradictory when:
 * 1. Its title has an "Artist - Song" prefix that names a different artist than the target.
 * 2. Its uploader is a specific channel (not generic) that doesn't match the target artist.
 *
 * Skips verified_topic channels — those are auto-generated and never contradictory.
 */
export function isCandidateContradictory(
  candidate: NormalizedCandidate,
  primaryArtist: string
): boolean {
  if (!primaryArtist) return false
  const primary = primaryArtist.toLowerCase()

  // Channel check 1: Topic channels are NOT automatically exempt. The uploader
  // name (minus " - Topic" suffix) must match or contain the primary artist.
  // e.g. "Imagine Dragons - Topic" matches "Imagine Dragons" → fine.
  //      "James Major - Topic" does NOT match "Imagine Dragons" → contradictory.
  if (candidate.channelType === 'verified_topic') {
    const topicArtist = candidate.uploader.toLowerCase().replace(/\s*[-–—]\s*topic\s*$/i, '').trim()
    if (topicArtist === primary || primary.includes(topicArtist) || topicArtist.includes(primary)) {
      return false // Correct Topic channel for this artist
    }
    return true // Wrong-artist Topic channel — contradictory
  }

  // Check 1: Title prefix contradicts
  const titleArtist = extractArtistFromTitle(candidate.rawTitle)
  let titlePrefixContradicts = false
  if (titleArtist) {
    const canonicalLower = candidate.canonicalTitle.toLowerCase()
    // Avoid flagging "Believer - James Major" where the prefix is the song title itself
    const prefixIsSongTitle =
      canonicalLower.includes(titleArtist) ||
      titleArtist.split(/\s+/).every(w => canonicalLower.includes(w))

    if (
      !prefixIsSongTitle &&
      !titleArtist.includes(primary) &&
      !primary.includes(titleArtist)
    ) {
      titlePrefixContradicts = true
    }
  }

  // Check 2: Uploader name doesn't match and looks like a specific channel
  const uploader = candidate.uploader.toLowerCase()
  if (!uploader.includes(primary) && !primary.includes(uploader)) {
    const genericTerms = ['vevo', 'official', 'music', 'records', 'topic', 'uploads', 'entertainment']
    const isGeneric = genericTerms.some(t => uploader.includes(t))
    const hasNameFormat = uploader.split(/\s+/).filter(w => w.length > 2).length >= 2

    if (hasNameFormat && !isGeneric) {
      return true
    }
  } else if (titlePrefixContradicts) {
    // Uploader matches primary — title is reversed "Song - Artist" format
    return false
  }

  if (titlePrefixContradicts) return true

  return false
}

/**
 * Check whether ANY candidate in a cluster has a contradictory artist.
 * Returns true only when ALL non-contradictory candidates (if any) also differ.
 */
export function hasContradictoryArtist(
  candidates: NormalizedCandidate[],
  primaryArtist: string
): boolean {
  if (!primaryArtist || candidates.length === 0) return false

  let contradictionFound = false
  let nonContradictoryFound = false

  for (const c of candidates) {
    if (isCandidateContradictory(c, primaryArtist)) {
      contradictionFound = true
    } else {
      nonContradictoryFound = true
    }
  }

  // Only return true if ALL candidates are contradictory
  // (If some match, the cluster still has valid candidates)
  return contradictionFound && !nonContradictoryFound
}

export interface ResolutionOptions {
  /** Duration tolerance in seconds for "exact match" (default: 2) */
  exactDurationTolerance?: number
  /** Duration tolerance for "approximate match" (default: 5) */
  approximateDurationTolerance?: number
  /** Whether to boost confidence for topic channels (default: true) */
  boostTopicChannels?: boolean
}

// ── Individual Score Functions ──

/**
 * Score how well the incoming title matches the cluster title.
 * Both arguments are already canonicalized — uses token equality
 * via compareTitles from title-identity-engine.
 * Returns 1.0 for exact token match, 0.0 for mismatch.
 */
export function scoreTitleMatch(incomingTitle: string, clusterTitle: string): number {
  const result = compareTitles(incomingTitle, clusterTitle)
  return result === 'title_mismatch' ? 0.0 : 1.0
}

/**
 * Score how well the incoming duration matches the candidate duration.
 * Within ±exactTolerance → 1.0, ±approxTolerance → 0.8, ±10s → 0.4, beyond → 0.0.
 */
export function scoreDurationMatch(
  incomingDuration: number,
  candidateDuration: number,
  exactTolerance?: number,
  approxTolerance?: number
): number {
  const exact = exactTolerance ?? 2
  const approx = approxTolerance ?? 5
  const diff = Math.abs(incomingDuration - candidateDuration)

  if (diff <= exact) return 1.0
  if (diff <= approx) return 0.8
  if (diff <= 10) return 0.4
  return 0.0
}

/**
 * Score artist match between incoming artists and cluster candidates.
 *
 * Scoring tiers:
 *   - Artist prefix in candidate title matches primary → 1.0  (Patch 7)
 *   - Primary artist matches uploader                         → 0.85
 *   - Primary artist in canonical title                       → 0.75
 *   - Primary artist found anywhere in raw title              → 0.70  (Patch 7)
 *   - Featuring artist match                                  → 0.55
 *   - No evidence of any artist                               → 0.0
 *   - ALL candidates have contradictory artist                → -0.75 (Patch 1+6)
 *
 * When some candidates are contradictory but others match, the best
 * non-contradictory score is returned — the cluster still has valid candidates.
 */
export function scoreArtistMatch(incomingArtists: string[], candidates: NormalizedCandidate[]): number {
  if (!incomingArtists?.length) return 1.0

  const primary = incomingArtists[0]?.toLowerCase() ?? ''
  if (!primary) return 1.0

  let bestScore = -10 // sentinel: no positive evidence found yet
  let anyContradiction = false
  let nonContradictoryNoEvidence = 0 // candidates that aren't contradictory but have no artist evidence

  for (const c of candidates) {
    const uploader = c.uploader.toLowerCase()
    const rawTitle = c.rawTitle.toLowerCase()
    const canonicalTitle = c.canonicalTitle.toLowerCase()
    const titleArtist = extractArtistFromTitle(c.rawTitle)

    // Skip contradictory candidates (different artist detected)
    if (isCandidateContradictory(c, primary)) {
      anyContradiction = true
      continue
    }

    // Patch 7: Artist prefix in title ("Imagine Dragons - Believer") = strongest signal
    if (titleArtist && (titleArtist.includes(primary) || primary.includes(titleArtist))) {
      return 1.0
    }

    // Primary artist matches uploader
    if (uploader.includes(primary) || primary.includes(uploader)) {
      bestScore = Math.max(bestScore, 0.85)
      continue
    }

    // Primary artist matches canonical title
    if (canonicalTitle.includes(primary)) {
      bestScore = Math.max(bestScore, 0.75)
      continue
    }

    // Patch 7b: Primary artist found anywhere in raw title
    if (rawTitle.includes(primary)) {
      bestScore = Math.max(bestScore, 0.70)
      continue
    }

    // Any featuring artist matches
    for (let i = 1; i < incomingArtists.length; i++) {
      const feat = incomingArtists[i].toLowerCase()
      if (uploader.includes(feat) || canonicalTitle.includes(feat) || rawTitle.includes(feat)) {
        bestScore = Math.max(bestScore, 0.55)
        continue
      }
    }

    nonContradictoryNoEvidence++
  }

  // Found at least one non-contradictory candidate with positive evidence
  if (bestScore > -10) return bestScore

  // All candidates are contradictory → heavy penalty (Patch 1+6)
  if (anyContradiction && nonContradictoryNoEvidence === 0) return -0.75

  // Mixed: some contradictory, others have no evidence → moderate penalty (Patch 2)
  // When the cluster contains candidates that positively identify a different artist,
  // the cluster should not be treated as neutral — the contradictory signal penalizes it.
  if (anyContradiction && nonContradictoryNoEvidence > 0) return -0.40

  // Channel-type bonuses (Patch 4): topic/verified channels get a positive signal
  // even without explicit artist evidence — YouTube auto-generated or verified official channels
  for (const c of candidates) {
    if (c.channelType === 'verified_topic' || c.isTopic) return 0.30
    if (c.channelType === 'verified_artist' || c.channelVerified) return 0.25
  }

  // No evidence either way
  return 0.0
}

/**
 * Score recording class compatibility.
 * When expectedClass is undefined (unknown), returns 1.0 (neutral).
 * Otherwise uses areRecordingClassesCompatible from Layer 5.
 */
export function scoreRecordingClassMatch(expectedClass: RecordingClass | undefined, candidateClass: RecordingClass): number {
  if (!expectedClass) return 1.0
  if (areRecordingClassesCompatible(expectedClass, candidateClass)) return 1.0
  return 0.0
}

/**
 * Score release/source match between incoming metadata and cluster candidates.
 * Album in candidate title/uploader → 0.9, year proximity ±1 → 0.6,
 * conflicting year data → 0.2, no data → 0.5 (neutral).
 */
export function scoreReleaseMatch(incoming: NormalizedMetadata, candidates: NormalizedCandidate[]): number {
  const hasYear = incoming.releaseYear != null
  const years = candidates.map(c => c.year).filter((y): y is number => y != null)

  // Album match — check if album name appears in any candidate title or uploader
  if (incoming.album && incoming.album.length > 0) {
    const albumLower = incoming.album.toLowerCase()
    for (const c of candidates) {
      if (c.canonicalTitle.toLowerCase().includes(albumLower) ||
          c.uploader.toLowerCase().includes(albumLower)) {
        return 0.9
      }
    }
  }

  // Year proximity — candidate year within ±1 year of incoming release year
  if (hasYear && years.length > 0) {
    for (const y of years) {
      if (Math.abs(y - incoming.releaseYear!) <= 1) return 0.6
    }
    // Year data exists but none match — conflicting
    return 0.2
  }

  return 0.5 // Neutral — no data to evaluate
}

// ── Confidence Calculation ──

/**
 * Combine individual question scores into a raw confidence (0.0–1.0).
 *
 * Normal weight distribution: title 30%, class 20%, duration 25%, artist 20%, release 5%.
 *
 * For short titles (≤2 tokens), artist weight DOUBLES and other weights compress
 * because a short generic title like "Believer" or "Stay" could match many artists —
 * artist evidence must carry more weight. (Patch 5)
 *
 * A negative artistScore (from contradictory-artist detection) is amplified by
 * the higher artist weight, ensuring wrong-artist candidates rank lower.
 */
export function combineConfidence(
  titleScore: number,
  classScore: number,
  durationScore: number,
  artistScore: number,
  releaseScore: number,
  titleTokenCount?: number
): number {
  // Short titles (≤2 tokens): artist matters more, release matters less
  if (titleTokenCount !== undefined && titleTokenCount <= 2) {
    return (
      titleScore * 0.25 +
      classScore * 0.15 +
      durationScore * 0.20 +
      artistScore * 0.40 +
      releaseScore * 0.00
    )
  }
  // Normal: balanced weights
  return (
    titleScore * 0.30 +
    classScore * 0.20 +
    durationScore * 0.25 +
    artistScore * 0.20 +
    releaseScore * 0.05
  )
}

/**
 * Transform raw confidence to a calibrated commercial-grade percentage.
 * Maps raw ranges to specific confidence values the engine is certain about.
 */
export function transformConfidence(raw: number): number {
  if (raw >= 0.95) return 0.99
  if (raw >= 0.85) return 0.95
  if (raw >= 0.75) return 0.88
  if (raw >= 0.65) return 0.83
  if (raw >= 0.55) return 0.71
  if (raw >= 0.40) return 0.61
  return 0.35
}

/**
 * Get a human-readable confidence label from a transformed confidence value.
 * ≥0.83 → accepted, ≥0.61 → manual_review, <0.61 → rejected.
 */
export function getConfidenceLabel(confidence: number): 'accepted' | 'manual_review' | 'rejected' {
  if (confidence >= 0.83) return 'accepted'
  if (confidence >= 0.61) return 'manual_review'
  return 'rejected'
}

// ── Main Identity Resolution ──

/**
 * Resolve identity for a single cluster against incoming metadata.
 * Scores each of the 5 identity questions, combines them with weights,
 * transforms to a calibrated confidence, and returns an IdentityResult.
 */
export function resolveIdentityForCluster(
  cluster: CandidateCluster,
  incoming: NormalizedMetadata,
  options?: ResolutionOptions
): IdentityResult {
  const opts = {
    exactDurationTolerance: 2,
    approximateDurationTolerance: 5,
    boostTopicChannels: true,
    ...options,
  }

  // Best candidate is the first one — clustering sorts by metadataQuality desc
  const best = cluster.candidates[0]

  // Score each identity question
  const titleScore = scoreTitleMatch(incoming.canonicalTitle, cluster.label)
  const classScore = scoreRecordingClassMatch(undefined, cluster.recordingClass)
  const durationScore = scoreDurationMatch(
    incoming.duration,
    best.duration,
    opts.exactDurationTolerance,
    opts.approximateDurationTolerance,
  )
  const artistScore = scoreArtistMatch(incoming.artists, cluster.candidates)
  const releaseScore = scoreReleaseMatch(incoming, cluster.candidates)

  // Patch 3: Generic titles need stronger artist evidence.
  // If the incoming title is a short generic word (e.g. "Believer", "Stay")
  // and artist evidence is weak (<0.6, i.e. no uploader or title match),
  // apply a penalty — it's likely a wrong-artist upload.
  // Penalty is reduced when other signals (title + duration) are strong,
  // to avoid rejecting correct-but-low-evidence matches for obscure artists. (Bug C)
  const tokenCount = incoming.canonicalTitle.split(/\s+/).filter(Boolean).length
  const isGenericTitle = tokenCount <= 2 && GENERIC_TITLES.has(incoming.canonicalTitle.toLowerCase())
  const genericPenalty = isGenericTitle && artistScore < 0.6
    ? (titleScore >= 0.9 && durationScore >= 0.8 ? 0.15 : 0.30)
    : 0
  const effectiveArtistScore = genericPenalty > 0 ? artistScore - genericPenalty : artistScore

  // Combine and transform (Patch 5: short titles get doubled artist weight)
  const raw = combineConfidence(titleScore, classScore, durationScore, effectiveArtistScore, releaseScore, tokenCount)
  const confidence = transformConfidence(raw)
  const confidenceLabel = getConfidenceLabel(confidence)

  return {
    confidence,
    confidenceLabel,
    cluster,
    matchedTitle: titleScore >= 0.9,
    matchedDuration: durationScore >= 0.8,
    matchedArtist: artistScore >= 0.6,
    matchedRecordingClass: classScore >= 1.0,
  }
}

/**
 * Resolve the single best identity from multiple candidate clusters.
 * Evaluates each cluster independently and returns the highest-confidence result.
 * Throws if the clusters array is empty.
 */
export function resolveBestIdentity(
  clusters: CandidateCluster[],
  incoming: NormalizedMetadata,
  options?: ResolutionOptions
): IdentityResult {
  if (clusters.length === 0) {
    throw new Error('Cannot resolve identity: clusters array is empty')
  }

  let best: IdentityResult | null = null

  for (const cluster of clusters) {
    const result = resolveIdentityForCluster(cluster, incoming, options)
    if (!best || result.confidence > best.confidence) {
      best = result
    }
  }

  return best!
}
