import { ipcMain } from 'electron'
import type { MediaResolver } from '../services/media-resolver'
import type { ResolveOptions } from '../services/media-resolver'
import { searchYouTube } from '../services/innertube'
import { IPC_CHANNELS } from '../../shared/constants'
import { importSpotifyPlaylist, rematchPlaylist } from '../services/spotify-importer'
import { PlaylistEngine } from '../../application/PlaylistEngine'
import { QueueEngine } from '../../application/QueueEngine'
import type { Track } from '../../shared/types'

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
   * Debug: Get the number of in-flight background resolve operations.
   */
  ipcMain.handle('test-pending-count', async () => {
    return resolver.getPendingResolveCount()
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
   */
  ipcMain.handle(
    IPC_CHANNELS.MUSIC_SEARCH,
    async (_event, query: string) => {
      if (!query || typeof query !== 'string') {
        throw new Error('Invalid query: expected a non-empty string')
      }
      return searchYouTube(query)
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
  ipcMain.handle(IPC_CHANNELS.SET_REPEAT, (_event, mode: string) => {
    if (mode !== 'none' && mode !== 'all' && mode !== 'one') {
      throw new Error('Invalid repeat mode')
    }
    QueueEngine.setRepeatMode(mode)
    return QueueEngine.getRepeatMode()
  })

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
   * If the playlist has stored Spotify source data, re-matches it first.
   */
  ipcMain.handle('load-playlist-into-queue', async (_event, playlistId: string) => {
    if (typeof playlistId !== 'string' || !playlistId) {
      throw new Error('Invalid playlistId: expected a non-empty string')
    }

    const pl = PlaylistEngine.getUserPlaylists().find((p) => p.id === playlistId)
    if (pl?.spotifySource) {
      await rematchPlaylist(playlistId)
    }

    const tracks = PlaylistEngine.getPlaylistTracks(playlistId)
    if (tracks.length === 0) {
      throw new Error('Playlist is empty')
    }
    QueueEngine.setQueue(tracks, 0)

    // Fire-and-forget: prewarm CDN for the first track so cold play is faster
    if (tracks.length > 0) {
      const firstId = tracks[0].id || tracks[0].sourceId
      resolver.prewarmCdn(firstId).catch(() => {})
    }

    return tracks
  })

  /**
   * Append a playlist's tracks to the end of the current queue (APPEND).
   * If the playlist has stored Spotify source data, re-matches it first.
   */
  ipcMain.handle('add-playlist-to-queue', async (_event, playlistId: string) => {
    if (typeof playlistId !== 'string' || !playlistId) {
      throw new Error('Invalid playlistId: expected a non-empty string')
    }

    const pl = PlaylistEngine.getUserPlaylists().find((p) => p.id === playlistId)
    if (pl?.spotifySource) {
      await rematchPlaylist(playlistId)
    }

    const tracks = PlaylistEngine.getPlaylistTracks(playlistId)
    if (tracks.length === 0) {
      throw new Error('Playlist is empty')
    }
    QueueEngine.appendTracks(tracks)
    return QueueEngine.getList()
  })

  console.log('[IPC] Handlers registered')
}

/**
 * Unregister all IPC handlers. Call on app quit.
 */
export function unregisterHandlers(): void {
  ipcMain.removeAllListeners('resolve-track')
  ipcMain.removeAllListeners('resolve-track-info')
  ipcMain.removeAllListeners('test-corrupt-cache')
  ipcMain.removeAllListeners('test-pending-count')
  ipcMain.removeAllListeners(IPC_CHANNELS.MUSIC_SEARCH)
  ipcMain.removeAllListeners(IPC_CHANNELS.IMPORT_SPOTIFY_PLAYLIST)
  ipcMain.removeAllListeners(IPC_CHANNELS.CANCEL_SPOTIFY_IMPORT)
  ipcMain.removeAllListeners(IPC_CHANNELS.GET_QUEUE)
  ipcMain.removeAllListeners(IPC_CHANNELS.ADD_TO_QUEUE)
  ipcMain.removeAllListeners(IPC_CHANNELS.REMOVE_FROM_QUEUE)
  ipcMain.removeAllListeners(IPC_CHANNELS.REORDER_QUEUE)
  ipcMain.removeAllListeners(IPC_CHANNELS.CLEAR_QUEUE)
  ipcMain.removeAllListeners(IPC_CHANNELS.SET_SHUFFLE)
  ipcMain.removeAllListeners(IPC_CHANNELS.SET_REPEAT)
  ipcMain.removeAllListeners(IPC_CHANNELS.GET_PLAYLISTS)
  ipcMain.removeAllListeners(IPC_CHANNELS.GET_PLAYLIST_TRACKS)
  console.log('[IPC] Handlers unregistered')
}
