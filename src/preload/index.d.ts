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

interface SpotifyImportProgress {
  current: number
  total: number
  currentTitle: string
  status: 'fetching' | 'matching' | 'saving'
}

interface SpotifyImportSkipped {
  title: string
  artist: string
  reason: string
}

interface SpotifyImportResult {
  playlistId: string
  playlistName: string
  matchedCount: number
  totalCount: number
  skipped: SpotifyImportSkipped[]
}

interface Track {
  id: string
  title: string
  artist: string
  album?: string
  duration: number
  thumbnailUrl: string
  source: 'youtube' | 'spotify_imported' | 'local'
  sourceId: string
}

interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
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

      // Spotify Import
      importSpotifyPlaylist: (url: string, spDc?: string) => Promise<SpotifyImportResult>
      cancelSpotifyImport: () => Promise<boolean>
      onSpotifyImportProgress: (
        callback: (progress: SpotifyImportProgress) => void
      ) => () => void

      // Playlist Browsing + Queue
      getPlaylists: () => Promise<Playlist[]>
      getPlaylistTracks: (playlistId: string) => Promise<Track[]>
      loadPlaylistIntoQueue: (playlistId: string) => Promise<Track[]>
    }
  }
}
