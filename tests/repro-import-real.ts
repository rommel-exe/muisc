/**
 * Full real import of the user's playlist (headless) to reproduce the
 * Believer -> James Major bug. Run: npx tsx tests/repro-import-real.ts
 */
import { importSpotifyPlaylist } from '../src/main/services/spotify-importer'
import { warmInnerTube } from '../src/main/services/innertube'

const PLAYLIST_URL =
  'https://open.spotify.com/playlist/79YYckMzTW22UKWafeoQ8d?si=c9cdc3fe87a84734&pt=a1d6a83ca67bc16ee65f6b127ab667de'

const fakeSender: any = {
  isDestroyed: () => false,
  send: (_channel: string, _payload: any) => {
    // uncomment to trace progress
    // if (payload?.currentTitle) console.log(`  progress: ${payload.currentTitle}`)
  },
}

async function main() {
  warmInnerTube().catch(() => {})
  const result = await importSpotifyPlaylist(PLAYLIST_URL, undefined, fakeSender)
  console.log(`\n=== IMPORT RESULT ===`)
  console.log(`playlist: ${result.playlistName}`)
  console.log(`matched: ${result.matchedCount}/${result.totalCount}, skipped: ${result.skipped.length}`)

  // Print every track whose title contains "believer" (case-insensitive)
  // We need the matched tracks — re-derive from playlist. Import doesn't return tracks,
  // so re-import is wasteful; instead subscribe via progress is gone. Use a hack:
  // result doesn't include tracks, so we search the playlist engine.
  const { PlaylistEngine } = await import('../src/application/PlaylistEngine')
  const pls = PlaylistEngine.getUserPlaylists()
  const pl = pls.find((p: any) => p.name === result.playlistName)
  if (pl) {
    const tracks = PlaylistEngine.getPlaylistTracks(pl.id)
    const believers = tracks.filter((t: any) => /believer/i.test(t.title))
    console.log(`\n=== BELIEVER TRACKS (${believers.length}) ===`)
    for (const t of believers) {
      const artist = (t.artist || '').toLowerCase()
      const isJames = artist.includes('james')
      const isCorrect =
        artist.includes('imagine') ||
        t.title.toLowerCase().includes('imagine dragons') ||
        t.channelType === 'verified_topic' ||
        t.channelType === 'verified_artist'
      console.log(
        `  "${t.title}" | uploader="${t.artist}" chType=${t.channelType} | JAMES=${isJames ? 'YES!!' : 'no'} correct=${isCorrect ? 'yes' : 'NO'}`
      )
    }
  }
}

main().catch((e) => {
  console.error('IMPORT ERROR:', e.message)
  process.exit(1)
})
