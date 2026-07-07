/**
 * Analyze why artist-level cache misses occur.
 * Checks whether misses are from title mismatch, duration mismatch,
 * or the video simply not being in the search results.
 */
import { searchYouTube, clearSearchCache } from '../src/main/services/innertube'
import { cleanTitle, cleanTrackTitle } from '../src/application/SearchEngine'
import { fetchSpotifyPlaylist } from '../src/main/services/spotify'

async function main() {
  clearSearchCache()
  const url = process.argv[2] || 'https://open.spotify.com/playlist/79YYckMzTW22UKWafeoQ8d?si=91811b4e8bee4c2f'
  const playlist = await fetchSpotifyPlaylist(url)
  const tracks = playlist.tracks
  console.log(`Total tracks: ${tracks.length}`)

  const artistTracks = new Map<string, typeof tracks>()
  for (const t of tracks) {
    const list = artistTracks.get(t.artist) || []
    list.push(t)
    artistTracks.set(t.artist, list)
  }
  console.log(`Unique artists: ${artistTracks.size}`)

  let matched = 0
  let titleMatchWrongDuration = 0
  let noTitleMatch = 0

  for (const [artist, artistTrackList] of artistTracks) {
    process.stdout.write(`\rAnalyzing ${artist}... ${matched} matched, ${noTitleMatch} no title, ${titleMatchWrongDuration} wrong dur`)
    const results = await searchYouTube(`${artist} topic`)

    for (const track of artistTrackList) {
      const cleanTrackName = cleanTrackTitle(track.title).toLowerCase()

      // Check for exact title match among results
      const matchingTitle = results.filter(r => 
        cleanTitle(r.title).toLowerCase() === cleanTrackName
      )

      if (matchingTitle.length === 0) {
        noTitleMatch++
        // Check if any result has the title as a SUBSTRING
        const partialMatch = results.some(r => {
          const rt = cleanTitle(r.title).toLowerCase()
          return rt.includes(cleanTrackName) || cleanTrackName.includes(rt)
        })
        if (partialMatch && noTitleMatch <= 10) {
          // Show a few examples with partial matches
          const clean = cleanTrackName
          const partialResults = results.filter(r => {
            const rt = cleanTitle(r.title).toLowerCase()
            return rt.includes(clean) || clean.includes(rt)
          })
          console.log(`\nPARTIAL: "${artist}" - "${track.title}" (${track.duration}s) vs "${partialResults[0]?.title}" (${partialResults[0]?.duration}s)`)
        }
      } else {
        // Title matches — check duration
        const durMatch = matchingTitle.some(r => 
          Math.abs(r.duration - track.duration) <= 2
        )
        if (durMatch) {
          matched++
        } else {
          titleMatchWrongDuration++
          if (titleMatchWrongDuration <= 5) {
            console.log(`\nDUR: "${artist}" - "${track.title}" (${track.duration}s) vs`)
            matchingTitle.slice(0, 3).forEach(r => 
              console.log(`     "${r.title}" (${r.duration}s)`)
            )
          }
        }
      }
    }
  }

  console.log(`\n\nRESULTS:`)
  console.log(`  Matched (title+duration): ${matched}`)
  console.log(`  Title matched, wrong duration: ${titleMatchWrongDuration}`)
  console.log(`  No title match in top results: ${noTitleMatch}`)
  console.log(`  Total: ${matched + titleMatchWrongDuration + noTitleMatch}`)
}

main().catch(console.error)
