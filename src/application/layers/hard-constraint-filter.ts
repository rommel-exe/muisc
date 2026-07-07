// ── Layer 6: Hard Constraint Filtering ──
import type { NormalizedMetadata, NormalizedCandidate, RecordingClass } from '../types'
import { areRecordingClassesCompatible } from './recording-classification'
import { isTitleIntegrityPass } from '../title-identity-engine'

export interface ConstraintOptions {
  durationTolerance?: number
  enforceRecordingClass?: boolean
}

/**
 * Derive expected recording class from incoming track metadata
 */
function _deriveExpectedRecordingClass(incoming: NormalizedMetadata): RecordingClass {
  const rawTitle = incoming.rawTitle.toLowerCase()

  if (/\b(live|concert|performance|tour)\b/.test(rawTitle)) return 'live'
  if (/\b(remix|edit|extended|radio_edit|mix|bootleg)\b/.test(rawTitle)) return 'remix'
  if (/\b(acoustic)\b/.test(rawTitle)) return 'acoustic'
  if (/\b(cover|tribute)\b/.test(rawTitle)) return 'cover'
  return 'studio'
}

/**
 * Check duration constraint only
 */
export function passesDurationConstraint(
  incomingDuration: number,
  candidateDuration: number,
  tolerance?: number
): boolean {
  const toleranceSeconds = tolerance ?? 5
  const maxDifference = incomingDuration < 180 ? toleranceSeconds : toleranceSeconds * 2
  return Math.abs(incomingDuration - candidateDuration) <= maxDifference
}

/**
 * Check artist constraint only
 */
export function passesArtistConstraint(
  incomingArtists: string[],
  candidateUploader: string,
  candidateTitle: string
): boolean {
  if (!incomingArtists?.length) return true

  const searchText = `${candidateUploader} ${candidateTitle}`.toLowerCase()

  for (const artist of incomingArtists) {
    const normalizedArtist = artist.toLowerCase().trim()

    if (normalizedArtist.includes(' ')) {
      const words = normalizedArtist.split(' ')
      const partialMatches = words.filter(word => word.length > 2 && searchText.includes(word))
      if (partialMatches.length >= 2) return true
    }

    if (searchText.includes(normalizedArtist)) return true
  }

  return false
}

/**
 * Check title overlap only
 */
export function passesTitleConstraint(
  incomingTitle: string,
  candidateTitle: string,
  threshold?: number
): boolean {
  if (!incomingTitle || !candidateTitle) return false

  const minOverlap = threshold ?? 0.5

  if (incomingTitle.length < 3) {
    return incomingTitle.toLowerCase() === candidateTitle.toLowerCase()
  }

  const incomingWords = incomingTitle
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2)

  const candidateWords = candidateTitle
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2)

  if (!incomingWords.length) return true

  const matchedWords = incomingWords.filter(word => candidateWords.includes(word))
  const overlapRatio = matchedWords.length / incomingWords.length

  return overlapRatio >= minOverlap
}

/**
 * Determine if incoming track is a variant version
 */
export function isVariantVersion(rawTitle: string): boolean {
  if (!rawTitle) return false

  const title = rawTitle.toLowerCase()

  const variantMarkers = [
    'remix', 'edit', 'extended', 'acoustic', 'live', 'concert',
    'version', 'mix', 'bootleg', 'rework', 'remaster', 'deluxe',
    'anniversary', 'mono', 'stereo', 'instrumental', 'cover',
    'tribute', 'mashup', 'nightcore', 'sped up', 'slowed', 'reverb'
  ]

  return variantMarkers.some(marker => title.includes(marker))
}

/**
 * Apply hard constraints to filter candidates
 */
export function applyHardConstraints(
  incoming: NormalizedMetadata,
  candidates: NormalizedCandidate[],
  options?: ConstraintOptions
): NormalizedCandidate[] {
  const durationTolerance = options?.durationTolerance ?? 5
  const enforceRecordingClass = options?.enforceRecordingClass ?? true

  const isVariant = isVariantVersion(incoming.rawTitle)
  const durationToleranceSeconds = isVariant ? durationTolerance * 2 : durationTolerance
  const expectedRecordingClass = _deriveExpectedRecordingClass(incoming)

  const passedCandidates: NormalizedCandidate[] = []

  for (const candidate of candidates) {
    if (!passesDurationConstraint(incoming.duration, candidate.duration, durationToleranceSeconds)) continue
    if (!passesArtistConstraint(incoming.artists, candidate.uploader, candidate.canonicalTitle)) continue
    if (enforceRecordingClass && !areRecordingClassesCompatible(expectedRecordingClass, candidate.recordingType)) continue
    if (!isTitleIntegrityPass(incoming.rawTitle, candidate.rawTitle)) continue

    passedCandidates.push(candidate)
  }

  return passedCandidates
}
