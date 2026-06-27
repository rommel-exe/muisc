/**
 * Full import test — runs all tracks with the same multi-query matching
 * logic as the production spotify-importer. Reports summary every 20 tracks.
 *
 * Each track gets:
 *   1. Standard search:  "Artist Title"
 *   2. If no candidate meets threshold, try: "Artist Title official"
 *   3. If still no match, try: "Artist Title topic" (YouTube Music auto-generated)
 *   4. If explicit: also tries "Artist Title explicit"
 *   5. If title has version suffixes (Remix etc.): also tries with original title
 *
 * Usage: npx tsx tests/import-test-full.ts
 */
import { fetchSpotifyPlaylist } from '../src/main/services/spotify'
import { searchYouTube } from '../src/main/services/innertube'
import { TrackIdentityEngine, generateSearchQueries } from '../src/application/TrackIdentityEngine'
import type { InnertubeSearchResult } from '../src/main/services/innertube'

const DEFAULT_URL = 'https://open.spotify.com/playlist/6cvgUIKXM8SKIYxDmDzTW1?si=29a79c9869d945bd'

interface TrackInfo {
  title: string
  artist: string
  duration: number
  explicit?: boolean
}

/**
 * Try multiple search queries for a single track, scoring all candidates
 * together. Returns the best score and whether it passed threshold.
 *
 * This mirrors TrackIdentityEngine.resolveIdentity() logic.
 */
async function findBestMatch(
  track: TrackInfo,
  threshold: number
): Promise<{ matched: boolean; score: number; title: string; isFallback: boolean }> {
  const queries = generateSearchQueries(track)
  const seen = new Set<string>()
  let bestScore = 0
  let bestTitle = '(no results)'

  for (const query of queries) {
    const results: InnertubeSearchResult[] = await searchYouTube(query)
    if (!results || results.length === 0) continue

    for (const r of results) {
      if (seen.has(r.videoId)) continue
      seen.add(r.videoId)

      const score = TrackIdentityEngine.calculateConfidence(
        { title: track.title, artist: track.artist, duration: track.duration },
        { title: r.title, duration: r.duration, channelType: r.channelType }
      )

      if (score > bestScore) {
        bestScore = score
        bestTitle = r.title
      }
    }

    // Early exit: found a candidate that passes threshold
    if (bestScore >= threshold) {
      return { matched: true, score: bestScore, title: bestTitle, isFallback: false }
    }
  }

  return { matched: false, score: bestScore, title: bestTitle, isFallback: false }
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  console.log(`Fetching playlist: ${url}`)
  const playlist = await fetchSpotifyPlaylist(url)
  const total = playlist.tracks.length
  console.log(`Playlist: "${playlist.name}" — ${total} tracks\n`)

  let matched = 0
  let strictCount = 0
  let fallbackCount = 0
  const failures: Array<{ title: string; artist: string; score: number; bestTitle: string; isFallback: boolean }> = []
  const fallbackDetails: Array<{ title: string; artist: string; score: number; bestTitle: string }> = []

  for (let i = 0; i < total; i++) {
    const t = playlist.tracks[i]
    const result = await findBestMatch(t, 0.7)

    if (result.matched) {
      matched++
      if (result.isFallback) {
        fallbackCount++
        fallbackDetails.push({ title: t.title, artist: t.artist, score: result.score, bestTitle: result.title })
      } else {
        strictCount++
      }
    } else {
      failures.push({ title: t.title, artist: t.artist, score: result.score, bestTitle: result.title, isFallback: result.isFallback })
    }

    if ((i + 1) % 20 === 0 || i === total - 1) {
      const pct = ((matched / (i + 1)) * 100).toFixed(1)
      process.stdout.write(`\rProgress: ${i + 1}/${total} matched=${matched} (${pct}%) failed=${failures.length}`)
    }
  }

  console.log(`\n\n═══════════════════════════════════════`)
  console.log(`FINISHED: ${matched}/${total} matched (${((matched / total) * 100).toFixed(1)}%)`)

  console.log(`\nMatched breakdown: ${strictCount} strict + ${fallbackCount} fallback = ${matched}/${total}`)

  if (fallbackDetails.length > 0) {
    console.log(`\nFallback matches (remix/version — correct track, version duration mismatch):`)
    for (const f of fallbackDetails) {
      console.log(`  • ${f.artist} — ${f.title} (score=${f.score.toFixed(2)}, matched="${f.bestTitle}")`)
    }
  }

  if (failures.length > 0) {
    console.log(`\nFailed (${failures.length}):`)
    for (const f of failures) {
      console.log(`  • ${f.artist} — ${f.title} (best=${f.score.toFixed(2)}, candidate="${f.bestTitle}")`)
    }
    process.exit(1)
  } else {
    console.log(`\n✓ ALL ${total} TRACKS MATCHED`)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
