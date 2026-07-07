# src/shared/ — Types & Constants

## What This Is

The only module in the project that both main and renderer processes import. Defines the shared type contracts and IPC channel name constants that keep main↔renderer communication typesafe.

**Critical constraint**: Must never import from any other module in the project. No Electron imports, no Node imports. Keeping this module clean prevents circular dependencies and ensures it can be imported anywhere.

## Files

| File | Lines | Exports | Responsibility |
|------|-------|---------|----------------|
| `types.ts` | 103 | 13 types/interfaces | All data shapes: Track, Playlist, Queue, SearchResult, ResolvedStream, SpotifyImport* |
| `constants.ts` | 62 | 4 constants | IPC channel names, DEFAULT_VOLUME, PROXY_PORT, DB_FILENAME |

## Key Types (types.ts)

| Type | Kind | Fields | Used By |
|------|------|--------|---------|
| `Track` | interface | id, title, artist, album?, duration, thumbnailUrl, source, sourceId, channelType? | Every module — ~15 files |
| `Playlist` | interface | id, name, createdAt, updatedAt, spotifySource? | handlers, PlaylistEngine, renderer |
| `QueueItem` | interface | trackId, position | Queue state |
| `QueueTrackRef` | interface | queueId, track | Queue display |
| `RepeatMode` | type alias | `'none' \| 'all' \| 'one'` | QueueEngine, MediaEngine, hooks |
| `PlaybackStateType` | type alias | `'IDLE' \| 'BUFFERING' \| 'PLAYING' \| 'PAUSED' \| 'ERRORED'` | MediaEngine |
| `PlaybackState` | interface | currentTrackId, queue, shuffle, repeat, volume, isPlaying | IPC state sync |
| `SearchResult` | interface | title, artist, duration, thumbnail, videoId | Search UI |
| `ResolvedStream` | interface | videoId, audioUrl, duration, title, thumbnail | Playback pipeline |
| `SpotifySourceTrack` | interface | title, artist, duration, explicit? | Import metadata |
| `SpotifySource` | interface | url, tracks | Playlist source tracking |
| `SpotifyImportProgress` | interface | current, total, currentTitle, status | Import progress IPC |
| `SpotifyImportSkipped` | interface | title, artist, reason | Import result reporting |
| `SpotifyImportResult` | interface | playlistId, playlistName, matchedCount, totalCount, skipped | Import completion |

## Key Constants (constants.ts)

### IPC_CHANNELS (57 lines, 28 channels)

Organized by domain:
- **Search**: `MUSIC_SEARCH`
- **Playback**: `PLAY_TRACK`, `PAUSE_TRACK`, `RESUME_TRACK`, `NEXT_TRACK`, `PREV_TRACK`, `SET_REPEAT`, `SET_SHUFFLE`, `SET_VOLUME`, `SEEK`
- **Queue**: `GET_QUEUE`, `ADD_TO_QUEUE`, `REMOVE_FROM_QUEUE`, `REORDER_QUEUE`, `CLEAR_QUEUE`, `QUEUE_NEXT`, `QUEUE_PREV`, `QUEUE_PEEK_NEXT`, `JUMP_TO_QUEUE_INDEX`
- **Playlists**: `CREATE_PLAYLIST`, `RENAME_PLAYLIST`, `DELETE_PLAYLIST`, `ADD_TRACK_TO_PLAYLIST`, `REMOVE_TRACK_FROM_PLAYLIST`, `REORDER_PLAYLIST`, `GET_PLAYLISTS`, `GET_PLAYLIST_TRACKS`
- **Library**: `GET_SONGS`, `ADD_TRACK`
- **Updater**: `CHECK_FOR_UPDATES`, `UPDATE_DOWNLOADED`
- **Preloader**: `PREFETCH_QUEUE`
- **Spotify Import**: `IMPORT_SPOTIFY_PLAYLIST`, `CANCEL_SPOTIFY_IMPORT`, `SPOTIFY_IMPORT_PROGRESS`, `SPOTIFY_IMPORT_DONE`, `SPOTIFY_IMPORT_ERROR`

Declared `as const` for literal type inference.

### Config Defaults
- `DEFAULT_VOLUME = 0.8`
- `PROXY_PORT = 18938`
- `DB_FILENAME = 'muisc.db'`

## Dependencies

- **Imports from**: Nothing (pure TS, no project imports)
- **Imported by**: `src/application/*`, `src/main/*`, `src/preload/index.d.ts` (mirror), `src/renderer/src/**` (via `../../../shared/types`)

## Conventions

- **No default exports**: All named exports (`export interface`, `export const`).
- **`as const` for IPC_CHANNELS**: Enables literal string types instead of `string`, so IPC handler registration is typesafe.
- **No Electron or Node types**: All types are plain JSON-serializable shapes — they cross the IPC boundary via contextBridge.
- **Mirrored in preload**: `src/preload/index.d.ts` duplicates some interfaces (`Track`, `Playlist`, `SearchResult`, etc.) for the renderer's global `Window` type. Update both when adding fields.
- **Backward compat**: Changing type shapes requires updating preload declaration, IPC handler signatures, and all consumers in the renderer.

## Gotchas

- **preload/index.d.ts duplication**: The preload type declarations are NOT auto-generated. They mirror `types.ts` but with a `QueueState` wrapper instead of raw `PlaybackState`. When modifying types, always update both files.
- **`as const` means readonly**: `IPC_CHANNELS.SOME_CHANNEL` is `readonly` — can't be reassigned. This is intentional.
- **Track.source enum**: Must be one of `'youtube' | 'spotify_imported' | 'local'`. Adding a new source type requires updating type checks in at least 3 modules (TrackIdentityEngine, SearchEngine, handlers).
