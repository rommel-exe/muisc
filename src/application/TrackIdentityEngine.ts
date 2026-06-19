import { SearchEngine, cleanTitle } from './SearchEngine'
import type { Track } from '../shared/types'

// ── Types ──

interface SpotifyTrack {
  title: string
  artist: string
  duration: number
  album?: string
}

interface ScoredCandidate {
  id: string
  title: string
  artist: string
  duration: number
  thumbnailUrl?: string
  source?: string
  sourceId?: string
  channelType?: string
  fingerprintHash?: string
  confidenceScore: number
}

interface MockCandidate {
  youtubeId: string
  title: string
  duration: number
  channelType: string
  fingerprintHash: string
}

// ── Confidence Scoring ──

/**
 * Calculate how closely a candidate result matches the target track.
 * Returns a confidence score between 0.0 and 1.0.
 *
 * Scoring factors:
 * 1. Duration Score: Δt <= 3s → 1.0, Δt >= 30s → 0.1, linear in between
 * 2. Title/Artist Match: bonus for normalized title match
 * 3. Channel Type: bonus for verified topic channels
 */
function calculateConfidence(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string; fingerprintHash?: string },
  _fingerprintHash?: string
): number {
  let score = 0

  // 1. Duration Score (0.0 - 0.4)
  const deltaT = Math.abs(target.duration - candidate.duration)
  let durationScore: number
  if (deltaT <= 3) {
    durationScore = 1.0
  } else if (deltaT >= 30) {
    durationScore = 0.1
  } else {
    // Linear interpolation: 1.0 at 3s → 0.1 at 30s
    durationScore = 1.0 - (0.9 * (deltaT - 3)) / 27
  }
  score += durationScore * 0.4

  // 2. Title Match (0.0 - 0.3)
  const targetTitle = cleanTitle(target.title).toLowerCase()
  const candidateTitle = cleanTitle(candidate.title).toLowerCase()

  // Check if the core title (artist stripped) matches
  const targetCore = targetTitle.replace(/^(.+?)\s*[-–—]\s*/, '').trim()
  const candidateCore = candidateTitle.replace(/^(.+?)\s*[-–—]\s*/, '').trim()

  if (targetCore === candidateCore) {
    score += 0.3
  } else if (targetCore.includes(candidateCore) || candidateCore.includes(targetCore)) {
    score += 0.2
  } else {
    // Check for partial word overlap
    const targetWords = targetCore.split(/\s+/)
    const candidateWords = candidateCore.split(/\s+/)
    const commonWords = targetWords.filter(w => candidateWords.includes(w))
    if (commonWords.length > 0) {
      score += 0.1 * (commonWords.length / Math.max(targetWords.length, candidateWords.length))
    }
  }

  // 3. Artist Match / Channel Type (0.0 - 0.3)
  const targetArtist = target.artist.toLowerCase()
  const candidateLower = candidate.title.toLowerCase()

  if (candidate.channelType === 'verified_topic') {
    score += 0.3
  } else if (candidateLower.includes(targetArtist)) {
    score += 0.2
  } else if (targetArtist) {
    // Check if target artist appears in candidate title
    const artistParts = targetArtist.split(/\s+/)
    const artistMatch = artistParts.filter(p => candidateLower.includes(p)).length
    if (artistMatch > 0) {
      score += 0.1 * (artistMatch / artistParts.length)
    }
  }

  // Clamp to [0, 1]
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

/**
 * Resolve a Spotify track to the best YouTube match from a pool of candidates.
 * Used in tests with mock search results; in production the pool comes from SearchEngine.
 *
 * Scoring framework:
 * 1. Normalize: strip annotations from candidate titles
 * 2. Score: calculate confidence for each candidate
 * 3. Select: return highest scoring candidate above threshold
 */
async function resolveFromCandidates(
  incomingTrack: SpotifyTrack,
  candidates: MockCandidate[],
  fingerprintHash: string
): Promise<ResolvedMatchResult> {
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const score = calculateConfidence(
      {
        title: incomingTrack.title,
        artist: incomingTrack.artist,
        duration: incomingTrack.duration,
      },
      {
        title: c.title,
        duration: c.duration,
        channelType: c.channelType,
        fingerprintHash: c.fingerprintHash,
      },
      fingerprintHash
    )

    return {
      id: c.youtubeId,
      title: c.title,
      artist: incomingTrack.artist,
      duration: c.duration,
      channelType: c.channelType,
      fingerprintHash: c.fingerprintHash,
      confidenceScore: score,
    }
  })

  // Sort by confidence score descending
  scored.sort((a, b) => b.confidenceScore - a.confidenceScore)

  const best = scored[0]

  return {
    id: best.id,
    title: best.title,
    artist: best.artist,
    duration: best.duration,
    thumbnailUrl: '',
    source: 'youtube',
    sourceId: best.id,
    confidenceScore: best.confidenceScore,
  }
}

/**
 * Resolve a Spotify track to a YouTube match by searching via SearchEngine.
 * Full production pipeline: search → normalize → score → select.
 *
 * @param incomingTrack - The Spotify track to match
 * @param threshold - Minimum confidence score (0-1). Default 0.82.
 *                    Use ~0.65 for best-effort import scenarios.
 */
async function resolveIdentity(incomingTrack: SpotifyTrack, threshold = 0.82): Promise<Track> {
  const query = `${incomingTrack.artist} ${incomingTrack.title}`
  const results = await SearchEngine.search(query)

  if (results.length === 0) {
    throw new Error(`No search results found for "${query}"`)
  }

  const scored = results.map((track) => {
    // NOTE: channelType (e.g. 'verified_topic') is not available in the Track
    // type returned by SearchEngine. The Innertube search response has this
    // info, but it's lost at the normalization boundary. This means the
    // 'verified_topic' 0.3 confidence bonus is never applied in production,
    // reducing match accuracy for the import feature. To fix this, extend
    // the Track type with an optional `channelType` field and populate it
    // in the SearchEngine normalization pipeline.
    const score = calculateConfidence(
      { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
      { title: track.title, duration: track.duration }
    )
    return { track, score }
  })

  scored.sort((a, b) => b.score - a.score)

  if (scored.length === 0 || scored[0].score < threshold) {
    throw new Error(`No match above confidence threshold for "${query}"`)
  }

  return scored[0].track
}

// ── Exported Singleton ──

export const TrackIdentityEngine = {
  resolveFromCandidates,
  resolveIdentity,
  calculateConfidence,
}
