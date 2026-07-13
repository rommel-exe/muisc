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
//
// Performance: uses parallel batch matching with configurable concurrency
// so a 300-track import finishes in ~15-20s instead of ~5 minutes.

import type { WebContents } from 'electron'
import { fetchSpotifyPlaylist } from './spotify'
import { searchYouTube } from './innertube'
import { TrackIdentityEngine } from '../../application/TrackIdentityEngine'
import { generateSearchQueries } from '../../application/layers/search-strategy'
import { PlaylistEngine } from '../../application/PlaylistEngine'
import { IPC_CHANNELS } from '../../shared/constants'
import type { Track, SpotifyImportProgress, SpotifyImportResult, SpotifyImportSkipped } from '../../shared/types'

  // ── Batch Config ──

const MAX_TRACKS = 1000
const CONCURRENCY = 50 // parallel track matching (searches hit cache after pre-fetch)
const PREFETCH_CONCURRENCY = 20 // pre-fetch concurrency (tuned to avoid rate limits)
const PROGRESS_INTERVAL = 25 // send IPC progress every N tracks (reduce IPC overhead)

// ── Progress Sender ──

let _progressCounter = 0

function sendProgress(
  sender: WebContents,
  progress: SpotifyImportProgress
): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.SPOTIFY_IMPORT_PROGRESS, progress)
  }
}

function sendProgressThrottled(
  sender: WebContents,
  progress: SpotifyImportProgress
): void {
  _progressCounter++
  if (_progressCounter % PROGRESS_INTERVAL === 0 || _progressCounter === progress.total) {
    sendProgress(sender, progress)
  }
}

// ── Parallel Batch Helper ──

/**
 * Process an array of items with limited concurrency.
 * Like Promise.all but with at most `concurrency` in-flight at once.
 */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let cancelled = false

  async function worker(): Promise<void> {
    while (!cancelled && nextIndex < items.length) {
      const idx = nextIndex++
      try {
        results[idx] = await fn(items[idx], idx)
      } catch (err: any) {
        cancelled = true
        throw err
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  try {
    await Promise.all(workers)
  } finally {
    cancelled = true
  }
  return results
}

// ── Search Cache Pre-fetch ──

/**
 * Pre-fill the search cache with primary queries so the parallel matching
 * phase hits cache instead of making live Innertube calls.
 *
 * Strategy:
 * - Only pre-fetch query[0] ("Artist Title") — most tracks (95%+) match on this
 * - Deduplicate queries for overlapping tracks/artists
 * - Use controlled concurrency with 403 retry to avoid rate limiting
 * - Failures are OK (the matching phase re-attempts uncached queries)
 */
async function preFetchSearchCache(
  tracks: Array<{ title: string; artist: string; duration: number; explicit?: boolean }>,
  signal?: AbortSignal
): Promise<void> {
  const uniqueQueries = new Set<string>()
  for (const track of tracks) {
    const queries = generateSearchQueries({
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      explicit: track.explicit ?? false,
    })
    // Pre-fetch first 4 tier-1 queries so matching phase has more cache hits
    for (let qi = 0; qi < Math.min(queries.length, 4); qi++) {
      uniqueQueries.add(queries[qi])
    }
  }

  const queryList = [...uniqueQueries]
  if (queryList.length === 0) return

  console.log(`[Import] Pre-fetching ${queryList.length} primary queries (concurrency=${PREFETCH_CONCURRENCY})`)

  await parallelMap(
    queryList,
    async (query) => {
      if (signal?.aborted) return
      try {
        await searchYouTube(query)
      } catch {
        // Individual pre-fetch failure is OK — the matching phase
        // re-attempts uncached queries inline
      }
    },
    PREFETCH_CONCURRENCY
  )
}

// ── Main Import Function ──

/**
 * Import a Spotify playlist by URL.
 *
 * 1. Fetches the playlist from Spotify's public page
 * 2. For each track (in parallel batches), searches YouTube and matches via confidence scoring
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

  // ── Step 2: Pre-fetch search cache ──
  // Warm the Innertube search cache with primary queries so the parallel
  // matching phase (Step 3) hits cache instead of making live API calls.
  // This avoids rate limiting and makes matching near-instant.
  await preFetchSearchCache(tracks, signal)

  sendProgress(sender, { current: 0, total, currentTitle: '', status: 'matching' })
  _progressCounter = 0

  // ── Step 3: Match each track (parallel batches) ──
  const results = await parallelMap(
    tracks,
    async (track, i) => {
      try {
        if (signal?.aborted) {
          return {
            type: 'skip' as const,
            skip: { title: track.title, artist: track.artist, reason: 'Import cancelled' },
          }
        }

        sendProgressThrottled(sender, {
          current: i,
          total,
          currentTitle: `${track.artist} — ${track.title}`,
          status: 'matching',
        })

        const result = await TrackIdentityEngine.resolveIdentity(
          { title: track.title, artist: track.artist, duration: track.duration, explicit: track.explicit }
        )
        return { type: 'match' as const, track: result }
      } catch (err: any) {
        return {
          type: 'skip' as const,
          skip: {
            title: track.title,
            artist: track.artist,
            reason: err.message ?? 'No match found',
          },
        }
      }
    },
    CONCURRENCY
  )

  if (signal?.aborted) {
    throw new Error('Import cancelled')
  }

  for (const r of results) {
    if (r.type === 'match') {
      matchedTracks.push(r.track)
    } else {
      skipped.push(r.skip)
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
      explicit: t.explicit,
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
 * Also uses parallel batch matching for fast re-matching.
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
  let rematchCounter = 0

  const results = await parallelMap(
    originalTracks,
    async (t, i) => {
      if (signal?.aborted) {
        throw new Error('Rematch cancelled')
      }

      rematchCounter++
      if (rematchCounter % PROGRESS_INTERVAL === 0 || rematchCounter === total) {
        onProgress?.({ current: i, total, currentTitle: `${t.artist} — ${t.title}` })
      }

      try {
        const result = await TrackIdentityEngine.resolveIdentity(
          { title: t.title, artist: t.artist, duration: t.duration, explicit: t.explicit }
        )
        return { type: 'match' as const, track: result }
      } catch (err: any) {
        return {
          type: 'skip' as const,
          skip: {
            title: t.title,
            artist: t.artist,
            reason: err.message ?? 'No match found',
          },
        }
      }
    },
    CONCURRENCY
  )

  for (const r of results) {
    if (r.type === 'match') {
      matchedTracks.push(r.track)
    } else {
      skipped.push(r.skip)
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
