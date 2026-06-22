/**
 * Debug Innertube resolve failures
 *
 * Usage: npx tsx tests/debug-innertube.ts
 */
import { resolveViaInnerTube, warmInnerTube, searchYouTube } from '../src/main/services/innertube'

async function test() {
  console.log('Warming Innertube...')
  const warmStart = Date.now()
  await warmInnerTube()
  console.log(`Warm done in ${Date.now() - warmStart}ms\n`)

  // Test known-good video IDs
  const ids = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', 'JGwWNGJdvx8']
  for (const id of ids) {
    try {
      console.log(`Resolving ${id}...`)
      const t0 = Date.now()
      const result = await resolveViaInnerTube(id)
      const elapsed = Date.now() - t0
      if (result) {
        console.log(`  ✅ SUCCESS: ${elapsed}ms`)
        console.log(`  Title: ${result.title}`)
        console.log(`  Duration: ${result.duration}s`)
        console.log(`  URL: ${result.streamingUrl.substring(0, 80)}...`)
      } else {
        console.log(`  ❌ FAILED: ${elapsed}ms — returned null`)
      }
    } catch (err: any) {
      console.log(`  💥 ERROR: ${err.message}`)
    }
    console.log()
  }

  // Also test search to verify Innertube session works at all
  console.log('--- Testing search ---')
  const searchStart = Date.now()
  const results = await searchYouTube('Rick Astley')
  console.log(`Search took ${Date.now() - searchStart}ms, got ${results.length} results`)
  if (results.length > 0) {
    const r = results[0]
    console.log(`  First result: ${r.videoId} — ${r.title}`)
    
    // Try to resolve the search result's video ID
    console.log(`\nResolving search result ${r.videoId}...`)
    const t0 = Date.now()
    const result = await resolveViaInnerTube(r.videoId)
    const elapsed = Date.now() - t0
    if (result) {
      console.log(`  ✅ SUCCESS: ${elapsed}ms`)
    } else {
      console.log(`  ❌ FAILED: ${elapsed}ms — returned null`)
    }
  }

  console.log('\nDone')
}

test().catch((err) => { console.error('FATAL:', err); process.exit(1) })
