import type { Track, Playlist, SpotifySource } from '../shared/types'
import { QueueEngine } from './QueueEngine'

// ── Internal State ──

let _playlists: Playlist[] = []
let _playlistTracks: Map<string, Track[]> = new Map()

// ── Core Methods ──

function createPlaylist(name: string): Playlist {
  const playlist: Playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  _playlists.push(playlist)
  _playlistTracks.set(playlist.id, [])
  return playlist
}

function addTrackToPlaylist(playlistId: string, track: Track): void {
  const existing = _playlistTracks.get(playlistId)
  if (existing) {
    existing.push(track)
  }
  // Update playlist timestamp
  const pl = _playlists.find(p => p.id === playlistId)
  if (pl) {
    pl.updatedAt = Date.now()
  }
}

function getUserPlaylists(): Playlist[] {
  return [..._playlists]
}

function getPlaylistTracks(playlistId: string): Track[] {
  return [...(_playlistTracks.get(playlistId) ?? [])]
}

function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  const existing = _playlistTracks.get(playlistId)
  if (existing) {
    const idx = existing.findIndex(t => t.id === trackId)
    if (idx >= 0) {
      existing.splice(idx, 1)
    }
  }
  const pl = _playlists.find(p => p.id === playlistId)
  if (pl) {
    pl.updatedAt = Date.now()
  }
}

function renamePlaylist(playlistId: string, newName: string): void {
  const pl = _playlists.find(p => p.id === playlistId)
  if (pl) {
    pl.name = newName
    pl.updatedAt = Date.now()
  }
}

function deletePlaylist(playlistId: string): void {
  _playlists = _playlists.filter(p => p.id !== playlistId)
  _playlistTracks.delete(playlistId)
}

interface SessionState {
  queue: Track[]
  currentIndex: number
  volume: number
}

/**
 * Hydrate application state from a saved session.
 * Restores QueueEngine state from a saved session.
 */
function hydrateSession(sessionState: SessionState): void {
  const { queue, currentIndex, volume } = sessionState

  if (queue && queue.length > 0) {
    QueueEngine.setQueue(queue, currentIndex)
  }

  // Volume restoration not yet wired — stored for future session persistence
  if (typeof volume === 'number') {
    // Volume will be restored via a dedicated IPC channel in a later phase
  }
}

function findPlaylistByName(name: string): Playlist | undefined {
  return _playlists.find(p => p.name === name)
}

/**
 * Replace all tracks for a playlist (used for re-matching).
 */
function setPlaylistTracks(playlistId: string, tracks: Track[]): void {
  _playlistTracks.set(playlistId, [...tracks])
  const pl = _playlists.find(p => p.id === playlistId)
  if (pl) {
    pl.updatedAt = Date.now()
  }
}

/**
 * Set the Spotify source data on a playlist so it can be re-matched later.
 */
function setPlaylistSource(playlistId: string, source: SpotifySource): void {
  const pl = _playlists.find(p => p.id === playlistId)
  if (pl) {
    pl.spotifySource = source
    pl.updatedAt = Date.now()
  }
}

function clear(): void {
  _playlists = []
  _playlistTracks.clear()
}

// ── Exported Singleton ──

export const PlaylistEngine = {
  createPlaylist,
  addTrackToPlaylist,
  getUserPlaylists,
  getPlaylistTracks,
  removeTrackFromPlaylist,
  renamePlaylist,
  deletePlaylist,
  findPlaylistByName,
  setPlaylistTracks,
  setPlaylistSource,
  hydrateSession,
  clear,
}
