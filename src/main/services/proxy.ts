// src/main/services/proxy.ts

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { PROXY_PORT } from '../../shared/constants'
import { getVideoInfo, YTDlpError } from './yt-dlp'

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

  // Track in-flight yt-dlp resolves so we can abort stale ones
  const pendingResolves = new Map<string, AbortController>()

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
        const streamUrl = await resolveStreamUrl(videoId)
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
   * Re-resolves if cache is expired.
   * Aborts any previous in-flight resolve for the same video ID
   * to prevent yt-dlp process pile-up on rapid skips.
   */
  async function resolveStreamUrl(videoId: string): Promise<string> {
    const cached = streamCache.get(videoId)
    const now = Date.now()

    if (cached && now - cached.cachedAt < cacheTtlMs) {
      return cached.streamUrl
    }

    // Abort any previous pending resolve for this video ID
    const existing = pendingResolves.get(videoId)
    if (existing) {
      existing.abort()
      console.log(`[Proxy] Aborted stale resolve for ${videoId}`)
    }

    const controller = new AbortController()
    pendingResolves.set(videoId, controller)

    try {
      // Re-resolve via yt-dlp with retry (handles transient GPU-crash kills)
      let lastError: Error | undefined
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const info = await getVideoInfo(videoId, { timeoutMs: 15000, signal: controller.signal })
          const bestFormat = info.formats
            .filter((f) => f.acodec !== 'none' && f.url)
            .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0]

          if (!bestFormat?.url) {
            throw new ProxyError('No audio format found', 'STREAM_NOT_FOUND')
          }

          streamCache.set(videoId, {
            streamUrl: bestFormat.url,
            cachedAt: Date.now(),
            contentType: `audio/${bestFormat.ext}`,
          })

          return bestFormat.url
        } catch (err: any) {
          if (controller.signal.aborted) throw err
          lastError = err
          if (attempt < 1) {
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      }
      throw lastError ?? new Error('Stream resolve failed')
    } finally {
      pendingResolves.delete(videoId)
    }
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
        { headers: proxyHeaders },
        (proxyRes) => {
          // Follow redirects
          if (proxyRes.statusCode && [301, 302, 303, 307].includes(proxyRes.statusCode)) {
            const location = proxyRes.headers.location
            if (location) {
              makeRequest(location, redirectCount + 1)
              return
            }
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
          proxyRes.pipe(clientRes)
        }
      )

      proxyReq.on('error', (err) => {
        console.error('[Proxy] Stream request failed:', err.message)
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' })
          clientRes.end(JSON.stringify({ error: 'Stream proxy failed' }))
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

  return {
    server,
    start,
    stop,
    clearCache,
    getStreamCacheEntry,
    setStreamCacheEntry,
    streamCache,
  }
}
