/**
 * Import benchmark — measures the full Spotify import pipeline with production-like
 * parallel matching. Mirrors importSpotifyPlaylist() logic without Electron deps.
 *
 * Strategy: artist-level pre-fetch at safe concurrency (10), then per-track
 * matching from the artist catalog. Only falls back to TrackIdentityEngine
 * when the artist cache doesn't have a match.
 *
 * Usage: npx tsx tests/import-benchmark.ts [URL]
 */
import { fetchSpotifyPlaylist } from '../src/main/services/spotify'
import { searchYouTube, clearSearchCache } from '../src/main/services/innertube'
import { setSearchFunction } from '../src/application/SearchEngine'
import { TrackIdentityEngine, generateSearchQueries } from '../src/application/TrackIdentityEngine'
import { PlaylistEngine } from '../src/application/PlaylistEngine'
import { cleanTitle, cleanTrackTitle } from '../src/application/SearchEngine'
import type { InnertubeSearchResult } from '../src/main/services/innertube'
import type { Track } from '../src/shared/types'

const DEFAULT_URL = 'https://open.spotify.com/playlist/79YYckMzTW22UKWafeoQ8d?si=91811b4e8bee4c2f'

// ── Parallel Map (same as spotify-importer.ts) ──

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let cancelled = false

  async function worker(): Promise<void> {
    while (!cancelled && nextIndex < items.length) {
      const idx = nextIndex++
      try {
        results[idx] = await fn(items[idx], idx)
      } catch (err: any) {
        cancelled = true
        throw err
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  try {
    await Promise.all(workers)
  } finally {
    cancelled = true
  }
  return results
}

// ── Progress ──

function printProgress(current: number, total: number, label: string): void {
  const pct = ((current / total) * 100).toFixed(0)
  process.stdout.write(`\r  ${label}: ${current}/${total} (${pct}%)`)
}

// ── Artist Cache Matching ──

/**
 * Try to find a YouTube video for a Spotify track by searching the artist's
 * cached catalog. Matches on cleaned title (minus artist prefix) and duration.
 */
function findMatchInArtistCache(
  track: { title: string; artist: string; duration: number },
  artistResults: InnertubeSearchResult[]
): { videoId: string; title: string; artist: string; duration: number } | null {
  const cleanTrackName = cleanTrackTitle(track.title).toLowerCase()
  const DURATION_TOLERANCE = 2 // seconds

  for (const result of artistResults) {
    // Strip artist prefix from YouTube title to get just the song name
    const resultClean = cleanTitle(result.title).toLowerCase()
    if (resultClean !== cleanTrackName) continue

    // Duration must be within tolerance
    if (Math.abs(result.duration - track.duration) > DURATION_TOLERANCE) continue

    return {
      videoId: result.videoId,
      title: result.title,
      artist: result.artist,
      duration: result.duration,
    }
  }
  return null
}

// ── Benchmark ──

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  const ARTIST_CONCURRENCY = 10
  const PER_TRACK_CONCURRENCY = 10

  clearSearchCache()
  PlaylistEngine.clear()

  // ── Step 1: Fetch ──
  console.log(`\n═══ SPOTIFY IMPORT BENCHMARK ═══`)
  console.log(`Playlist URL: ${url}`)
  console.log(`Artist concurrency: ${ARTIST_CONCURRENCY}`)
  console.log(`Per-track concurrency: ${PER_TRACK_CONCURRENCY}`)

  let t0 = Date.now()
  const playlist = await fetchSpotifyPlaylist(url)
  const tracks = playlist.tracks
  const total = tracks.length
  let t1 = Date.now()
  console.log(`\nFetch: ${playlist.name} — ${total} tracks (${(t1 - t0) / 1000}s)`)

  if (total === 0) {
    console.error('No tracks found')
    process.exit(1)
  }

  // ── Step 2: Artist-level pre-fetch ──
  // Group tracks by artist and search for each artist's Topic channel.
  // At concurrency=10 (Innertube's tuned max), no rate limit slowdowns.
  const artistTracks = new Map<string, Array<typeof tracks[0]>>()
  for (const track of tracks) {
    const list = artistTracks.get(track.artist) || []
    list.push(track)
    artistTracks.set(track.artist, list)
  }
  const uniqueArtists = [...artistTracks.keys()]
  const artistCache = new Map<string, InnertubeSearchResult[]>()

  console.log(`\n── Step 2: Artist catalog (${uniqueArtists.length} artists, concurrency=${ARTIST_CONCURRENCY}) ──`)

  let artistDone = 0
  await parallelMap(uniqueArtists, async (artist) => {
    const results = await searchYouTube(`${artist} topic`).catch(() => [] as InnertubeSearchResult[])
    if (results.length > 0) {
      artistCache.set(artist, results)
    }
    artistDone++
    printProgress(artistDone, uniqueArtists.length, 'Artists')
  }, ARTIST_CONCURRENCY)

  let t2 = Date.now()
  const artistTime = (t2 - t1) / 1000
  const totalArtistResults = [...artistCache.values()].reduce((sum, r) => sum + r.length, 0)
  console.log(`\n  Artist catalog: ${artistTime}s (${totalArtistResults} total results cached)`)

  // ── Step 3: Wire SearchEngine for fallback ──
  setSearchFunction(async (query: string) => {
    const results = await searchYouTube(query)
    return results.map((r: InnertubeSearchResult) => ({
      id: r.videoId,
      title: r.title,
      artist: r.artist,
      duration: r.duration,
      thumbnailUrl: r.thumbnail,
      source: 'youtube' as const,
      sourceId: r.videoId,
      channelType: r.channelType,
    }))
  })

  // ── Step 4: Per-track matching (artist cache first, then engine fallback) ──
  console.log(`\n── Step 4: Per-track matching (concurrency=${PER_TRACK_CONCURRENCY}) ──`)

  const matchedTracks: Track[] = []
  const skipped: Array<{ title: string; artist: string; reason: string }> = []
  let matchCount = 0
  let fromArtistCache = 0
  let fromEngine = 0

  const matchingResults = await parallelMap(
    tracks,
    async (track) => {
      // Try artist cache first
      const artistResults = artistCache.get(track.artist)
      if (artistResults) {
        const cachedMatch = findMatchInArtistCache(
          { title: track.title, artist: track.artist, duration: track.duration },
          artistResults
        )
        if (cachedMatch) {
          fromArtistCache++
          matchCount++
          printProgress(matchCount, total, 'Matching')
          const t: Track = {
            id: cachedMatch.videoId,
            title: cachedMatch.title,
            artist: cachedMatch.artist,
            duration: cachedMatch.duration,
            thumbnailUrl: '',
            source: 'youtube',
            sourceId: cachedMatch.videoId,
          }
          return { type: 'match' as const, track: t }
        }
      }

      // Fall back to TrackIdentityEngine
      try {
        const result = await TrackIdentityEngine.resolveIdentity(
          { title: track.title, artist: track.artist, duration: track.duration, explicit: track.explicit }
        )
        fromEngine++
        matchCount++
        printProgress(matchCount, total, 'Matching')
        return { type: 'match' as const, track: result }
      } catch (err: any) {
        return { type: 'skip' as const, skip: { title: track.title, artist: track.artist, reason: err.message ?? 'No match found' } }
      }
    },
    PER_TRACK_CONCURRENCY
  )

  let t3 = Date.now()
  const matchTime = (t3 - t2) / 1000

  for (const r of matchingResults) {
    if (r.type === 'match') {
      matchedTracks.push(r.track)
    } else {
      skipped.push(r.skip)
    }
  }

  // Report
  console.log(`\n\n═══════════════════════════════════════`)
  console.log(`RESULTS:`)
  console.log(`  Total:           ${total} tracks`)
  console.log(`  Matched:         ${matchedTracks.length}`)
  console.log(`  From artist cache: ${fromArtistCache}`)
  console.log(`  From engine:     ${fromEngine}`)
  console.log(`  Skipped:         ${skipped.length}`)
  console.log(`  Match rate:      ${((matchedTracks.length / total) * 100).toFixed(1)}%`)
  console.log(``)
  console.log(`  Fetch:           ${((t1 - t0) / 1000).toFixed(1)}s`)
  console.log(`  Artist catalog:  ${artistTime.toFixed(1)}s`)
  console.log(`  Matching:        ${matchTime.toFixed(1)}s`)
  console.log(`  ─────────────────────`)
  console.log(`  TOTAL:           ${((t3 - t0) / 1000).toFixed(1)}s`)
  console.log(``)

  if (skipped.length > 0) {
    console.log(`SKIPPED:`)
    for (const s of skipped) {
      console.log(`  ✗ ${s.artist} — ${s.title}: ${s.reason}`)
    }
    process.exit(1)
  } else {
    const totalTimeSec = (t3 - t0) / 1000
    console.log(`✓ ALL ${total} TRACKS MATCHED SUCCESSFULLY in ${totalTimeSec.toFixed(1)}s`)
  }
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
