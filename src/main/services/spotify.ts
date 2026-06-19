// src/main/services/spotify.ts
//
// Spotify playlist fetcher — extracts ALL track metadata from a public Spotify
// playlist URL using Spotify's internal Web API (no OAuth app registration needed).
//
// Strategy:
//   1. sp_dc cookie auth → Spotify Web API with full pagination (most reliable)
//   2. Anonymous TOTP auth → Spotify Web API with full pagination (works out of box)
//   3. __NEXT_DATA__ HTML fallback (~100 tracks, legacy Spotify pages only)

import * as crypto from 'crypto'

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

// ── Anonymous TOTP Auth ──
//
// Spotify's web player uses a TOTP (Time-based One-Time Password) flow to issue
// anonymous access tokens. The secrets are embedded in the web-player JS bundle.
// These must be updated when Spotify rotates them (extract from web-player.*.js):
//   regex: {secret:\s*["']([^"']+)["']\s*,\s*version:\s*(\d+)\s*}
//
// Last updated: 2026-06-19

const TOKEN_SECRETS = [
  { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
  { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
  { secret: '{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH', version: 59 },
]

interface SpotifyTokenResponse {
  clientId: string
  accessToken: string
  accessTokenExpirationTimestampMs: number
  isAnonymous: boolean
}

/**
 * Transform the raw secret string into TOTP key bytes.
 * Matches the web-player's own transformation.
 */
function transformSecret(secret: string): Buffer {
  // XOR each char code with (index % 33 + 9)
  const xorResult = secret.split('').map((ch, i) => ch.charCodeAt(0) ^ ((i % 33) + 9))
  // Join as decimal string → UTF-8 bytes → hex → bytes
  // This round-trip matches the web-player's Buffer.from(…,"utf8").toString("hex") / fromHex
  const hexKey = Buffer.from(xorResult.join(''), 'utf8').toString('hex')
  return Buffer.from(hexKey, 'hex')
}

/**
 * Generate a 6-digit TOTP using SHA1, 30-second period.
 */
function generateTOTP(secretBytes: Buffer, timestampSeconds: number): string {
  const timeStep = 30
  const counter = Math.floor(timestampSeconds / timeStep)

  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))

  const hmac = crypto.createHmac('sha1', secretBytes)
  hmac.update(counterBuffer)
  const hmacResult = hmac.digest()

  const offset = hmacResult[hmacResult.length - 1] & 0xf
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff)

  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * Get an anonymous access token from Spotify using TOTP auth.
 * This works without any user-provided credentials.
 */
async function getAnonymousToken(signal?: AbortSignal): Promise<SpotifyTokenResponse> {
  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  // Use the newest secret (highest version)
  const { secret, version } = TOKEN_SECRETS[0]
  const secretBytes = transformSecret(secret)

  // Step 1: Get server timestamp
  const timeRes = await fetch('https://open.spotify.com/api/server-time', {
    headers: { 'User-Agent': ua, Accept: 'application/json' },
    signal,
  })
  if (!timeRes.ok) {
    throw new Error(`Spotify server-time returned HTTP ${timeRes.status}`)
  }
  const timeData = (await timeRes.json()) as { serverTime?: number }
  const serverTime = timeData.serverTime
  if (!serverTime || isNaN(serverTime)) {
    throw new Error('Spotify server-time response missing serverTime')
  }

  // Step 2: Generate TOTP from server timestamp
  const totp = generateTOTP(secretBytes, serverTime)

  // Step 3: Exchange TOTP for an access token
  const params = new URLSearchParams({
    reason: 'init',
    productType: 'web-player',
    totp,
    totpServer: totp,
    totpVer: String(version),
  })

  const tokenRes = await fetch(
    `https://open.spotify.com/api/token?${params.toString()}`,
    {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        Referer: 'https://open.spotify.com/',
      },
      signal,
    }
  )
  if (!tokenRes.ok) {
    throw new Error(
      `Spotify token request failed (HTTP ${tokenRes.status}). ` +
      'Try importing with an sp_dc cookie instead.'
    )
  }

  const data = (await tokenRes.json()) as SpotifyTokenResponse
  if (!data.accessToken) {
    throw new Error('Spotify token response missing accessToken')
  }

  return data
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

/**
 * Get authorization for the Spotify Web API.
 *
 * Strategy:
 *   1. If an sp_dc cookie value is provided, use it as Basic auth.
 *   2. Otherwise, get an anonymous token via TOTP auth (works out of box).
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

  // Strategy 2: Anonymous TOTP auth
  const tokenData = await getAnonymousToken(signal)
  return { header: `Bearer ${tokenData.accessToken}`, isSpDc: false }
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
 * Uses sp_dc cookie auth or anonymous TOTP auth.
 */
async function fetchTracksViaApi(
  playlistId: string,
  spDc?: string,
  signal?: AbortSignal
): Promise<SpotifyPlaylistResult | null> {
  try {
    const { header, isSpDc } = await getAuth(spDc, signal)
    console.log(`[Spotify] Auth: ${isSpDc ? 'sp_dc' : 'anonymous token'}`)
    if (signal?.aborted) throw new Error('Import cancelled')

    // Fetch playlist metadata
    const metaRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`,
      { headers: { Authorization: header, 'User-Agent': SPOTIFY_UA }, signal }
    )
    if (metaRes.status === 429) {
      console.log(`[Spotify] Rate limited by Spotify API. Suggest using sp_dc cookie.`)
      return null
    }
    if (!metaRes.ok) {
      console.log(`[Spotify] API metadata request failed: HTTP ${metaRes.status}`)
      return null
    }
    const metaData = (await metaRes.json()) as { name?: string; tracks?: { total?: number } }
    if (!metaData?.name || !metaData?.tracks?.total) {
      console.log(`[Spotify] Playlist has 0 tracks or missing metadata`)
      return null
    }
    const playlistName = metaData.name
    const totalCount = metaData.tracks.total

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
        if (res.status === 429) {
          console.log(`[Spotify] Rate limited during pagination after ${allTracks.length} tracks`)
        } else {
          console.log(`[Spotify] Pagination request failed: HTTP ${res.status} after ${allTracks.length} tracks`)
        }
        // Return what we have so far
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
  } catch (err) {
    console.log(`[Spotify] fetchTracksViaApi failed:`, err instanceof Error ? err.message : err)
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
 *   1. PRIMARY: Use sp_dc cookie auth or anonymous TOTP auth → Spotify Web API
 *      with full pagination. Anonymous TOTP works out of the box with no setup.
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

  // Check if the playlist page is behind a login wall
  if (html.includes('/login') || html.includes('Log in')) {
    throw new Error(
      'This playlist appears to be private or unavailable. ' +
      'Make it public in Spotify settings and try again.'
    )
  }

  // Try to parse __NEXT_DATA__ (older Spotify page format)
  const nextData = extractNextData(html)
  if (nextData) {
    const fallbackResult = extractTracksFromNextData(nextData)
    if (fallbackResult && fallbackResult.tracks.length > 0) {
      fallbackResult.tracks = deduplicateTracks(fallbackResult.tracks)
      console.log(`[Spotify] Fallback (__NEXT_DATA__): ${fallbackResult.tracks.length} tracks (limited to ~100)`)
      return fallbackResult
    }
  }

  // If we got the HTML but no __NEXT_DATA__, the page is client-side rendered.
  // The API approach should have already worked unless the token was rejected.
  throw new Error(
    'Could not extract tracks from this playlist. ' +
    'The playlist may be empty or the Spotify API returned an unexpected response.'
  )
}
