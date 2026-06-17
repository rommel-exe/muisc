import { createProxy } from './proxy'
import { getVideoInfo, YTDlpError } from './yt-dlp'
import type { YTDlpInfo } from './yt-dlp'
import { resolveViaInnerTube } from './innertube'
import type { InnertubeResult } from './innertube'
import type { ResolvedStream } from '../../shared/types'
import { PROXY_PORT } from '../../shared/constants'

export interface ResolveOptions {
  /** Force re-resolution even if cached */
  forceRefresh?: boolean
  /** Extraction mode hint (default: 'foreground') */
  mode?: 'foreground' | 'background'
  /** External abort signal (e.g. from background preloader) */
  signal?: AbortSignal
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
    maxRetries = 1,
    cacheSize = 100,
    cacheTtlMs = 5 * 60 * 60 * 1000,
    preloadedWindowSize = 3,
    maxConcurrentPreloads = 2,
  } = config

  /**
   * Re-resolve callback for proxy's CDN 403/410 recovery.
   * Clears MediaResolver's cache and returns a fresh CDN stream URL.
   */
  const reResolveStream = async (videoId: string): Promise<string> => {
    // Clear resolve cache so next resolve-track gets fresh metadata
    resolveCache.delete(videoId)

    // Abort any pending resolve for this video ID
    const existing = pendingResolves.get(videoId)
    if (existing) {
      existing.abort()
      console.log(`[MediaResolver] Aborted pending resolve for ${videoId} during 403/410 recovery`)
    }

    const controller = new AbortController()
    pendingResolves.set(videoId, controller)

    try {
      // Retry once on transient failures (GPU process crash, etc.)
      let lastError: Error | undefined
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const info = await getVideoInfo(videoId, { timeoutMs: 15000, signal: controller.signal })
          const bestFormat = info.formats
            .filter((f) => f.acodec !== 'none' && f.url)
            .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0]

          if (!bestFormat?.url) {
            throw new Error('No audio format found during 403/410 recovery')
          }

          // Update proxy's stream cache with new CDN URL
          proxy.setStreamCacheEntry(videoId, {
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
      throw lastError ?? new Error('Stream re-resolve failed')
    } finally {
      pendingResolves.delete(videoId)
    }
  }

  const proxy = createProxy({ port: proxyPort, cacheTtlMs, onReResolve: reResolveStream })

  // LRU cache: videoId → ResolvedStream (minus audioUrl, which is derived from proxy)
  const resolveCache = new Map<string, { info: ResolvedStream; cachedAt: number }>()

  // Track pending resolves so we can abort duplicates
  const pendingResolves = new Map<string, AbortController>()

  // ── Sliding window preloader state ──

  // AbortControllers for background preloads so we can cancel stale ones on window shift
  const backgroundControllers = new Map<string, AbortController>()

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
   * 1. Check resolve cache (skip if forceRefresh) — 0ms on hit
   * 2. Abort any previous/stale resolve for this video ID (rapid-skip guard)
   * 3. Parallel race: InnerTube (pure JS, ~500ms) vs yt-dlp (Python, ~2-3s)
   *    — InnerTube winner: abort yt-dlp, return fast URL immediately
   *    — yt-dlp winner: already in-flight, return when done (no sequential penalty)
   *    — InnerTube failure: yt-dlp has been running in parallel — zero time lost
   * 4. Cache the metadata in LRU
   * 5. Return ResolvedStream with the proxy URL
   *
   * The proxy handles the actual CDN streaming — this just provides the metadata and URL.
   */
  async function resolve(
    videoId: string,
    opts: ResolveOptions = {}
  ): Promise<ResolvedStream> {
    const { forceRefresh = false, mode = 'foreground', signal: externalSignal } = opts

    // Check cache first
    if (!forceRefresh) {
      const cached = resolveCache.get(videoId)
      if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
        return cached.info
      }
    }

    // When no external signal is provided, use internal abort tracking
    // to deduplicate rapid foreground resolves for the same video ID.
    // Background preloads manage their own controllers externally.
    if (!externalSignal) {
      // Abort previous foreground resolve for the same video ID (rapid re-spam)
      const existing = pendingResolves.get(videoId)
      if (existing) {
        existing.abort()
        console.log(`[MediaResolver] Aborted pending resolve for ${videoId}`)
      }

      // Abort any in-flight background preload for the same video ID so the
      // foreground resolve doesn't race a background yt-dlp subprocess.
      // Without this, rapid skip-spam can leave both running concurrently,
      // wasting resources and potentially corrupting the proxy stream cache.
      const bgController = backgroundControllers.get(videoId)
      if (bgController) {
        bgController.abort()
        console.log(`[MediaResolver] Aborted background preload for ${videoId} (foreground resolve)`)
        // executeBackgroundPreload's finally{} will clean up the Map entry
      }
    }

    const controller = new AbortController()
    if (!externalSignal) {
      pendingResolves.set(videoId, controller)
    }

    // Use external signal (e.g. from background preloader) or internal controller
    const activeSignal = externalSignal ?? controller.signal

    // ── Helper: populate proxy cache + resolve cache + return ResolvedStream ──
    const cacheAndReturn = (
      videoId: string,
      title: string,
      duration: number,
      thumbnail: string,
    ): ResolvedStream => {
      const resolved: ResolvedStream = {
        videoId,
        audioUrl: getProxyUrl(videoId),
        duration,
        title,
        thumbnail,
      }
      resolveCache.set(videoId, { info: resolved, cachedAt: Date.now() })
      evictIfNeeded()
      return resolved
    }

    // ── yt-dlp retry promise ──
    // Extracted so we can race it against InnerTube.
    const ytDlpPromise = (async (): Promise<YTDlpInfo> => {
      let lastError: Error | undefined
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await getVideoInfo(videoId, { timeoutMs: 15000, signal: activeSignal, mode })
        } catch (err: any) {
          if (activeSignal.aborted) throw err
          lastError = err
          const isRetryable =
            err instanceof YTDlpError &&
            (err.code === 'TIMEOUT' || err.code === 'PARSE_ERROR')
          if (!isRetryable || attempt >= maxRetries) throw err
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      throw lastError ?? new Error('Unknown resolve error')
    })()

    // ── Parallel race: InnerTube (fast, pure JS) vs yt-dlp (safe, Python) ──
    // Only foreground resolves race; background preloads use yt-dlp directly.
    let resolved: ResolvedStream | null = null

    if (!externalSignal) {
      const innertubePromise = resolveViaInnerTube(videoId, activeSignal)

      // Safe-race: if InnerTube returns a valid result first, abort yt-dlp and use it.
      // If InnerTube fails or yt-dlp wins first, fall through to yt-dlp below.
      // The "never settle" catch means InnerTube rejection doesn't reject the race.
      const neverSettle = new Promise<{ source: 'innertube'; value: InnertubeResult }>(() => {})
      const wrappedFast = innertubePromise.then(
        (r) => (r ? { source: 'innertube' as const, value: r } : null),
        () => neverSettle, // reject → InnerTube didn't win
      )
      const wrappedSafe = ytDlpPromise.then(
        () => null as { source: 'innertube'; value: InnertubeResult } | null, // yt-dlp resolved first → don't use InnerTube
        () => null, // yt-dlp errored → don't use InnerTube either
      )

      const winner = await Promise.race([wrappedFast, wrappedSafe])

      if (winner?.source === 'innertube') {
        // 🏎️ InnerTube won! Kill yt-dlp and use the fast result.
        controller.abort()
        console.log(`[MediaResolver] InnerTube won race for ${videoId}`)

        proxy.setStreamCacheEntry(videoId, {
          streamUrl: winner.value.streamingUrl,
          cachedAt: Date.now(),
          contentType: winner.value.contentType,
        })

        resolved = cacheAndReturn(
          winner.value.videoId,
          winner.value.title,
          winner.value.duration,
          winner.value.thumbnail,
        )
        pendingResolves.delete(videoId)
        return resolved
      }
      // If we get here: InnerTube returned null, failed, or yt-dlp was faster.
      // yt-dlp is already running — fall through to the handler below.
    }

    // ── yt-dlp result handler (already running for foreground, or just started for background preloads) ──
    try {
      const info = await ytDlpPromise

      // Pre-populate proxy stream cache
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

      resolved = cacheAndReturn(info.id, info.title, info.duration, info.thumbnail)
    } finally {
      pendingResolves.delete(videoId)
    }

    return resolved
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
   * Prefetch upcoming queue tracks into the LRU cache.
   * Keeps the next N tracks warm by resolving them in background mode.
   *
   * Call this whenever the queue changes or playback advances:
   * - After adding tracks to the queue
   * - After skip/next/prev
   * - After play starts on a new track
   *
   * Concurrency is capped to avoid saturating network bandwidth.
   * Stale preloads (for IDs no longer in the window) are aborted automatically.
   */
  async function prefetchQueue(upcomingVideoIds: string[]): Promise<void> {
    // 1. Abort any in-flight preloads for IDs outside the current window
    const windowedIds = new Set(upcomingVideoIds.slice(0, preloadedWindowSize))
    for (const [id, controller] of backgroundControllers) {
      if (!windowedIds.has(id)) {
        controller.abort()
        backgroundControllers.delete(id)
      }
    }

    // 2. Determine which upcoming tracks actually need preloading
    const targets = upcomingVideoIds
      .slice(0, preloadedWindowSize)
      .filter((id) => {
        // Already being preloaded (backgroundControllers keys are video IDs)
        if (backgroundControllers.has(id)) return false
        // Already in cache and still fresh
        const cached = resolveCache.get(id)
        if (cached && Date.now() - cached.cachedAt < cacheTtlMs) return false
        return true
      })

    // 3. Feed targets into the background preloader, respecting concurrency cap
    const availableSlots = Math.max(0, maxConcurrentPreloads - backgroundControllers.size)
    for (const videoId of targets.slice(0, availableSlots)) {
      // Fire-and-forget — errors are handled internally
      executeBackgroundPreload(videoId)
    }
  }

  /**
   * Background preload a single video ID.
   * Resolves in background mode and caches the result when complete.
   * The AbortController is registered in `backgroundControllers` so that
   * `prefetchQueue` can cancel stale preloads and `stop()` can kill all.
   */
  async function executeBackgroundPreload(videoId: string): Promise<void> {
    const controller = new AbortController()
    backgroundControllers.set(videoId, controller)

    try {
      console.log(`[MediaResolver] Background preloading: ${videoId}`)
      // Pass the signal to resolve() so external abort actually cancels yt-dlp
      await resolve(videoId, { mode: 'background', signal: controller.signal })
      console.log(`[MediaResolver] Background preload complete: ${videoId}`)
    } catch (err: any) {
      // Aborted preloads are intentional — don't log as warnings
      if (err instanceof YTDlpError && err.code === 'ABORTED') {
        console.log(`[MediaResolver] Background preload aborted: ${videoId}`)
      } else {
        console.warn(`[MediaResolver] Background preload failed for ${videoId}:`, err.message)
      }
    } finally {
      backgroundControllers.delete(videoId)
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
    // Abort all pending background preloads
    for (const [id, controller] of backgroundControllers) {
      controller.abort()
      console.log(`[MediaResolver] Aborted background preload for ${id}`)
    }
    backgroundControllers.clear()

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
   * Get the number of pending (in-flight) resolve operations.
   */
  function getPendingCount(): number {
    return pendingResolves.size
  }

  /**
   * Abort all pending resolve operations.
   */
  function abortAllPending(): void {
    for (const [videoId, controller] of pendingResolves) {
      controller.abort()
      console.log(`[MediaResolver] Aborted pending resolve for ${videoId}`)
    }
    pendingResolves.clear()
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
    /** Number of in-flight resolve operations */
    getPendingCount,
    /** Abort all pending resolve operations */
    abortAllPending,
  }
}

export type MediaResolver = ReturnType<typeof createMediaResolver>
