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

  // Deduplicate while preserving order
  return [...new Set(queries)]
}

// ── Confidence Scoring ──

/**
 * Calculate how closely a candidate result matches the target track.
 * Returns a confidence score between 0.0 and 1.0.
 *
 * DURATION IS THE GATEKEEPER. If duration is within ±2s, the candidate
 * gets a high base score. If duration differs by more than 2s, the
 * candidate is almost certainly the wrong recording and scores very low.
 *
 * This forces the search phase to find the EXACT YouTube upload
 * matching the Spotify track's duration — any remix, karaoke, live,
 * or cover version will have a detectably different duration.
 *
 * Scoring:
 *   Duration (±2s):    0.0 - 0.6   (gatekeeper — strict)
 *   Title match:       0.0 - 0.2   (confirmatory)
 *   Artist/channel:    0.0 - 0.2   (confirmatory)
 *   ─────────────────────────────
 *   Max possible:      1.0
 *   Threshold:         0.65
 */
export function calculateConfidence(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string }
): number {
  let score = 0

  const deltaT = Math.abs(target.duration - candidate.duration)

  // ═══ 1. Duration Score (gatekeeper — 0.0 to 0.6) ═══
  //
  // Strict ±2s window. If the YouTube upload doesn't match the Spotify
  // track's duration within 2 seconds, it's the wrong recording.
  // A 3-5s difference might still be the same track (encoding trimming),
  // so we give a weak score but not enough to pass threshold alone.
  if (deltaT <= 2) {
    score += 0.6 // Exact recording match
  } else if (deltaT <= 5) {
    score += 0.2 // Possible but unlikely — needs strong other signals
  }
  // else: Δt > 5s → 0 contribution, candidate won't pass threshold

  // ═══ 2. Title Match (0.0 to 0.2) ═══
  //
  // Compare cleaned titles. Uses cleanTrackTitle for the target (no
  // artist prefix removal) and cleanTitle for the candidate (removes
  // "Artist - " prefix and annotations).
  const targetTitle = cleanTrackTitle(target.title).toLowerCase()
  const candidateTitle = cleanTitle(candidate.title).toLowerCase()

  // Also compute normalized versions for fuzzy/Unicode matching
  const targetNorm = normalizeForMatch(target.title)
  const candidateNorm = normalizeForMatch(candidate.title)

  if (targetTitle === candidateTitle) {
    score += 0.2
  } else if (targetNorm === candidateNorm) {
    // Handles cases where cleanTitle still differs but normalized text matches
    // e.g., special characters, minor punctuation differences
    score += 0.18
  } else if (targetTitle.includes(candidateTitle) || candidateTitle.includes(targetTitle)) {
    score += 0.15
  } else if (targetNorm.includes(candidateNorm) || candidateNorm.includes(targetNorm)) {
    score += 0.12
  } else {
    // Partial word overlap
    const targetWords = targetNorm.split(/\s+/).filter(Boolean)
    const candidateWords = candidateNorm.split(/\s+/).filter(Boolean)
    const commonWords = targetWords.filter(w => candidateWords.includes(w))
    if (commonWords.length > 0) {
      const overlap = commonWords.length / Math.max(targetWords.length, candidateWords.length)
      score += 0.1 * Math.min(1, overlap)
    }
  }

  // ═══ 3. Artist / Channel Match (0.0 to 0.2) ═══
  const targetArtist = normalizeForMatch(target.artist)
  const candidateLower = normalizeForMatch(candidate.title)

  if (candidate.channelType === 'verified_topic') {
    // Topic channels are auto-generated by YouTube Music — they always
    // have the exact artist and track name, making them the most reliable
    // source for matching.
    score += 0.2
  } else if (candidateLower.includes(targetArtist)) {
    // Target artist name appears somewhere in the candidate title
    score += 0.15
  } else if (targetArtist) {
    // Partial artist match — check individual words
    const artistParts = targetArtist.split(/\s+/).filter(Boolean)
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
 */
async function resolveFromCandidates(
  incomingTrack: SpotifyTrack,
  candidates: MockCandidate[],
  _fingerprintHash: string
): Promise<ResolvedMatchResult> {
  const scored = candidates.map((c) => {
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
      }
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
 * Search YouTube and try multiple query strategies until a match is found.
 *
 * Strategy:
 *   1. Try each query in order (standard, official, explicit, original, topic)
 *   2. Merge candidates (dedup by videoId)
 *   3. Score all candidates — if highest ≥ threshold, return immediately
 *   4. If exhausted without a match, throw
 *
 * This ensures we find the EXACT YouTube upload for each Spotify track
 * by iterating queries until we find the right duration match.
 *
 * @param incomingTrack - The Spotify track to match
 * @param threshold - Minimum confidence score (0-1). Default 0.65.
 */
async function resolveIdentity(incomingTrack: SpotifyTrack, threshold = 0.65): Promise<Track> {
  const queries = generateSearchQueries(incomingTrack)
  const seen = new Set<string>()
  let allCandidates: Array<{ track: Track; score: number }> = []

  for (const query of queries) {
    const results = await SearchEngine.search(query)

    // Score new candidates
    for (const track of results) {
      if (seen.has(track.id)) continue
      seen.add(track.id)

      const score = calculateConfidence(
        { title: incomingTrack.title, artist: incomingTrack.artist, duration: incomingTrack.duration },
        { title: track.title, duration: track.duration, channelType: track.channelType }
      )
      allCandidates.push({ track, score })
    }

    // Sort descending by score
    allCandidates.sort((a, b) => b.score - a.score)

    // Early exit: if the best candidate already meets threshold, return it
    if (allCandidates.length > 0 && allCandidates[0].score >= threshold) {
      return allCandidates[0].track
    }
  }

  // All queries exhausted — last resort (remix/original version mismatch).
  //
  // When a track has a different version (Remix, Taylor's Version, etc.),
  // YouTube may not have an upload with matching duration. In that case
  // the best candidate is the original version with the same title+artist.
  // Accept it if the title and artist confirm the track identity.
  //
  // A score ≥ 0.35 means: title match (≥0.18) + artist/channel signal (≥0.15),
  // which is strong enough to confirm identity despite duration difference.
  if (allCandidates.length > 0 && allCandidates[0].score >= 0.35) {
    return allCandidates[0].track
  }

  throw new Error(
    `No match above confidence threshold for "${incomingTrack.artist} — ${incomingTrack.title}"` +
    (allCandidates.length > 0 ? ` (best=${allCandidates[0].score.toFixed(2)})` : ' (no candidates)')
  )
}

// ── Exported Singleton ──

export const TrackIdentityEngine = {
  resolveFromCandidates,
  resolveIdentity,
  calculateConfidence,
}
