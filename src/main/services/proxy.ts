// src/main/services/proxy.ts

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import dns from 'node:dns'
import { PROXY_PORT } from '../../shared/constants'
import { getVideoInfo, getStreamUrl as subprocessGetUrl, type YTDlpInfo, YTDlpError } from './yt-dlp'
import { getDaemon } from './yt-dlp-daemon'

const PROXY_TIMING_LOGS = true

/** Shared HTTPS agent with keep-alive for CDN connections.
 *  Warms TCP+TLS so subsequent connections to the same CDN edge are faster. */
const cdnAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
})

export interface StreamCache {
  /** CDN stream URL */
  streamUrl: string
  /** Timestamp when cached */
  cachedAt: number
  /** Content-Type from YouTube */
  contentType: string
}

export interface ProxyOptions {
  port?: number
  cacheTtlMs?: number  // default: 5 hours (YouTube URLs last ~6h)
  /** Callback for CDN 403/410 recovery — clears MediaResolver cache and re-resolves stream URL */
  onReResolve?: (videoId: string) => Promise<string>
}

export class ProxyError extends Error {
  constructor(
    message: string,
    public code: 'PORT_IN_USE' | 'STREAM_NOT_FOUND' | 'RESOLVE_FAILED',
    public cause?: Error
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

/**
 * Create and start a local HTTP proxy server.
 * Returns the server instance and helper methods.
 */
export function createProxy(options: ProxyOptions = {}) {
  const {
    port = PROXY_PORT,
    cacheTtlMs = 5 * 60 * 60 * 1000,
    onReResolve,
  } = options

  // In-memory cache: videoId → StreamCache
  const streamCache = new Map<string, StreamCache>()

  // Track in-flight yt-dlp resolves so we can await them instead of duplicating work.
  // Shared with MediaResolver so resolve() can kick off bg work that proxy waits on.
  const pendingResolves = new Map<string, Promise<string>>()
  const pendingControllers = new Map<string, AbortController>()

  const server = http.createServer(async (req, res) => {
    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, cached: streamCache.size }))
      return
    }

    // Stream endpoint: /stream?v=VIDEO_ID
    if (url.pathname === '/stream') {
      const videoId = url.searchParams.get('v')
      if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing video ID' }))
        return
      }

      try {
        const handlerT0 = Date.now()

        // Fast path: prewarm buffer — serve first chunk from RAM, then
        // pipe CDN tail from byte CHUNK_SIZE onwards via Range request.
        const pb = prewarmBuffer.get(videoId)
        if (pb) {
          prewarmBuffer.delete(videoId)
          if (PROXY_TIMING_LOGS) console.log(`[Proxy] Prewarm HIT ${videoId}: ${pb.data.length} bytes`)

          const tPre = Date.now()
          const prewarmContentType = pb.contentType
          const prewarmData = pb.data
          const prewarmDataLen = pb.data.length

          // Write headers + 1MB buffer IMMEDIATELY — browser starts parsing
          // while CDN tail is fetched in parallel
          res.writeHead(200, {
            'Content-Type': prewarmContentType,
            'Access-Control-Allow-Origin': '*',
            'Transfer-Encoding': 'chunked',
          })
          res.write(prewarmData)
          if (PROXY_TIMING_LOGS) console.log(`[Proxy] Prewarm SENT ${videoId}: ${prewarmDataLen}b in ${Date.now()-tPre}ms`)

          // Fetch CDN tail in parallel (Range from buffer end).
          // Handles 403/410 stale URLs via re-resolve & retry.
          // Handles connection errors with one retry attempt.
          const MAX_TAIL_RETRIES = 1
          const initialStreamUrl = await resolveStreamUrl(videoId)

          const doTailFetch = (tailUrl: string, tailAttempt = 0): void => {
            const parsedTailUrl = new URL(tailUrl)
            const tailTransport = parsedTailUrl.protocol === 'https:' ? https : http
            const tailReq = tailTransport.get(tailUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'Referer': 'https://www.youtube.com/',
                'Range': `bytes=${prewarmDataLen}-`,
              },
              agent: parsedTailUrl.protocol === 'https:' ? cdnAgent : undefined,
            }, (tailRes) => {
              if (PROXY_TIMING_LOGS) console.log(`[Proxy] Prewarm TAIL ${videoId}: CDN TTFB=${Date.now()-tPre}ms status=${tailRes.statusCode}`)

              // 403/410 — stale CDN URL, re-resolve and retry fresh
              if (tailRes.statusCode === 403 || tailRes.statusCode === 410) {
                console.log(`[Proxy] Prewarm TAIL ${videoId}: CDN returned ${tailRes.statusCode}, re-resolving...`)
                tailRes.destroy()
                if (tailAttempt < MAX_TAIL_RETRIES) {
                  streamCache.delete(videoId)
                  const resolveFn = onReResolve ?? resolveStreamUrl
                  resolveFn(videoId)
                    .then((newUrl) => doTailFetch(newUrl, tailAttempt + 1))
                    .catch((err) => {
                      console.error(`[Proxy] Prewarm TAIL re-resolve failed for ${videoId}:`, err.message)
                      res.end()
                    })
                } else {
                  res.end()
                }
                return
              }

              // Pipe the CDN tail — audio resumes from the prewarm buffer's end
              tailRes.on('error', (tailErr) => {
                console.warn(`[Proxy] Prewarm TAIL stream error for ${videoId}:`, tailErr.message)
                if (!res.destroyed) res.end()
              })
              tailRes.pipe(res)
            })

            tailReq.on('error', (err) => {
              if (tailAttempt < MAX_TAIL_RETRIES) {
                console.warn(`[Proxy] Prewarm TAIL ${videoId} failed (attempt ${tailAttempt + 1}), retrying...`)
                streamCache.delete(videoId)
                resolveStreamUrl(videoId)
                  .then((newUrl) => doTailFetch(newUrl, tailAttempt + 1))
                  .catch(() => {
                    console.error(`[Proxy] Prewarm TAIL retry resolve failed for ${videoId}`)
                    res.end()
                  })
              } else {
                console.error(`[Proxy] Prewarm TAIL ${videoId} failed after retry:`, err.message)
                res.end()
              }
            })
          }

          doTailFetch(initialStreamUrl)
          return
        }
        console.log(`[Proxy] Prewarm MISS ${videoId} — buffer has ${prewarmBuffer.size} entries`)

        const streamUrl = await resolveStreamUrl(videoId)
        if (!streamUrl) {
          throw new ProxyError(`Empty stream URL for ${videoId}`, 'STREAM_NOT_FOUND')
        }
        if (PROXY_TIMING_LOGS) console.log(`[Proxy] HANDLER ${videoId}: resolve=${Date.now()-handlerT0}ms → proxyStream`)
        proxyStream(streamUrl, videoId, req, res)
      } catch (err: any) {
        console.error(`[Proxy] Failed to stream ${videoId}:`, err.message)
        if (err instanceof YTDlpError && err.code === 'INVALID_VIDEO') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' })
        }
        res.end(JSON.stringify({ error: err.message, code: err.code }))
      }
      return
    }

    // Unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  /**
   * Get or resolve a stream URL for a video ID.
   * Checks cache first, then awaits any in-flight background resolve,
   * and finally starts a new resolve if nothing is pending.
   */
  async function resolveStreamUrl(videoId: string): Promise<string> {
    // 1. Cache hit
    const cached = streamCache.get(videoId)
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return cached.streamUrl
    }

    // 2. There's already a background resolve in-flight — await it
    const pending = pendingResolves.get(videoId)
    if (pending) {
      const url = await pending
      // Re-check cache (resolve populates it)
      const hit = streamCache.get(videoId)
      if (hit) return hit.streamUrl
      return url
    }

    // 3. Nothing pending — start a fresh foreground resolve
    return triggerResolve(videoId)
  }

  /**
   * Internal: run yt-dlp and cache the result.
   * Called by resolveStreamUrl and triggerBackgroundResolve.
   */
  async function triggerResolve(videoId: string): Promise<string> {
    const controller = new AbortController()
    pendingControllers.set(videoId, controller)
    const promise = doResolve(videoId, controller)
    pendingResolves.set(videoId, promise)

    try {
      return await promise
    } finally {
      pendingResolves.delete(videoId)
      pendingControllers.delete(videoId)
    }
  }

  async function doResolve(videoId: string, _controller: AbortController): Promise<string> {
    let lastError: Error | undefined
    // 🏎️ Fast path: warm daemon (2 attempts)
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const daemon = getDaemon()
        const url = await daemon.getStreamUrl(videoId, 15000)
        if (url) {
          streamCache.set(videoId, {
            streamUrl: url,
            cachedAt: Date.now(),
            contentType: 'audio/mp4',
          })
          return url
        }
        throw new ProxyError('No stream URL returned', 'STREAM_NOT_FOUND')
      } catch (err: any) {
        if (_controller.signal.aborted) throw err
        lastError = err
        if (attempt < 1) {
          console.warn(`[Proxy] Daemon resolve failed for ${videoId}, retrying...`)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }

    // 🐢 Fallback: subprocess direct resolution.
    // Daemon may fail with SABR/rate-limiting errors (e.g. "The page needs
    // to be reloaded"). The subprocess with different player_client flags
    // can succeed where the daemon fails.
    console.warn(`[Proxy] Daemon failed for ${videoId}, falling back to subprocess...`)
    try {
      const url = await subprocessGetUrl(videoId, {
        timeoutMs: 30000,
        signal: _controller.signal,
      })
      if (url) {
        streamCache.set(videoId, {
          streamUrl: url,
          cachedAt: Date.now(),
          contentType: 'audio/mp4',
        })
        return url
      }
    } catch (err: any) {
      console.warn(`[Proxy] Subprocess fallback also failed for ${videoId}:`, err.message)
    }

    throw lastError ?? new Error('Stream resolve failed')
  }

  /**
   * Trigger a background yt-dlp resolve for a video ID.
   * Runs TWO extractions in parallel:
   *   1. 🏎️ Fast URL extraction via --get-url (~2s) — populates stream cache ASAP
   *   2. 🐢 Full metadata via -j (~12s on first run) — returns title/duration/thumbnail
   *
   * pendingResolves resolves as soon as the fast URL is available,
   * so the audio stream can start playing while metadata is still loading.
   *
   * Returns the full YTDlpInfo for MediaResolver metadata extraction.
   */
  function triggerBackgroundResolve(videoId: string): Promise<YTDlpInfo> {
    const existing = pendingInfoResolves.get(videoId)
    if (existing) return existing

    const controller = new AbortController()
    pendingControllers.set(videoId, controller)

    // Helper: try subprocess resolve as daemon fallback
    const trySubprocessFallback = async (): Promise<string> => {
      try {
        console.warn(`[Proxy] Falling back to subprocess for ${videoId}`)
        const url = await subprocessGetUrl(videoId, {
          timeoutMs: 15000,
          signal: controller.signal,
        })
        if (url) {
          streamCache.set(videoId, {
            streamUrl: url,
            cachedAt: Date.now(),
            contentType: 'audio/mp4',
          })
          await downloadAudioChunk(videoId, url)
        }
        return url
      } catch (subErr: any) {
        console.warn(`[Proxy] Subprocess fallback also failed for ${videoId}:`, subErr.message)
        return ''
      }
    }

    // 🏎️ Fast path: stream URL via warm daemon (with subprocess fallback)
    const urlPromise: Promise<string> = getDaemon().getStreamUrl(videoId, 15000).then(async (url) => {
      if (url) {
        streamCache.set(videoId, {
          streamUrl: url,
          cachedAt: Date.now(),
          contentType: 'audio/webm',
        })
        // 🔥 Download first PREWARM_CHUNK_SIZE bytes into prewarm buffer.
        // AWAIT the chunk so pendingResolves waits for it — the handler
        // will find the prewarm buffer HIT and send it instantly, then
        // fetch the CDN tail in parallel.
        await downloadAudioChunk(videoId, url)
        return url
      }
      // Daemon returned empty URL — fall back to subprocess
      return trySubprocessFallback()
    }).catch(async (err) => {
      console.warn(`[Proxy] Fast URL resolve failed for ${videoId}:`, err.message)
      // Daemon errored (SABR/rate-limit) — fall back to subprocess
      return trySubprocessFallback()
    })

    // 🐢 Slow path: full metadata
    const infoPromise: Promise<YTDlpInfo> = getVideoInfo(videoId, {
      timeoutMs: 15000,
      signal: controller.signal,
    }).then((info) => {
      // Update stream cache with accurate content-type from metadata
      const bestFormat = info.formats
        .filter((f) => f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0]
      if (bestFormat?.url) {
        streamCache.set(videoId, {
          streamUrl: bestFormat.url,
          cachedAt: Date.now(),
          contentType: `audio/${bestFormat.ext}`,
        })
      }
      return info
    }).catch((err) => {
      console.warn(`[Proxy] Background metadata resolve failed for ${videoId}:`, err.message)
      return { id: videoId, title: 'Unknown', duration: 0, thumbnail: '', formats: [] } as YTDlpInfo
    })

    // pendingResolves: fast URL, or if that fails, fall through to metadata URL
    const pendingResolve = urlPromise.then((url) => {
      if (url) return url
      // Fast path failed — wait for metadata path to get the URL
      return infoPromise.then(async (info) => {
        const f = info.formats.find((ff) => ff.acodec !== 'none' && ff.url)
        if (f?.url) {
          streamCache.set(videoId, {
            streamUrl: f.url,
            cachedAt: Date.now(),
            contentType: `audio/${f.ext}`,
          })
          // 🔥 Prewarm CDN connection — otherwise skip hits cold CDN TTFB (~540ms)
          await downloadAudioChunk(videoId, f.url)
          return f.url
        }
        return ''
      })
    })
    pendingResolves.set(videoId, pendingResolve)
    // Clean up pendingResolves when settled, just like the others
    pendingResolve.finally(() => {
      pendingResolves.delete(videoId)
    })

    pendingInfoResolves.set(videoId, infoPromise)

    // Clean up tracking maps when BOTH paths settle (not just the faster one)
    Promise.allSettled([urlPromise, infoPromise]).finally(() => {
      pendingControllers.delete(videoId)
      pendingInfoResolves.delete(videoId)
    })

    return infoPromise
  }

  // Track background resolves that return full YTDlpInfo
  const pendingInfoResolves = new Map<string, Promise<YTDlpInfo>>()

  function getPendingResolveCount(): number {
    return pendingInfoResolves.size
  }

  /**
   * Proxy an HTTPS stream from YouTube CDN to the client.
   * Follows redirects (YouTube CDN uses 302/303 redirects).
   * Handles 403 by clearing cache, re-resolving, and retrying.
   */
  function proxyStream(
    streamUrl: string,
    videoId: string,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse
  ) {
    const tStart = Date.now()
    let cdnFirstByteMs = 0

    const makeRequest = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' })
        clientRes.end(JSON.stringify({ error: 'Too many redirects' }))
        return
      }

      const parsedUrl = new URL(targetUrl)
      const transport = parsedUrl.protocol === 'https:' ? https : http

      const proxyHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }
      // Only forward Range header if client actually sent one
      if (clientReq.headers.range) {
        proxyHeaders['Range'] = clientReq.headers.range
      }

      const proxyReq = transport.get(
        targetUrl,
        {
          headers: proxyHeaders,
          agent: parsedUrl.protocol === 'https:' ? cdnAgent : undefined,
        },
        (proxyRes) => {
          // Follow redirects
          if (proxyRes.statusCode && [301, 302, 303, 307].includes(proxyRes.statusCode)) {
            const location = proxyRes.headers.location
            if (location) {
              if (PROXY_TIMING_LOGS) console.log(`[Proxy] CDN REDIRECT ${redirectCount+1} ${videoId} → ${location.substring(0, 80)}`)
              makeRequest(location, redirectCount + 1)
              return
            }
          }

          // CDN first byte timing (first response after any redirects)
          if (cdnFirstByteMs === 0) {
            cdnFirstByteMs = Date.now() - tStart
            const cl = proxyRes.headers['content-length'] ?? '?'
            const cr = proxyRes.headers['content-range'] ?? '-'
            const ct = proxyRes.headers['content-type'] ?? '?'
            if (PROXY_TIMING_LOGS) console.log(`[Proxy] CDN TTFB ${videoId}: ${cdnFirstByteMs}ms status=${proxyRes.statusCode} len=${cl} range=${cr} type=${ct}`)
          }

          // Handle 403/410 — stale URL, re-resolve
          if (proxyRes.statusCode === 403 || proxyRes.statusCode === 410) {
            console.log(`[Proxy] CDN returned ${proxyRes.statusCode} for ${videoId}, re-resolving...`)
            streamCache.delete(videoId)
            const resolveFn = onReResolve ?? resolveStreamUrl
            resolveFn(videoId)
              .then((newUrl) => makeRequest(newUrl, redirectCount + 1))
              .catch((err) => {
                console.error(`[Proxy] Re-resolve failed for ${videoId}:`, err.message)
                if (!clientRes.headersSent) {
                  clientRes.writeHead(502)
                  clientRes.end(JSON.stringify({ error: 'Re-resolve failed' }))
                }
              })
            return
          }

          // Forward response headers
          const headers: Record<string, string> = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': proxyRes.headers['content-type'] ?? 'audio/mpeg',
          }
          if (proxyRes.headers['content-length']) {
            headers['Content-Length'] = proxyRes.headers['content-length']
          }
          if (proxyRes.headers['content-range']) {
            headers['Content-Range'] = proxyRes.headers['content-range']
          }
          if (proxyRes.headers['accept-ranges']) {
            headers['Accept-Ranges'] = proxyRes.headers['accept-ranges']
          }

          clientRes.writeHead(proxyRes.statusCode ?? 200, headers)

          let dataStartMs = 0
          let dataBytes = 0
          proxyRes.on('data', (chunk: Buffer) => {
            if (dataStartMs === 0) {
              dataStartMs = Date.now()
              if (PROXY_TIMING_LOGS) console.log(`[Proxy] DATA START ${videoId}: +${dataStartMs - tStart}ms redirects=${redirectCount}`)
            }
            dataBytes += chunk.length
          })
          proxyRes.on('end', () => {
            if (PROXY_TIMING_LOGS) console.log(`[Proxy] DATA END ${videoId}: ${dataBytes} bytes transferred`)
          })
          // ⚠️ Handle CDN response stream errors (ECONNRESET mid-stream).
          // Without this, proxyRes.pipe(clientRes) does NOT forward errors,
          // so clientRes stays open indefinitely and the audio element hangs.
          proxyRes.on('error', (err) => {
            console.warn(`[Proxy] CDN response error for ${videoId}:`, err.message)
            if (!clientRes.destroyed) clientRes.end()
          })
          proxyRes.pipe(clientRes)
        }
      )

      proxyReq.on('error', (err) => {
        console.error('[Proxy] Stream request failed:', err.message)
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' })
          clientRes.end(JSON.stringify({ error: 'Stream proxy failed' }))
        } else if (!clientRes.destroyed) {
          // Headers already sent (streaming audio) — end client response
          // cleanly so the audio element gets EOF and fires 'ended' instead
          // of hanging indefinitely waiting for data that will never come.
          clientRes.end()
        }
      })
    }

    makeRequest(streamUrl)
  }

  /**
   * Start the proxy server.
   */
  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new ProxyError(`Port ${port} in use`, 'PORT_IN_USE', err))
        } else {
          reject(err)
        }
      })
      server.listen(port, '127.0.0.1', () => {
        console.log(`[Proxy] Listening on http://127.0.0.1:${port}`)
        resolve()
      })
    })
  }

  /**
   * Stop the proxy server gracefully.
   */
  function stop(): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  /**
   * Clear the stream cache (useful for testing or forced refresh).
   */
  function clearCache(videoId?: string): void {
    if (videoId) {
      streamCache.delete(videoId)
    } else {
      streamCache.clear()
    }
  }

  /**
   * Get a stream cache entry by video ID.
   */
  function getStreamCacheEntry(videoId: string): StreamCache | undefined {
    return streamCache.get(videoId)
  }

  /**
   * Set a stream cache entry for a video ID.
   */
  function setStreamCacheEntry(videoId: string, entry: StreamCache): void {
    streamCache.set(videoId, entry)
  }

  /** Prewarm audio buffer: videoId → first N KB of CDN audio bytes */
  const prewarmBuffer = new Map<string, { data: Buffer; contentType: string }>()
  /** Max tracks to keep in prewarm buffer (evict oldest) */
  const MAX_PREWARM = 5
  /** Bytes to pre-buffer for instant serve (moov atom for format 18 can be 200-800KB) */
  const PREWARM_CHUNK_SIZE = 1024 * 1024

  function evictPrewarmBuffer(): void {
    if (prewarmBuffer.size <= MAX_PREWARM) return
    const oldest = prewarmBuffer.keys().next().value
    if (oldest) prewarmBuffer.delete(oldest)
  }

  /**
   * Download the first PREWARM_CHUNK_SIZE bytes of CDN audio into the
   * prewarm buffer. Also warms the CDN keep-alive connection.
   * Fire-and-forget, best-effort.
   */
  function downloadAudioChunk(videoId: string, url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const t0 = Date.now()
      const hostname = new URL(url).hostname
      try { dns.resolve(hostname, () => {}) } catch {}

      const chunks: Buffer[] = []
      let total = 0
      let done = false
      let settled = false
      const req = https.get(url, {
        agent: cdnAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Referer': 'https://www.youtube.com/',
        },
      }, (res) => {
        const ct = res.headers['content-type'] ?? 'audio/mpeg'
        res.on('data', (chunk: Buffer) => {
          if (done) return
          chunks.push(chunk)
          total += chunk.length
          if (total >= PREWARM_CHUNK_SIZE) {
            done = true
            req.destroy()
            prewarmBuffer.set(videoId, { data: Buffer.concat(chunks), contentType: ct })
            if (PROXY_TIMING_LOGS) console.log(`[Proxy] Chunk buffered ${videoId}: ${total} bytes in ${Date.now()-t0}ms`)
            evictPrewarmBuffer()
            if (!settled) { settled = true; resolve() }
          }
        })
        res.on('end', () => {
          if (!done && total > 0) {
            prewarmBuffer.set(videoId, { data: Buffer.concat(chunks), contentType: ct })
            if (PROXY_TIMING_LOGS) console.log(`[Proxy] Chunk buffered ${videoId}: ${total} bytes (complete) in ${Date.now()-t0}ms`)
            evictPrewarmBuffer()
          }
          if (!settled) { settled = true; resolve() }
        })
      })
      req.on('error', (err) => {
        if (!done && !settled) { settled = true; resolve() }
        if (!done) console.warn(`[Proxy] Chunk download error for ${videoId}:`, err.message)
      })
      req.setTimeout(8000, () => {
        if (!done && !settled) { settled = true; resolve() }
        if (!done) req.destroy()
      })
    })
  }

  /**
   * Pre-warm the CDN connection for a video: resolve CDN URL via
   * triggerResolve (daemon + subprocess fallback), cache it, then
   * pre-buffer the first chunk into RAM for instant serve.
   * Fire-and-forget — called at startup for the first queue track.
   *
   * If streamCache already has a URL (e.g. populated by Innertube from
   * MediaResolver's resolve()), it uses that directly and skips the
   * daemon entirely — critical for <1s cold play.
   */
  async function prewarmCdn(videoId: string): Promise<void> {
    try {
      // Fast path: URL already cached (e.g. from Innertube resolve) —
      // downloadAudioChunk starts the 1MB prewarm buffer immediately.
      const cached = streamCache.get(videoId)
      if (cached?.streamUrl) {
        downloadAudioChunk(videoId, cached.streamUrl)
        return
      }

      // Slow path: resolve via daemon + subprocess fallback
      const url = await triggerResolve(videoId)
      if (!url) return

      downloadAudioChunk(videoId, url)
    } catch (err: any) {
      console.warn(`[Proxy] Prewarm CDN failed for ${videoId}:`, err?.message ?? err)
    }
  }

  return {
    server,
    start,
    stop,
    clearCache,
    getStreamCacheEntry,
    setStreamCacheEntry,
    triggerBackgroundResolve,
    getPendingResolveCount,
    prewarmCdn,
    streamCache,
  }
}
