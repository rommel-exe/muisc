// ── Layer 10 — Confidence Validation ──
// Calibrates and validates final confidence score.
// Pure synchronous functions — no async. No circular imports.

import type {
  IdentityResult,
  ConfidenceValidation,
  CandidateCluster,
  NormalizedCandidate,
} from '../types'

/**
 * Compute average metadata quality across cluster candidates.
 */
export function averageMetadataQuality(candidates: NormalizedCandidate[]): number {
  if (candidates.length === 0) return 0
  let sum = 0
  for (const c of candidates) {
    sum += c.metadataQuality
  }
  return sum / candidates.length
}

/**
 * Count the number of distinct recording classes in the candidate set.
 */
export function classDiversity(candidates: NormalizedCandidate[]): number {
  const seen = new Set<string>()
  for (const c of candidates) {
    seen.add(c.recordingType)
  }
  return seen.size
}

/**
 * Check if any candidate has a verified channel.
 */
export function hasVerifiedChannel(candidates: NormalizedCandidate[]): boolean {
  return candidates.some(c => c.channelVerified)
}

/**
 * Check if topic channel is present among candidates.
 */
export function hasTopicChannel(candidates: NormalizedCandidate[]): boolean {
  return candidates.some(c => c.isTopic)
}

/**
 * Round to nearest 0.01 (whole percentage point).
 */
export function roundToPercentage(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Map raw adjusted confidence through the Layer 8 confidence transform.
 */
function confidenceTransform(raw: number): number {
  if (raw >= 0.95) return 0.99
  if (raw >= 0.85) return 0.95
  if (raw >= 0.75) return 0.88
  if (raw >= 0.65) return 0.83
  if (raw >= 0.55) return 0.71
  if (raw >= 0.40) return 0.61
  return 0.35
}

/**
 * Apply all boosts and penalties to raw confidence.
 */
export function calibrateConfidence(
  rawConfidence: number,
  clusterQuality: {
    candidateCount: number
    avgQuality: number
    hasVerified: boolean
    hasTopic: boolean
    classDiversity: number
  },
): number {
  let adjusted = rawConfidence
  const { candidateCount, avgQuality, hasVerified, hasTopic } = clusterQuality

  // Step 1 — Cluster quality (cap based on candidate multiplicity)
  if (candidateCount >= 2) {
    // Multiple candidates → highest possible confidence is 0.99
    adjusted = Math.min(adjusted, 0.99)
  } else {
    // Single candidate → cap at 0.93
    adjusted = Math.min(adjusted, 0.93)
  }

  // Step 2 — Metadata quality penalty
  if (avgQuality >= 0.8) {
    // No adjustment
  } else if (avgQuality >= 0.5) {
    adjusted -= 0.02
  } else {
    adjusted -= 0.05
  }

  // Step 3 — Channel verification
  if (hasTopic) {
    adjusted += 0.02
  } else if (hasVerified) {
    adjusted += 0.01
  } else {
    adjusted -= 0.02
  }

  // Step 4 — Candidate count boost
  if (candidateCount >= 5) {
    adjusted += 0.02
  } else if (candidateCount >= 3) {
    adjusted += 0.01
  }
  // 1-2 candidates: no boost

  return adjusted
}

/**
 * Get final label from validated confidence.
 */
export function getFinalLabel(confidence: number): 'accepted' | 'manual_review' | 'rejected' {
  if (confidence >= 0.83) return 'accepted'
  if (confidence >= 0.61) return 'manual_review'
  return 'rejected'
}

/**
 * Build a human-readable reason string describing the calibration decisions.
 */
function buildReason(
  adjustedRaw: number,
  transformed: number,
  cluster: CandidateCluster,
  avgQuality: number,
  verified: boolean,
  topic: boolean,
): string {
  const { candidates } = cluster
  const parts: string[] = []

  if (candidates.length >= 2) {
    parts.push(`multi-candidate (${candidates.length})`)
  } else {
    parts.push('single-candidate capped to 0.93')
  }

  if (avgQuality < 0.8) {
    parts.push(`metadata penalty (avg=${avgQuality.toFixed(2)})`)
  }

  if (topic) {
    parts.push('topic channel boost')
  } else if (verified) {
    parts.push('verified channel boost')
  } else {
    parts.push('unverified channel penalty')
  }

  if (candidates.length >= 5) {
    parts.push('abundant candidates boost')
  } else if (candidates.length >= 3) {
    parts.push('moderate candidates boost')
  }

  parts.push(`adjusted=${adjustedRaw.toFixed(4)}→transformed=${transformed.toFixed(2)}`)

  return parts.join('; ')
}

/**
 * Validate and calibrate confidence for a resolved identity result.
 *
 * Entry point for Layer 10 — applies all boosts, penalties, and the
 * confidence transform to produce the final validated confidence and label.
 */
export function validateConfidence(
  identityResult: IdentityResult,
  cluster: CandidateCluster,
): ConfidenceValidation {
  const { candidates } = cluster

  if (candidates.length === 0) {
    throw new Error('Cannot validate empty cluster')
  }

  const rawConfidence = identityResult.confidence
  const avgQuality = averageMetadataQuality(candidates)
  const verified = hasVerifiedChannel(candidates)
  const topic = hasTopicChannel(candidates)
  const diversity = classDiversity(candidates)

  // Apply calibrations
  let adjustedScore = calibrateConfidence(rawConfidence, {
    candidateCount: candidates.length,
    avgQuality,
    hasVerified: verified,
    hasTopic: topic,
    classDiversity: diversity,
  })

  // Clamp to [0.0, 1.0]
  adjustedScore = Math.max(0, Math.min(1, adjustedScore))

  // Round to nearest whole percentage point
  const rounded = roundToPercentage(adjustedScore)

  // Map through confidence transform
  const validatedConfidence = confidenceTransform(rounded)

  // Assign label
  const label = getFinalLabel(validatedConfidence)

  const wasAdjusted = rawConfidence !== validatedConfidence
    || identityResult.confidenceLabel !== label

  const reason = buildReason(rounded, validatedConfidence, cluster, avgQuality, verified, topic)

  return {
    validatedConfidence,
    label,
    adjusted: wasAdjusted,
    reason,
  }
}
