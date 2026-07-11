/**
 * Deterministic reproduction of the "Believer -> James Major" bug.
 * Simulates the rate-limited import scenario where the ONLY candidate that
 * survives the duration gate is James Major's Topic-channel upload.
 * Run: npx tsx tests/repro-bug-sole-survivor.ts
 */
import { setSearchFunction } from '../src/application/SearchEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'
import { isCandidateContradictory } from '../src/application/layers/identity-resolution'

// Mock search that returns ONLY James Major's Topic upload (simulating the
// rate-limited import where Imagine Dragons verified candidates were dropped).
function mockSearch(_query: string) {
  return Promise.resolve([
    {
      id: 'qJt5nqsQvjc',
      title: 'Believer',
      artist: 'James Major - Topic',
      duration: 202,
      thumbnailUrl: '',
      source: 'youtube' as const,
      sourceId: 'qJt5nqsQvjc',
      channelType: 'verified_topic',
    },
  ])
}

setSearchFunction(mockSearch)

async function main() {
  // Show the contradiction check result for the sole candidate
  const contradict = isCandidateContradictory(
    {
      rawTitle: 'Believer',
      uploader: 'James Major - Topic',
      channelType: 'verified_topic',
      isTopic: true,
      channelVerified: true,
      canonicalTitle: 'believer',
    } as any,
    'Imagine Dragons'
  )
  console.log(`isCandidateContradictory(James Major - Topic, Imagine Dragons) = ${contradict}`)

  try {
    const track = await TrackIdentityEngine.resolveIdentity({
      title: 'Believer',
      artist: 'Imagine Dragons',
      duration: 204,
    })
    const uploader = (track.artist || '').toLowerCase()
    const isJames = uploader.includes('james')
    console.log(
      `RESULT: "${track.title}" | uploader="${track.artist}" chType=${track.channelType} | JAMES WINS=${isJames ? 'YES !!! BUG' : 'no'}`
    )
  } catch (e: any) {
    console.log(`RESULT: threw -> ${e.message}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
