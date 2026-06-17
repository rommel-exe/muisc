import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS } from '../shared/constants'

// Custom APIs for renderer
const api = {
  /**
   * Search YouTube Music via Innertube API.
   * Returns SearchResult[] with title, artist, duration, thumbnail, videoId.
   */
  searchMusic: (query: string) =>
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

  /**
   * Debug: Abort all pending resolve operations.
   */
  testAbortAll: (): Promise<boolean> =>
    ipcRenderer.invoke('test-abort-all'),
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
