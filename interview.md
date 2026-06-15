---
sessionID: ses_13522a6ddffesXr4RrWYxKpQCM
baseMessageCount: 0
updatedAt: 2026-06-15T10:39:25.124Z
status: spec-complete
---

# Music App (working title TBD)

> A free desktop music streaming player for macOS and Windows. Search YouTube, build playlists, and listen — no subscription needed.

---

## 1. Core Concept

A native-desktop music player that sources audio from YouTube (via yt-dlp) and presents it in a curated, playlist-forward experience. The differentiator is **free streaming** — no ads, no subscription, no account required.

### 1.1 Unique Value Proposition

- **Free** — zero-cost streaming from YouTube's catalog
- **Playlist-forward** — designed around queuing and organizing, not just one-off playback
- **Minimal glassmorphism UI** — clean, translucent, content-focused aesthetic
- **Local-first** — no account, no cloud, your playlists stay on your machine

---

## 2. Platform & Tech Stack

| Layer | Choice |
|-------|--------|
| **Desktop Framework** | Electron |
| **Primary Language** | TypeScript (renderer + main process) |
| **Audio Extraction** | yt-dlp (spawned as subprocess) |
| **Search/Metadata** | Innertube API (unofficial YouTube API, no key needed) |
| **Audio Playback** | HTMLAudioElement via Electron HTTP proxy |
| **Local Storage** | SQLite (better-sqlite3) |
| **Packaging** | electron-builder |
| **Auto-Update** | electron-updater via GitHub Releases |
| **Target OS** | macOS (DMG) + Windows (NSIS installer) |

---

## 3. Audio Pipeline

```
Track Selected
      ↓
  MediaEngine            ← manages playback state, queue, repeat
      ↓
  MediaResolver          ← resolves a track to a playable stream URL
      ↓
Electron HTTP Proxy      ← proxies the YouTube CDN audio stream through localhost
      ↓
 YouTube CDN Audio Stream
      ↓
  AudioService           ← wraps HTMLAudioElement, handles events
      ↓
    Speakers
```

**Playback flow:**
1. User searches and selects a track → added to queue
2. MediaEngine tells MediaResolver to resolve the current track
3. MediaResolver calls yt-dlp to extract the direct audio stream URL
4. Stream is proxied through Electron's local HTTP server (avoids CORS/mixed-content issues)
5. AudioService feeds the stream into an HTMLAudioElement
6. Audio output to system speakers

---

## 4. Search & Discovery

### 4.1 Search Source
- **Innertube API** — same internal API used by yt-dlp
- No API key required
- Returns: title, artist/channel, duration, thumbnail, video ID
- Coverts YouTube results into "tracks" for the app's data model

### 4.2 Search UX
- Search field in the sidebar or top bar
- Results displayed as a scrollable list (track title, artist, album art thumbnail, duration)
- Tap a result → adds to queue (does not replace current playback)
- Tap-and-hold or context menu → "Play Now", "Add to Queue", "Add to Playlist"

---

## 5. Playback Features (v1)

### 5.1 Queue
- Tracks play from a queue in order
- Add tracks to the end of the queue
- "Play Now" clears the queue and starts fresh (or inserts next)
- Queue is visible and reorderable (drag to reorder)

### 5.2 Repeat Modes
- **No Repeat** — queue plays through once, stops at end
- **Repeat All** — queue loops endlessly
- **Repeat One** — current track repeats

### 5.3 Shuffle
- Toggle shuffle to randomize queue order
- Shuffle applies to the current queue (does not reorder the saved playlist)

### 5.4 Now Playing View
- Album art (large, centered, glassmorphism backdrop)
- Track title + artist
- Progress bar (seekable)
- Play/Pause, Next, Previous, Shuffle, Repeat controls
- Volume slider
- Current time / total duration

---

## 6. Library & Storage

### 6.1 Local Database (SQLite)
- **Tracks table** — id, youtubeId, title, artist, album, duration, thumbnail, addedAt
- **Playlists table** — id, name, createdAt, updatedAt
- **PlaylistTracks table** — id, playlistId, trackId, position, addedAt
- **Queue table** — current queue state (persisted across sessions)

### 6.2 "Your Library"
- **Songs** — all tracks you've ever played or saved (deduplicated by YouTube ID)
- **Playlists** — list of user-created playlists
- **Queue** — the current playback queue

### 6.3 Playlist Management
- Create new playlist
- Rename playlist
- Delete playlist
- Add/remove tracks
- Drag to reorder tracks within a playlist
- **Import from Spotify** — paste a Spotify playlist URL → resolve track names via Innertube → create local playlist (best-effort matching)

### 6.4 No Account Required
- Everything stored locally
- No sign-up, no login, no cloud sync in v1

---

## 7. System Integration (v1)

- **Media Keys** — keyboard play/pause/next/prev (MediaSession API / Electron global shortcuts)
- **OS Media Notification Center** — macOS Control Center / Windows media overlay shows now-playing info and play/pause/skip controls
- **Tray icon** — minimize to tray, background playback (secondary priority)
- **Auto-update** — checks GitHub Releases on launch, downloads + installs silently

---

## 8. UI / Design

### 8.1 Visual Style: Glassmorphism Minimal
- Dark base with translucent glass panels (frosted glass effect using backdrop-filter)
- Album art as dominant visual element — blurred behind glass panels
- Clean typography, generous whitespace
- Minimal chrome — no title bar clutter, custom frameless window with traffic light controls (macOS)
- Accent color derived from current album art or a static accent

### 8.2 Layout (Mock Wireframe)

```
┌─────────────────────────────────────────────────┐
│ ┌──────────┐  ┌───────────────────────────────┐ │
│ │  Search  │  │                               │ │
│ │  [_____] │  │       NOW PLAYING             │ │
│ │          │  │    ┌───────────────┐          │ │
│ │  Library │  │    │   Album Art   │          │ │
│ │  ─────── │  │    │   (large)     │          │ │
│ │  Songs   │  │    └───────────────┘          │ │
│ │  Playlists│  │     Track Title               │ │
│ │  Queue   │  │     Artist Name                │ │
│ │          │  │    ════════●══════════         │ │
│ │          │  │    ◄◄  ▶▶  ►►  ↺  🔀         │ │
│ │          │  │                               │ │
│ │          │  └───────────────────────────────┘ │
│ └──────────┘                                     │
└─────────────────────────────────────────────────┘
```

- **Sidebar (left)** — narrow column: search bar, library navigation (Songs, Playlists, Queue)
- **Main area** — now playing view with album art and controls
- **Queue drawer** — slides in from right or bottom, shows upcoming tracks

---

## 9. Packaging & Distribution

| Format | Tool |
|--------|------|
| macOS | electron-builder → DMG + zip |
| Windows | electron-builder → NSIS installer |
| Auto-update | electron-updater + GitHub Releases |

---

## 10. Out of Scope (v1)

- ❌ Offline downloads (requires storing audio files locally)
- ❌ User accounts / cloud sync
- ❌ Native YouTube Music playlist sync
- ❌ Collaborative / shared playlists
- ❌ Discord Rich Presence
- ❌ Mobile app
- ❌ Music recommendations engine
- ❌ Audio visualizer

---

## 11. Future Possibilities (post-v1)

- Offline mode (cache tracks)
- Cloud sync with optional account
- More playlist import sources (YouTube Music, Apple Music, Tidal)
- Smart playlists (rules-based)
- Discord Rich Presence
- Linux support
- Global search (search your library + YouTube in one field)
- Audio normalization (ReplayGain / EBU R128)

---

## 12. Implementation Roadmap

> This roadmap is designed specifically for vibe-coding with AI assistance. Each phase has clear milestones so you know exactly when to move on. The key principle: **get the plumbing working before touching the UI**.

### Phase 1: The Invisible Core

**Goal:** Get a rough Electron window to successfully stream a YouTube audio track via yt-dlp to your speakers.

Don't touch a single Tailwind class or glassmorphism effect yet. You need to prove the plumbing works.

#### Step 1.1: Project Scaffolding
- Set up Electron + TypeScript boilerplate using Vite-Electron template
- Configure TypeScript with strict mode
- Set up project structure:
  ```
  src/
  ├── main/           ← Electron main process
  │   ├── index.ts
  │   ├── ipc/
  │   └── services/
  ├── renderer/       ← Frontend
  │   ├── index.html
  │   ├── main.ts
  │   └── components/
  └── shared/         ← Types, constants shared between main/renderer
  ```

#### Step 1.2: The yt-dlp Subprocess
- Create `src/main/services/yt-dlp.ts`
- Write a function that spawns yt-dlp to extract a streaming URL from a hardcoded YouTube video ID (e.g., a lo-fi track)
- Handle stderr/stdout parsing, timeout, and error states
- Verify yt-dlp is available on PATH or bundled with the app

#### Step 1.3: The Local HTTP Proxy
- Create `src/main/services/proxy.ts`
- Build an Express/Node HTTP server that:
  1. Accepts a request with a video ID
  2. Spawns yt-dlp to get the stream URL
  3. Proxies the audio stream back to the client
- Handle YouTube stream URL expiry (re-fetch if stale)
- Stream audio chunks to avoid loading entire track into memory

#### Step 1.4: Sound Check
- Create a blank `renderer/index.html` with a basic `<audio>` tag
- Wire it up to your proxy
- **Milestone:** Click a generic HTML button → music plays out of your speakers

**Exit Criteria for Phase 1:**
- [ ] Electron window opens
- [ ] yt-dlp subprocess extracts a stream URL
- [ ] Audio plays through the proxy
- [ ] You can hear music from a hardcoded YouTube video

---

### Phase 2: Search & Discovery (The Innertube Phase)

**Goal:** Search for a song, see results, and play the one you click.

Now that the audio pipeline is alive, you need a way to feed it tracks without hardcoding IDs.

#### Step 2.1: Innertube Integration
- Install `youtubei.js` (or `innertube` package) in the main process
- Create `src/main/services/innertube.ts`
- Write a search function that takes a query string and returns:
  - title, artist, duration, thumbnail URL, video ID
- Expose via IPC channel: `music-search`

#### Step 2.2: The Barebones Search UI
- Create `renderer/components/Search.tsx` (or `.vue`)
- Build a simple text input + results list
- Type a query → hit enter → print raw search results to screen
- No styling yet — just functional

#### Step 2.3: Connect Search to Playback
- Wire search results to the Phase 1 pipeline
- Clicking a result → passes YouTube ID to yt-dlp → plays audio
- **Milestone:** Type "lo-fi beats" → see results → click one → music plays

**Exit Criteria for Phase 2:**
- [ ] Innertube search returns results
- [ ] Results display with title, artist, thumbnail, duration
- [ ] Clicking a result plays the track
- [ ] No hardcoded video IDs remain

---

### Phase 3: The Brain (SQLite & Queue Phase)

**Goal:** Build the state machine that handles queues, history, and creating playlists.

This is where your app becomes a player and not just a search engine.

#### Step 3.1: Database Setup
- Install `better-sqlite3`
- Create `src/main/services/database.ts`
- Write schema migration script for tables:
  - `tracks` — id, youtubeId, title, artist, album, duration, thumbnail, addedAt
  - `playlists` — id, name, createdAt, updatedAt
  - `playlist_tracks` — id, playlistId, trackId, position, addedAt
  - `queue` — current queue state (persisted across sessions)
- Run migration on app startup

#### Step 3.2: The MediaEngine State
- Create `src/main/services/media-engine.ts`
- Build the playback queue state machine:
  - What is playing now?
  - What is next? What is previous?
  - Is shuffle on? Is repeat on? (none/all/one)
- Persist queue state to SQLite so it survives app restarts
- Expose via IPC: `play-track`, `next-track`, `prev-track`, `set-repeat`, `set-shuffle`

#### Step 3.3: Playlists CRUD
- Create `src/main/services/playlists.ts`
- Backend functions:
  - `createPlaylist(name)`
  - `renamePlaylist(id, newName)`
  - `deletePlaylist(id)`
  - `addTrackToPlaylist(playlistId, trackId)`
  - `removeTrackFromPlaylist(playlistId, trackId)`
  - `reorderPlaylist(playlistId, trackIds[])`
- Expose via IPC channels

#### Step 3.4: Wire to Frontend
- Create `renderer/stores/` (or state management)
- Connect queue state to UI
- Show current queue in a sidebar panel
- **Milestone:** Search → add to queue → play → next → previous → repeat all works

**Exit Criteria for Phase 3:**
- [ ] SQLite database created and migrated
- [ ] Queue persists across app restarts
- [ ] Repeat modes (none/all/one) work correctly
- [ ] Shuffle toggles queue order
- [ ] Playlists can be created, renamed, deleted
- [ ] Tracks can be added/removed from playlists
- [ ] Queue is visible and reorderable

---

### Phase 4: The High-Fidelity "Vibe" Pass (UI Phase)

**Goal:** Turn the ugly prototype into a gorgeous, glassmorphic desktop masterpiece.

Now that the app fully functions under the hood, you get to do the pure vibe-coding frontend work. This is the most satisfying phase.

#### Step 4.1: Frameless Window & Sidebar Layout
- Configure Electron for frameless window:
  - `BrowserWindow({ titleBarStyle: 'hidden', ... })`
  - Enable `vibrancy: 'under-window'` for macOS
- Implement the layout from the spec:
  - Sidebar on the left (search, library nav, playlists)
  - Now Playing view in the center
  - Queue drawer (slides in from right)

#### Step 4.2: Glassmorphism Styling
- Set up Tailwind CSS with custom theme
- Apply glassmorphism utilities:
  ```css
  backdrop-blur-md bg-white/10 border border-white/20
  ```
- Dynamic album art background:
  - Take current track's thumbnail
  - Apply heavy Gaussian blur
  - Set as absolute background of app wrapper
  - Creates ambient glow effect
- Color palette: dark base, translucent panels, accent from album art

#### Step 4.3: Custom Playback Controls
- Build custom progress slider (seekable, shows buffered)
- Volume slider with mute toggle
- Play/Pause, Next, Previous icons (use Lucide React or Phosphor Icons)
- Animated transitions between states (play ↔ pause morph)

#### Step 4.4: Search & Library UI
- Search results as a polished list (hover states, selection feedback)
- Library sidebar: Songs, Playlists, Queue with item counts
- Playlist detail view with track list
- Add-to-playlist modal/dropdown

#### Step 4.5: Now Playing Polish
- Large album art with subtle float animation
- Track title + artist with proper typography hierarchy
- Glassmorphism controls overlay
- Progress bar with time indicators
- **Milestone:** The app looks like a shipped product

**Exit Criteria for Phase 4:**
- [ ] Frameless window with proper title bar controls
- [ ] Glassmorphism panels throughout
- [ ] Dynamic album art background with blur
- [ ] Custom playback controls (not native HTML)
- [ ] Search results polished
- [ ] Library views styled
- [ ] Now Playing view looks premium

---

### Phase 5: System Trim & Packaging (Polish Phase)

**Goal:** Make it feel like a native app and bundle it into an installer.

#### Step 5.1: Operating System Integration
- Hook into MediaSession API:
  ```typescript
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    artwork: [{ src: track.thumbnail }]
  });
  ```
- Ensure keyboard Play/Pause/Skip keys work when app is focused
- Verify OS media notification overlay shows track info

#### Step 5.2: Spotify Importer
- Build the input field (paste Spotify playlist URL)
- Spotify URL parser: extract playlist ID from URL
- Spotify API (or web scraping) to get track names
- Loop through track names → search Innertube → best match → save to SQLite playlist
- Show progress indicator during import
- Handle failures gracefully (skip unmatched tracks)

#### Step 5.3: Tray Icon
- Create tray icon (16x16, 22x22, 32x32 variants)
- Right-click menu: Play/Pause, Next, Previous, Show Window, Quit
- Click to show/hide window
- Window hides to tray instead of closing

#### Step 5.4: Production Build
- Configure `electron-builder.yml`:
  ```yaml
  appId: com.yourapp.music
  productName: Music App
  mac:
    target: dmg
    artifactName: ${productName}-${version}.dmg
  win:
    target: nsis
    artifactName: ${productName}-${version}.exe
  ```
- Configure `electron-updater` for auto-update
- Set up GitHub Releases workflow
- **Milestone:** DMG and EXE installers work, auto-update checks for new versions

#### Step 5.5: Final Polish
- App icon (macOS .icns, Windows .ico)
- Splash screen (optional)
- Error handling: graceful failures for network issues, yt-dlp not found
- Logging: write logs to disk for debugging

**Exit Criteria for Phase 5:**
- [ ] Media keys work
- [ ] OS media overlay shows track info
- [ ] Spotify playlist import works
- [ ] Tray icon with menu
- [ ] DMG builds and installs on macOS
- [ ] EXE builds and installs on Windows
- [ ] Auto-update checks GitHub Releases

---

### Summary: What You Build in Each Phase

| Phase | Output | Vibe-Coding Focus |
|-------|--------|-------------------|
| **1: Core** | Audio plays from hardcoded ID | Backend plumbing, no UI |
| **2: Search** | Search + click to play | IPC + minimal UI |
| **3: Brain** | Queue, repeat, playlists | State machine + SQLite |
| **4: UI** | Glassmorphism desktop app | Pure frontend vibe |
| **5: Polish** | Native-feeling packaged app | System integration + packaging |

### Where to Start Right Now

Boot up your terminal, create your project folder, install Electron, and hand Phase 1 to your AI companion.

**Decision needed:** Frontend framework for the renderer:
- **React** — most AI training data, easiest to vibe-code
- **Vue** — simpler mental model, good DX
- **Vanilla TS** — ultra-lightweight, no framework overhead

Recommendation: **React** — AI models have the most examples for React + Electron combinations.

---

## 13. Open Questions

| Question | Status |
|----------|--------|
| App name | TBD (current placeholder is fine for development) |
| App icon | TBD |
| macOS code signing | TBD (needs Apple Developer account) |
| Windows code signing | TBD |
| GitHub repository name | TBD |
| Frontend framework | React (recommended), Vue, or Vanilla TS |
