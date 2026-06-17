import { ElectronAPI } from '@electron-toolkit/preload'

import type { SearchResult, ResolvedStream } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      /** Search YouTube Music via Innertube API */
      searchMusic: (query: string) => Promise<SearchResult[]>

      /** Resolve a video ID to a playable stream URL */
      resolveTrack: (
        videoId: string,
        opts?: { forceRefresh?: boolean }
      ) => Promise<ResolvedStream>

      /** Prefetch upcoming queue tracks into the LRU cache */
      prefetchQueue: (upcomingVideoIds: string[]) => Promise<boolean>

      // Debug/test methods
      testCorruptCache: (videoId: string) => Promise<boolean>
      testPendingCount: () => Promise<number>
      testAbortAll: () => Promise<boolean>
    }
  }
}
