# muisc

A free desktop music streaming player for macOS and Windows.

Search YouTube, build playlists, and listen — no subscription needed.

## Features

- **Free streaming** — no ads, no subscription, no account required
- **Playlist-forward** — search YouTube, add to queue, manage playlists
- **Glassmorphism UI** — clean, translucent, content-focused aesthetic
- **Local-first** — your playlists stay on your machine (SQLite)
- **Spotify import** — paste a Spotify playlist URL to import tracks

## Tech Stack

- Electron + TypeScript
- yt-dlp (audio extraction from YouTube)
- Innertube API (unofficial YouTube search, no API key needed)
- better-sqlite3 (local storage)
- electron-builder + electron-updater (packaging & auto-update)

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## License

MIT
