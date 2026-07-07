# src/main/services/ — Main Process Services

## What This Is

Core backend services running in Electron's main process (Node.js context). Handle YouTube stream resolution, audio proxying, search, Spotify API interaction, and playlist import. These are the "engine room" of muisc.

## Files

| File | Lines | Responsibility |
|------|-------|----------------|
| `innertube.ts` | ~300 | YouTube search via `youtubei.js` (unofficial, no API key). Eager singleton initialization. yt-dlp search fallback. |
| `media-resolver.ts` | ~200 | Stream resolution orchestration: bridges yt-dlp, proxy, cache, and prefetch. Configurable config interface. |
| `proxy.ts` | ~765 | Local HTTP proxy with LRU cache, 403/410 stale-URL recovery, parallel daemon+subprocess race, CDN prewarm |
| `spotify.ts` | ~557 | Spotify TOTP anonymous auth + web player API client. Two-endpoint data fetching (playlist v2 + GraphQL). |
| `spotify-importer.ts` | ~300 | Full playlist import pipeline: fetch Spotify tracks → YouTube match (via TrackIdentityEngine) → save. CONCURRENCY=10. |
| `yt-dlp.ts` | ~150 | Raw yt-dlp subprocess wrapper. `getUrl()` (--get-url) and `getInfo()` (--dump-json). |
| `yt-dlp-daemon.ts` | ~200 | Persistent Python daemon wrapper. Warm Python process avoids ~2s cold-start import overhead. |

## Key Exports & APIs

### innertube.ts
- `warmInnerTube()` — pre-warm session at app startup; safe to call early/multiple times
- `searchYouTube(query)` → `InnertubeSearchResult[]` — main search entry; Innertube first, yt-dlp fallback on failure
- `resolveStream(videoId)` → `InnertubeResult` — resolves video ID to stream URL + metadata
- `resolveInfo(videoId)` → `InnertubeResult` — lightweight metadata-only (no stream URL)
- `formatDuration(seconds)` — utility for search result display

### media-resolver.ts
- `createResolver(config?)` → `MediaResolver` instance
- Methods: `resolve(videoId, opts?)` → `ResolvedStream`, `cacheStream(videoId)`, `getCachedStream(videoId)`, `prefetchUpcoming(ids)`, `clearCache()`, `destroy()`
- Exported interfaces: `ResolveOptions`, `MediaResolverConfig`

### proxy.ts
- `createProxy(options?)` — creates & starts the local HTTP server
- `ProxyError` — typed error class with `code: 'PORT_IN_USE' | 'STREAM_NOT_FOUND' | 'RESOLVE_FAILED'`
- Internal: `StreamCache` map (videoId → URL + timestamp), parallel daemon+subprocess race for URL resolution
- HTTP endpoints: `GET /health`, `GET /stream?v=VIDEO_ID`
- CORS enabled (all origins); supports `Range` headers for seeking; stale URL recovery on partial content requests

### spotify.ts
- `getAnonymousToken()` → TOTP-authenticated session token
- `fetchTrackUris(playlistUrl)` → `string[]` (via `spclient.wg.spotify.com/playlist/v2/`)
- `resolveAllTrackMetadata(uris)` → `SpotifyTrack[]` (via GraphQL persisted query, batches of 50, parallel)
- `searchSpotify(query)` → fallback search using web player API
- `getTrackMetadata(uri)` — single track metadata fetch

### spotify-importer.ts
- `importSpotifyPlaylist(url, spDc?)` → `SpotifyImportResult`
- `cancelImport()` — sets abort signal, stops mid-import
- Pipeline: `fetchSpotifyTracks()` → `matchTracks(tracks)` (parallel, CONCURRENCY=10) → `saveAsPlaylist(name, matched)`
- Uses `sendProgressThrottled` — IPC progress events fire every 5 tracks (not every track)
- Background rematch: after import, checks pending queue tracks for updated metadata

### yt-dlp.ts
- `subprocessGetUrl(videoId, opts?)` → `Promise<string | null>` — fast `--get-url` extraction (~1.5s)
- `subprocessGetInfo(videoId, opts?)` → `Promise<YTDlpInfo>` — full `--dump-json` metadata
- Custom error class: `YTDlpError` with `code: 'TIMEOUT' | 'INVALID_VIDEO' | 'NO_AUDIO' | 'CANCELLED'`
- Both support `AbortSignal` and configurable timeout

### yt-dlp-daemon.ts
- `startDaemon()` — spawns `scripts/yt-dlp-daemon.py`; ~500ms for warm resolves vs ~2s subprocess cold
- `getDaemon()` → daemon singleton; starts on first call
- `getStreamUrl(videoId, timeoutMs)` — daemon.resolve
- `getVideoInfo(videoId, timeoutMs)` — daemon.info
- Fallback: if daemon fails, calling service falls through to subprocess

## Dependencies Between Services

```
proxy.ts ←── media-resolver.ts ←── innertube.ts
    ↑              ↑
yt-dlp-daemon.ts   yt-dlp.ts (subprocess fallback)

spotify.ts ←── spotify-importer.ts (uses TrackIdentityEngine from src/application/)
```

## Conventions

- **Named function exports**: Each file exports individual async functions (not classes), except proxy.ts which exports `createProxy()` factory.
- **Eager singleton initialization** (innertube.ts): `warmInnerTube()` is called at app start; module-level `instance` / `instancePromise` pattern with retry.
- **Error handling**: Typed error classes (`ProxyError`, `YTDlpError`) with descriptive codes. Services generally propagate errors up to `handlers.ts` for IPC error responses.
- **Console logging**: Structured `[ServiceName]` prefix for all logs. `console.warn` for recoverable failures, `console.error` for unrecoverable.
- **No direct Electron APIs**: Services use Node built-ins (http, child_process) but never `app`, `BrowserWindow`, `ipcMain` directly. (IPC goes through `handlers.ts`.)

## Gotchas

- **Innertube is rate-limited**: CONCURRENCY >15 in spotify-importer causes Innertube to slow down (~3-5s per query). CONCURRENCY=10 is the tuned maximum. Rate limiting causes fallback to yt-dlp which is slower.
- **Innertube sessions can fail silently**: `getInstance()` resets `instancePromise` on failure so next caller retries. But `warmInnerTube()` swallows failures with `console.warn`.
- **yt-dlp daemon must stay warm**: Daemon is started once at app init. If it crashes, `getDaemon()` returns a dead reference — service must fall through to subprocess. Daemon logs go to `/tmp/yt-dlp-daemon.log`.
- **Proxy port 18938**: Must not conflict. Dev server keeps one running — check `lsof -ti:18938` before starting fresh instances.
- **YouTube stream URLs expire (~6h)**: LRU cache TTL is 5h. Proxy handles stale CDN URLs via range-header detection + re-resolve. `onReResolve` callback in proxy config re-extracts URL when 403/410 encountered mid-playback.
- **Spotify secrets expire**: `TOKEN_SECRETS` in spotify.ts need updating when Spotify updates their web player bundle. TOTP auth returns same cached token per IP — that's normal.
- **sp_dc cookie is optional**: Power users can pass `spDc` for faster REST API (no GraphQL batching). Without it, the anonymous two-endpoint approach works for all playlists (no pagination limit).
- **GraphQL persisted hash may change**: If Spotify updates their GraphQL API, the `operationName` / `extensions.persistedQuery.sha256Hash` in spotify.ts needs updating.
