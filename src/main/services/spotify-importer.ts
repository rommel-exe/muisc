// src/main/services/spotify-importer.ts
//
// Orchestrates the full Spotify playlist import pipeline:
//   1. Fetch playlist from Spotify (public URL)
//   2. For each track, search YouTube + match via confidence scoring
//   3. Create a local playlist with matched tracks
//   4. Report progress via callback

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

  // ── Step 3: Create playlist + add tracks ──
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
  const newPlaylist = PlaylistEngine.createPlaylist(playlistName)

  for (const track of matchedTracks) {
    PlaylistEngine.addTrackToPlaylist(newPlaylist.id, track)
  }

  // ── Result ──
  return {
    playlistId: newPlaylist.id,
    playlistName,
    matchedCount: matchedTracks.length,
    totalCount: total,
    skipped,
  }
}
