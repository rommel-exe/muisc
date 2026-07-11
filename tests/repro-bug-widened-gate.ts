/**
 * Verify the fix recovers the correct artist via the widened-gate fallback.
 * Candidate pool includes BOTH James Major (202s, within tight gate) and an
 * Imagine Dragons upload (209s, outside tight gate but within ±10s).
 * Before the fix James Major wins (wrong artist). After the fix, the
 * contradictory James Major is rejected and the widened gate recovers Imagine Dragons.
 * Run: npx tsx tests/repro-bug-widened-gate.ts
 */
import { setSearchFunction } from '../src/application/SearchEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'

function mockSearch(_query: string) {
  return Promise.resolve([
    {
      id: 'jamesMajorId',
      title: 'Believer',
      artist: 'James Major - Topic',
      duration: 202,
      thumbnailUrl: '',
      source: 'youtube' as const,
      sourceId: 'jamesMajorId',
      channelType: 'verified_topic',
    },
    {
      id: 'imagineDragonsId',
      title: 'Imagine Dragons - Believer (Official Music Video)',
      artist: 'ImagineDragons',
      duration: 209,
      thumbnailUrl: '',
      source: 'youtube' as const,
      sourceId: 'imagineDragonsId',
      channelType: 'user_upload',
    },
  ])
}

setSearchFunction(mockSearch)

async function main() {
  try {
    const track = await TrackIdentityEngine.resolveIdentity({
      title: 'Believer',
      artist: 'Imagine Dragons',
      duration: 204,
    })
    const uploader = (track.artist || '').toLowerCase()
    const isJames = uploader.includes('james')
    const isCorrect = track.title.toLowerCase().includes('imagine dragons') || uploader.includes('imagine')
    console.log(
      `RESULT: "${track.title}" | uploader="${track.artist}" | JAMES=${isJames ? 'YES (BUG)' : 'no'} correct=${isCorrect ? 'YES ✓' : 'NO'}`
    )
  } catch (e: any) {
    console.log(`RESULT: threw -> ${e.message}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
