# AGENTS.md

## What This Is

Greenfield Electron desktop music player. Free YouTube streaming via yt-dlp + Innertube API. Phase 1 scaffold complete — project builds and typechecks.

## Source of Truth

**`interview.md`** — full spec + 5-phase implementation roadmap. Read this first. Don't invent architecture decisions; they're already made.

## Tech Stack (locked)

- Electron 35 + TypeScript (electron-vite build tool)
- yt-dlp subprocess → local HTTP proxy → HTMLAudioElement
- Innertube API (`youtubei.js`) for search (no API key)
- better-sqlite3 for local storage
- electron-builder + electron-updater (auto-update via GitHub Releases)
- React 19 frontend

## Project Structure (actual — update as you build)

This section reflects the **actual** codebase structure. When you add, move, rename, or delete files/folders, update this section immediately. Future agents depend on it being accurate.

```
src/
├── application/    ← Application Layer engines (main process)
│   ├── MediaEngine.ts    ← Master orchestrator: state transitions, concurrency, self-healing
│   ├── QueueEngine.ts    ← Pure queue state machine: list, index, history, repeat, shuffle
│   ├── TrackIdentityEngine.ts ← Weighted matching & confidence scoring for track resolution
│   ├── SearchEngine.ts   ← Search normalization: Innertube wrapper, title/duration parsing
│   └── PlaylistEngine.ts ← Playlist CRUD, SQLite abstraction, session hydration
├── main/           ← Electron main process (Node context)
│   ├── index.ts       ← BrowserWindow creation, app lifecycle
│   ├── ipc/           ← IPC handler registration
│   └── services/      ← yt-dlp, proxy, innertube, database, media-resolver
├── playback/       ← Audio playback interfaces (mocked in tests)
│   ├── AudioService.ts   ← HTMLAudioElement wrapper interface
│   └── MediaResolver.ts  ← Stream resolution interface
├── preload/        ← Preload scripts (contextBridge)
│   ├── index.ts       ← Exposes electronAPI to renderer
│   └── index.d.ts     ← Type declarations for renderer
├── renderer/       ← Frontend (React, browser context)
│   ├── index.html     ← Vite HTML entry
│   └── src/
│       ├── main.tsx   ← React root mount
│       ├── App.tsx    ← Root component
│       ├── env.d.ts   ← Vite client types
│       └── components/ ← React components
└── shared/         ← Types, constants (imported by main + renderer)
    ├── types.ts       ← Track, Playlist, Queue, PlaybackState interfaces
    └── constants.ts   ← IPC channel names, config defaults

build/
├── entitlements.mac.plist ← macOS notarization entitlements

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
```

## Phase Order (critical)

Don't skip phases. Each builds on the previous:

1. **Core** — yt-dlp + proxy + audio plays from hardcoded ID
2. **Search** — Innertube integration, search → click → play
3. **Brain** — SQLite, queue state machine, playlists CRUD
4. **UI** — glassmorphism, frameless window, custom controls
5. **Polish** — MediaSession, Spotify import, tray, packaging

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
