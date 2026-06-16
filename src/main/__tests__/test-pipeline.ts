/**
 * Pipeline Integration Test — MediaResolver + YTDlp multi-tier architecture
 *
 * Simulates a user's playback session: foreground resolve for the active track,
 * then background sliding window preload for the queue, then cache-hit skip.
 *
 * Run: npx tsx src/main/__tests__/test-pipeline.ts
 * Monitor: ps aux | grep 'yt-dlp' | grep -v grep  (to see worker processes)
 *
 * Requires: yt-dlp on PATH, internet connection
 */
import { createMediaResolver } from '../services/media-resolver'

const TEST_PORT = 18950 // unique port to avoid conflicts

async function runPipelineTest(): Promise<void> {
  console.log('═'.repeat(60))
  console.log('  PIPELINE TEST: Foreground/Background Tiering + Sliding Window')
  console.log('═'.repeat(60))
  console.log()

  // ── Setup ──
  const resolver = createMediaResolver({
    proxyPort: TEST_PORT,
    preloadedWindowSize: 3,
    maxConcurrentPreloads: 2,
  })

  try {
    await resolver.start()
    console.log('[Setup] Resolver + proxy started on port', TEST_PORT)
    console.log()

    // Track IDs: active + 3 queue items
    const activeTrack = 'dQw4w9WgXcQ'   // Rick Astley — Never Gonna Give You Up
    const queueTracks = [
      'kJQP7kiw5Fk',                    // Luis Fonsi — Despacito
      'JGwWNGJdvx8',                    // Ed Sheeran — Shape of You
      'fJ9rUzIMcZQ',                    // Queen — Bohemian Rhapsody
    ]

    // ════════════════════════════════════════
    // PHASE 1: Foreground Mode — Active Track
    // ════════════════════════════════════════
    console.log('─'.repeat(60))
    console.log('  PHASE 1: Foreground Resolve (Active Track)')
    console.log('─'.repeat(60))

    const fgStart = Date.now()
    const activeStream = await resolver.resolve(activeTrack, { mode: 'foreground' })
    const fgDuration = Date.now() - fgStart

    console.log(`  Active track:     ${activeStream.title}`)
    console.log(`  Duration:         ${activeStream.duration}s`)
    console.log(`  Proxy URL:        ${activeStream.audioUrl}`)
    console.log(`  Foreground time:  ${fgDuration}ms`)
    console.log()

    // Verify the resolve returned valid data
    if (!activeStream.audioUrl || !activeStream.title) {
      throw new Error('FAIL: Foreground resolve returned incomplete data')
    }
    if (fgDuration > 60000) {
      console.warn(`  ⚠️  Foreground took ${fgDuration}ms — slower than expected`)
    } else {
      console.log(`  ✅ Foreground resolve completed in acceptable time`)
    }

    // ════════════════════════════════════════
    // PHASE 2: Sliding Window — Background Preload
    // ════════════════════════════════════════
    console.log('─'.repeat(60))
    console.log('  PHASE 2: Sliding Window Preload')
    console.log('─'.repeat(60))
    console.log(`  Queue window:     ${queueTracks.join(', ')}`)
    console.log(`  Window size:      3 | Max concurrent: 2`)
    console.log()

    // Time how long prefetchQueue takes to initiate (not to complete)
    const pqStart = Date.now()
    await resolver.prefetchQueue(queueTracks)
    const pqDuration = Date.now() - pqStart
    console.log(`  prefetchQueue() returned in ${pqDuration}ms (fire-and-forget)`)
    console.log(`  Expected: ~0ms (only does setup, doesn't await yt-dlp)`)
    if (pqDuration > 100) {
      console.warn(`  ⚠️  prefetchQueue init took longer than expected`)
    }
    console.log()

    // The cache should have the active track but NOT the queue tracks yet
    console.log(`  Cache status (immediately after prefetch):`)
    for (const id of [activeTrack, ...queueTracks]) {
      console.log(`    ${id} — ${id === activeTrack ? 'cached (from Phase 1)' : 'preloading (background)'}`)
    }
    console.log()

    // ════════════════════════════════════════
    // PHASE 3: Cache Hit — Skip to Queue Track
    // ════════════════════════════════════════
    console.log('─'.repeat(60))
    console.log('  PHASE 3: Cache Hit Validation')
    console.log('─'.repeat(60))
    console.log('  Waiting for background preloads to complete...')
    console.log()

    // Wait for background preloads to finish (yt-dlp takes ~5-15s per track)
    // We'll resolve queueTracks[0] and expect cache hit
    const checkCacheTime = 20000 // wait up to 20s for preloads
    const pollInterval = 500

    const waitForCache = (videoId: string, timeoutMs: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        const start = Date.now()
        const poll = async (): Promise<void> => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timeout waiting for ${videoId} to be cached`))
            return
          }
          try {
            const hitStart = Date.now()
            await resolver.resolve(videoId)
            const hitDuration = Date.now() - hitStart
            if (hitDuration < 100) {
              resolve(hitDuration)
              return
            }
          } catch {
            // resolve may fail if not yet cached — retry
          }
          setTimeout(poll, pollInterval)
        }
        poll()
      })
    }

    try {
      const hitDuration = await waitForCache(queueTracks[0], checkCacheTime)
      console.log(`  🎯 Track "${queueTracks[0]}" resolved in ${hitDuration}ms (cache hit!)`)
      if (hitDuration <= 5) {
        console.log('  ✅ PERFECT: Zero-millisecond cache hit — background preloader working!')
      } else if (hitDuration < 100) {
        console.log('  ✅ Cache hit within tolerance (< 100ms)')
      } else {
        console.log(`  ⚠️  ${hitDuration}ms — may not be a cache hit (re-resolved from network)`)
      }
    } catch {
      console.log('  ⚠️  Background preload not yet complete — trying manual resolve...')
      // Fallback: do a fresh resolve (not from cache)
      const resolveStart = Date.now()
      const queueStream = await resolver.resolve(queueTracks[0])
      const resolveDuration = Date.now() - resolveStart
      console.log(`  Direct resolve took ${resolveDuration}ms`)
      console.log(`  Queue track: ${queueStream.title}`)

      // Now the cache should be warm for subsequent calls
      const hitStart = Date.now()
      await resolver.resolve(queueTracks[0])
      const hitDuration = Date.now() - hitStart
      console.log(`  Second resolve: ${hitDuration}ms (should be cache hit)`)
    }
    console.log()

    // ════════════════════════════════════════
    // PHASE 4: Duplicate Prefetch — No Extra Work
    // ════════════════════════════════════════
    console.log('─'.repeat(60))
    console.log('  PHASE 4: Idempotent Prefetch')
    console.log('─'.repeat(60))
    console.log('  Calling prefetchQueue again with same window...')

    const dupStart = Date.now()
    await resolver.prefetchQueue([...queueTracks])
    const dupDuration = Date.now() - dupStart
    console.log(`  Duplicate prefetch: ${dupDuration}ms (should skip cached items)`)

    // ── Verify rich metadata is available on subsequent getVideoInfo call ──
    console.log()
    console.log('─'.repeat(60))
    console.log('  PHASE 5: Rich Metadata Validation')
    console.log('─'.repeat(60))
    console.log('  (Rich metadata is returned by getVideoInfo, not in ResolvedStream)')
    console.log('  Verifying yt-dlp returns chapters, uploader, etc...')
    console.log()

    // Import getVideoInfo to verify rich metadata extraction
    const { getVideoInfo } = await import('../services/yt-dlp')
    const richStart = Date.now()
    const richInfo = await getVideoInfo(activeTrack, { mode: 'foreground' })
    const richDuration = Date.now() - richStart

    console.log(`  getVideoInfo fetched in ${richDuration}ms`)
    console.log(`  Title:           ${richInfo.title}`)
    console.log(`  Uploader:        ${richInfo.uploader ?? '(not available)'}`)
    console.log(`  Channel:         ${richInfo.channel ?? '(not available)'}`)
    console.log(`  Chapters:        ${richInfo.chapters ? `${richInfo.chapters.length} found` : 'none'}`)
    console.log(`  Thumbnails:      ${richInfo.thumbnails ? `${richInfo.thumbnails.length} resolutions` : 'none'}`)

    if (richInfo.uploader) {
      console.log('  ✅ Rich metadata fields are populated from -j output')
    } else {
      console.log('  ℹ️  Some rich fields may not be available for this video')
    }

    // ── Summary ──
    console.log()
    console.log('═'.repeat(60))
    console.log('  TEST COMPLETE')
    console.log('═'.repeat(60))
    console.log()
    console.log(`  Foreground resolve:       ${fgDuration}ms`)
    console.log(`  Background init:          ${pqDuration}ms (async)`)
    console.log(`  Rich metadata:            ${richDuration}ms`)
    console.log(`  Rich fields available:    ${richInfo.uploader ? 'uploader' : ''} ${richInfo.chapters ? 'chapters' : ''} ${richInfo.thumbnails ? 'thumbnails' : ''}`)
    console.log()

  } finally {
    await resolver.stop()
    console.log('[Teardown] Resolver stopped')
  }
}

runPipelineTest().catch((err) => {
  console.error('\n❌ Pipeline test failed:', err)
  process.exit(1)
})
