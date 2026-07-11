import { fetchSpotifyPlaylist } from '../src/main/services/spotify'

const URL =
  'https://open.spotify.com/playlist/79YYckMzTW22UKWafeoQ8d?si=c9cdc3fe87a84734&pt=a1d6a83ca67bc16ee65f6b127ab667de'

async function main() {
  const pl = await fetchSpotifyPlaylist(URL)
  console.log(`playlist: ${pl.name}, total: ${pl.totalCount}`)
  const believers = pl.tracks.filter((t) => /believer/i.test(t.title))
  console.log(`believer tracks: ${believers.length}`)
  for (const t of believers) {
    console.log(`  title="${t.title}" artist="${t.artist}" duration=${t.duration}s`)
  }
}
main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
