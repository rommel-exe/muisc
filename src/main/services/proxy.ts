// src/main/services/proxy.ts

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { PROXY_PORT } from '../../shared/constants'
import { getVideoInfo, getStreamUrl as subprocessGetUrl, type YTDlpInfo, YTDlpError } from './yt-dlp'
import { getDaemon } from './yt-dlp-daemon'

const PROXY_TIMING_LOGS = true

/** Shared HTTPS agent with keep-alive for CDN connections.
 *  Warms TCP+TLS so subsequent connections to the same CDN edge are faster. */
const cdnAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 20,
  maxFreeSockets: 10,
})

/**
 * Speculative CDN pre-fetch buffer.
 * When a stream URL is cached, we proactively connect to the CDN and buffer
 * audio data BEFORE the audio element requests it. This eliminates CDN
 * connection + TTFB from the critical path (~100-300ms savings).
 */
interface SpeculativeBuffer {
  /** CDN response headers (for forwarding) */
  headers: http.IncomingHttpHeaders | null
  /** Buffered audio data chunks (capped at 1MB) */
  chunks: Buffer[]
  /** The live CDN response stream for ongoing data */
  stream: http.IncomingMessage | null
  /** True once CDN response headers received (ready to serve) */
  connected: boolean
  /** True if CDN stream ended (entire track buffered) */
  done: boolean
  /** Non-null if fetch failed */
  error: Error | null
  /** Set when buffer is consumed or abandoned */
  destroyed: boolean
  /** Timestamp for cleanup */
  createdAt: number
}

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
  // Separate map for triggerBackgroundResolve's URL promises so they don't
  // conflict with triggerResolve's entries in pendingResolves.
  const backgroundUrlResolves = new Map<string, Promise<string>>()
  const pendingControllers = new Map<string, AbortController>()

  // ⚡ Speculative CDN pre-fetch buffers: videoId → speculative buffer.
  // When a stream URL is cached, we proactively connect to the CDN and start
  // buffering audio data. When the audio element's HTTP request arrives, we
  // serve pre-buffered data immediately + pipe the remaining live stream.
  // Saves ~100-300ms CDN connection + TTFB from the critical path.
  const specBuffers = new Map<string, SpeculativeBuffer>()

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

        // 🔥 Stale URL prevention: if the browser requests partial content
        // starting at a non-zero byte, it's continuing a truncated stream.
        // Clear the cached URL so resolveStreamUrl gets a fresh one —
        // stale CDN URLs cause 403/timeouts and songs stop mid-playback.
        const rangeHeader = req.headers['range']
        if (rangeHeader) {
          const rangeStart = parseInt(rangeHeader.replace(/bytes=/, '').split('-')[0], 10)
          if (rangeStart > 0) streamCache.delete(videoId)
        }

        // ── Check speculative CDN pre-fetch buffer first ──
        const specBuf = specBuffers.get(videoId)
        if (specBuf?.connected && !specBuf.error) {
          if (PROXY_TIMING_LOGS) console.log(`[Proxy] HANDLER ${videoId}: spec buffer HIT at ${Date.now()-handlerT0}ms`)
          useSpeculativeBuffer(specBuf, videoId, res)
          return
        }

        // ── Resolve stream URL via daemon + subprocess fallback ──
        const streamUrl = await resolveStreamUrl(videoId)
        if (!streamUrl) {
          throw new ProxyError(`Empty stream URL for ${videoId}`, 'STREAM_NOT_FOUND')
        }
        if (PROXY_TIMING_LOGS) console.log(`[Proxy] HANDLER ${videoId}: resolve=${Date.now()-handlerT0}ms`)

        if (PROXY_TIMING_LOGS) console.log(`[Proxy] HANDLER ${videoId}: proxyStream after ${Date.now()-handlerT0}ms`)
        proxyStream(streamUrl, videoId, req, res)
      } catch (err: any) {
        console.error(`[Proxy] Failed to stream ${videoId}:`, err.message)
        if (res.headersSent) {
          if (!res.destroyed) res.end()
          return
        }
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

    // 2. There's already a foreground or background resolve in-flight — await it
    const foregroundPending = pendingResolves.get(videoId)
    if (foregroundPending) {
      const url = await foregroundPending
      // Re-check cache (resolve populates it)
      const hit = streamCache.get(videoId)
      if (hit) return hit.streamUrl
      return url
    }
    const bgPending = backgroundUrlResolves.get(videoId)
    if (bgPending) {
      const url = await bgPending
      const hit = streamCache.get(videoId)
      if (hit) return hit.streamUrl
      return url
    }

    // 3. Nothing pending — start a fresh foreground resolve
    return triggerResolve(videoId)
  }

  /**
   * Start a speculative CDN pre-fetch for a video ID.
   * Proactively connects to the CDN and buffers audio data AFTER the stream
   * URL is cached. When the audio element later connects, the buffered data
   * is served immediately, eliminating CDN connection + TTFB latency.
   *
   * Fire-and-forget: errors are silently logged. If the fetch fails or
   * isn't ready by the time the client connects, proxyStream falls back
   * to the normal live connection path.
   */
  function startSpeculativeFetch(videoId: string, streamUrl: string): void {
    if (!streamUrl || specBuffers.has(videoId)) return

    const buf: SpeculativeBuffer = {
      headers: null,
      chunks: [],
      stream: null,
      connected: false,
      done: false,
      error: null,
      destroyed: false,
      createdAt: Date.now(),
    }
    specBuffers.set(videoId, buf)

    // ⏰ Auto-cleanup after 30s if no client connects.
    // Prevents dangling CDN connections for pre-resolved tracks the user
    // never plays (e.g., search results they scroll past).
    const cleanupTimer = setTimeout(() => {
      if (!buf.destroyed) {
        buf.destroyed = true
        specBuffers.delete(videoId)
      }
    }, 30000)
    // Allow timer to not prevent process exit
    if (cleanupTimer.unref) cleanupTimer.unref()

    const doFetch = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5 || buf.destroyed) return

      try {
        const parsedUrl = new URL(targetUrl)
        const transport = parsedUrl.protocol === 'https:' ? https : http

        const req = transport.get(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
          agent: parsedUrl.protocol === 'https:' ? cdnAgent : undefined,
        }, (res) => {
          // Follow redirects
          if (res.statusCode && [301, 302, 303, 307].includes(res.statusCode)) {
            const location = res.headers.location
            if (location) {
              res.destroy()
              doFetch(location, redirectCount + 1)
            }
            return
          }

          if (buf.destroyed) {
            res.destroy()
            return
          }

          buf.headers = res.headers
          buf.stream = res
          buf.connected = true

          let totalBytes = 0
          const MAX_SPEC_BUFFER = 1024 * 1024 // 1MB cap

          res.on('data', (chunk: Buffer) => {
            if (buf.destroyed) {
              res.destroy()
              return
            }
            buf.chunks.push(chunk)
            totalBytes += chunk.length
            if (totalBytes > MAX_SPEC_BUFFER) {
              // Buffer capped at 1MB; stream stays alive for piping to client
            }
          })

          res.on('end', () => {
            buf.done = true
          })

          res.on('error', (err) => {
            buf.error = err
          })
        })

        req.setTimeout(15000, () => {
          req.destroy()
          buf.error = new Error('Speculative fetch timeout')
        })

        req.on('error', (err) => {
          buf.error = err
        })
      } catch (err: any) {
        buf.error = err
      }
    }

    doFetch(streamUrl)
  }

  /**
   * Serve a pre-fetched speculative buffer to the client.
   * Writes buffered CDN data immediately, then pipes the remaining live stream.
   */
  function useSpeculativeBuffer(
    specBuf: SpeculativeBuffer,
    videoId: string,
    clientRes: http.ServerResponse
  ): void {
    const t0 = Date.now()
    specBuf.destroyed = true // Prevent further buffering
    specBuffers.delete(videoId)

    // Forward CDN response headers
    const contentType = specBuf.headers?.['content-type'] ?? 'audio/mpeg'
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': contentType,
    }
    if (specBuf.headers?.['content-length']) {
      headers['Content-Length'] = specBuf.headers['content-length'] as string
    }
    if (specBuf.headers?.['content-range']) {
      headers['Content-Range'] = specBuf.headers['content-range'] as string
    }
    if (specBuf.headers?.['accept-ranges']) {
      headers['Accept-Ranges'] = specBuf.headers['accept-ranges'] as string
    }

    clientRes.writeHead(200, headers)

    // Write all buffered chunks immediately (zero-delay, already in memory)
    for (const chunk of specBuf.chunks) {
      clientRes.write(chunk)
    }
    const bufBytes = specBuf.chunks.reduce((s, c) => s + c.length, 0)
    specBuf.chunks = [] // Free memory

    if (PROXY_TIMING_LOGS) {
      console.log(`[Proxy] SPEC BUFFER HIT ${videoId}: ${bufBytes}bytes served in ${Date.now()-t0}ms (zero CDN connect)`)
    }

    // Pipe remaining live CDN stream if still active
    if (specBuf.stream && !specBuf.done && !specBuf.error) {
      specBuf.stream.pipe(clientRes)

      specBuf.stream.on('error', (err) => {
        console.warn(`[Proxy] Spec buffer stream error for ${videoId}:`, err.message)
        if (!clientRes.destroyed) clientRes.end()
      })

      clientRes.on('close', () => {
        specBuf.stream?.destroy()
      })
    } else {
      clientRes.end()
    }
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

    // 🏎️ Start subprocess in PARALLEL with the daemon path. The subprocess
    // uses --get-url via raw yt-dlp (~1.5s) which can be faster than the
    // daemon when the daemon has a cold module cache or YouTube returns errors.
    // Both paths cache their result independently — the winner serves the
    // response, the loser populates the cache for the next click.
    let subprocessDone = false
    const subprocessPromise = subprocessGetUrl(videoId, {
      timeoutMs: 30000,
      signal: _controller.signal,
    }).then(url => {
      subprocessDone = true
      if (url) {
        streamCache.set(videoId, {
          streamUrl: url,
          cachedAt: Date.now(),
          contentType: 'audio/mp4',
        })
        startSpeculativeFetch(videoId, url)
      }
      return url
    })

    // 🏎️ Try the warm daemon while subprocess runs in background.
    // The daemon is ~500ms when it works (no Python import overhead).
    // Each attempt RACES against the parallel subprocess so we never wait
    // for the daemon if the subprocess already finished.
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const daemon = getDaemon()
        const url = await Promise.race([
          // 🏎️ 5000ms daemon timeout — with extractor_retries=5, session expiry
          // is handled transparently. If daemon still fails, fall through to
          // the parallel subprocess which also has extractor_retries=5.
          daemon.getStreamUrl(videoId, 5000),
          subprocessPromise.then(u => {
            if (u) return u
            // Subprocess returned no URL — keep waiting for the daemon.
            // This .then rejects the race so the daemon attempt continues.
            return Promise.reject(new Error('subprocess no url'))
          }),
        ])
        if (url) {
          streamCache.set(videoId, {
            streamUrl: url,
            cachedAt: Date.now(),
            contentType: 'audio/mp4',
          })
          startSpeculativeFetch(videoId, url)
          return url
        }
        throw new ProxyError('No stream URL returned', 'STREAM_NOT_FOUND')
      } catch (err: any) {
        // If subprocess already resolved and returned a URL, it wins.
        // The race resolved with subprocess — return the URL.
        if (subprocessDone && err.message === 'subprocess no url') {
          // Subprocess returned null — continue daemon attempts
          lastError = new Error('Subprocess returned no URL')
          if (attempt < 1) {
            await new Promise((r) => setTimeout(r, 1000))
          }
          continue
        }
        if (_controller.signal.aborted) throw err
        lastError = err
        if (attempt < 1) {
          console.warn(`[Proxy] Daemon resolve failed for ${videoId}, retrying...`)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }

    // 🐢 Both daemon attempts failed. By now the parallel subprocess
    // has likely already resolved. Await it — returns cached URL if
    // it succeeded, or null/throw.
    console.warn(`[Proxy] Daemon failed for ${videoId}, awaiting parallel subprocess...`)
    const subprocessUrl = await subprocessPromise
    if (subprocessUrl) return subprocessUrl

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

    // 🏎️ Race daemon + subprocess in PARALLEL for fastest URL resolution.
    // The daemon is ~500ms when warm; the subprocess is ~1500ms but works even
    // when the daemon's YouTube session expires. Racing both avoids the
    // sequential daemon→subprocess fallback overhead shown by benchmarks.
    // First valid URL wins and populates streamCache immediately.
    const daemonUrlP = getDaemon().getStreamUrl(videoId, 5000).then(url => {
      if (url) {
        streamCache.set(videoId, {
          streamUrl: url,
          cachedAt: Date.now(),
          contentType: 'audio/webm',
        })
        startSpeculativeFetch(videoId, url)
      }
      return url
    }).catch((err: any) => {
      console.warn(`[Proxy] Daemon URL resolve failed for ${videoId}:`, err.message)
      return ''
    })

    const subprocessUrlP = subprocessGetUrl(videoId, {
      timeoutMs: 15000,
      signal: controller.signal,
    }).then(url => {
      if (url) {
        streamCache.set(videoId, {
          streamUrl: url,
          cachedAt: Date.now(),
          contentType: 'audio/mp4',
        })
        startSpeculativeFetch(videoId, url)
      }
      return url
    }).catch((subErr: any) => {
      console.warn(`[Proxy] Subprocess URL resolve failed for ${videoId}:`, subErr.message)
      return ''
    })

    // Take the first URL resolved. If one fails, wait for the other.
    const urlPromise: Promise<string> = Promise.race([
      daemonUrlP.then(url => url || subprocessUrlP),
      subprocessUrlP.then(url => url || daemonUrlP),
    ]).then(url => {
      if (url) return url
      // Both failed — fall through to infoPromise via pendingResolve below
      return ''
    })

    // 🐢 Slow path: full metadata — delayed 500ms to let the daemon's fast
    // URL extraction finish first. This avoids two concurrent yt-dlp
    // extractions for the same videoId hitting YouTube rate limits.
    const infoPromise: Promise<YTDlpInfo> = new Promise<void>((r) => setTimeout(r, 500))
      .then(() => getVideoInfo(videoId, {
        timeoutMs: 15000,
        signal: controller.signal,
      })).then((info) => {
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
        startSpeculativeFetch(videoId, bestFormat.url)
      }
      return info
    }).catch((err) => {
      console.warn(`[Proxy] Background metadata resolve failed for ${videoId}:`, err.message)
      return { id: videoId, title: 'Unknown', duration: 0, thumbnail: '', formats: [] } as YTDlpInfo
    })

    // backgroundUrlResolves: fast URL, or if that fails, fall through to metadata URL
    const pendingResolve = urlPromise.then((url) => {
      if (url) return url
      // Fast path failed — wait for metadata path to get the URL
      return infoPromise.then((info) => {
        const f = info.formats.find((ff) => ff.acodec !== 'none' && ff.url)
        if (f?.url) {
          streamCache.set(videoId, {
            streamUrl: f.url,
            cachedAt: Date.now(),
            contentType: `audio/${f.ext}`,
          })
          startSpeculativeFetch(videoId, f.url)
          return f.url
        }
        return ''
      })
    })
    backgroundUrlResolves.set(videoId, pendingResolve)
    // Clean up backgroundUrlResolves when settled, just like the others
    pendingResolve.finally(() => {
      backgroundUrlResolves.delete(videoId)
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

    const makeRequest = (targetUrl: string, redirectCount = 0, timeoutRetries = 0) => {
      const MAX_TIMEOUT_RETRIES = 2
      if (timeoutRetries > MAX_TIMEOUT_RETRIES) {
        console.error(`[Proxy] CDN timeout retries exhausted for ${videoId}`)
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' })
          clientRes.end(JSON.stringify({ error: 'CDN timeout after retries' }))
        } else if (!clientRes.destroyed) {
          clientRes.end()
        }
        return
      }

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

          // ⚠️ Safety net: if the timeout handler already fired and started
          // re-resolving (timeoutHandled=true), or headers were already sent
          // from a previous racing CDN response, don't write them again.
          // Without this, a CDN response that arrives after proxyReq.destroy()
          // (response was already parsed by the HTTP parser before the destroy)
          // tries to writeHead on an already-headed response → ERR_HTTP_HEADERS_SENT.
          if (timeoutHandled || clientRes.headersSent) {
            if (!clientRes.destroyed) clientRes.end()
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
            // Don't close clientRes if the timeout handler is already dealing with this
            // (timeoutHandled is declared below but in the same closure; by the time this
            // callback fires, it exists — Temporal Dead Zone is not an issue for async callbacks).
            if (timeoutHandled) return
            if (!clientRes.destroyed) clientRes.end()
          })
          proxyRes.pipe(clientRes)

          // ⚠️ Handle client-side errors (e.g. client disconnects mid-pipe).
          // Without this, a destroyed res silently breaks proxyRes.pipe() and
          // the CDN stream keeps buffering data in memory indefinitely.
          // Also catches ERR_STREAM_WRITE_AFTER_END race: if clientRes.end()
          // fires between pipe's writable check and the actual write, the
          // error handler prevents a hard crash.
          clientRes.on('error', (err: Error) => {
            if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_WRITE_AFTER_END') return
            console.warn(`[Proxy] Client response error for ${videoId}:`, err.message)
          })
          clientRes.on('close', () => {
            if (timeoutHandled) return
            timeoutHandled = true
            proxyReq.destroy()
          })
        }
      )

      let timeoutHandled = false

      proxyReq.on('error', (err) => {
        // If the timeout handler already dealt with this, don't send headers
        // (req.destroy() emits 'error' asynchronously, so the timeout handler
        // runs before this event — without this flag we'd write 502 here,
        // then the re-resolved CDN response tries to write 206 → crash).
        if (timeoutHandled) return
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

      // 🔥 CDN connection timeout: if CDN edge accepts TCP but sends no data
      // for 10s, destroy the request, clear the stale cache entry, re-resolve
      // the stream URL (may get a different CDN edge), and retry.
      //
      // ⚠️ Must check clientRes.headersSent before re-resolving:
      // if headers were already written to the client (mid-stream timeout),
      // retrying via makeRequest would try writeHead() on an already-headed
      // response → ERR_HTTP_HEADERS_SENT.
      //
      // In that case, end the response gracefully so the audio element
      // receives EOF and fires the `ended` event naturally, rather than
      // leaving the response dangling (no more data, no EOF) and relying
      // on client-side stall detection (3s delay) to auto-advance.
      //
      // Both the timeout handler and error handler must be careful not to
      // skip ending the response: if timeoutHandled is set and the error
      // handler fires next (from req.destroy()), it must still end clientRes.
      proxyReq.setTimeout(10000, () => {
        console.warn(`[Proxy] CDN timeout for ${videoId}, re-resolving...`)
        timeoutHandled = true
        proxyReq.destroy()
        // Headers already sent → end client response so audio element
        // gets EOF and fires `ended` immediately (instead of stalling).
        if (clientRes.headersSent || clientRes.writableEnded) {
          if (!clientRes.destroyed) clientRes.end()
          return
        }
        if (clientRes.destroyed) return
        streamCache.delete(videoId)
        const resolveFn = onReResolve ?? resolveStreamUrl
        resolveFn(videoId)
          .then((newUrl) => {
            if (newUrl) makeRequest(newUrl, redirectCount, timeoutRetries + 1)
            else if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' })
              clientRes.end(JSON.stringify({ error: 'CDN timeout re-resolve empty' }))
            } else if (!clientRes.destroyed) {
              clientRes.end()
            }
          })
          .catch((err) => {
            console.error(`[Proxy] CDN timeout re-resolve failed for ${videoId}:`, err.message)
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' })
              clientRes.end(JSON.stringify({ error: 'CDN timeout re-resolve failed' }))
            } else if (!clientRes.destroyed) {
              clientRes.end()
            }
          })
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
   * Aborts all in-flight resolves and clears all internal state.
   */
  function stop(): Promise<void> {
    // Abort all in-flight yt-dlp subprocesses
    for (const controller of pendingControllers.values()) {
      controller.abort()
    }
    pendingResolves.clear()
    backgroundUrlResolves.clear()
    pendingControllers.clear()
    pendingInfoResolves.clear()
    streamCache.clear()
    for (const buf of specBuffers.values()) {
      buf.destroyed = true
      if (buf.stream) buf.stream.destroy()
    }
    specBuffers.clear()
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
      const buf = specBuffers.get(videoId)
      if (buf) {
        buf.destroyed = true
        if (buf.stream) buf.stream.destroy()
        specBuffers.delete(videoId)
      }
    } else {
      streamCache.clear()
      for (const buf of specBuffers.values()) {
        buf.destroyed = true
        if (buf.stream) buf.stream.destroy()
      }
      specBuffers.clear()
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



  /**
   * Background video resolution using a direct subprocess (NOT the serial daemon).
   *
   * Unlike triggerBackgroundResolve which queues work on the serial yt-dlp daemon,
   * this spawns an independent Python subprocess per call. Multiple calls run in
   * parallel — no queue contention with foreground daemon requests.
   *
   * The subprocess has a 30s timeout (vs 15s in foreground) because Python's
   * yt-dlp module import takes ~2-4s on a cold process. Once imported, the
   * --get-url extraction completes in ~500ms. The longer timeout ensures
   * cold subprocesses succeed without timing out.
   *
   * Populates streamCache so the proxy handler can serve cached content
   * when the user clicks.
   *
   * Fire-and-forget: errors are logged but never thrown.
   * Called from MediaResolver.resolveQueue() for background pre-resolution.
   */
  async function backgroundResolve(videoId: string): Promise<void> {
    // Skip if already cached (streamCache has URL → already resolved)
    const cached = streamCache.get(videoId)
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) return

    // Skip if already in-flight via the daemon path (pendingResolves/pendingInfoResolves).
    // Foreground clicks use triggerResolve which populates pendingResolves,
    // triggerBackgroundResolve populates pendingInfoResolves — check both
    // to prevent duplicate work when resolveQueue and a foreground
    // resolve race for the same videoId.
    if (pendingResolves.has(videoId) || pendingInfoResolves.has(videoId)) return

    try {
      // Use subprocess directly (NOT triggerResolve) to avoid clogging the
      // daemon's serial FIFO queue. The subprocess runs independently and
      // populates streamCache on success.
      const url = await subprocessGetUrl(videoId, { timeoutMs: 30000 })
      if (!url) return

      streamCache.set(videoId, {
        streamUrl: url,
        cachedAt: Date.now(),
        contentType: 'audio/mp4',
      })
      startSpeculativeFetch(videoId, url)
    } catch (err: any) {
      // Subprocess failed — this is expected for cold imports. The foreground
      // resolve (triggerResolve → daemon) will handle the click when the user
      // taps this track. The daemon is fast (~500ms) and unclogged because we
      // didn't queue anything on it.
      console.warn(`[Proxy] Background resolve failed for ${videoId}:`, err.message)
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
    backgroundResolve,
    getPendingResolveCount,
    streamCache,
  }
}
