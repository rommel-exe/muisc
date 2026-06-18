export interface Track {
  id: string            // Global Unique Identifier (YouTube ID or Content Hash)
  title: string         // Normalized Title
  artist: string        // Primary Artist Name
  album?: string        // Album Name if available
  duration: number      // Length in seconds
  thumbnailUrl: string  // High-res image link
  source: 'youtube' | 'spotify_imported' | 'local'
  sourceId: string      // Original source ID string
}

export interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
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
