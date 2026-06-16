import { createProxy } from './proxy'
import { getVideoInfo, YTDlpError } from './yt-dlp'
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
          const info = await getVideoInfo(videoId, 15000, controller.signal)
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
   * 1. Check resolve cache (skip if forceRefresh)
   * 2. Abort any previous pending resolve for this video ID
   * 3. Call yt-dlp to get video metadata (with abort signal)
   * 4. Cache the metadata
   * 5. Return ResolvedStream with the proxy URL
   *
   * The proxy handles the actual CDN streaming — this just provides the metadata and URL.
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

    // Abort any previous pending resolve for this video ID
    const existing = pendingResolves.get(videoId)
    if (existing) {
      existing.abort()
      console.log(`[MediaResolver] Aborted pending resolve for ${videoId}`)
    }

    const controller = new AbortController()
    pendingResolves.set(videoId, controller)

    // Resolve via yt-dlp with retry
    let lastError: Error | undefined
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const info = await getVideoInfo(videoId, 15000, controller.signal)

          const resolved: ResolvedStream = {
            videoId: info.id,
            audioUrl: getProxyUrl(videoId),
            duration: info.duration,
            title: info.title,
            thumbnail: info.thumbnail,
          }

          // Cache the result
          resolveCache.set(videoId, { info: resolved, cachedAt: Date.now() })
          evictIfNeeded()

          return resolved
        } catch (err: any) {
          // Don't retry if aborted
          if (controller.signal.aborted) {
            throw err
          }

          lastError = err

          // Only retry on retryable errors
          const isRetryable =
            err instanceof YTDlpError &&
            (err.code === 'TIMEOUT' || err.code === 'PARSE_ERROR')

          if (!isRetryable || attempt >= maxRetries) {
            throw err
          }

          // Wait 1s before retry
          await new Promise((r) => setTimeout(r, 1000))
        }
      }

      // Should never reach here, but TypeScript needs it
      throw lastError ?? new Error('Unknown resolve error')
    } finally {
      pendingResolves.delete(videoId)
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
