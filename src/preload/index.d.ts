import { ElectronAPI } from '@electron-toolkit/preload'

interface ResolvedStream {
  videoId: string
  audioUrl: string
  duration: number
  title: string
  thumbnail: string
}

interface SearchResult {
  videoId: string
  title: string
  artist: string
  duration: number
  thumbnail: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      /** Search YouTube for tracks matching a query */
      search: (query: string) => Promise<SearchResult[]>

      /** Resolve a video ID to a playable audio source */
      resolveTrack: (
        videoId: string,
        opts?: { forceRefresh?: boolean }
      ) => Promise<ResolvedStream>

      /** Resolve a video ID's real metadata (awaits full yt-dlp extraction) */
      resolveTrackInfo: (videoId: string) => Promise<ResolvedStream>

      /** Prefetch upcoming queue tracks into the LRU cache */
      prefetchQueue: (upcomingVideoIds: string[]) => Promise<boolean>

      // Debug/test methods
      testCorruptCache: (videoId: string) => Promise<boolean>
      testPendingCount: () => Promise<number>
      testAbortAll: () => Promise<boolean>
    }
  }
}
