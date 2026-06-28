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

type AnnotationCategory = 'official' | 'derivative' | 'normal'

/**
 * Classify a YouTube video's annotation type by examining its raw title
 * (before any cleanup) and channel type.
 *
 * This is the tiebreaker that lets us distinguish "Eminem - Without Me
 * (Official Video)" from "Eminem - Without Me (Lyrics)" — both become
 * "Without Me" after cleanTitle(), but their raw titles tell different
 * stories about whether the upload is official content or a derivative.
 */
export function getAnnotationCategory(rawTitle: string, channelType?: string): AnnotationCategory {
  const lower = rawTitle.toLowerCase()

  // Official signals — uploads from the rights holder or auto-generated topics
  const hasOfficialAnnotation = /\(official\s+(audio|video|music\s*video|lyric\s*video|4k\s*remaster|hd)\)/i.test(rawTitle)
    || /\[official\s+(audio|video|music\s*video)\]/i.test(rawTitle)
    || /\(official\)/i.test(rawTitle)
  const isTopic = channelType === 'verified_topic'
  const isVerifiedArtist = channelType === 'verified_artist'

  if (hasOfficialAnnotation || isTopic || isVerifiedArtist) {
    return 'official'
  }

  // Derivative signals — non-original content
  const hasLyrics = /\(lyrics?\s*(video)?\)/i.test(lower) || /\[lyrics?\]/i.test(lower)
  const hasAudioOnly = /\(audio\s*only\)/i.test(lower)
  const hasInstrumental = /\binstrumental\b/i.test(lower) && !/official\s+instrumental/i.test(lower)
  const hasCover = /\bcover\b/i.test(lower) && !/official\s+cover/i.test(lower)
  const hasKaraoke = /\bkaraoke\b/i.test(lower)

  if (hasLyrics || hasAudioOnly || hasInstrumental || hasCover || hasKaraoke) {
    return 'derivative'
  }

  return 'normal'
}

// ── Confidence Scoring ──

/**
 * Calculate how closely a candidate result matches the target track.
 * Returns a confidence score between 0.0 and 1.0.
 *
 * DURATION IS THE GATEKEEPER. If duration is within ±1s, the candidate
 * gets a high base score. If duration differs by more than 1s, the
 * candidate is almost certainly the wrong recording and scores very low.
 *
 * This forces the search phase to find the EXACT YouTube upload
 * matching the Spotify track's duration — any remix, karaoke, live,
 * or cover version will have a detectably different duration.
 *
 * Scoring:
 *   Duration (±1s):    0.0 - 0.6   (gatekeeper — strict)
 *   Title match:       0.0 - 0.2   (confirmatory)
 *   Artist/channel:    0.0 - 0.2   (confirmatory)
 *   Annotation quality: -0.10 to +0.04 (tiebreaker)
 *   ─────────────────────────────
 *   Max possible:      1.0
 *   Threshold:         0.7
 *
 * Annotation quality is the tiebreaker when multiple YouTube videos share
 * the same duration and cleaned title. Official uploads get a slight bonus;
 * derivative uploads (lyrics, instrumental, cover, karaoke, audio-only)
 * get a significant penalty because they are almost never the intended match.
 */
export function calculateConfidence(
  target: { title: string; artist: string; duration: number },
  candidate: { title: string; duration: number; channelType?: string }
): number {
  let score = 0

  const deltaT = Math.abs(target.duration - candidate.duration)

  // ═══ 1. Duration Score (gatekeeper — 0.0 to 0.6) ═══
  //
  // Strict ±1s window. If the YouTube upload doesn't match the Spotify
  // track's duration within 1 second, it's the wrong recording.
  // No partial credit — any difference beyond 1s gets 0 from duration.
  if (deltaT <= 1) {
    score += 0.6 // Exact recording match
  }
  // else: Δt > 1s → 0 contribution, candidate won't pass threshold

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

  // ═══ 4. Annotation Quality Score (tiebreaker: -0.10 to +0.04) ═══
  //
  // Examines the RAW candidate title (before cleanTitle strips annotations)
  // to distinguish official uploads from derivative content.
  //
  // When two candidates have the same duration, same cleaned title,
  // and similar artist signals (e.g. lyrics video vs official video),
  // this is the tiebreaker that pushes official content above derivative.
  const annotationCat = getAnnotationCategory(candidate.title, candidate.channelType)
  if (annotationCat === 'derivative') {
    score -= 0.10  // significant penalty for lyrics, instrumental, cover, karaoke, audio-only
  } else if (annotationCat === 'official') {
    score += 0.04  // slight bonus for official uploads and verified channels
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
 * @param threshold - Minimum confidence score (0-1). Default 0.7.
 */
async function resolveIdentity(incomingTrack: SpotifyTrack, threshold = 0.7): Promise<Track> {
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

    // Early exit: if the best candidate meets threshold AND is not a
    // derivative upload (lyrics, instrumental, cover, karaoke, audio-only),
    // return it immediately. Derivative candidates don't trigger early exit
    // — we continue searching remaining queries for a better match.
    if (allCandidates.length > 0 && allCandidates[0].score >= threshold) {
      const best = allCandidates[0]
      const cat = getAnnotationCategory(best.track.title, best.track.channelType)
      if (cat !== 'derivative') {
        return best.track
      }
    }
  }

  // All queries exhausted without finding a clean match above threshold.
  // Return the best available rather than throwing, as long as it clears
  // a minimum viability bar (0.3). This ensures tracks with only derivative
  // uploads on YouTube still get imported instead of silently skipped.
  if (allCandidates.length > 0 && allCandidates[0].score >= 0.3) {
    return allCandidates[0].track
  }

  throw new Error(
    `No match for "${incomingTrack.artist} — ${incomingTrack.title}"` +
    (allCandidates.length > 0 ? ` (best=${allCandidates[0].score.toFixed(2)})` : ' (no candidates)')
  )
}

// ── Exported Singleton ──

export const TrackIdentityEngine = {
  resolveFromCandidates,
  resolveIdentity,
  calculateConfidence,
  getAnnotationCategory,
}
