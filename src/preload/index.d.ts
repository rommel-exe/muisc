import { ElectronAPI } from '@electron-toolkit/preload'

interface ResolvedStream {
  videoId: string
  audioUrl: string
  duration: number
  title: string
  thumbnail: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      resolveTrack: (
        videoId: string,
        opts?: { forceRefresh?: boolean }
      ) => Promise<ResolvedStream>

      // Debug/test methods
      testCorruptCache: (videoId: string) => Promise<boolean>
      testPendingCount: () => Promise<number>
      testAbortAll: () => Promise<boolean>
    }
  }
}
