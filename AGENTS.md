# AGENTS.md

## What This Is

Greenfield Electron desktop music player. Free YouTube streaming via yt-dlp + Innertube API. Phases 1–3 (Core, Search, Brain) and Phase 5 substeps (Spotify import, CI/CD) are built. Phase 4 (UI) is not started beyond wireframes. Project builds (~399 files, ~29K lines) and typechecks.

## Source of Truth

**`interview.md`** — full spec + 5-phase implementation roadmap. Read this first. Don't invent architecture decisions; they're already made.

## Tech Stack (locked)

- Electron 35 + TypeScript (electron-vite build tool)
- yt-dlp subprocess → local HTTP proxy → dual HTMLAudioElement (gapless transitions)
- Innertube API (`youtubei.js`) for search (no API key)
- better-sqlite3 for local storage (v0 — schema designed, NOT yet implemented; all state is in-memory)
- electron-builder + electron-updater (auto-update via GitHub Releases)
- React 19 frontend (App.tsx + useMediaEngine/useAudioPlayer hooks + MediaEngine class)

## Project Structure (actual — update as you build)

This section reflects the **actual** codebase structure. When you add, move, rename, or delete files/folders, update this section immediately. Future agents depend on it being accurate.

```
src/
├── application/    ← Application Layer engines — pure TS, zero Electron deps → see src/application/AGENTS.md
│   ├── QueueEngine.ts         ← Queue state machine: list, index, history, repeat, shuffle
│   ├── TrackIdentityEngine.ts ← Weighted matching & confidence scoring for track resolution
│   ├── SearchEngine.ts        ← Search normalization: Innertube wrapper, title/duration parsing
│   └── PlaylistEngine.ts      ← Playlist CRUD + Spotify source metadata (in-memory; no SQLite yet)
├── main/           ← Electron main process (Node context)
│   ├── index.ts       ← BrowserWindow creation, app lifecycle (+ no-sandbox flag)
│   ├── __tests__/     ← Pipeline diagnostics: resolve, verify, test scripts
│   ├── ipc/
│   │   └── handlers.ts   ← 19 IPC channel registrations + queue navigation + Spotify import
│   └── services/     ← Core backend services → see src/main/services/AGENTS.md
│       ├── innertube.ts       ← YouTube search via youtubei.js (no API key)
│       ├── media-resolver.ts  ← Stream resolution orchestration: yt-dlp, proxy, cache, prewarm
│       ├── proxy.ts           ← Local HTTP proxy with LRU cache + 403/410 retry
│       ├── spotify.ts         ← Spotify TOTP auth + web player API client
│       ├── spotify-importer.ts ← Spotify playlist import: fetch, match, save (CONCURRENCY=10)
│       ├── yt-dlp.ts          ← yt-dlp subprocess wrapper
│       └── yt-dlp-daemon.ts   ← Persistent yt-dlp Python daemon
├── preload/        ← Preload scripts (contextBridge)
│   ├── index.ts       ← Exposes electronAPI to renderer (17 channels)
│   └── index.d.ts     ← Type declarations for renderer (mirrors src/shared/types.ts)
├── renderer/       ← Frontend (React, browser context)
│   ├── index.html     ← Vite HTML entry
│   └── src/
│       ├── main.tsx   ← React root mount
│       ├── App.tsx    ← Monolithic root component (678 lines — no subcomponents yet)
│       ├── env.d.ts   ← Vite client types
│       ├── engine/
│       │   ├── MediaEngine.ts  ← EventEmitter-based bridge: IPC ↔ AudioPlayer (821 lines)
│       │   └── types.ts        ← AudioBridge, ApiBridge, MediaEngineState interfaces
│       ├── hooks/
│       │   ├── useAudioPlayer.ts  ← Dual HTMLAudioElement with next-track preload + swap (573 lines)
│       │   └── useMediaEngine.ts  ← React hook wrapping MediaEngine, exposes engineState + controls
│       ├── components/ ← (empty — App.tsx is monolithic, .gitkeep only)
│       └── wireframes/ ← Static high-fidelity UI mockups (design reference, NOT wired into App.tsx)
│           ├── index.tsx, MainLayout.tsx, SearchResults.tsx, QueueDrawerOpen.tsx
│           ├── LibrarySongs.tsx, LibraryPlaylists.tsx, PlaylistDetail.tsx
│           └── NowPlayingExpanded.tsx
└── shared/         ← Types, constants → see src/shared/AGENTS.md
    ├── types.ts       ← Track, Playlist, Queue, PlaybackState, SearchResult, SpotifyImport* interfaces
    └── constants.ts   ← IPC channel names (IPC_CHANNELS), DEFAULT_VOLUME, PROXY_PORT, DB_FILENAME

build/
└── entitlements.mac.plist ← macOS notarization entitlements

scripts/
└── yt-dlp-daemon.py ← Python daemon (keeps yt-dlp module imports warm)

tests/
├── application-layer.test.ts ← Vitest unit tests (QueueEngine, TrackIdentityEngine, SearchEngine, PlaylistEngine)
├── import-test-full.ts       ← Full 332-track Spotify import + YouTube match integration test (npx tsx)
├── import-test.ts            ← Quick smoke test (npx tsx)
└── failing-tracks-test.ts    ← Edge case diagnostics for low-confidence matches

.github/workflows/
└── release.yml     ← Merged CI+Release: type-check, build (PR/push), publish (v* tag)
```

## Key Config Files

- `electron.vite.config.ts` — Vite config for main/preload/renderer
- `electron-builder.yml` — Packaging config (DMG + AppImage + NSIS + GitHub Releases)
- `tsconfig.json` — Root project references
- `tsconfig.node.json` — Main + preload TypeScript config
- `tsconfig.web.json` — Renderer TypeScript config
- `dev-app-update.yml` — Local auto-update testing config
- `.vscode/launch.json` — F5 debugging (Debug Main Process + Debug Renderer)

## NPM Scripts

```bash
npm run dev          # Start dev server (electron-vite dev)
npm run build        # Production build (electron-vite build)
npm run build:mac    # Build + package macOS DMG
npm run build:win    # Build + package Windows NSIS
npm run typecheck    # TypeScript type-check (node + web)
npm test             # Unit tests (vitest)
```

## Integration Tests

```bash
npx tsx tests/import-test-full.ts   # Full Spotify import + YouTube match test
npx tsx tests/import-test.ts        # Quick smoke test
```

## Phase Order (critical)

Don't skip phases. Each builds on the previous:

1. **Core** — yt-dlp + proxy + audio plays from hardcoded ID
2. **Search** — Innertube integration, search → click → play
3. **Brain** — SQLite, queue state machine, playlists CRUD
4. **UI** — glassmorphism, frameless window, custom controls
5. **Polish** — MediaSession, Spotify import, tray, packaging

## Phase Status

| Phase | Status | Notes |
|-------|--------|-------|
| **1: Core** | ✅ Complete | yt-dlp, proxy, dual audio elements, CDN prewarm, 403/410 retry |
| **2: Search** | ✅ Complete | Innertube search, search→click→play, debounced search UI |
| **3: Brain** | 🟡 Partial | Queue state machine, playlists CRUD, track identity engine all work. **No SQLite yet** — all state is in-memory, lost on restart |
| **4: UI** | ⬜ Not started | Wireframes exist as design reference but **not wired** into App.tsx. Bare monospace debug UI in production |
| **5: Polish** | 🟡 Partial | Spotify import (TOTP auth, 332/332 match rate), CI/CD release workflow, auto-update config. **Missing**: MediaSession API, tray icon, custom app icon, code signing |

## Dev Server

- A persistent `npm run dev` instance is running on PID 46911 (started 2026-06-20). **Never kill, restart, or touch this server.**
- Logs live in `/tmp/muisc-dev.log`.
- If a new dev server is needed for testing/debugging, start a **separate instance** using a different port or a separate clone/worktree.
- When starting fresh dev servers, always check for existing ones first: `lsof -ti:5173`, `lsof -ti:18938`.
- Never run `pkill`, `kill`, or any command that could touch the persistent dev server or its proxy (port 18938).

## Git Workflow

- **Commit after every change.** Each file edit = one commit. No batching. No "one more thing" before committing.
- Use clear, short commit messages: what changed, not what you were thinking.
- Push after committing so the remote stays current.
- Before starting new work, check `git status` — if there are uncommitted changes from a previous step, commit them first.

## CI/CD

- **Build & Release workflow** (`.github/workflows/release.yml`): Merged CI + release in one file.
  - **Type-check** on ubuntu (all triggers)
  - **Build** on push to main: matrix (macOS + Linux + Windows), packages with `--publish never`
  - **Publish** on `v*` tag push: sequential — Linux creates the release, then macOS + Windows upload assets to it
- **Auto-update**: electron-updater checks GitHub Releases on app launch. Uses `secrets.GITHUB_TOKEN` with `contents: write`.
- electron-builder derives the GitHub release tag from `package.json` version field (prefixed with `v`)

## Gotchas

- YouTube stream URLs expire — proxy must re-fetch if stale
- yt-dlp must be on PATH or bundled (check early)
- `better-sqlite3` needs native rebuild for Electron (`electron-rebuild`)
- Frameless window needs `titleBarStyle: 'hidden'` + custom drag regions
- Innertube is unofficial — can break without notice
- macOS needs `zip` target alongside `dmg` for auto-update (`latest-mac.yml` generation)
- electron-vite@^3 bundles Vite 6 internally — don't upgrade Vite or electron-vite independently without checking compatibility
- macOS 26 (Sequoia) requires `app.commandLine.appendSwitch('no-sandbox')` to prevent child process crashes (exit_code=15)
- Spotify import (spotify.ts) uses a **two-endpoint anonymous approach** via the web player's internal APIs:
  1. `spclient.wg.spotify.com/playlist/v2/playlist/{id}` — returns all track URIs (no pagination)
  2. `api-partner.spotify.com/pathfinder/v1/query` (GraphQL, persisted hash) — resolves URIs to track metadata in batches of 50
  - **Rate limits are the web player's** — not the REST API — so large imports work out of the box
- TOTP auth is used to get an anonymous token (same flow as open.spotify.com):
  - Secrets extracted from `web-player.*.js` bundle: `{secret:"...", version:N}`
  - Update `TOKEN_SECRETS` in `src/main/services/spotify.ts` when they expire
  - The `/api/token` endpoint returns the same cached token per IP — this is normal
- sp_dc cookie still works as a REST API fallback for power users (faster, no GraphQL batching)
- The old `get_access_token` endpoint is WAF-blocked (403) — do not try to use it
- The old `__NEXT_DATA__` HTML fallback is dead — Spotify pages are fully CSR now
