/**
 * Reproduce the REAL resolveIdentity for "Believer" by Imagine Dragons
 * across a range of incoming durations (to find which Spotify duration
 * makes James Major win). Run: npx tsx tests/repro-believer-real.ts
 */
import { setSearchFunction } from '../src/application/SearchEngine'
import { searchYouTube } from '../src/main/services/innertube'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'

setSearchFunction(async (query: string) => {
  const results = await searchYouTube(query)
  return results.map((r: any) => ({
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

async function run(duration: number) {
  try {
    const track = await TrackIdentityEngine.resolveIdentity({
      title: 'Believer',
      artist: 'Imagine Dragons',
      duration,
    })
    const uploader = (track.artist || '').toLowerCase()
    const isJames = uploader.includes('james')
    const isCorrect =
      uploader.includes('imagine') ||
      track.title.toLowerCase().includes('imagine dragons') ||
      track.channelType === 'verified_topic' ||
      track.channelType === 'verified_artist'
    console.log(
      `dur=${duration}s => "${track.title}" | uploader="${track.artist}" chType=${track.channelType} | JAMES=${isJames ? 'YES!!' : 'no'} correct=${isCorrect ? 'yes' : 'NO'}`
    )
  } catch (e: any) {
    console.log(`dur=${duration}s => ERROR: ${e.message}`)
  }
}

async function main() {
  // Try a wide range of plausible Spotify durations for Believer
  for (let d = 190; d <= 215; d++) {
    await run(d)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
