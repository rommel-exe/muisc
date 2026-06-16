import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getVideoInfo, findYTDlp, YTDlpError } from '../services/yt-dlp'
import { createProxy } from '../services/proxy'

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

  it('should throw TIMEOUT error when timeout is too short', async () => {
    // Set timeout to 1ms - should fail immediately
    await expect(
      getVideoInfo(TEST_VIDEO_ID, 1)
    ).rejects.toThrow()

    try {
      await getVideoInfo(TEST_VIDEO_ID, 1)
    } catch (err) {
      expect(err).toBeInstanceOf(YTDlpError)
      expect((err as YTDlpError).code).toBe('TIMEOUT')
    }
  }, 10000)

  it('should throw INVALID_VIDEO for a non-existent video', async () => {
    await expect(
      getVideoInfo('xxxxxxxxxxxxxxxxx')
    ).rejects.toThrow()

    try {
      await getVideoInfo('xxxxxxxxxxxxxxxxx')
    } catch (err) {
      expect(err).toBeInstanceOf(YTDlpError)
      expect((err as YTDlpError).code).toBe('INVALID_VIDEO')
    }
  }, 30000)

  it('should support abort signal', async () => {
    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    await expect(
      getVideoInfo(TEST_VIDEO_ID, 30000, controller.signal)
    ).rejects.toThrow()

    try {
      await getVideoInfo(TEST_VIDEO_ID, 30000, controller.signal)
    } catch (err) {
      expect(err).toBeInstanceOf(YTDlpError)
      expect((err as YTDlpError).code).toBe('ABORTED')
    }
  }, 10000)
})

describe('HTTP Proxy', () => {
  const TEST_PORT = 18938 // Use different port to avoid conflicts
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
    expect(res.headers.get('content-type')).toMatch(/audio/)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')

    // Should have some content
    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      expect(parseInt(contentLength)).toBeGreaterThan(0)
    }
  }, 30000)

  it('should support Range requests (206 Partial Content)', async () => {
    // First ensure the video is cached
    await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      { signal: AbortSignal.timeout(15000) }
    )

    // Now make a range request
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/stream?v=${TEST_VIDEO_ID}`,
      {
        headers: { Range: 'bytes=0-100' },
        signal: AbortSignal.timeout(10000),
      }
    )

    expect(res.status).toBe(206)

    const contentRange = res.headers.get('content-range')
    expect(contentRange).toBeTruthy()
    expect(contentRange).toMatch(/bytes/)

    const contentLength = parseInt(res.headers.get('content-length') ?? '0')
    expect(contentLength).toBeLessThanOrEqual(101) // 0-100 = 101 bytes
  }, 30000)

  it('should return 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`)
    expect(res.status).toBe(404)
  })
})
