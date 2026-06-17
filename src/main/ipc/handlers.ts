import { ipcMain } from 'electron'
import type { MediaResolver } from '../services/media-resolver'
import type { ResolveOptions } from '../services/media-resolver'
import { IPC_CHANNELS } from '../../shared/constants'

/**
 * Register all IPC handlers for the media resolver pipeline.
 * Call this once during app startup, after the resolver is created.
 */
export function registerHandlers(resolver: MediaResolver): void {
  /**
   * Resolve a video ID to a playable stream.
   * Returns ResolvedStream with proxy URL.
   */
  ipcMain.handle(
    'resolve-track',
    async (_event, videoId: string, opts?: ResolveOptions) => {
      if (!videoId || typeof videoId !== 'string') {
        throw new Error('Invalid videoId: expected a non-empty string')
      }
      return resolver.resolve(videoId, opts)
    }
  )

  /**
   * Debug: Corrupt the cached stream URL for a video to test 403 recovery.
   */
  ipcMain.handle('test-corrupt-cache', async (_event, videoId: string) => {
    return resolver.corruptCache(videoId)
  })

  /**
   * Debug: Get the number of pending (in-flight) resolve operations.
   */
  ipcMain.handle('test-pending-count', async () => {
    return resolver.getPendingCount()
  })

  /**
   * Debug: Abort all pending resolve operations.
   */
  ipcMain.handle('test-abort-all', async () => {
    resolver.abortAllPending()
    return true
  })

  /**
   * Prefetch upcoming queue tracks into the LRU cache.
   * Called by the renderer when the queue changes or playback advances.
   * Fire-and-forget — errors are handled internally by the preloader.
   */
  ipcMain.handle(IPC_CHANNELS.PREFETCH_QUEUE, async (_event, upcomingVideoIds: string[]) => {
    if (!Array.isArray(upcomingVideoIds)) {
      throw new Error('Invalid upcomingVideoIds: expected an array of strings')
    }
    // Don't await — prefetch is best-effort background work
    resolver.prefetchQueue(upcomingVideoIds).catch(() => {
      // Errors are logged internally in executeBackgroundPreload
    })
    return true
  })

  console.log('[IPC] Handlers registered')
}

/**
 * Unregister all IPC handlers. Call on app quit.
 */
export function unregisterHandlers(): void {
  ipcMain.removeAllListeners('resolve-track')
  ipcMain.removeAllListeners('test-corrupt-cache')
  ipcMain.removeAllListeners('test-pending-count')
  ipcMain.removeAllListeners('test-abort-all')
  ipcMain.removeAllListeners(IPC_CHANNELS.PREFETCH_QUEUE)
  console.log('[IPC] Handlers unregistered')
}
