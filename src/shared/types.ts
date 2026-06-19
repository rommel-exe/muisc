export interface Track {
  id: string            // Global Unique Identifier (YouTube ID or Content Hash)
  title: string         // Normalized Title
  artist: string        // Primary Artist Name
  album?: string        // Album Name if available
  duration: number      // Length in seconds
  thumbnailUrl: string  // High-res image link
  source: 'youtube' | 'spotify_imported' | 'local'
  sourceId: string      // Original source ID string
  /** Channel type from YouTube (e.g. 'verified_topic', 'user_upload') */
  channelType?: string
}

export interface SpotifySourceTrack {
  title: string
  artist: string
  duration: number
  explicit?: boolean
}

export interface SpotifySource {
  url: string
  tracks: SpotifySourceTrack[]
}

export interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** If this playlist was imported from Spotify, the original data used to re-match */
  spotifySource?: SpotifySource
}

export interface PlaylistTrack {
  id: string
  playlistId: string
  trackId: string
  position: number
  addedAt: number
}

export interface QueueItem {
  trackId: string
  position: number
}

export type RepeatMode = 'none' | 'all' | 'one'

export type PlaybackStateType = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED' | 'ERRORED'

export interface PlaybackState {
  currentTrackId: string | null
  queue: QueueItem[]
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  isPlaying: boolean
}

export interface SearchResult {
  title: string
  artist: string
  duration: number
  thumbnail: string
  videoId: string
}

export interface ResolvedStream {
  videoId: string
  audioUrl: string // localhost proxy URL, ephemeral
  duration: number
  title: string
  thumbnail: string
}

// ── Spotify Import Types ──

export interface SpotifyImportProgress {
  current: number
  total: number
  currentTitle: string
  status: 'fetching' | 'matching' | 'saving'
}

export interface SpotifyImportSkipped {
  title: string
  artist: string
  reason: string
}

export interface SpotifyImportResult {
  playlistId: string
  playlistName: string
  matchedCount: number
  totalCount: number
  skipped: SpotifyImportSkipped[]
}
