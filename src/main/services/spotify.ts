// src/main/services/spotify.ts
//
// Spotify playlist fetcher — extracts ALL track metadata from a public Spotify
// playlist URL using Spotify's internal Web API (no OAuth app registration needed).
//
// Strategy (two-tier):
//   1. PRIMARY: Get an ephemeral access token from open.spotify.com, then paginate
//      through the Spotify Web API to fetch all tracks.
//   2. FALLBACK: Parse the __NEXT_DATA__ JSON from the playlist page HTML
//      (limited to ~100 tracks from the first page).

export interface SpotifyTrack {
  title: string
  artist: string
  duration: number   // seconds
  album?: string
  uri?: string       // spotify:track:xxx (for dedup)
}

export interface SpotifyPlaylistResult {
  name: string
  tracks: SpotifyTrack[]
  totalCount: number    // actual total on Spotify (may differ from tracks.length if truncated)
}

// ── URL Parsing ──

function parsePlaylistId(url: string): string | null {
  const webMatch = url.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/)
  if (webMatch) return webMatch[1]
  const uriMatch = url.match(/spotify:playlist:([a-zA-Z0-9]+)/)
  if (uriMatch) return uriMatch[1]
  return null
}

// ── sp_dc Cookie Auth ──

/**
 * Build a Spotify Web API Authorization header from an sp_dc cookie value.
 * The sp_dc cookie (set by open.spotify.com on login) acts as a Basic auth
 * credential: base64(sp_dc + ':'). No OAuth app registration needed.
 */
function buildSpDcAuth(spDc: string): string {
  return 'Basic ' + Buffer.from(spDc + ':').toString('base64')
}

// ── HTTP Helpers ──

const SPOTIFY_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Safari/537.36'

async function spotifyFetch(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': SPOTIFY_UA,
      'Accept': 'application/json, text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal,
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

// ── Access Token ──

interface SpotifyAccessToken {
  accessToken: string
  clientId: string
  accessTokenExpirationTimestampMs: number
  isAnonymous: boolean
}

/**
 * Get authorization for the Spotify Web API.
 *
 * Strategy:
 *   1. If an sp_dc cookie value is provided, use it as Basic auth
 *      (no OAuth app registration needed — same as the web player).
 *   2. Otherwise, try the public get_access_token endpoint (blocked by WAF
 *      in many environments as of mid-2025+).
 *
 * Returns a { authHeader, isSpDc } tuple where authHeader is the value
 * to pass as the Authorization HTTP header.
 */
async function getAuth(
  spDc?: string,
  signal?: AbortSignal
): Promise<{ header: string; isSpDc: boolean }> {
  // Strategy 1: sp_dc cookie (most reliable)
  if (spDc && spDc.trim()) {
    return { header: buildSpDcAuth(spDc.trim()), isSpDc: true }
  }

  // Strategy 2: get_access_token endpoint (often blocked)
  const res = await spotifyFetch('https://open.spotify.com/get_access_token', signal)
  if (!res.ok) {
    throw new Error(
      'Spotify authentication failed. Provide an sp_dc cookie from your ' +
      'logged-in Spotify web player session to import playlists.\n\n' +
      'To get it:\n' +
      '1. Open open.spotify.com in Chrome and log in\n' +
      '2. Open DevTools → Application → Cookies\n' +
      '3. Copy the sp_dc value\n' +
      '4. Paste it into the sp_dc field in the app'
    )
  }
  const data = (await res.json()) as SpotifyAccessToken
  if (!data.accessToken) {
    throw new Error('Spotify access token response missing accessToken')
  }
  return { header: `Bearer ${data.accessToken}`, isSpDc: false }
}

// ── API Track Fetching (with pagination) ──

interface SpotifyApiTrackItem {
  track?: {
    name?: string
    artists?: Array<{ name?: string }>
    duration_ms?: number
    album?: { name?: string }
    uri?: string
  }
}

/**
 * Fetch ALL tracks from a playlist via the Spotify Web API with full pagination.
 * Uses sp_dc cookie auth or an ephemeral access token from open.spotify.com.
 */
async function fetchTracksViaApi(
  playlistId: string,
  spDc?: string,
  signal?: AbortSignal
): Promise<SpotifyPlaylistResult | null> {
  try {
    const { header } = await getAuth(spDc, signal)
    if (signal?.aborted) throw new Error('Import cancelled')

    // First, get the playlist name and total track count
    const metaRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`,
      {
        headers: { Authorization: header, 'User-Agent': SPOTIFY_UA },
        signal,
      }
    )
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as { name?: string; tracks?: { total?: number } }
    const playlistName = meta.name ?? 'Imported Playlist'
    const totalCount = meta.tracks?.total ?? 0

    if (totalCount === 0) return null

    // Paginate through all tracks
    const allTracks: SpotifyTrack[] = []
    const limit = 100
    let offset = 0

    while (offset < totalCount) {
      if (signal?.aborted) throw new Error('Import cancelled')

      const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&fields=items(track(name,artists(name),duration_ms,album(name),uri))`
      const res = await fetch(url, {
        headers: { Authorization: header, 'User-Agent': SPOTIFY_UA },
        signal,
      })
      if (!res.ok) {
        // Token may have expired mid-pagination — return what we have
        if (allTracks.length > 0) break
        return null
      }

      const body = (await res.json()) as { items?: SpotifyApiTrackItem[] }
      const items = body.items ?? []

      for (const item of items) {
        const t = item.track
        if (!t?.name) continue

        const artist = t.artists?.[0]?.name ?? 'Unknown Artist'
        const durationMs = t.duration_ms ?? 0
        const uri = t.uri

        allTracks.push({
          title: t.name,
          artist,
          duration: Math.round(durationMs / 1000),
          album: t.album?.name,
          uri,
        })
      }

      if (items.length < limit) break // last page
      offset += limit
    }

    if (allTracks.length === 0) return null

    return { name: playlistName, tracks: allTracks, totalCount }
  } catch {
    return null
  }
}

// ── HTML FALLBACK: __NEXT_DATA__ Parsing ──

/**
 * Fetch the Spotify playlist page HTML.
 */
async function fetchPlaylistPage(
  playlistId: string,
  signal?: AbortSignal
): Promise<string> {
  const url = `https://open.spotify.com/playlist/${playlistId}`
  const response = await spotifyFetch(url, signal)

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Playlist not found — check the URL and make sure it exists.')
    }
    throw new Error(`Spotify returned HTTP ${response.status}`)
  }

  return response.text()
}

function extractNextData(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  )
  if (!match) return null
  try {
    return JSON.parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractTracksFromNextData(data: Record<string, unknown>): SpotifyPlaylistResult | null {
  try {
    const props = data.props as Record<string, unknown> | undefined
    const pageProps = props?.pageProps as Record<string, unknown> | undefined
    const state = pageProps?.state as Record<string, unknown> | undefined
    const stateData = state?.data as Record<string, unknown> | undefined
    const entity = stateData?.entity as Record<string, unknown> | undefined

    if (entity) {
      const name = typeof entity.name === 'string' ? entity.name : 'Imported Playlist'
      const tracks = extractTrackItems(entity)
      if (tracks.length > 0) return { name, tracks, totalCount: tracks.length }
    }

    const playlist = pageProps?.playlist as Record<string, unknown> | undefined
    if (playlist) {
      const name = typeof playlist.name === 'string' ? playlist.name : 'Imported Playlist'
      const tracks = extractTrackItems(playlist)
      if (tracks.length > 0) return { name, tracks, totalCount: tracks.length }
    }

    return null
  } catch {
    return null
  }
}

function extractTrackItems(entity: Record<string, unknown>): SpotifyTrack[] {
  const tracks: SpotifyTrack[] = []
  const tracksField = entity.tracks
  if (!tracksField) return tracks

  let items: unknown[] = []
  if (Array.isArray(tracksField)) {
    items = tracksField
  } else if (typeof tracksField === 'object' && tracksField !== null) {
    const tf = tracksField as Record<string, unknown>
    if (Array.isArray(tf.items)) items = tf.items
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const trackObj = (item as Record<string, unknown>).track as Record<string, unknown> | undefined
    if (!trackObj) continue
    const name = typeof trackObj.name === 'string' ? trackObj.name : ''
    if (!name) continue

    const artists = trackObj.artists
    let artist = 'Unknown Artist'
    if (Array.isArray(artists) && artists.length > 0) {
      const first = artists[0]
      if (first && typeof first === 'object') {
        artist = typeof (first as Record<string, unknown>).name === 'string'
          ? (first as Record<string, unknown>).name as string
          : 'Unknown Artist'
      }
    }

    const durationMs = typeof trackObj.duration_ms === 'number' ? trackObj.duration_ms : 0
    const album = trackObj.album as Record<string, unknown> | undefined
    const uri = typeof trackObj.uri === 'string' ? trackObj.uri : undefined

    tracks.push({
      title: name,
      artist,
      duration: Math.round(durationMs / 1000),
      album: album && typeof album.name === 'string' ? album.name : undefined,
      uri,
    })
  }

  return tracks
}

// ── Deduplication ──

function deduplicateTracks(tracks: SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>()
  return tracks.filter((t) => {
    if (t.uri) {
      if (seen.has(t.uri)) return false
      seen.add(t.uri)
    }
    return true
  })
}

// ── Main Export ──

/**
 * Fetch a public Spotify playlist by URL.
 *
 * Strategy:
 *   1. PRIMARY: Use sp_dc cookie auth → Spotify Web API with full pagination.
 *      If no sp_dc is provided, fall back to get_access_token endpoint (often blocked).
 *   2. FALLBACK: Parse the __NEXT_DATA__ JSON from the playlist page HTML
 *      (limited to ~100 tracks — only used when the API approach fails).
 *
 * @param url - Spotify playlist URL (e.g. https://open.spotify.com/playlist/...)
 * @param spDc - Optional sp_dc cookie value from a logged-in Spotify web session.
 *               When provided, used as Basic auth for the Web API directly.
 * @param signal - Optional AbortSignal for cancellation
 * @returns Playlist name and deduplicated track list
 * @throws If the URL is invalid, the playlist is private, or both fetch strategies fail
 */
export async function fetchSpotifyPlaylist(
  url: string,
  spDc?: string,
  signal?: AbortSignal
): Promise<SpotifyPlaylistResult> {
  const playlistId = parsePlaylistId(url)
  if (!playlistId) {
    throw new Error(
      'Invalid Spotify playlist URL. Expected format: ' +
      'https://open.spotify.com/playlist/...'
    )
  }

  // ── PRIMARY: Spotify Web API (full pagination) ──
  const apiResult = await fetchTracksViaApi(playlistId, spDc, signal)
  if (apiResult && apiResult.tracks.length > 0) {
    apiResult.tracks = deduplicateTracks(apiResult.tracks)
    console.log(`[Spotify] API fetch: ${apiResult.tracks.length}/${apiResult.totalCount} tracks`)
    return apiResult
  }

  // ── FALLBACK: __NEXT_DATA__ page parsing (~100 tracks) ──
  if (signal?.aborted) throw new Error('Import cancelled')

  let html: string
  try {
    html = await fetchPlaylistPage(playlistId, signal)
  } catch (err) {
    if (isAbortError(err)) throw new Error('Import cancelled')
    throw err
  }

  if (html.includes('/login') || html.includes('Log in') || !html.includes('__NEXT_DATA__')) {
    throw new Error(
      'This playlist appears to be private or unavailable. ' +
      'Make it public in Spotify settings and try again.'
    )
  }

  const nextData = extractNextData(html)
  if (!nextData) {
    throw new Error(
      'Could not parse Spotify playlist data. ' +
      'The page format may have changed.'
    )
  }

  const fallbackResult = extractTracksFromNextData(nextData)
  if (!fallbackResult || fallbackResult.tracks.length === 0) {
    throw new Error(
      'Could not extract tracks from this playlist. ' +
      'It may be empty or the format has changed.'
    )
  }

  fallbackResult.tracks = deduplicateTracks(fallbackResult.tracks)
  console.log(`[Spotify] Fallback (__NEXT_DATA__): ${fallbackResult.tracks.length} tracks (limited to ~100)`)
  return fallbackResult
}