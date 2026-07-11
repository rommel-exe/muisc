// Verifies the LAST imported "Genre Mix (2) (Spotify Import)" playlist's
// Believer track resolves to Imagine Dragons (not James Major).
import { PlaylistEngine } from '../src/application/PlaylistEngine'

const pls = PlaylistEngine.getUserPlaylists()
const pl = pls.find((p: any) => p.name === 'Genre Mix (2) (Spotify Import)')
if (!pl) {
  console.log('RESULT: playlist not found')
  process.exit(2)
}
const tracks = PlaylistEngine.getPlaylistTracks(pl.id)
const believers = tracks.filter((t: any) => /believer/i.test(t.title))
console.log(`playlist="${pl.name}" total=${tracks.length} believers=${believers.length}`)
for (const t of believers) {
  const artist = (t.artist || '').toLowerCase()
  const isJames = artist.includes('james')
  const isCorrect =
    artist.includes('imagine') ||
    t.title.toLowerCase().includes('imagine dragons') ||
    t.channelType === 'verified_topic' ||
    t.channelType === 'verified_artist'
  console.log(
    `RESULT title="${t.title}" uploader="${t.artist}" chType=${t.channelType} | JAMES=${isJames ? 'YES(BUG)' : 'no'} correct=${isCorrect ? 'YES' : 'NO'}`
  )
}
