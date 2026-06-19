// src/main/services/spotify-importer.ts
//
// Orchestrates the full Spotify playlist import pipeline:
//   1. Fetch playlist from Spotify (public URL)
//   2. For each track, search YouTube + match via confidence scoring
//   3. Create or update a local playlist with matched tracks
//   4. Report progress via callback
//
// Also provides rematchPlaylist() to re-run matching on an already-imported
// playlist using its stored Spotify source data — so existing playlists get
// improved matches when search or filtering improves.

import type { WebContents } from 'electron'
import { fetchSpotifyPlaylist } from './spotify'
import { TrackIdentityEngine } from '../../application/TrackIdentityEngine'
import { PlaylistEngine } from '../../application/PlaylistEngine'
import { IPC_CHANNELS } from '../../shared/constants'
import type { Track, SpotifyImportProgress, SpotifyImportResult, SpotifyImportSkipped } from '../../shared/types'

// ── Batch Config ──

const MAX_TRACKS = 1000
const MATCH_CONFIDENCE_THRESHOLD = 0.65
const BATCH_DELAY_MS = 200 // small delay between searches to avoid rate limiting

// ── Progress Sender ──

function sendProgress(
  sender: WebContents,
  progress: SpotifyImportProgress
): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.SPOTIFY_IMPORT_PROGRESS, progress)
  }
}

// ── Main Import Function ──

/**
 * Import a Spotify playlist by URL.
 *
 * 1. Fetches the playlist from Spotify's public page
 * 2. For each track, searches YouTube and matches via confidence scoring
 * 3. Creates a local playlist and adds matched tracks
 * 4. Reports progress via IPC events on the provided webContents
 *
 * @param url - Spotify playlist URL
 * @param spDc - Optional sp_dc cookie value from a logged-in Spotify web session
 * @param sender - BrowserWindow webContents for progress events
 * @param signal - Optional AbortSignal for cancellation
 * @returns Import result summary
 */
export async function importSpotifyPlaylist(
  url: string,
  spDc: string | undefined,
  sender: WebContents,
  signal?: AbortSignal
): Promise<SpotifyImportResult> {
  // ── Step 1: Fetch playlist ──
  sendProgress(sender, { current: 0, total: 0, currentTitle: '', status: 'fetching' })

  if (signal?.aborted) {
    throw new Error('Import cancelled')
  }

  const playlist = await fetchSpotifyPlaylist(url, spDc, signal)

  let tracks = playlist.tracks
  if (tracks.length > MAX_TRACKS) {
    tracks = tracks.slice(0, MAX_TRACKS)
  }

  const total = tracks.length
  const matchedTracks: Track[] = []
  const skipped: SpotifyImportSkipped[] = []

  sendProgress(sender, { current: 0, total, currentTitle: '', status: 'matching' })

  // ── Step 2: Match each track ──
  for (let i = 0; i < tracks.length; i++) {
    if (signal?.aborted) {
      throw new Error('Import cancelled')
    }

    const track = tracks[i]
    sendProgress(sender, {
      current: i,
      total,
      currentTitle: `${track.artist} — ${track.title}`,
      status: 'matching',
    })

    try {
      const result = await TrackIdentityEngine.resolveIdentity(
        { title: track.title, artist: track.artist, duration: track.duration },
        MATCH_CONFIDENCE_THRESHOLD
      )
      matchedTracks.push(result)
    } catch (err: any) {
      skipped.push({
        title: track.title,
        artist: track.artist,
        reason: err.message ?? 'No match found',
      })
    }

    // Small delay between searches to avoid rate limiting
    if (i < tracks.length - 1 && BATCH_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }
  }

  // ── Step 3: Create or update playlist ──
  sendProgress(sender, { current: total, total, currentTitle: '', status: 'saving' })

  if (signal?.aborted) {
    throw new Error('Import cancelled')
  }

  if (matchedTracks.length === 0) {
    throw new Error(
      'No tracks could be matched. All tracks were skipped. ' +
      `(${skipped.length} total)`
    )
  }

  const playlistName = `${playlist.name} (Spotify Import)`

  // Reuse existing playlist if one with the same name already exists.
  // This way re-importing (e.g. after fixing search filters) updates
  // in-place instead of creating a duplicate.
  const existingPlaylist = PlaylistEngine.findPlaylistByName(playlistName)
  const targetPlaylist = existingPlaylist ?? PlaylistEngine.createPlaylist(playlistName)

  // Store Spotify source data so we can re-match this playlist later
  // without needing to re-fetch from Spotify.
  PlaylistEngine.setPlaylistSource(targetPlaylist.id, {
    url,
    tracks: tracks.map((t) => ({
      title: t.title,
      artist: t.artist,
      duration: t.duration,
    })),
  })

  // Replace all tracks with the freshly matched results
  PlaylistEngine.setPlaylistTracks(targetPlaylist.id, matchedTracks)

  // ── Result ──
  return {
    playlistId: targetPlaylist.id,
    playlistName,
    matchedCount: matchedTracks.length,
    totalCount: total,
    skipped,
  }
}

// ── Re-match an Existing Playlist ──

interface RematchProgress {
  current: number
  total: number
  currentTitle: string
}

export type { RematchProgress }

/**
 * Re-run YouTube matching for an already-imported Spotify playlist.
 *
 * Uses the stored `spotifySource` data (original Spotify track metadata) to
 * re-search YouTube and match — so that improvements like disabling safety
 * mode automatically apply to playlists imported before the fix.
 *
 * Call this when loading an existing imported playlist into the queue.
 *
 * @param playlistId - ID of an existing playlist that has `spotifySource` data
 * @param onProgress - Optional callback for progress updates (e.g. IPC sender)
 * @param signal - Optional AbortSignal
 * @returns Updated matched track count and skipped list
 */
export async function rematchPlaylist(
  playlistId: string,
  onProgress?: (progress: RematchProgress) => void,
  signal?: AbortSignal
): Promise<{
  playlistId: string
  matchedCount: number
  skipped: Array<{ title: string; artist: string; reason: string }>
}> {
  const playlists = PlaylistEngine.getUserPlaylists()
  const pl = playlists.find((p) => p.id === playlistId)
  if (!pl?.spotifySource) {
    // Not a Spotify-imported playlist — nothing to do
    return { playlistId, matchedCount: 0, skipped: [] }
  }

  const originalTracks = pl.spotifySource.tracks
  const total = originalTracks.length
  const matchedTracks: Track[] = []
  const skipped: Array<{ title: string; artist: string; reason: string }> = []

  for (let i = 0; i < originalTracks.length; i++) {
    if (signal?.aborted) {
      throw new Error('Rematch cancelled')
    }

    const t = originalTracks[i]
    onProgress?.({ current: i, total, currentTitle: `${t.artist} — ${t.title}` })

    try {
      const result = await TrackIdentityEngine.resolveIdentity(
        { title: t.title, artist: t.artist, duration: t.duration },
        MATCH_CONFIDENCE_THRESHOLD
      )
      matchedTracks.push(result)
    } catch (err: any) {
      skipped.push({
        title: t.title,
        artist: t.artist,
        reason: err.message ?? 'No match found',
      })
    }

    if (i < originalTracks.length - 1 && BATCH_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }
  }

  // Update the playlist with new matches
  PlaylistEngine.setPlaylistTracks(playlistId, matchedTracks)

  return {
    playlistId,
    matchedCount: matchedTracks.length,
    skipped,
  }
}
