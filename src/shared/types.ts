export interface Track {
  id: string
  youtubeId: string
  title: string
  artist: string
  album: string
  duration: number // seconds
  thumbnail: string
  addedAt: number // timestamp
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
