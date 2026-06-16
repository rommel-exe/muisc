import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  /**
   * Resolve a video ID to a playable audio source.
   * Returns ResolvedStream with proxy URL.
   */
  resolveTrack: (videoId: string, opts?: { forceRefresh?: boolean }) =>
    ipcRenderer.invoke('resolve-track', videoId, opts),

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
