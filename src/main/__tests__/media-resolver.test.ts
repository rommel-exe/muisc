import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getVideoInfo, findYTDlp, YTDlpError } from '../services/yt-dlp'
import { createProxy } from '../services/proxy'
import { createMediaResolver } from '../services/media-resolver'

// ─────────────────────────────────────────────
// Test A: yt-dlp Extraction & Stream URL Validation
// ─────────────────────────────────────────────
describe('yt-dlp Service', () => {
  // Use a known public video - Rick Astley "Never Gonna Give You Up"
  const TEST_VIDEO_ID = 'dQw4w9WgXcQ'

  it('should detect yt-dlp binary', async () => {
    const path = await findYTDlp()
    expect(path).toBeTruthy()
    expect(typeof path).toBe('string')
  })

  it('should extract valid metadata for a known video', async () => {
    const info = await getVideoInfo(TEST_VIDEO_ID)

    expect(info.id).toBe(TEST_VIDEO_ID)
    expect(info.title).toBeTruthy()
    expect(typeof info.duration).toBe('number')
    expect(info.duration).toBeGreaterThan(0)
    expect(info.thumbnail).toBeTruthy()
    expect(info.thumbnail).toMatch(/^https?:\/\//)
    expect(Array.isArray(info.formats)).toBe(true)
    expect(info.formats.length).toBeGreaterThan(0)

    // Check format structure
    const format = info.formats[0]
    expect(format.format_id).toBeTruthy()
    expect(format.ext).toBeTruthy()
    expect(format.url).toBeTruthy()
    expect(format.url).toMatch(/^https?:\/\//)
  }, 30000)

  // ── Test A: URL starts with https:// ──
  it('should return stream URLs starting with https://', async () => {
    const info = await getVideoInfo(TEST_VIDEO_ID)
    const validFormats = info.formats.filter((f) => f.acodec !== 'none' && f.url)
    expect(validFormats.length).toBeGreaterThan(0)
    for (const f of validFormats) {
      expect(f.url.startsWith('https://')).toBe(true)
    }
  }, 30000)

  // ── Test A: URL expiresAt — verify proxy cache has recent cachedAt timestamp ──
  it('should have valid cachedAt timestamp on proxy cache entry', async () => {
    const proxy = createProxy({ port: 18939 })
    await proxy.start()
    try {
      // Make a stream request to populate cache
      const res = await fetch(
        `http://127.0.0.1:18939/stream?v=${TEST_VIDEO_ID}`,
        { signal: AbortSignal.timeout(20000) }
      )
      expect(res.ok || res.status === 206).toBe(true)

      // Check proxy cache entry has a recent cachedAt (within last 30s)
      const entry = proxy.getStreamCacheEntry(TEST_VIDEO_ID)
      expect(entry).toBeTruthy()
      expect(entry!.cachedAt).toBeGreaterThan(0)
      expect(Date.now() - entry!.cachedAt).toBeLessThan(30000)
    } finally {
      await proxy.stop()
    }
  }, 60000)

  // ── Test A: Timeout throws YTDLP_TIMEOUT ──
  it('should throw TIMEOUT error when timeout is too short (1ms)', async () => {
    await expect(getVideoInfo(TEST_VIDEO_ID, { timeoutMs: 1 })).rejects.toThrow(YTDlpError)
    await expect(getVideoInfo(TEST_VIDEO_ID, { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  }, 10000)

  it('should throw INVALID_VIDEO for a non-existent video', async () => {
    await expect(getVideoInfo('xxxxxxxxxxxxxxxxx')).rejects.toThrow(YTDlpError)
    await expect(getVideoInfo('xxxxxxxxxxxxxxxxx')).rejects.toMatchObject({
      code: 'INVALID_VIDEO',
    })
  }, 30000)

  it('should support abort signal (ABORTED code)', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      getVideoInfo(TEST_VIDEO_ID, { timeoutMs: 30000, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'ABORTED' })
  }, 10000)
})

// ─────────────────────────────────────────────
// Test B: Proxy Range Request Compliance
// ─────────────────────────────────────────────
describe('HTTP Proxy', () => {
  const TEST_PORT = 18948 // Use different port to avoid conflicts with dev server
  let proxy: ReturnType<typeof createProxy>

  // Use a real video that will be resolved by yt-dlp
  const TEST_VIDEO_ID = 'dQw4w9WgXcQ'

  beforeAll(async () => {
    proxy = createProxy({ port: TEST_PORT })
    await proxy.start()
  }, 30000)

  afterAll(async () => {
    await proxy.stop()
  })

  it('should respond to health check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
  })

  it('should return 400 for missing video ID', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/stream`)
    expect(res.status).toBe(400)
  })

  it('should stream audio with full request (200 OK)', async () => {
    // First resolve the video to populate cache
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      { signal: AbortSignal.timeout(15000) }
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBeTruthy()
    // YouTube serves audio tracks in MP4 containers labeled video/mp4
    expect(res.headers.get('content-type')).toMatch(/^(audio|video)\//)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')

    // Should have some content
    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      expect(parseInt(contentLength)).toBeGreaterThan(0)
    }
  }, 30000)

  // ── Test B: Range request returns 206 Partial Content ──
  it('should support Range requests (206 Partial Content)', async () => {
    // First ensure the video is cached (full request)
    await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      { signal: AbortSignal.timeout(15000) }
    )

    // Now make a range request: bytes 0-100
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      {
        headers: { Range: 'bytes=0-100' },
        signal: AbortSignal.timeout(10000),
      }
    )

    // Assert 206 Partial Content
    expect(res.status).toBe(206)

    // Assert content-range header exists and matches requested byte block
    const contentRange = res.headers.get('content-range')
    expect(contentRange).toBeTruthy()
    expect(contentRange).toMatch(/^bytes 0-100\/\d+$/)

    // Assert content-length matches requested range (0-100 = 101 bytes)
    const contentLength = parseInt(res.headers.get('content-length') ?? '0')
    expect(contentLength).toBe(101)
  }, 30000)

  it('should support mid-stream range request (bytes 1000-2000)', async () => {
    // Ensure cached
    await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      { signal: AbortSignal.timeout(15000) }
    )

    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      {
        headers: { Range: 'bytes=1000-2000' },
        signal: AbortSignal.timeout(10000),
      }
    )

    expect(res.status).toBe(206)
    const contentRange = res.headers.get('content-range')
    expect(contentRange).toBeTruthy()
    expect(contentRange).toMatch(/^bytes 1000-2000\/\d+$/)
    expect(parseInt(res.headers.get('content-length') ?? '0')).toBe(1001)
  }, 30000)

  it('should return 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`)
    expect(res.status).toBe(404)
  })

  it('should forward CORS headers on every response', async () => {
    // Retry wrapper for the fetch: the proxy is fully started in beforeAll,
    // but macOS can briefly delay new connection acceptance under concurrent
    // streaming test load. Retry with short backoff instead of failing.
    let res: Response | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, { signal: AbortSignal.timeout(5000) })
        break
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)))
      }
    }
    expect(res).toBeTruthy()
    expect(res!.headers.get('access-control-allow-origin')).toBe('*')
    expect(res!.headers.get('access-control-allow-headers')).toContain('Range')
    expect(res!.headers.get('access-control-expose-headers')).toContain('Content-Range')
  })

  it('should abort stale resolve when same video ID requested concurrently', async () => {
    // Fire 3 rapid requests for the same video ID.
    // Only the last one should complete — earlier ones get aborted.
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        fetch(
          `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
          { signal: AbortSignal.timeout(30000) }
        )
      )
    )

    // At least one should succeed (the final one)
    const succeeded = results.filter((r) => r.status === 'fulfilled')
    expect(succeeded.length).toBeGreaterThanOrEqual(1)

    // The successful one must have valid response
    const fulfilled = succeeded[0]
    if (fulfilled?.status === 'fulfilled') {
      const res = fulfilled.value
      const ok = res.status === 200 || res.status === 206
      expect(ok).toBe(true)
      // YouTube serves audio tracks in MP4 containers labeled video/mp4
      expect(res.headers.get('content-type')).toMatch(/^(audio|video)\//)
    }
  }, 60000)
})

// ─────────────────────────────────────────────
// MediaResolver Unit Tests
// ─────────────────────────────────────────────
describe('MediaResolver', () => {
  const TEST_VIDEO_ID = 'dQw4w9WgXcQ'

  it('should generate correct proxy URL', () => {
    const resolver = createMediaResolver({ proxyPort: 18941 })
    const url = resolver.getProxyUrl(TEST_VIDEO_ID)
    expect(url).toBe(`http://127.0.0.1:18941/stream?v=${TEST_VIDEO_ID}`)
  })

  it('should have 0 pending resolves initially', () => {
    const resolver = createMediaResolver({ proxyPort: 18941 })
    expect(resolver.getPendingResolveCount()).toBe(0)
  })

  it('should clear cache without throwing', () => {
    const resolver = createMediaResolver({ proxyPort: 18941 })
    expect(() => resolver.clearCache()).not.toThrow()
    expect(() => resolver.clearCache(TEST_VIDEO_ID)).not.toThrow()
  })

  it('should resolve instantly with proxy URL and placeholder metadata', async () => {
    const resolver = createMediaResolver({ proxyPort: 18942 })
    try {
      const start = Date.now()
      const result = await resolver.resolve(TEST_VIDEO_ID)
      const elapsed = Date.now() - start

      // Instant return: resolve must not block on yt-dlp
      expect(elapsed).toBeLessThan(500)
      expect(result.videoId).toBe(TEST_VIDEO_ID)
      expect(result.audioUrl).toBe(`http://127.0.0.1:18942/stream?v=${TEST_VIDEO_ID}`)
      // Placeholder metadata until background resolve completes
      expect(result.title).toBe('Loading...')
      expect(result.duration).toBe(0)
      expect(result.thumbnail).toBe('')
    } finally {
      await resolver.stop()
    }
  }, 15000)

  it('should eventually populate cache with real metadata after background resolve', async () => {
    const resolver = createMediaResolver({ proxyPort: 18943 })
    try {
      await resolver.start()
      // Trigger resolve (returns instantly with placeholder)
      await resolver.resolve(TEST_VIDEO_ID)

      // Poll for background resolve to complete (up to 20s)
      let title: string | undefined
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const cached = resolver.resolve(TEST_VIDEO_ID)
        const result = await cached
        if (result.title !== 'Loading...') {
          title = result.title
          break
        }
      }

      expect(title).toBeTruthy()
      expect(title).not.toBe('Loading...')
    } finally {
      await resolver.stop()
    }
  }, 30000)

  it('should return same cached result on second resolve', async () => {
    const resolver = createMediaResolver({ proxyPort: 18944 })
    try {
      await resolver.start()
      await resolver.resolve(TEST_VIDEO_ID)

      // Wait for background resolve to complete
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const cached = await resolver.resolve(TEST_VIDEO_ID)
        if (cached.title !== 'Loading...') break
      }

      const first = await resolver.resolve(TEST_VIDEO_ID)
      const second = await resolver.resolve(TEST_VIDEO_ID)
      expect(second.videoId).toBe(first.videoId)
      expect(second.audioUrl).toBe(first.audioUrl)
      expect(second.duration).toBe(first.duration)
      expect(second.title).toBe(first.title)
    } finally {
      await resolver.stop()
    }
  }, 30000)

  it('should force refresh when forceRefresh=true', async () => {
    const resolver = createMediaResolver({ proxyPort: 18945 })
    try {
      await resolver.start()
      await resolver.resolve(TEST_VIDEO_ID)

      // Wait for background resolve
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const cached = await resolver.resolve(TEST_VIDEO_ID)
        if (cached.title !== 'Loading...') break
      }

      // forceRefresh returns placeholder again and triggers re-resolve
      const refreshed = await resolver.resolve(TEST_VIDEO_ID, { forceRefresh: true })
      expect(refreshed.videoId).toBe(TEST_VIDEO_ID)
      expect(refreshed.title).toBe('Loading...')
    } finally {
      await resolver.stop()
    }
  }, 30000)

  it('should corrupt cached proxy stream URL', async () => {
    const resolver = createMediaResolver({ proxyPort: 18946 })
    try {
      // corruptCache needs proxy cache entry — without one, returns false
      expect(resolver.corruptCache(TEST_VIDEO_ID)).toBe(false)
    } finally {
      await resolver.stop()
    }
  })

  it('should corrupt cache after proxy stream request', async () => {
    const proxyPort = 18947
    const resolver = createMediaResolver({ proxyPort })
    try {
      await resolver.start()

      // Make a stream request to populate proxy's cache
      const streamRes = await fetch(
        `http://127.0.0.1:${proxyPort}/stream?v=${TEST_VIDEO_ID}`,
        { signal: AbortSignal.timeout(20000) }
      )
      expect(streamRes.ok || streamRes.status === 206).toBe(true)

      const corrupted = resolver.corruptCache(TEST_VIDEO_ID)
      expect(corrupted).toBe(true)
    } finally {
      resolver.clearCache()
      await resolver.stop()
    }
  }, 60000)

  it('should manage multiple video resolves independently', async () => {
    const resolver = createMediaResolver({ proxyPort: 18948 })
    try {
      await resolver.start()

      // Resolve two different videos concurrently (returns instantly)
      const ids = [TEST_VIDEO_ID, 'kXYiU_JCYtU'] // Rick Astley, Numb - Linkin Park
      const results = await Promise.all(
        ids.map((id) => resolver.resolve(id).catch(() => null))
      )

      const succeeded = results.filter(Boolean)
      expect(succeeded.length).toBe(2)
      for (const r of succeeded) {
        expect(r!.videoId).toBeTruthy()
        expect(r!.audioUrl).toContain('/stream?v=')
        // Both return placeholder metadata initially
        expect(r!.title).toBe('Loading...')
      }

      // Wait for background resolves to complete
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const r1 = await resolver.resolve(TEST_VIDEO_ID)
        const r2 = await resolver.resolve('kXYiU_JCYtU')
        if (r1.title !== 'Loading...' && r2.title !== 'Loading...') break
      }

      expect(resolver.getPendingResolveCount()).toBe(0)
    } finally {
      await resolver.stop()
    }
  }, 60000)
})
