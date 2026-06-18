import { createProxy } from './proxy'
import type { YTDlpInfo } from './yt-dlp'
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

  /** Tracks in-flight metadata resolves so resolveTrackInfo can await them.
   *  Deleted only after the cache is populated (not when the TCP connection settles),
   *  eliminating the race between background-resolve completion and cache update. */
  const pendingInfo = new Map<string, Promise<YTDlpInfo>>()

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

    // Trigger background yt-dlp resolve — proxy caches the CDN URL when done.
    // Fire-and-forget: the promise resolves the daemon URL (~250ms in Python)
    // and updates resolveCache with real metadata when infoPromise settles.
    const infoPromise = proxy.triggerBackgroundResolve(videoId)
    pendingInfo.set(videoId, infoPromise)

    infoPromise.then((info) => {
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
      // Errors logged in proxy.triggerBackgroundResolve
    }).finally(() => {
      pendingInfo.delete(videoId)
    })

    // Return proxy URL immediately. Audio connects to localhost proxy (~10ms)
    // while the daemon resolves the CDN URL in parallel. The proxy then
    // pipes the CDN stream — net effect: CDN connection and daemon run
    // concurrently, not sequentially.
    return {
      videoId,
      audioUrl: getProxyUrl(videoId),
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

  /**
   * Wait for the real metadata (title, duration, thumbnail) for a video ID.
   *
   * resolve() returns placeholder metadata immediately so the audio stream
   * can start loading in parallel. Call this after resolve() when you need
   * the real title/duration — it waits for the in-flight yt-dlp metadata
   * extraction to complete, then returns the populated cache result.
   *
   * If no resolve is in-flight, triggers a fresh background resolve and waits.
   * Safe to call multiple times — subsequent calls hit the cache instantly.
   */
  async function resolveTrackInfo(videoId: string): Promise<ResolvedStream> {
    // Check cache first — fast path when metadata is ready
    const cached = resolveCache.get(videoId)
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return cached.info
    }

    // Wait for an in-flight resolve, or start one
    const pending = pendingInfo.get(videoId) ?? proxy.triggerBackgroundResolve(videoId)
    const info = await pending
    const resolved: ResolvedStream = {
      videoId: info.id,
      audioUrl: getProxyUrl(videoId),
      duration: info.duration,
      title: info.title,
      thumbnail: info.thumbnail || '',
    }
    resolveCache.set(videoId, { info: resolved, cachedAt: Date.now() })
    evictIfNeeded()
    return resolved
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

  /**
   * Pre-warm the CDN connection for a video by pre-resolving its URL
   * and immediately making a small HTTPS GET. The shared keep-alive
   * agent maintains the TCP+TLS connection for subsequent proxy requests.
   * Fire-and-forget — called at startup for the first queue track.
   */
  async function prewarmCdn(videoId: string): Promise<void> {
    return proxy.prewarmCdn(videoId)
  }

  return {
    resolve,
    resolveTrackInfo,
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
    /** Pre-warm CDN connection for a video ID */
    prewarmCdn,
  }
}

export type MediaResolver = ReturnType<typeof createMediaResolver>
