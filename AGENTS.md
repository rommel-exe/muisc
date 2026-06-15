# AGENTS.md

## What This Is

Greenfield Electron desktop music player. Free YouTube streaming via yt-dlp + Innertube API. No code exists yet — spec only.

## Source of Truth

**`interview.md`** — full spec + 5-phase implementation roadmap. Read this first. Don't invent architecture decisions; they're already made.

## Tech Stack (locked)

- Electron + TypeScript (Vite-Electron template)
- yt-dlp subprocess → local HTTP proxy → HTMLAudioElement
- Innertube API (`youtubei.js`) for search (no API key)
- better-sqlite3 for local storage
- electron-builder + electron-updater
- React (recommended frontend, not yet decided)

## Project Structure (target)

```
src/
├── main/           ← Electron main process
│   ├── index.ts
│   ├── ipc/
│   └── services/   ← yt-dlp, proxy, innertube, database, media-engine
├── renderer/       ← Frontend (React)
│   ├── index.html
│   ├── main.ts
│   └── components/
└── shared/         ← Types, constants
```

## Phase Order (critical)

Don't skip phases. Each builds on the previous:

1. **Core** — yt-dlp + proxy + audio plays from hardcoded ID
2. **Search** — Innertube integration, search → click → play
3. **Brain** — SQLite, queue state machine, playlists CRUD
4. **UI** — glassmorphism, frameless window, custom controls
5. **Polish** — MediaSession, Spotify import, tray, packaging

## Gotchas

- YouTube stream URLs expire — proxy must re-fetch if stale
- yt-dlp must be on PATH or bundled (check early)
- `better-sqlite3` needs native rebuild for Electron (`electron-rebuild`)
- Frameless window needs `titleBarStyle: 'hidden'` + custom drag regions
- Innertube is unofficial — can break without notice
