---
sessionID: ses_13522a6ddffesXr4RrWYxKpQCM
baseMessageCount: 0
updatedAt: 2026-06-15T10:50:36.786Z
---

# Muisc app

## Current spec

Electron desktop music player: yt-dlp streams from YouTube via Electron HTTP proxy → HTMLAudioElement. Innertube API search. Playlist-forward UX with queue/repeat/shuffle. Media keys + OS media controls. Local SQLite storage. Custom playlists with drag-reorder and Spotify URL import. Glassmorphism UI. Packaged with auto-update via GitHub. macOS + Windows. Name TBD.

## Q&A history

Q: What kind of music app is this?
A: Streaming player (playlists, library, recommendations)

Q: Which platform do you want to target first?
A: Desktop (macOS / Windows)

Q: Where does the music come from?
A: Streaming service integration (Spotify/YouTube Music API)

Q: What's the main reason this app should exist over existing players like Spotify desktop or iTunes?
A: It will be free for the streaming music

Q: How does 'free streaming' work technically? (Spotify and YouTube Music APIs don't allow full-track streaming.)
A: Scrape/play audio from YouTube Music or YouTube (like a frontend for free-tier YouTube)

Q: Preferred desktop tech stack?
A: Electron (web tech, fast to ship, larger bundle)

Q: How should the app get music from YouTube?
A: Use youtube-dl/yt-dlp to extract audio URLs (more flexible, but breakable)

Q: What's the MVP feature set for v1?
A: Search + play, now playing view, basic library (saved songs + playlists)

Q: Where are user playlists and saved songs stored?
A: Local only (JSON file or SQLite on disk, no account needed)

Q: What visual style fits the free streaming concept?
A: Clean minimal/glassmorphism (translucent, focus on content)

Q: How does the search-and-play flow work?
A: Search YouTube → show results → tap to add to queue/playlist, play from there (playlist-forward)

Q: Is 'Muisc' the intentional app name or a typo for 'Music'?
A: THESE ARE BOTH PLACE-HOLDING APP NAMES ALRIGHT?!

Q: What should the app actually be called?
A: I WILL DECIDE LATER

Q: How does audio actually play in the app?
A: Track Selected
      ↓
MediaEngine
      ↓
MediaResolver
      ↓
Electron HTTP Proxy
      ↓
YouTube CDN Audio Stream
      ↓
AudioService
      ↓
HTMLAudioElement
      ↓
Speakers

Q: Queue and repeat behavior for v1?
A: Queue + repeat modes (no repeat, repeat all, repeat one) + shuffle

Q: How does the app search for tracks and resolve metadata (title, artist, album art, duration)?
A: Use the Innertube API (what yt-dlp uses internally — unofficial, no key needed)

Q: How do you plan to distribute the app?
A: Packaged + auto-update (electron-updater with GitHub releases)

Q: v1 system integration features?
A: Media keys (keyboard play/pause/next/prev) + OS media notification center

Q: Playlist management beyond basic CRUD?
A: OPTION NUMBER 1 BUT I SHOULD BE ABLE TO IMPORT PLAYLISTS FROM SPOTIFY OR OTHER SERVICES USING THE URL

Q: Which playlist import sources should v1 support?
A: Start with Spotify — add more later
