/**
 * End-to-end import test: fetches a real Spotify playlist and runs the
 * TrackIdentityEngine matching pipeline to measure match rate.
 *
 * Usage: npx tsx tests/import-test.ts <spotify-url>
 *   or:  npx tsx tests/import-test.ts  (uses default URL below)
 */

import { fetchSpotifyPlaylist } from '../src/main/services/spotify'
import { searchYouTube } from '../src/main/services/innertube'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'
import { cleanTrackTitle, cleanTitle } from '../src/application/SearchEngine'

const DEFAULT_URL = 'https://open.spotify.com/playlist/6cvgUIKXM8SKIYxDmDzTW1?si=29a79c9869d945bd'

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  console.log(`\nFetching playlist: ${url}\n`)

  // Step 1: Fetch Spotify playlist
  const playlist = await fetchSpotifyPlaylist(url)
  console.log(`Playlist: "${playlist.name}" — ${playlist.tracks.length} tracks\n`)

  let matched = 0
  let failed: Array<{ title: string; artist: string; error: string }> = []

  // Step 2: For each track, search + match
  for (let i = 0; i < playlist.tracks.length; i++) {
    const track = playlist.tracks[i]
    const queryTitle = cleanTrackTitle(track.title)
    const query = `${track.artist} ${queryTitle}`

    process.stdout.write(
      `[${i + 1}/${playlist.tracks.length}] ${track.artist} — ${track.title} ... `
    )

    try {
      // Search YouTube
      const results = await searchYouTube(query)

      if (results.length === 0) {
        process.stdout.write(`❌ NO RESULTS\n`)
        failed.push({ title: track.title, artist: track.artist, error: 'No search results' })
        continue
      }

      // Score candidates
      const scored = results.map((r) => {
        const score = TrackIdentityEngine.calculateConfidence(
          { title: track.title, artist: track.artist, duration: track.duration },
          { title: r.title, duration: r.duration, channelType: r.channelType }
        )
        return { result: r, score }
      })

      scored.sort((a, b) => b.score - a.score)
      const best = scored[0]

      // Show raw title + cleaned title for top result
      const cleanedTitle = cleanTitle(best.result.title)
      const matchIndicator = best.score >= 0.65 ? '✓' : '✗'
      process.stdout.write(
        `${matchIndicator} score=${best.score.toFixed(2)} ` +
        `"${cleanedTitle}" (raw: ${best.result.title.slice(0, 50)})\n`
      )

      if (best.score >= 0.65) {
        matched++
      } else {
        failed.push({
          title: track.title,
          artist: track.artist,
          error: `Best score ${best.score.toFixed(2)} < 0.65 threshold`,
        })
      }
    } catch (err: any) {
      process.stdout.write(`❌ ERROR: ${err.message}\n`)
      failed.push({ title: track.title, artist: track.artist, error: err.message })
    }
  }

  // Step 3: Report
  const total = playlist.tracks.length
  console.log(`\n═══════════════════════════════════════`)
  console.log(`Matched: ${matched}/${total} (${((matched / total) * 100).toFixed(1)}%)`)
  console.log(`Failed:  ${failed.length}/${total}`)

  if (failed.length > 0) {
    console.log(`\nFailed tracks:`)
    for (const f of failed) {
      console.log(`  • ${f.artist} — ${f.title}`)
      console.log(`    ${f.error}`)
    }
  }
}

main().catch(console.error)
