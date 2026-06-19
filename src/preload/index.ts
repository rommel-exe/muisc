import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ResolvedStream, SpotifyImportProgress, SpotifyImportResult } from '../shared/types'
import { IPC_CHANNELS } from '../shared/constants'

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
