// ── Layer 7: Candidate Clustering ──
import type { NormalizedCandidate, CandidateCluster, RecordingClass } from '../types'
import { areRecordingClassesCompatible, getRecordingClassPriority } from './recording-classification'
import { extractArtistFromTitle } from './identity-resolution'

// ── ClusteringOptions ──

export interface ClusteringOptions {
  /** Duration tolerance in seconds for same-recording determination (default: 3) */
  durationTolerance?: number
  /** Whether to split variant versions into separate clusters (default: true) */
  splitVariants?: boolean
  /** Minimum title similarity ratio (0-1) to consider same recording (default: 0.7) */
  titleSimilarityThreshold?: number
}

// ── Constants ──

const DEFAULT_OPTIONS: Required<ClusteringOptions> = {
  durationTolerance: 3,
  splitVariants: true,
  titleSimilarityThreshold: 0.7,
}

/** Recording classes that represent variant/alternate versions of a recording */
const VARIANT_CLASSES: readonly RecordingClass[] = [
  'acoustic', 'live', 'performance', 'remix', 'cover', 'instrumental',
  'demo', 'radio_edit', 'extended', 'nightcore', 'speed_up', 'slowed',
  'mashup', 'remaster', 'deluxe', 'anniversary', 'reaction',
]

// ── Word overlap ──

/**
 * Calculate the ratio of shared words between two title strings.
 * 1.0 = identical word set, 0.0 = no words in common.
 */
export function calculateWordOverlap(title1: string, title2: string): number {
  const words1 = title1.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  const words2 = title2.toLowerCase().split(/\s+/).filter(w => w.length > 0)

  if (words1.length === 0 && words2.length === 0) return 1
  if (words1.length === 0 || words2.length === 0) return 0

  const set2 = new Set(words2)
  const shared = words1.filter(w => set2.has(w)).length

  return shared / Math.max(words1.length, words2.length)
}

// ── Artist helpers ──

/** Extract the best artist hint from a candidate (raw title prefix → uploader fallback) */
function getCandidateArtist(candidate: NormalizedCandidate): string {
  const titleArtist = extractArtistFromTitle(candidate.rawTitle)
  if (titleArtist) return titleArtist
  return candidate.uploader.toLowerCase()
}

/** Check if two candidates share the same artist */
function artistsMatch(a: NormalizedCandidate, b: NormalizedCandidate): boolean {
  const artistA = getCandidateArtist(a)
  const artistB = getCandidateArtist(b)
  if (!artistA || !artistB) return true // missing data — don't gate on it
  return artistA.includes(artistB) || artistB.includes(artistA)
}

// ── Recording class helpers ──

function isVariantClass(rc: RecordingClass): boolean {
  return VARIANT_CLASSES.includes(rc)
}

/** Bidirectional recording-class compatibility check */
function clusterClassesCompatible(a: RecordingClass, b: RecordingClass): boolean {
  return areRecordingClassesCompatible(a, b) || areRecordingClassesCompatible(b, a)
}

// ── Cluster membership ──

/**
 * Check whether a candidate belongs to an existing cluster.
 * Implements the 4-check greedy clustering algorithm.
 */
export function belongsToCluster(
  candidate: NormalizedCandidate,
  cluster: CandidateCluster,
  options?: ClusteringOptions
): boolean {
  const opts: Required<ClusteringOptions> = { ...DEFAULT_OPTIONS, ...options }
  const seed = cluster.candidates[0]

  // Check 1: Title similarity
  const titleOverlap = calculateWordOverlap(candidate.canonicalTitle, seed.canonicalTitle)
  if (titleOverlap < opts.titleSimilarityThreshold) return false

  // Check 2: Duration match (relaxed for variant classes)
  const durationDiff = Math.abs(candidate.duration - seed.duration)
  const tolerance = isVariantClass(candidate.recordingType) || isVariantClass(seed.recordingType)
    ? opts.durationTolerance * 3
    : opts.durationTolerance

  if (durationDiff > tolerance) {
    // Title matched but duration is off — same song, different version
    if (opts.splitVariants) return false
    // Without splitVariants, group loosely
  }

  // Check 3: Artist overlap
  if (!artistsMatch(candidate, seed)) return false

  // Check 4: Recording class compatibility
  if (!clusterClassesCompatible(seed.recordingType, candidate.recordingType)) {
    if (opts.splitVariants) return false
  }

  return true
}

// ── Cluster ID generation ──

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0 // Convert to 32-bit int
  }
  return Math.abs(hash).toString(16)
}

function generateClusterId(candidate: NormalizedCandidate): string {
  return `cluster_${candidate.videoId}_${simpleHash(candidate.canonicalTitle)}`
}

// ── Main clustering function ──

/**
 * Group candidates into clusters by recording identity.
 *
 * Greedy algorithm: sort by metadata quality, seed first cluster with best
 * candidate, then evaluate each remaining candidate against existing clusters
 * using title/duration/artist/compatibility checks.
 *
 * Deterministic — same input always produces the same output.
 */
export function clusterCandidates(
  candidates: NormalizedCandidate[],
  options?: ClusteringOptions
): CandidateCluster[] {
  if (candidates.length === 0) return []

  const opts: Required<ClusteringOptions> = { ...DEFAULT_OPTIONS, ...options }

  // Sort by metadata quality descending (deterministic: stable-sort by videoId tiebreaker)
  const sorted = [...candidates].sort((a, b) => {
    const diff = b.metadataQuality - a.metadataQuality
    if (diff !== 0) return diff
    return a.videoId.localeCompare(b.videoId)
  })

  const clusters: CandidateCluster[] = []

  for (const candidate of sorted) {
    let added = false

    for (const cluster of clusters) {
      if (belongsToCluster(candidate, cluster, opts)) {
        cluster.candidates.push(candidate)
        added = true
        break
      }
    }

    if (!added) {
      clusters.push({
        id: generateClusterId(candidate),
        label: candidate.canonicalTitle,
        candidates: [candidate],
        recordingClass: candidate.recordingType,
      })
    }
  }

  return clusters
}

// ── Cluster ranking ──

/**
 * Return the cluster with the most canonical recording class.
 * Undefined when no clusters exist.
 */
export function getBestCluster(clusters: CandidateCluster[]): CandidateCluster | undefined {
  if (clusters.length === 0) return undefined

  return [...clusters].sort(
    (a, b) => getRecordingClassPriority(a.recordingClass) - getRecordingClassPriority(b.recordingClass)
  )[0]
}

// ── Relevance scoring ──

/** Score a single cluster's relevance against a target reference */
function scoreClusterRelevance(
  cluster: CandidateCluster,
  targetTitle: string,
  targetArtist: string,
  targetDuration: number
): number {
  const seed = cluster.candidates[0]
  let score = 0

  // Recording class priority (invert so more canonical = higher score)
  score += (28 - getRecordingClassPriority(cluster.recordingClass)) * 10

  // Title similarity to target
  score += calculateWordOverlap(cluster.label, targetTitle) * 30

  // Duration proximity
  const durDiff = Math.abs(seed.duration - targetDuration)
  if (durDiff <= 3) score += 30
  else if (durDiff <= 10) score += 15

  // Artist match
  const seedArtist = getCandidateArtist(seed)
  const targetArtistLower = targetArtist.toLowerCase()
  if (seedArtist.includes(targetArtistLower) || targetArtistLower.includes(seedArtist)) {
    score += 10
  }

  return score
}

/**
 * Sort clusters by relevance to a target reference (e.g. the original
 * Spotify track). Best match first, worst last.
 */
export function sortClustersByRelevance(
  clusters: CandidateCluster[],
  targetTitle: string,
  targetArtist: string,
  targetDuration: number
): CandidateCluster[] {
  return [...clusters].sort((a, b) => {
    const scoreA = scoreClusterRelevance(a, targetTitle, targetArtist, targetDuration)
    const scoreB = scoreClusterRelevance(b, targetTitle, targetArtist, targetDuration)
    return scoreB - scoreA
  })
}
