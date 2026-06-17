import { createProxy } from './proxy'
import { getDaemon } from './yt-dlp-daemon'
import { getVideoInfo } from './yt-dlp'
import type { ResolvedStream } from '../../shared/types'
import { PROXY_PORT } from '../../shared/constants'

export interface ResolveOptions {
  /** Force re-resolution even if cached */
  forceRefresh?: boolean
}

export interface MediaResolverConfig {
  proxyPort?: number
  /** Max retries for retryable errors */
  maxRetries?: number
  /** LRU cache size */
  cacheSize?: number
  /** Cache TTL in ms (default 5 hours) */
  cacheTtlMs?: number
  /** Number of upcoming queue tracks to preload (default: 3) */
  preloadedWindowSize?: number
  /** Max concurrent background preload operations (default: 2) */
  maxConcurrentPreloads?: number
}

/**
 * MediaResolver — the bridge between track identity and playable audio.
 *
 * Centralizes all yt-dlp, proxy, caching, and recovery complexity.
 * Every other service calls resolve() and gets a clean proxy URL back.
 */
export function createMediaResolver(config: MediaResolverConfig = {}) {
  const {
    proxyPort = PROXY_PORT,
    cacheSize = 100,
    cacheTtlMs = 5 * 60 * 60 * 1000,
    preloadedWindowSize = 3,
    maxConcurrentPreloads = 2,
  } = config

  /**
   * Re-resolve callback for proxy's CDN 403/410 recovery.
   * Clears MediaResolver's cache and triggers a fresh background resolve.
   */
  const reResolveStream = async (videoId: string): Promise<string> => {
    resolveCache.delete(videoId)
    await proxy.triggerBackgroundResolve(videoId)
    const cached = proxy.getStreamCacheEntry(videoId)
    if (cached?.streamUrl) return cached.streamUrl
    throw new Error('Stream re-resolve failed')
  }

  const proxy = createProxy({ port: proxyPort, cacheTtlMs, onReResolve: reResolveStream })

  // LRU cache: videoId → ResolvedStream (minus audioUrl, which is derived from proxy)
  const resolveCache = new Map<string, { info: ResolvedStream; cachedAt: number }>()

  /**
   * Get a proxy URL for a video ID.
   * This is the URL the renderer should load into HTMLAudioElement.
   */
  function getProxyUrl(videoId: string): string {
    return `http://127.0.0.1:${proxyPort}/stream?v=${videoId}`
  }

  /**
   * Resolve a video ID to a playable audio source.
   *
   * Flow:
   * 1. Check resolve cache — 0ms on hit, return proxy URL immediately
   * 2. Trigger background yt-dlp resolve via proxy (fire-and-forget)
   * 3. Return proxy URL immediately with cached or placeholder metadata
   *
   * The proxy's stream cache is populated by backgroundResolve. When the
   * renderer's Audio element connects to the proxy, the proxy blocks until
   * the stream cache is populated, then starts piping the YouTube CDN stream.
   * This means the audio connection establishes in parallel with yt-dlp,
   * and the renderer is never blocked on the yt-dlp subprocess.
   */
  async function resolve(
    videoId: string,
    opts: ResolveOptions = {}
  ): Promise<ResolvedStream> {
    const { forceRefresh = false } = opts

    // Check cache first
    if (!forceRefresh) {
      const cached = resolveCache.get(videoId)
      if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
        return cached.info
      }
    }

    // ── Resolve the stream URL ──
    // Two parallel paths:
    //   1. 🏎️ Fast: daemon.getStreamUrl() (~250ms) → direct CDN URL.
    //      Chromium's QUIC support gives faster, more consistent CDN connections.
    //   2. 🐢 Background: getVideoInfo subprocess populates resolve cache with
    //      metadata + proxy stream cache (for fallback/re-resolve).
    //
    // If the daemon fails, falls back to the proxy URL.

    // 🏎️ Fast: daemon-extracted CDN URL (warm connection pool, ~250ms)
    const daemonUrl = getDaemon().getStreamUrl(videoId, 5000)
      .then((url) => {
        if (url) {
          proxy.setStreamCacheEntry(videoId, {
            streamUrl: url,
            cachedAt: Date.now(),
            contentType: 'audio/mp4',
          })
        }
        return url
      })
      .catch(() => '' as string)

    // 🐢 Slow: full metadata via subprocess (title, duration, thumbnail)
    getVideoInfo(videoId, { mode: 'background', timeoutMs: 30000 })
      .then((info) => {
        const bestFormat = info.formats
          .filter((f) => f.acodec !== 'none' && f.url)
          .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0]
        if (bestFormat?.url) {
          proxy.setStreamCacheEntry(videoId, {
            streamUrl: bestFormat.url,
            cachedAt: Date.now(),
            contentType: `audio/${bestFormat.ext}`,
          })
        }
        const resolved: ResolvedStream = {
          videoId: info.id,
          audioUrl: bestFormat?.url || getProxyUrl(videoId),
          duration: info.duration,
          title: info.title,
          thumbnail: info.thumbnail || '',
        }
        resolveCache.set(videoId, { info: resolved, cachedAt: Date.now() })
        evictIfNeeded()
      })
      .catch(() => {
        // Errors logged in getVideoInfo
      })

    // Await just the fast daemon URL (~250ms), not the slow metadata
    const url = await daemonUrl
    const audioUrl = url || getProxyUrl(videoId)

    return {
      videoId,
      audioUrl,
      duration: 0,
      title: 'Loading...',
      thumbnail: '',
    }
  }

  /**
   * Evict oldest entries if cache exceeds size limit.
   */
  function evictIfNeeded(): void {
    if (resolveCache.size <= cacheSize) return

    // Evict oldest entries
    const entries = Array.from(resolveCache.entries())
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt)

    const toRemove = entries.slice(0, entries.length - cacheSize)
    for (const [key] of toRemove) {
      resolveCache.delete(key)
    }
  }

  // ── Sliding window queue preloader ──

  /**
   * Prefetch upcoming queue tracks into the proxy stream cache and
   * MediaResolver's metadata cache.
   *
   * With the instant-return proxy strategy, this pre-fetches metadata
   * (title, duration, thumbnail) and stream URLs so they're ready when
   * the user navigates. Not required for the <2s cold-click goal but
   * improves subsequent-click UX.
   *
   * Call this whenever the queue changes or playback advances.
   */
  async function prefetchQueue(upcomingVideoIds: string[]): Promise<void> {
    const targets = upcomingVideoIds
      .slice(0, preloadedWindowSize)
      .filter((id) => {
        const cached = resolveCache.get(id)
        if (cached && Date.now() - cached.cachedAt < cacheTtlMs) return false
        return true
      })
      .slice(0, maxConcurrentPreloads)

    // Fire-and-forget — proxy.triggerBackgroundResolve deduplicates
    for (const videoId of targets) {
      proxy.triggerBackgroundResolve(videoId).then((info) => {
        const resolved: ResolvedStream = {
          videoId: info.id,
          audioUrl: getProxyUrl(videoId),
          duration: info.duration,
          title: info.title,
          thumbnail: info.thumbnail || '',
        }
        resolveCache.set(videoId, { info: resolved, cachedAt: Date.now() })
        evictIfNeeded()
      }).catch(() => {
        // Errors logged in proxy
      })
    }
  }

  /**
   * Clear the resolve cache for a specific video or all.
   */
  function clearCache(videoId?: string): void {
    if (videoId) {
      resolveCache.delete(videoId)
      proxy.clearCache(videoId)
    } else {
      resolveCache.clear()
      proxy.clearCache()
    }
  }

  /**
   * Start the proxy server. Call this on app ready.
   */
  async function start(): Promise<void> {
    await proxy.start()
    console.log('[MediaResolver] Ready')
  }

  /**
   * Stop the proxy server gracefully. Call this on app quit.
   */
  async function stop(): Promise<void> {
    resolveCache.clear()
    await proxy.stop()
    console.log('[MediaResolver] Stopped')
  }

  /**
   * Corrupt the cached stream URL for a video to trigger a 403 error.
   * Useful for testing 403 recovery in the proxy.
   * Clears the resolve cache so next resolve ignores cached metadata.
   * Returns true if a proxy cache entry was found and corrupted.
   */
  function corruptCache(videoId: string): boolean {
    // Clear resolve cache so next resolve ignores cached metadata
    resolveCache.delete(videoId)

    // Corrupt proxy cache entry to trigger 403
    const cached = proxy.getStreamCacheEntry(videoId)
    if (!cached) return false

    proxy.setStreamCacheEntry(videoId, {
      ...cached,
      streamUrl: cached.streamUrl.replace(/sig=[^&]+/, 'sig=BROKEN_SIGNATURE'),
    })
    console.log(`[MediaResolver] Corrupted cache for ${videoId}`)
    return true
  }

  return {
    resolve,
    clearCache,
    start,
    stop,
    /** Prefetch upcoming queue tracks into the LRU cache */
    prefetchQueue,
    /** Expose for testing */
    getProxyUrl,
    /** Corrupt cached stream URL for testing 403 recovery */
    corruptCache,
    /** Number of in-flight resolve operations (delegates to proxy) */
    getPendingResolveCount: proxy.getPendingResolveCount,
  }
}

export type MediaResolver = ReturnType<typeof createMediaResolver>
