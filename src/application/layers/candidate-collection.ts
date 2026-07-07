// ── Layer 3: Candidate Collection ──
// Executes search queries from Layer 2 in order of specificity,
// merges results across queries, deduplicates, and provides
// early-exit heuristics for pipeline efficiency.

import type { SpotifyTrack } from '../types'
import type { Track } from '../../shared/types'
import { generateSearchQueries } from './search-strategy'

export interface CollectionOptions {
  /** Minimum candidates to collect before considering early stop (default: 60) */
  minUniqueCandidates?: number
  /** Stop if this many strong candidates found (default: 20) */
  earlyExitStrongCount?: number
  /** Minimum confidence for "strong" candidate (default: 0.7) */
  strongThreshold?: number
  /** Maximum queries to try (default: unlimited) */
  maxQueries?: number
  /** AbortSignal for cancellation */
  signal?: AbortSignal
}

// ── Strong Candidate Detection (basic heuristics, no full pipeline) ──

function isStrongCandidate(track: Track, targetDuration: number): boolean {
  const delta = Math.abs(track.duration - targetDuration)
  if (delta > 3) return false
  if (track.channelType === 'verified_topic') return true
  if (track.channelType === 'verified_artist' && delta <= 1) return true
  return false
}

// ── Utility Functions ──

export function countStrongCandidates(
  candidates: Track[],
  targetDuration: number
): number {
  let count = 0
  for (const c of candidates) {
    if (isStrongCandidate(c, targetDuration)) count++
  }
  return count
}

export function deduplicateTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  const result: Track[] = []
  for (const t of tracks) {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      result.push(t)
    }
  }
  return result
}

// ── Main Collection Function ──

export async function collectCandidates(
  incomingTrack: SpotifyTrack,
  searchFn: (query: string) => Promise<Track[]>,
  options?: CollectionOptions
): Promise<Track[]> {
  const minUnique = options?.minUniqueCandidates ?? 60
  const earlyExit = options?.earlyExitStrongCount ?? 20
  const maxQ = options?.maxQueries
  const signal = options?.signal

  const queries = generateSearchQueries(incomingTrack)
  const capped = maxQ != null ? queries.slice(0, maxQ) : queries

  const all: Track[] = []
  const seen = new Set<string>()

  for (const q of capped) {
    if (signal?.aborted) return deduplicateTracks(all)

    const results = await searchFn(q)
    if (!results || results.length === 0) continue

    for (const t of results) {
      if (!seen.has(t.id)) {
        seen.add(t.id)
        all.push(t)
      }
    }

    if (all.length >= minUnique) break
    if (countStrongCandidates(all, incomingTrack.duration) >= earlyExit) break
  }

  return deduplicateTracks(all)
}

// ── Test Compatibility: Filter + Dedup from raw candidate arrays ──

type CandidateInput = {
  youtubeId: string
  title: string
  duration: number
  channelType: string
}

export function deduplicateAndFilter(
  candidates: CandidateInput[],
  targetDuration: number
): CandidateInput[] {
  const seen = new Set<string>()
  const result: CandidateInput[] = []
  for (const c of candidates) {
    if (seen.has(c.youtubeId)) continue
    seen.add(c.youtubeId)
    if (Math.abs(c.duration - targetDuration) <= 3) {
      result.push(c)
    }
  }
  return result
}
