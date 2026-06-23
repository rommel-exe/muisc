import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ResolvedStream, SpotifyImportProgress, SpotifyImportResult, Track, Playlist } from '../shared/types'
import { IPC_CHANNELS } from '../shared/constants'

// ── Types ──

interface QueueState {
  list: Array<{ queueId: string; track: Track }>
  index: number
  shuffleActive: boolean
  repeatMode: string
}

// Custom APIs for renderer
const api = {
  /**
   * Resolve a video ID's real metadata (title, duration, thumbnail).
   * Awaits the full yt-dlp metadata extraction before returning.
   */
  resolveTrackInfo: (videoId: string): Promise<ResolvedStream> =>
    ipcRenderer.invoke('resolve-track-info', videoId),

  /**
   * Search YouTube for tracks matching a query.
   * Returns lightweight search results (no streaming URLs).
   */
  search: (query: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC_SEARCH, query),

  /**
   * Resolve a video ID to a playable audio source.
   * Returns ResolvedStream with proxy URL.
   */
  resolveTrack: (videoId: string, opts?: { forceRefresh?: boolean }) =>
    ipcRenderer.invoke('resolve-track', videoId, opts),

  /**
   * Prefetch upcoming queue tracks into the LRU cache.
   * Keeps the next N tracks warm by resolving them in background mode.
   */
  prefetchQueue: (upcomingVideoIds: string[]): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFETCH_QUEUE, upcomingVideoIds),

  /**
   * Debug: Corrupt cached stream URL to test 403 recovery.
   */
  testCorruptCache: (videoId: string): Promise<boolean> =>
    ipcRenderer.invoke('test-corrupt-cache', videoId),

  /**
   * Debug: Get number of pending resolve operations.
   */
  testPendingCount: (): Promise<number> =>
    ipcRenderer.invoke('test-pending-count'),

  // ── Spotify Import ──

  /**
   * Import a Spotify playlist by URL.
   * Returns the import result on completion.
   * Progress events are delivered via onSpotifyImportProgress.
   */
  importSpotifyPlaylist: (url: string, spDc?: string): Promise<SpotifyImportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SPOTIFY_PLAYLIST, { url, spDc }),

  /**
   * Cancel an in-progress Spotify import.
   */
  cancelSpotifyImport: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_SPOTIFY_IMPORT),

  /**
   * Listen for Spotify import progress updates.
   * Returns a cleanup function to unsubscribe.
   */
  onSpotifyImportProgress: (
    callback: (progress: SpotifyImportProgress) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: SpotifyImportProgress) => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.SPOTIFY_IMPORT_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SPOTIFY_IMPORT_PROGRESS, handler)
    }
  },

  // ── Playlist Browsing ──

  /**
   * List all user playlists.
   */
  getPlaylists: (): Promise<Playlist[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLAYLISTS),

  /**
   * Get tracks for a playlist by ID.
   */
  getPlaylistTracks: (playlistId: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLAYLIST_TRACKS, playlistId),

  /**
   * Load a playlist's tracks into the queue for playback (FULL REPLACE).
   */
  loadPlaylistIntoQueue: (playlistId: string): Promise<Track[]> =>
    ipcRenderer.invoke('load-playlist-into-queue', playlistId),

  /**
   * Append a playlist's tracks to the end of the current queue (APPEND).
   */
  addPlaylistToQueue: (playlistId: string): Promise<Array<{ queueId: string; track: Track }>> =>
    ipcRenderer.invoke('add-playlist-to-queue', playlistId),

  // ── Queue Management ──

  /**
   * Get the current queue state.
   */
  getQueue: (): Promise<QueueState> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_QUEUE),

  /**
   * Add one or more tracks to the end of the queue.
   */
  addToQueue: (tracks: Track | Track[]): Promise<Array<{ queueId: string; track: Track }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_TO_QUEUE, tracks),

  /**
   * Remove a track from the queue by its index.
   */
  removeFromQueue: (index: number): Promise<Array<{ queueId: string; track: Track }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOVE_FROM_QUEUE, index),

  /**
   * Toggle shuffle on/off. Pass a boolean to set explicitly, omit to toggle.
   */
  setShuffle: (active?: boolean): Promise<{ shuffleActive: boolean; list: Array<{ queueId: string; track: Track }>; index: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_SHUFFLE, active),

  /**
   * Set repeat mode: 'none' | 'all' | 'one'
   */
  setRepeat: (mode: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_REPEAT, mode),

  /**
   * Advance to the next track via QueueEngine state machine.
   * Returns { queueId, track, index } or null.
   */
  queueNext: (): Promise<{ queueId: string; track: Track; index: number } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUEUE_NEXT),

  /**
   * Go to the previous track via QueueEngine state machine.
   * Returns { queueId, track, index } or null.
   */
  queuePrev: (): Promise<{ queueId: string; track: Track; index: number } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PREV),

  /**
   * Peek at the next track without advancing the queue.
   * Returns { track, index: null } or null.
   */
  queuePeekNext: (): Promise<{ track: Track; index: null } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PEEK_NEXT),

  /**
   * Jump to a specific queue index (user clicked a non-current track in the queue).
   * Unlike next()/previous(), this directly sets the index without modifying history.
   */
  jumpToQueueIndex: (index: number): Promise<{ index: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.JUMP_TO_QUEUE_INDEX, index),
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
