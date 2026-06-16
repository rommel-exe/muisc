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

  const proxy = createProxy({ port: proxyPort, cacheTtlMs })

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
   * 1. Check resolve cache (skip if forceRefresh)
   * 2. Call yt-dlp to get video metadata
   * 3. Cache the metadata
   * 4. Return ResolvedStream with the proxy URL
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

    // Resolve via yt-dlp with retry
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const info = await getVideoInfo(videoId)

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
        lastError = err

        // Only retry on retryable errors
        const isRetryable =
          err instanceof YTDlpError &&
          (err.code === 'TIMEOUT')

        if (!isRetryable || attempt >= maxRetries) {
          throw err
        }

        // Wait 1s before retry
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError ?? new Error('Unknown resolve error')
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

  return {
    resolve,
    clearCache,
    start,
    stop,
    /** Expose for testing */
    getProxyUrl,
  }
}

export type MediaResolver = ReturnType<typeof createMediaResolver>
