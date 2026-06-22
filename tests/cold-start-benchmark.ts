/**
 * Cold-Start 100-Track Benchmark
 *
 * Measures the end-to-end time from clicking a track to receiving the first
 * byte of audio from the local proxy. This directly captures the user-visible
 * cold-start: proxy resolves the YouTube stream URL -> pipes CDN audio -> first byte.
 *
 * The daemon (warm at startup) extracts stream URLs in ~400ms. CDN TTFB adds
 * ~200ms. Total cold-start should be < 1000ms.
 *
 * Pass condition: average < 1000ms across 100 unique tracks
 *
 * Usage: npx tsx tests/cold-start-benchmark.ts
 */
import http from 'node:http'
import { createMediaResolver } from '../src/main/services/media-resolver'

const TEST_PORT = 18952
const PROXY_URL = `http://localhost:${TEST_PORT}`

const TRACK_IDS = [
  'dQw4w9WgXcQ', 'fJ9rUzIMcZQ', 'kJQP7kiw5Fk', 'JGwWNGJdvx8', 'OPf0YbXqDm0',
  'RgKAFK5djSk', 'lp-EO5I60KA', 'HP-MbfHFUqs', 'CevxZvSJLk8', 'kTHNpusq654',
  'hT_nvWreIhg', 'YVkUvmDQ3HY', 'qrO4YZeyl0I', 'VuNIsY6JdUw', 'pRpeEdMmmQ0',
  'yyDUC1LUXSU', '09R8_2nJtjg', '9bZkp7q19f0', 'IcrbM1l_BoI', 'M11SvDtPBhA',
  '7PCkvCPvDXk', 'v1c2OfAzDTI', 'y6Sxv-sUYtM', 'F90Cw4l-8NY', 'ktvTqknDobU',
  '1G4isv_Fylg', 'lDK9QqIzhwk', 'iS1g8G_njx8', 'iP6XpLQM2Cs', 'fRh_vgS2dFE',
  'pXRviuL6vMY', '9Ht5RZpzPqw', 'Mx_OexsUI2M', 'hHUbLv4ThOo', 'VPRjCeoBqrI',
  'r7qovpFAGrQ', 'k2qgadSvNyU', '1w7OgIMMRc4', 'ByXuk9QqQkk', 'DkeiKbqa02g',
  'BQ0mxQXmLsk', 'XqZsoesa55w', 'q0hyYWKXF0Q', 'Ks-_Mh1QhMc', 'YQHsXMglC9A',
  'kffacxfA7G4', 'QLCpqdqeoII', 'e-fA-gBCkj0', 'LjhCEhWiKXk', '5qm8PH4xAss',
  '60ItHLz5WEA', 'YgSPaXgAdzE', 'DK_0jXPuIr0', 'oavMtUWDBTM', 'mWRsgZuwf_8',
  'JmcA9LIIXWw', 'ghb6eDopW8I', 'erG5rgNYSdk', 'gAjR4_CbPpQ', 'G7KNmW9a75Y',
  '5NV6Rdv1a3I',
  'mNEUkkoUoIA', 'O2CIAKVTOrc', 'b1kbLwvqugk', 'fLexgOxsZu0',
  'hOyn0bCydZo', 'UqyT8IEBkvY', 'OiC1rgCPmUQ', 'uXyxFMbqKYA',
  'jdlCOIaWwTQ', 'xwe8F_AhLY0', 'fCZVL_8D048', 'lA7Bzwhzk-U',
  '4D89Qr5vH6U', 'ZEWGyyLiqY4', 'GC5E8ie2pdM', 'LjpUi1T43-I',
  '7J653nwumcw', 'vp2ZoXIFJfw', 'fTKqtvXjkvo', 'E0Y8OEo_zOc',
  'N6DW31S_oyI', 'HuvGir8xjJU', 'MvctVYj8gZ0', 'zgEpn08w4pM',
  '71xPQE5JSIc', 'rPtxYOyAUKc', 'hpuQC5YcgKU', 'Ym8hNu4DrgI',
  'PSZlMvc4CC8', 'mtWCXT0hRDs', 'U4aDVz1MFrg', 'AREJ5KBLNpo',
  '6q1dQ9iWTo4', 'OtNy5Jdinr4', 'm2BnK_hf2qg', 'kUpdNkHTPug',
  'l8AvkMzUKGA', 'HG17RVdpUvY', 'Bx5r4YtHkHE', '7m5mYiMkKS8',
  'usuBIx1BHQk', 'VeBM2edeRNo', 'eEA-aCFcEt4', 'bSQ1J7qVw7I',
  'PJhccVMTgN4', 'KYnqchTqVE8', 'd65Im0TxfUc', 'b-bK2Vn3D38',
  'UYB4nz6iE9E', 'tLND5ULZoXk', 'L2e8fCBpK6o', 'OE9kjPYejLA',
  'qDa9F5A8Q7Q', 'zIxP-Q-PKdg', 'du2CfeT8M1I', 'obJbLSDsBAY',
  '0rYKbMjtnMo', 'OVMsbS-sHfQ', 'sDQVDBE-wAQ', 'S47PnPdhNBI',
  'k_FVKy9BS4Q', '6un7ZoifFFw', '5GL9JoH4Sws', 'bSe6XXeO7uY',
  'fSqicTTg1Ps', 'lWA2pjMjpBs', 'XXYlFuWEuKI', 'Y902ANbFTSU',
  'bESGLojNYSo', 'Q3puRYUK7Uk', '5vheNbQlsyU',
]

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface TrackResult {
  videoId: string
  /** Time from proxy request start to first audio byte (ms) */
  ttfByteMs: number
  error?: string
}

/** Make a GET request to the proxy /stream endpoint and measure TTFB.
 *  Cancels the request after receiving the first chunk (we only care about timing). */
function measureProxyTtfb(videoId: string, timeoutMs = 15000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const req = http.get(`${PROXY_URL}/stream?v=${videoId}`, (res) => {
      res.once('data', () => {
        const elapsed = Date.now() - t0
        req.destroy()
        resolve(elapsed)
      })
      res.on('error', (err) => {
        req.destroy()
        reject(err)
      })
      const sc = res.statusCode ?? 0
      if (sc !== 200 && sc >= 400) {
        req.destroy()
        reject(new Error(`HTTP ${sc}`))
      }
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error(`Timeout after ${timeoutMs}ms`))
    })
  })
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  muisc Cold-Start 100-Track Benchmark')
  console.log('  Measures: HTTP /stream request -> first audio byte (TTFB)')
  console.log('  Pass:     average TTFB < 1000ms across 100 tracks')
  console.log('═══════════════════════════════════════════════════════')
  console.log()

  const resolver = createMediaResolver({
    proxyPort: TEST_PORT,
    cacheSize: 100,
    cacheTtlMs: 5 * 60 * 60 * 1000,
  })

  try {
    await resolver.start()
    console.log(`[Setup] Resolver + proxy started on ${PROXY_URL}`)

    // Wait for daemon warmup (starts in background from resolver.start())
    console.log('Waiting for daemon warmup (4s)...')
    await sleep(4000)
    console.log('[Warmup] Daemon should be ready')
    console.log()

    const uniqueIds = dedupe(TRACK_IDS)
    console.log(`Testing ${uniqueIds.length} unique tracks`)
    console.log()

    // Warmup: use a videoId NOT in the test set to avoid prewarm HIT on track 1
    const WARMUP_ID = 'Mk1Hpgoqfxo'
    console.log('  [warmup] Pre-resolving warmup track to settle daemon...')
    await resolver.warmupVideo(WARMUP_ID).catch(() => {})
    await sleep(2000)
    console.log('  [warmup] Done')
    console.log()

    const results: TrackResult[] = []
    const overallStart = Date.now()

    for (let i = 0; i < uniqueIds.length; i++) {
      const videoId = uniqueIds[i]
      const num = i + 1
      process.stdout.write(`  [${num}/${uniqueIds.length}] ${videoId}... `)

      try {
        resolver.clearCache(videoId)
        resolver.warmupVideo(videoId).catch(() => {})

        const ttfb = await measureProxyTtfb(videoId)

        results.push({ videoId, ttfByteMs: ttfb })
        process.stdout.write(`\x1b[32m${ttfb}ms\x1b[0m\n`)
      } catch (err: any) {
        results.push({ videoId, ttfByteMs: -1, error: err.message })
        process.stdout.write(`\x1b[31m${err.message}\x1b[0m\n`)
      }
    }

    const overallElapsed = Date.now() - overallStart
    const validResults = results.filter((r) => r.ttfByteMs > 0)

    if (validResults.length === 0) {
      console.log('\n\u274c No valid results - all tracks failed')
      process.exit(1)
    }

    const timings = validResults.map((r) => r.ttfByteMs).sort((a, b) => a - b)
    const avg = Math.round(timings.reduce((s, t) => s + t, 0) / timings.length)
    const min = timings[0]
    const max = timings[timings.length - 1]
    const median = timings.length % 2 === 0
      ? Math.round((timings[timings.length / 2 - 1] + timings[timings.length / 2]) / 2)
      : timings[Math.floor(timings.length / 2)]
    const p95 = timings[Math.floor(timings.length * 0.95)]
    const p99 = timings[Math.floor(timings.length * 0.99)]

    const passCount = timings.filter((t) => t < 1000).length
    const passRate = Math.round((passCount / timings.length) * 100)

    console.log()
    console.log('═══════════════════════════════════════════════════════')
    console.log('  RESULTS')
    console.log('═══════════════════════════════════════════════════════')
    console.log(`  Total tracks:                ${uniqueIds.length}`)
    console.log(`  Successful proxy responses:  ${validResults.length}`)
    console.log(`  Failed:                      ${results.length - validResults.length}`)
    console.log(`  Total benchmark time:        ${Math.round(overallElapsed / 1000)}s`)
    console.log()
    console.log(`  Cold-start TTFB (ms):`)
    console.log(`    min:    ${min}`)
    console.log(`    median: ${median}`)
    console.log(`    avg:    ${avg}`)
    console.log(`    max:    ${max}`)
    console.log(`    p95:    ${p95}`)
    console.log(`    p99:    ${p99}`)
    console.log()
    console.log(`  Pass rate (TTFB < 1000ms):   ${passRate}% (${passCount}/${timings.length})`)
    console.log(`  Verdict:                     ${avg < 1000 ? '\x1b[32m\u2705 PASS\x1b[0m' : '\x1b[31m\u274c FAIL\x1b[0m'} (avg ${avg}ms)`)
    console.log()

    // Histogram
    console.log('  Histogram (TTFB):')
    const binSize = 100
    const bins: Record<number, number> = {}
    for (const t of timings) {
      const bin = Math.floor(t / binSize) * binSize
      bins[bin] = (bins[bin] || 0) + 1
    }
    const maxCount = Math.max(...Object.values(bins), 1)
    for (const [bin, count] of Object.entries(bins).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const bar = '\u2588'.repeat(Math.round((count / maxCount) * 30))
      const pass = Number(bin) + binSize < 1000
      const color = pass ? '\x1b[32m' : '\x1b[31m'
      console.log(`    ${String(bin).padStart(5)}-${Number(bin) + binSize - 1}ms: ${color}${bar} ${count}\x1b[0m`)
    }

    console.log()
    process.exit(avg < 1000 ? 0 : 1)
  } catch (err: any) {
    console.error('\n\u274c Benchmark failed:', err.message)
    process.exit(1)
  } finally {
    await resolver.stop().catch(() => {})
  }
}

main()
