/**
 * Quick test for the specific failing tracks.
 */
import { cleanTrackTitle, cleanTitle } from '../src/application/SearchEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'
import { searchYouTube } from '../src/main/services/innertube'

async function test(track: string, artist: string, duration: number) {
  const queryTitle = cleanTrackTitle(track)
  const query = `${artist} ${queryTitle}`
  const results = await searchYouTube(query)
  
  const scored = results.map(r => ({
    result: r,
    score: TrackIdentityEngine.calculateConfidence(
      { title: track, artist, duration },
      { title: r.title, duration: r.duration, channelType: r.channelType }
    )
  })).sort((a, b) => b.score - a.score)
  
  const best = scored[0]
  const passed = best && best.score >= 0.7
  const cleanedTitle = best ? cleanTitle(best.result.title) : 'N/A'
  console.log(
    `${passed ? '✓' : '✗'} score=${best ? best.score.toFixed(2) : 'N/A'} ` +
    `"${cleanedTitle}"\tquery="${query}"`
  )
}

const tracks: Array<[string, string, number]> = [
  ['Sunflower - Remix', 'Post Malone', 174],
  ['Girls Like You (feat. Cardi B) - Cardi B Version', 'Maroon 5', 231],
  ['Dusk Till Dawn (feat. Sia) - Radio Edit', 'ZAYN', 238],
  ['I Took A Pill In Ibiza - Seeb Remix', 'Mike Posner', 229],
  ['Moves Like Jagger - Studio Recording From "The Voice" Performance', 'Maroon 5', 262],
  ['Save Your Tears (Remix) (with Ariana Grande) - Bonus Track', 'The Weeknd', 191],
  ['Happy - From "Despicable Me 2"', 'Pharrell Williams', 233],
]

async function main() {
  for (const [t, a, d] of tracks) {
    await test(t, a, d)
  }
}

main().catch(console.error)
