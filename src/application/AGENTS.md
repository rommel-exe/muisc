# src/application/ — Application Layer Engines

## What This Is

Pure TypeScript module-level singleton engines. **Zero Electron imports, zero Node.js imports** — these are plain TS modules that can be unit-tested and reasoned about independently. They encapsulate the core domain logic of the muisc player.

## Files

| File | Lines | Exports | Responsibility |
|------|-------|---------|----------------|
| `QueueEngine.ts` | 397 | `QueueEngine` object (16 methods) | Queue state machine: list, index, history, repeat (none/all/one), Fisher-Yates shuffle, reorder |
| `TrackIdentityEngine.ts` | 874 | `TrackIdentityEngine` object (10 methods) | Weighted confidence scoring, YouTube→Spotify matching, early-exit optimization, variant detection |
| `SearchEngine.ts` | 201 | `SearchEngine` object (3 methods) | Innertube search normalization, title cleaning, annotation patterns |
| `PlaylistEngine.ts` | ~138 | `PlaylistEngine` object (CRUD methods) | Playlist CRUD + Spotify source metadata (in-memory; no SQLite yet) |

No `index.ts` barrel file — consumers import each engine directly by name.

## Key Exports

### QueueEngine
- `setQueue(tracks, startIndex)` — replaces queue entirely
- `appendTracks(tracks)` — appends (preserves shuffle order)
- `next()` / `previous()` — state machine navigation with history tracking
- `removeTrack(index)` / `reorder(from, to)` — queue editing
- `jumpToIndex(index)` — user clicks a queue item
- `updateTrackAt(index, track)` — background rematch updates
- `peekNext()` — lookahead for preloading
- `toggleShuffle()` / `setRepeatMode()` / `getRepeatMode()`
- `_getState()` — test-only, returns frozen snapshot

### TrackIdentityEngine
- `resolveIdentity(incomingTrack: SpotifyTrack)` → `Promise<Track>` — **main entry**. Generates 9 progressive search queries, early-exits at confidence ≥0.80 + duration gate + version check, falls back to best canonical-score candidate if no titlesMatch.
- `resolveFromCandidates(candidates, incomingTrack)` → `Track` — offline resolution from pre-fetched candidate pool
- `calculateConfidence(youtube, spotify)` → `number` — weighted scoring: title edit distance (0.4), duration (0.3), channel type (0.2), extra words (0.1)
- `calculateCanonicalScore(youtube, spotify)` → `number` — bonus for Topic channels, version type hierarchy (official > live > lyric > cover)
- `detectVersionMarkers(title)` → `'remix_edit' | 'alternate_version' | null` — checks for remix/edit/version/cover markers
- `getAnnotationCategory(title, channelType)` → category string — classifies YouTube title into canonical categories
- `isAcceptableVersion(title, channelType)` → `boolean` — gates which versions are acceptable matches
- `getVersionPenalty(title)` → `number` — penalizes non-canonical versions

### SearchEngine
- `search(query)` → `Promise<Track[]>` — Innertube search with fallback to yt-dlp
- `searchRaw(query)` → `Promise<InnertubeSearchResult[]>` — raw results (no normalization)
- `cleanTrackTitle(title)` → `string` — strips `(Official Video)`, `(from ...)`, annotation markers

### PlaylistEngine
- `createPlaylist(name)` → `Playlist`
- `deletePlaylist(id)` / `renamePlaylist(id, name)` / `getPlaylists()`
- `addTrackToPlaylist(playlistId, track)` / `removeTrackFromPlaylist(playlistId, trackId)` / `getPlaylistTracks(playlistId)`
- `loadIntoQueue(playlistId)` / `appendToQueue(playlistId)`
- Import tracking: `setSpotifySource(id, source)`, `addImportedTracksAsSpotify(id, incoming)`

## Dependencies

- **Imports from**: `src/shared/types.ts` (Track, Playlist, etc.)
- **Imported by**: `src/main/ipc/handlers.ts`, `src/main/services/spotify-importer.ts`, `src/main/index.ts`, `tests/`

Internal dependency: SearchEngine → TrackIdentityEngine (called within resolveIdentity)

## Conventions

- **Module-level singletons**: Each file exports a const object with method references. No classes. No constructors. No DI.
- **Immutable state**: Spread/rest patterns (`{ ...state, field: newVal }`). `getStateForTest()` returns a shallow copy.
- **Named exports only**: No default exports.
- **No side effects on import**: Engine functions are lazy — nothing happens until called. (Compare: `innertube.ts` has eager cache.)
- **Verbose console.warn**: Matching failures log with candidate counts and scores for debugging.
- **Errors over null**: Functions throw `Error` on no-match; callers catch and handle.

## Matching Pipeline (Spotify Import)

```
SpotifyTrack
  → generateSearchQueries()   (9 progressive queries: title+artist, "topic", clean, etc.)
    → SearchEngine.search()    (Innertube → yt-dlp fallback)
      → calculateConfidence()  (title edit distance + duration + channel type)
        → [EARLY EXIT at ≥0.80 + gate + version] OR continue queries
          → acceptable filter (duration gate ±2s normal, ±5s variant)
            → titlesMatch() + canonicalScore sort → return best
```

## Gotchas

- **SearchEngine has no covering unit tests** — only integration-tested via spotify-importer. Breakage may not show in `npm test`.
- **TrackIdentityEngine has no covering unit tests** — same issue.
- **Early exit optimizes speed but skips remaining queries**: threshold 0.80 only matches definitive Topic tracks; remix/variant tracks may need all 9 queries.
- **generateSearchQueries order matters**: first queries are most specific (title+artist), last are most general (title only). Later queries find remixes.
- **Variant detection** (`detectVersionMarkers`) inspects the *incoming Spotify* title, not YouTube result — this controls whether duration gate widens.
- **All state is in-memory**: PlaylistEngine does not persist to SQLite yet. Restart loses everything.
