import { createProxy } from './proxy'
import type { YTDlpInfo } from './yt-dlp'
import type { ResolvedStream, Track } from '../../shared/types'
import { PROXY_PORT } from '../../shared/constants'
import { getDaemon } from './yt-dlp-daemon'

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

    // 🔥 Force refresh: clear the proxy's stream cache so the handler
    // doesn't return the stale CDN URL. Without this, resolveStreamUrl
    // returns the cached URL (still within 5h TTL) even though the
    // CDN edge is dead/unreachable. The fresh background resolve below
    // populates a new streamCache entry, and the handler awaits it.
    if (forceRefresh) {
      proxy.clearCache(videoId)
    }

    // 🐢 daemon + proxy path.
    // The proxy handler will block until the daemon resolves the stream URL.
    // On a warm daemon (pre-warmed at app startup), this is ~500-800ms.
    // On a cold daemon (first call), this includes yt-dlp module import (~2-3s).
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
   * Start the proxy server and warm the yt-dlp daemon.
   * Call this on app ready.
   *
   * The daemon's Python process imports yt-dlp and establishes the YouTube
   * HTTP connection pool during startup (~2-3s). By the time the user clicks
   * play, the daemon is warm and resolves URLs in ~500-800ms.
   *
   * We start the daemon in the background (fire-and-forget) so it doesn't
   * block the proxy server or window creation.
   */
  async function start(): Promise<void> {
    await proxy.start()

    // Fire daemon warmup in background — yt-dlp module import is expensive
    // and should happen before the user's first click.
    getDaemon().start().catch((err) => {
      console.warn('[MediaResolver] Daemon warm failed:', (err as Error).message)
    })

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

  /**
   * Batch-resolve track URLs so they're cached when the user clicks.
   * Fire-and-forget: resolves in background, does not block queue loading.
   * First track resolves immediately (priority), remaining tracks
   * are staggered (4 concurrent, 100ms spacing).
   */
  async function resolveQueue(tracks: Track[]): Promise<void> {
    const CONCURRENCY = 4
    const MAX_RESOLVE = 50

    const videoIds = tracks
      .map((t) => t.id || t.sourceId)
      .filter((id): id is string => Boolean(id))
      .slice(0, MAX_RESOLVE)

    if (videoIds.length === 0) return

    // First track resolves immediately (highest priority)
    proxy.triggerBackgroundResolve(videoIds[0]).catch(() => {})

    // Remaining tracks in staggered batches starting from index 1.
    // ⚠️ Original code started at i=CONCURRENCY (4), skipping indices 1,2,3!
    // This caused early queue tracks to have cold CDN TTFB (~540ms).
    for (let i = 1; i < videoIds.length; i += CONCURRENCY) {
      const batch = videoIds.slice(i, i + CONCURRENCY)
      batch.forEach((id) => {
        proxy.triggerBackgroundResolve(id).catch(() => {})
      })
      await new Promise((r) => setTimeout(r, 100))
    }
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
    /**
     * Batch-resolve all tracks in a queue so streamCache is warm.
     * Fire-and-forget: resolves are staggered (4 concurrent, 100ms spacing)
     * to avoid overwhelming the daemon. The first track resolves
     * immediately with priority.
     */
    resolveQueue,

    /**
     * Speculatively pre-resolve a video ID so the stream URL and prewarm
     * chunk are ready when the user clicks play. Fire-and-forget.
     *
     * Call this when search results appear, before the user clicks:
     * the daemon extraction (~500ms) and chunk download (~200ms) run
     * in the background. By the time the user clicks, the handler
     * serves from cache or finds the prewarm buffer populated.
     */
    warmupVideo: proxy.triggerBackgroundResolve,
  }
}

export type MediaResolver = ReturnType<typeof createMediaResolver>
