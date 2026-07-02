import { ipcMain } from 'electron'
import type { MediaResolver } from '../services/media-resolver'
import type { ResolveOptions } from '../services/media-resolver'
import { searchYouTube } from '../services/innertube'
import { IPC_CHANNELS } from '../../shared/constants'
import { importSpotifyPlaylist, rematchPlaylist } from '../services/spotify-importer'
import { PlaylistEngine } from '../../application/PlaylistEngine'
import { QueueEngine } from '../../application/QueueEngine'
import type { RepeatMode, Track } from '../../shared/types'

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
   * Only available in development mode.
   */
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
    ipcMain.handle('test-corrupt-cache', async (_event, videoId: string) => {
      return resolver.corruptCache(videoId)
    })

    /**
     * Debug: Get the number of in-flight background resolve operations.
     */
    ipcMain.handle('test-pending-count', async () => {
      return resolver.getPendingResolveCount()
    })
  }

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
    resolver.prefetchQueue(upcomingVideoIds).catch((err: any) => {
      console.warn(`[IPC] Prefetch failed:`, err?.message ?? err)
    })
    return true
  })

  /**
   * Resolve a video ID's metadata (title, duration, thumbnail).
   * Unlike resolve-track, this waits for the full yt-dlp metadata extraction
   * before returning — use it when you need the real song title for display.
   */
  ipcMain.handle(
    'resolve-track-info',
    async (_event, videoId: string) => {
      if (!videoId || typeof videoId !== 'string') {
        throw new Error('Invalid videoId: expected a non-empty string')
      }
      return resolver.resolveTrackInfo(videoId)
    }
  )

  /**
   * Search YouTube for tracks matching a query.
   * Returns lightweight search results (no streaming URLs).
   *
   * After returning results, speculatively pre-resolves the FIRST result's
   * stream URL so the handler can serve from cache when the user clicks play.
   */
  ipcMain.handle(
    IPC_CHANNELS.MUSIC_SEARCH,
    async (_event, query: string) => {
      if (!query || typeof query !== 'string') {
        throw new Error('Invalid query: expected a non-empty string')
      }
      const results = await searchYouTube(query)

      // Speculative pre-resolution: start daemon for the first result.
      // By the time the user clicks play, the stream URL is cached.
      if (results.length > 0) {
        resolver.warmupVideo(results[0].videoId).catch(() => {
          // Errors are logged inside triggerBackgroundResolve
        })
      }

      return results
    }
  )

  // ── Queue Management ──

  /**
   * Get the current queue state for UI rendering.
   * Returns { list: QueueTrack[], index: number, shuffleActive: boolean, repeatMode: string }
   */
  ipcMain.handle(IPC_CHANNELS.GET_QUEUE, () => {
    return {
      list: QueueEngine.getList(),
      index: QueueEngine.getCurrentIndex(),
      shuffleActive: QueueEngine.isShuffleActive(),
      repeatMode: QueueEngine.getRepeatMode(),
    }
  })

  /**
   * Add tracks to the end of the current queue.
   * Accepts a single Track or an array of Tracks.
   */
  ipcMain.handle(IPC_CHANNELS.ADD_TO_QUEUE, (_event, tracks: Track | Track[]) => {
    const arr = Array.isArray(tracks) ? tracks : [tracks]
    if (arr.length === 0) throw new Error('No tracks to add')
    QueueEngine.appendTracks(arr)
    return QueueEngine.getList()
  })

  /**
   * Remove a track from the queue by its index.
   */
  ipcMain.handle(IPC_CHANNELS.REMOVE_FROM_QUEUE, (_event, index: number) => {
    if (typeof index !== 'number' || index < 0) {
      throw new Error('Invalid index')
    }
    QueueEngine.removeTrack(index)
    return QueueEngine.getList()
  })

  /**
   * Reorder a track in the queue.
   */
  ipcMain.handle(IPC_CHANNELS.REORDER_QUEUE, (_event, fromIndex: number, toIndex: number) => {
    if (typeof fromIndex !== 'number' || typeof toIndex !== 'number' || fromIndex < 0 || toIndex < 0) {
      throw new Error('Invalid reorder indices: expected non-negative numbers')
    }
    QueueEngine.reorder(fromIndex, toIndex)
    return QueueEngine.getList()
  })

  /**
   * Clear the entire queue.
   */
  ipcMain.handle(IPC_CHANNELS.CLEAR_QUEUE, () => {
    QueueEngine.clear()
    return true
  })

  /**
   * Toggle shuffle on/off.
   * Returns the new shuffle state.
   */
  ipcMain.handle(IPC_CHANNELS.SET_SHUFFLE, (_event, active?: boolean) => {
    if (typeof active === 'boolean') {
      QueueEngine.setShuffleActive(active)
    } else {
      QueueEngine.toggleShuffle()
    }
    return {
      shuffleActive: QueueEngine.isShuffleActive(),
      list: QueueEngine.getList(),
      index: QueueEngine.getCurrentIndex(),
    }
  })

  /**
   * Set repeat mode.
   */
  ipcMain.handle(IPC_CHANNELS.SET_REPEAT, (_event, mode: RepeatMode) => {
    if (mode !== 'none' && mode !== 'all' && mode !== 'one') {
      throw new Error('Invalid repeat mode')
    }
    QueueEngine.setRepeatMode(mode)
    return QueueEngine.getRepeatMode()
  })

  /** Generation counter for load-playlist-into-queue / add-playlist-to-queue.
   *  Incremented on every call. Rematch callbacks check this — if the generation
   *  has changed, the callback's data is stale and should not overwrite the queue. */
  let _loadQueueGen = 0

  // ── Spotify Import ──

  /**
   * Import a Spotify playlist by URL.
   * Sends progress events during import and returns the result on completion.
   * Only one import can run at a time — starting a new one cancels any in-flight.
   */
  let currentAbortController: AbortController | null = null

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SPOTIFY_PLAYLIST,
    async (event, args: { url: string; spDc?: string }) => {
      const url = args?.url
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL: expected a non-empty string')
      }
      const spDc = args?.spDc

      // Cancel previous import if still running
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
      }

      const abortController = new AbortController()
      currentAbortController = abortController
      const signal = abortController.signal

      try {
        const result = await importSpotifyPlaylist(url, spDc, event.sender, signal)
        return result
      } finally {
        if (currentAbortController === abortController) {
          currentAbortController = null
        }
      }
    }
  )

  /**
   * Cancel an in-progress Spotify import.
   */
  ipcMain.handle(IPC_CHANNELS.CANCEL_SPOTIFY_IMPORT, () => {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
      return true
    }
    return false
  })

  // ── Playlist Browsing + Queue Loading ──

  /**
   * List all user playlists.
   */
  ipcMain.handle(IPC_CHANNELS.GET_PLAYLISTS, () => {
    return PlaylistEngine.getUserPlaylists()
  })

  /**
   * Get tracks for a playlist by ID.
   */
  ipcMain.handle(IPC_CHANNELS.GET_PLAYLIST_TRACKS, (_event, playlistId: string) => {
    if (typeof playlistId !== 'string' || !playlistId) {
      throw new Error('Invalid playlistId: expected a non-empty string')
    }
    return PlaylistEngine.getPlaylistTracks(playlistId)
  })

  /**
   * Load a playlist's tracks into the queue (FULL REPLACE) and return them.
   * Queue loads instantly (<1s). If the playlist has stored Spotify source
   * data, rematch runs in background and updates queue when done.
   */
  ipcMain.handle('load-playlist-into-queue', async (_event, playlistId: string) => {
    if (typeof playlistId !== 'string' || !playlistId) {
      throw new Error('Invalid playlistId: expected a non-empty string')
    }

    // Load queue IMMEDIATELY with existing tracks (no rematch wait)
    const tracks = PlaylistEngine.getPlaylistTracks(playlistId)
    if (tracks.length === 0) {
      throw new Error('Playlist is empty')
    }
    const loadGen = ++_loadQueueGen
    QueueEngine.setQueue(tracks, 0)

    // Fire rematch in background if needed — updates queue when done
    const pl = PlaylistEngine.getUserPlaylists().find((p) => p.id === playlistId)
    if (pl?.spotifySource) {
      rematchPlaylist(playlistId).then(() => {
        // Guard: if a newer load call has replaced the queue, skip stale rematch
        if (_loadQueueGen !== loadGen) {
          console.log(`[IPC] Rematch stale for ${playlistId} (gen=${loadGen} != ${_loadQueueGen}), skipping`)
          return
        }
        const updated = PlaylistEngine.getPlaylistTracks(playlistId)
        const queueLen = QueueEngine.getList().length
        for (let i = 0; i < updated.length; i++) {
          if (i < queueLen) {
            QueueEngine.updateTrackAt(i, updated[i])
          } else {
            // Overflow: rematch found more tracks than the queue had.
            // Append extras so the user sees all matched tracks.
            QueueEngine.appendTracks([updated[i]])
          }
        }
        console.log(`[IPC] Rematch complete for ${playlistId}, queue updated`)
      }).catch((err: any) => {
        console.error(`[IPC] Rematch failed for ${playlistId}:`, err.message)
      })
    }

    resolver.resolveQueue(tracks).catch(() => {})

    return tracks
  })

  /**
   * Append a playlist's tracks to the end of the current queue (APPEND).
   * Queue appends instantly (<1s). If the playlist has stored Spotify source
   * data, rematch runs in background and updates appended tracks when done.
   */
  ipcMain.handle('add-playlist-to-queue', async (_event, playlistId: string) => {
    if (typeof playlistId !== 'string' || !playlistId) {
      throw new Error('Invalid playlistId: expected a non-empty string')
    }

    // Append IMMEDIATELY with existing tracks (no rematch wait)
    const tracks = PlaylistEngine.getPlaylistTracks(playlistId)
    if (tracks.length === 0) {
      throw new Error('Playlist is empty')
    }
    const startIndex = QueueEngine.getList().length
    const appendGen = ++_loadQueueGen
    QueueEngine.appendTracks(tracks)

    // Fire rematch in background — updates appended tracks when done
    const pl = PlaylistEngine.getUserPlaylists().find((p) => p.id === playlistId)
    if (pl?.spotifySource) {
      rematchPlaylist(playlistId).then(() => {
        if (_loadQueueGen !== appendGen) {
          console.log(`[IPC] Rematch stale for append ${playlistId} (gen=${appendGen} != ${_loadQueueGen}), skipping`)
          return
        }
        const updated = PlaylistEngine.getPlaylistTracks(playlistId)
        const queueLen = QueueEngine.getList().length
        for (let i = 0; i < updated.length; i++) {
          if (startIndex + i < queueLen) {
            QueueEngine.updateTrackAt(startIndex + i, updated[i])
          } else {
            // Overflow: rematch found more tracks than the queue had.
            QueueEngine.appendTracks([updated[i]])
          }
        }
        console.log(`[IPC] Rematch complete for ${playlistId}, appended tracks updated`)
      }).catch((err: any) => {
        console.error(`[IPC] Rematch failed for ${playlistId}:`, err.message)
      })
    }

    return QueueEngine.getList()
  })

  // ── Queue Navigation (delegates to QueueEngine state machine) ──

  /**
   * Advance to the next track via QueueEngine.next().
   * Returns { queueId, track, index } or null if end of queue.
   */
  ipcMain.handle(IPC_CHANNELS.QUEUE_NEXT, () => {
    const result = QueueEngine.next()
    if (!result) return null
    return { ...result, index: QueueEngine.getCurrentIndex() }
  })

  /**
   * Go to the previous track via QueueEngine.previous().
   * Returns { queueId, track, index } or null if no previous track.
   */
  ipcMain.handle(IPC_CHANNELS.QUEUE_PREV, () => {
    const result = QueueEngine.previous()
    if (!result) return null
    return { ...result, index: QueueEngine.getCurrentIndex() }
  })

  /**
   * Peek at the next track without advancing (non-destructive).
   * Returns { queueId, track, index } or null if no upcoming track.
   * The index is approximate for shuffle mode (QueueEngine.peekNext).
   */
  ipcMain.handle(IPC_CHANNELS.QUEUE_PEEK_NEXT, () => {
    const track = QueueEngine.peekNext()
    if (!track) return null
    // Peek doesn't affect index — we return current next candidate
    return { track, index: null }
  })

  /**
   * Jump to a specific queue index (user clicked a non-current track in the queue).
   * Unlike next()/previous(), this directly sets the index without modifying history.
   */
  ipcMain.handle(IPC_CHANNELS.JUMP_TO_QUEUE_INDEX, (_event, index: number) => {
    if (typeof index !== 'number' || index < 0) {
      throw new Error('Invalid index')
    }
    QueueEngine.jumpToIndex(index)
    return { index: QueueEngine.getCurrentIndex() }
  })

  console.log('[IPC] Handlers registered')
}

/**
 * Unregister all IPC handlers. Call on app quit.
 */
export function unregisterHandlers(): void {
  const allChannels = [
    'resolve-track',
    'resolve-track-info',
    'test-corrupt-cache',
    'test-pending-count',
    'load-playlist-into-queue',
    'add-playlist-to-queue',
    ...Object.values(IPC_CHANNELS),
  ]
  for (const channel of allChannels) {
    ipcMain.removeHandler(channel)
  }
  console.log('[IPC] Handlers unregistered')
}
