// src/main/services/spotify.ts
//
// Spotify playlist fetcher — extracts ALL track metadata from a public Spotify
// playlist URL using the web player's own internal APIs.
//
// Architecture (no OAuth app registration or user credentials needed):
//   1. Get anonymous access token via TOTP auth (same as open.spotify.com web player)
//   2. Fetch playlist from spclient.wg.spotify.com (all tracks in one call)
//   3. Batch-resolve track metadata via GraphQL (api-partner.spotify.com)
//
// Primary path: TOTP → spclient + GraphQL (works out of the box, no rate limits)
// Fallback path: sp_dc cookie → REST API (for power users, no rate limits)

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
  totalCount: number
}

// ── URL Parsing ──

function parsePlaylistId(url: string): string | null {
  const webMatch = url.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/)
  if (webMatch) return webMatch[1]
  const uriMatch = url.match(/spotify:playlist:([a-zA-Z0-9]+)/)
  if (uriMatch) return uriMatch[1]
  return null
}

// ── TOTP Anonymous Auth ──
//
// Spotify's web player uses a TOTP flow to issue anonymous access tokens.
// Secrets are embedded in the web-player JS bundle and must be re-extracted
// when Spotify rotates them.
//
// Extraction regex from web-player.*.js:
//   {secret:\s*["']([^"']+)["']\s*,\s*version:\s*(\d+)\s*}
//
// Last updated: 2026-06-19

const TOKEN_SECRETS = [
  { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
  { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
  { secret: '{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH', version: 59 },
]

/**
 * Transform the raw secret string into TOTP key bytes.
 * Matches the web-player's own transformation (XOR → decimal-string → hex → bytes).
 */
function transformSecret(secret: string): Buffer {
  const xorResult = secret.split('').map((ch, i) => ch.charCodeAt(0) ^ ((i % 33) + 9))
  const hexKey = Buffer.from(xorResult.join(''), 'utf8').toString('hex')
  return Buffer.from(hexKey, 'hex')
}

/**
 * Generate a 6-digit TOTP using HMAC-SHA1, 30-second period.
 */
function generateTOTP(secretBytes: Buffer, timestampSeconds: number): string {
  const counter = Math.floor(timestampSeconds / 30)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))

  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return String(code % 1_000_000).padStart(6, '0')
}

const SPOTIFY_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/**
 * Get an anonymous access token from Spotify using TOTP auth.
 * Follows the same flow as open.spotify.com's web player.
 */
async function getAnonymousToken(signal?: AbortSignal): Promise<string> {
  const { secret, version } = TOKEN_SECRETS[0]
  const secretBytes = transformSecret(secret)

  // Step 1: Get server timestamp
  const timeRes = await fetch('https://open.spotify.com/api/server-time', {
    headers: { 'User-Agent': SPOTIFY_UA, Accept: 'application/json' },
    signal,
  })
  if (!timeRes.ok) {
    throw new Error(`Spotify server-time returned HTTP ${timeRes.status}`)
  }
  const timeData = (await timeRes.json()) as { serverTime?: number }
  if (!timeData.serverTime) {
    throw new Error('Spotify server-time response missing serverTime')
  }

  // Step 2: Generate TOTP, exchange for token
  const totp = generateTOTP(secretBytes, timeData.serverTime)
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
        'User-Agent': SPOTIFY_UA,
        Accept: 'application/json',
        Referer: 'https://open.spotify.com/',
      },
      signal,
    }
  )
  if (!tokenRes.ok) {
    throw new Error(`Spotify token request failed (HTTP ${tokenRes.status})`)
  }

  const data = (await tokenRes.json()) as { accessToken?: string }
  if (!data.accessToken) {
    throw new Error('Spotify token response missing accessToken')
  }
  return data.accessToken
}

// ── sp_dc Cookie Auth ──

function buildSpDcAuth(spDc: string): string {
  return 'Basic ' + Buffer.from(spDc + ':').toString('base64')
}

// ── Common HTTP Headers ──

function authHeaders(tokenOrHeader: string): Record<string, string> {
  return {
    'User-Agent': SPOTIFY_UA,
    Authorization: tokenOrHeader,
    Origin: 'https://open.spotify.com',
    Referer: 'https://open.spotify.com/',
    Accept: 'application/json',
    'app-platform': 'WebPlayer',
  }
}

// ── Playlist Fetch from spclient ──
//
// Uses the Spotify web player's internal playlist service (spclient).
// Returns all track URIs in a single response — no pagination needed.
// This endpoint shares the web player's rate limit pool, which is high.

interface SpClientPlaylistResponse {
  attributes?: { name?: string }
  length?: number
  contents?: {
    truncated?: boolean
    items?: Array<{ uri?: string; attributes?: Record<string, string> }>
  }
}

async function fetchPlaylistUris(
  playlistId: string,
  token: string,
  signal?: AbortSignal
): Promise<{ name: string; uris: string[] }> {
  const res = await fetch(
    `https://spclient.wg.spotify.com/playlist/v2/playlist/${playlistId}`,
    { headers: authHeaders(`Bearer ${token}`), signal }
  )

  if (!res.ok) {
    throw new Error(
      `Spotify playlist fetch failed (HTTP ${res.status}). ` +
      'The playlist may be private or unavailable.'
    )
  }

  const data = (await res.json()) as SpClientPlaylistResponse
  const name = data.attributes?.name ?? 'Imported Playlist'
  const items = data.contents?.items ?? []

  if (items.length === 0) {
    throw new Error('Playlist has no tracks or is empty.')
  }

  const uris = items
    .map((i) => i.uri)
    .filter((u): u is string => !!u)

  return { name, uris }
}

// ── Track Metadata Resolution via GraphQL ──
//
// The Spotify web player uses a GraphQL endpoint (api-partner.spotify.com)
// with persisted queries. The lookupEntities hash resolves a batch of URIs
// to full track metadata (name, artist, duration, album, cover art).
//
// Batch size limit: 50 URIs per call.

const LOOKUP_ENTITIES_HASH = 'f952da037440f694cc6925b9e3f649d39077a744c4db7dfba01cb883723f4f77'
const BATCH_SIZE = 50

interface GraphQLTrackData {
  data?: {
    lookupEntities?: Array<{
      typedEntity?: {
        data?: {
          name?: string
          uri?: string
          artists?: { items?: Array<{ profile?: { name?: string }; uri?: string }> }
          duration?: { totalMilliseconds?: number }
          albumOfTrack?: { name?: string; uri?: string }
        }
      }
    }>
  }
}

async function resolveBatch(
  uris: string[],
  token: string,
  signal?: AbortSignal
): Promise<Map<string, SpotifyTrack>> {
  const result = new Map<string, SpotifyTrack>()

  const body = JSON.stringify({
    variables: { uris },
    extensions: { persistedQuery: { version: 1, sha256Hash: LOOKUP_ENTITIES_HASH } },
  })

  const res = await fetch(
    'https://api-partner.spotify.com/pathfinder/v1/query',
    {
      method: 'POST',
      headers: {
        ...authHeaders(`Bearer ${token}`),
        'Content-Type': 'application/json',
      },
      body,
      signal,
    }
  )

  if (!res.ok) {
    console.log(`[Spotify] GraphQL batch resolve failed: HTTP ${res.status}`)
    return result
  }

  const data = (await res.json()) as GraphQLTrackData
  const entities = data?.data?.lookupEntities ?? []

  for (const entity of entities) {
    const trackData = entity?.typedEntity?.data
    if (!trackData?.name) continue

    const uri = trackData.uri || ''
    result.set(uri, {
      title: trackData.name,
      artist: trackData.artists?.items?.[0]?.profile?.name ?? 'Unknown Artist',
      duration: Math.round((trackData.duration?.totalMilliseconds ?? 0) / 1000),
      album: trackData.albumOfTrack?.name,
      uri,
    })
  }

  return result
}

async function resolveAllTrackMetadata(
  uris: string[],
  token: string,
  signal?: AbortSignal
): Promise<SpotifyTrack[]> {
  const allTracks: SpotifyTrack[] = []

  for (let i = 0; i < uris.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new Error('Import cancelled')

    const batch = uris.slice(i, i + BATCH_SIZE)
    const resolved = await resolveBatch(batch, token, signal)

    for (const uri of batch) {
      const track = resolved.get(uri)
      if (track) {
        allTracks.push(track)
      } else {
        // If metadata resolve fails for a track, still include it with minimal info
        allTracks.push({
          title: 'Unknown Track',
          artist: 'Unknown Artist',
          duration: 0,
          uri,
        })
      }
    }
  }

  return allTracks
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
 * Strategy (from most reliable to fallback):
 *   1. PRIMARY — Anonymous TOTP auth → spclient (playlist URIs) + GraphQL (track metadata).
 *      Works out of the box, no user setup needed. Handles any playlist size.
 *   2. FALLBACK — sp_dc cookie auth → Spotify Web API (REST) with pagination.
 *      Used when sp_dc is explicitly provided.
 *
 * Under the hood this uses the web player's own internal APIs (spclient + api-partner),
 * so rate limits are aligned with what the web player itself uses.
 *
 * @param url - Spotify playlist URL
 * @param spDc - Optional sp_dc cookie value (for REST API fallback)
 * @param signal - Optional AbortSignal for cancellation
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

  // ── Strategy 1: Anonymous TOTP → spclient + GraphQL ──
  if (!spDc) {
    console.log('[Spotify] Using anonymous TOTP auth → spclient + GraphQL')
    const token = await getAnonymousToken(signal)
    if (signal?.aborted) throw new Error('Import cancelled')

    const { name, uris } = await fetchPlaylistUris(playlistId, token, signal)
    if (signal?.aborted) throw new Error('Import cancelled')

    const totalCount = uris.length

    const tracks = await resolveAllTrackMetadata(uris, token, signal)
    if (signal?.aborted) throw new Error('Import cancelled')

    const deduped = deduplicateTracks(tracks)
    console.log(`[Spotify] Imported ${deduped.length}/${totalCount} tracks via anonymous API`)

    return { name, tracks: deduped, totalCount }
  }

  // ── Strategy 2: sp_dc cookie → REST API with pagination ──
  console.log('[Spotify] Using sp_dc cookie auth → REST API')
  return fetchViaRestApi(playlistId, spDc, signal)
}

// ── REST API Fallback (sp_dc cookie) ──

interface SpotifyApiTrackItem {
  track?: {
    name?: string
    artists?: Array<{ name?: string }>
    duration_ms?: number
    album?: { name?: string }
    uri?: string
  }
}

async function fetchViaRestApi(
  playlistId: string,
  spDc: string,
  signal?: AbortSignal
): Promise<SpotifyPlaylistResult> {
  const header = buildSpDcAuth(spDc)

  // Fetch playlist metadata
  const metaRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`,
    {
      headers: { Authorization: header, 'User-Agent': SPOTIFY_UA },
      signal,
    }
  )
  if (!metaRes.ok) {
    throw new Error(`Spotify REST API metadata request failed (HTTP ${metaRes.status})`)
  }

  const metaData = (await metaRes.json()) as { name?: string; tracks?: { total?: number } }
  const playlistName = metaData.name ?? 'Imported Playlist'
  const totalCount = metaData.tracks?.total ?? 0

  if (totalCount === 0) {
    throw new Error('Playlist has 0 tracks.')
  }

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
      if (allTracks.length > 0) break
      throw new Error(`Spotify REST API pagination request failed (HTTP ${res.status})`)
    }

    const body = (await res.json()) as { items?: SpotifyApiTrackItem[] }
    const items = body.items ?? []

    for (const item of items) {
      const t = item.track
      if (!t?.name) continue
      allTracks.push({
        title: t.name,
        artist: t.artists?.[0]?.name ?? 'Unknown Artist',
        duration: Math.round((t.duration_ms ?? 0) / 1000),
        album: t.album?.name,
        uri: t.uri,
      })
    }

    if (items.length < limit) break
    offset += limit
  }

  if (allTracks.length === 0) {
    throw new Error('Could not fetch any tracks from this playlist.')
  }

  const deduped = deduplicateTracks(allTracks)
  console.log(`[Spotify] REST API: ${deduped.length}/${totalCount} tracks`)
  return { name: playlistName, tracks: deduped, totalCount }
}
