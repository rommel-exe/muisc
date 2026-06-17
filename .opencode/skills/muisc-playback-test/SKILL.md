---
name: muisc-playback-test
description: End-to-end playback testing for the muisc Electron music player. Use when the user wants to test how long it takes to play a track, verify the instant-return proxy pipeline, measure cold/warm/prefetched playback latency, or automate playback QA via agent-browser. Covers both CLI pipeline tests and Electron GUI browser automation.
---

# muisc Playback Test

End-to-end playback timing test for the muisc Electron music player.

## Architecture Overview

The app uses an **instant-return proxy** strategy:

```
resolve() returns proxy URL immediately (<50ms)  →  audio loads proxy URL
                                                         ↓
proxy blocks until yt-dlp finishes extracting stream URL  →  pipes CDN audio
```

The frontend logs per-segment timing to an on-screen console:

```
[time] resolve: 35ms — Loading...
[time] load: 1ms
[time] play: 4477ms  |  TOTAL: 4513ms
```

### Segments

| Segment | Measures |
|---------|----------|
| **resolve** | IPC call to main process — returns proxy URL instantly (cached or placeholder) |
| **load** | `HTMLAudioElement.load()` call (triggers proxy connection) |
| **play** | `HTMLAudioElement.play()` resolves when audio actually starts — **the real cost** |
| **TOTAL** | resolve + load + play |

## Prerequisites

```bash
# agent-browser for GUI automation
npm i -g agent-browser && agent-browser install

# yt-dlp for stream extraction
pip install yt-dlp

# muisc app dev server running
cd /path/to/muisc && npm run dev
```

The app opens with remote debugging on port 9222 (configured in `electron.vite.config.ts`).

---

## Test Suite

### A. Pipeline Smoke Test (CLI, no GUI)

Quick backend verification — runs yt-dlp extraction + cache directly, no Electron window:

```bash
npx tsx src/main/__tests__/test-pipeline.ts
npx tsx src/main/__tests__/verify-pipeline.ts
```

These run the resolver pipeline in Node.js and log all timing. Requires yt-dlp on PATH.

### B. GUI Playback Timing via agent-browser

Full end-to-end test through the Electron renderer.

#### B1. Setup — connect to the app

```bash
# The app should already be running via `npm run dev`.
# Connect agent-browser to its CDP port:
agent-browser connect 9222

# Verify the connection and see the UI:
agent-browser snapshot -i
```

Expected output — app title "muisc test" with a queue of 10 tracks, each with a ▶ button, and transport controls (◀ ⏸ ▶) below.

#### B2. Cold Playback Test

Measures the first-ever click on a track (no cache, yt-dlp must run cold).

```bash
# Click the first track's play button
agent-browser click @e3

# Wait for audio to start playing (yt-dlp takes ~4-15s first time)
agent-browser wait 8000

# Read the timing log at the bottom of the page
agent-browser get text @e1

# The last lines of the log show the three timing segments
```

**Expected cold timing:**
| Segment | Typical | Notes |
|---------|---------|-------|
| resolve | < 50ms | Instant-return proxy — returns "Loading..." placeholder |
| load | 0-2ms | Audio element triggers proxy connection |
| play | 4,000-15,000ms | Proxy blocks waiting for yt-dlp extraction |
| TOTAL | 4,000-15,000ms | User-perceived "time to first audio" on first click |

**Acceptance:** TOTAL < 15,000ms for a cold click.

#### B3. Warm Playback Test

Re-click the same track after it finished resolving (cache hit).

```bash
# The track should now be playing. Click pause, then re-click play.
# Or click the same track button again.
agent-browser click @e3
agent-browser wait 3000
agent-browser get text @e1
```

**Expected warm timing:**
| Segment | Typical | Notes |
|---------|---------|-------|
| resolve | < 30ms | Returns cached metadata (actual title, not "Loading...") |
| load | 0-20ms | |
| play | 100-400ms | Stream URL cached in proxy — immediately pipes CDN stream |
| TOTAL | 100-500ms | **~40x faster than cold** |

**Acceptance:** TOTAL < 1,000ms for a warm (cached) click.

#### B4. Prefetched Queue Test

Navigate to a track that was pre-resolved by the background preloader.

After Track 1 starts playing, the app calls `prefetchQueue()` which resolves the next 2-3 tracks in the background. Test this by clicking Track 2 or 3 after Track 1 resolves:

```bash
# After cold-playing Track 1 (wait for it to actually play, ~8s):
# Click Track 2 (Luis Fonsi — Despacito)
agent-browser click @e4
agent-browser wait 4000
agent-browser get text @e1
```

**Expected prefetched timing:**
| Segment | Typical | Notes |
|---------|---------|-------|
| resolve | < 5ms | Metadata already cached by background preloader |
| load | 0-5ms | |
| play | 200-600ms | Stream URL already cached from background yt-dlp |
| TOTAL | 200-600ms | **Near-instant — preloader did the heavy lifting** |

**Acceptance:** TOTAL < 1,500ms (should be in the low hundreds).

To test the *cold case* (track outside preload window, e.g. Track 10 — "The Chainsmokers — Closer"), click it directly:

```bash
agent-browser click @e12
agent-browser wait 12000
agent-browser get text @e1
```

Expected: TOTAL ~4,500-6,500ms (cold yt-dlp for that track).

---

## Test Script (for reuse)

Save as `.opencode/skills/muisc-playback-test/test-playback.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== muisc Playback Timing Test ==="
echo ""

# Connect
agent-browser connect 9222

# --- Cold test ---
echo "--- B2: Cold Playback ---"
agent-browser click @e3
agent-browser wait 8000
agent-browser get text @e1 | tail -5
echo ""

# --- Prefetched test ---
echo "--- B4: Prefetched Queue Track ---"
agent-browser click @e4
agent-browser wait 5000
agent-browser get text @e1 | tail -5
echo ""

# --- Warm test ---
echo "--- B3: Warm Cached Track ---"
agent-browser click @e3
agent-browser wait 3000
agent-browser get text @e1 | tail -5
echo ""

# --- Far queue (cold) test ---
echo "--- B4: Far Queue Track (Cold) ---"
agent-browser click @e12
agent-browser wait 12000
agent-browser get text @e1 | tail -5
echo ""

echo "=== Done ==="
```

---

## Result Interpretation

### Reading the log

When you extract text, look for the most recent lines:

```
[7:12:25 PM] resolve: 35ms — Loading...    ← placeholder title (not cached yet)
[7:12:25 PM] load: 1ms                      ← trivial
[7:12:30 PM] play: 4477ms  |  TOTAL: 4513ms  ← yt-dlp extracted + streamed
```

A later warm retry shows:

```
[7:38:24 PM] resolve: 26ms — Rick Astley...  ← actual title (cached metadata)
[7:38:24 PM] load: 15ms
[7:38:24 PM] play: 182ms  |  TOTAL: 223ms     ← stream was cached
```

### Key indicators

| Log Sign | Meaning |
|----------|---------|
| `resolve: <50ms — Loading...` | Cache miss — yt-dlp will run in background |
| `resolve: <50ms — Real Title` | Cache hit — metadata already resolved |
| `play: >2000ms` | Cold yt-dlp extraction (normal for first click) |
| `play: <500ms` | Cache hit — stream URL was already resolved |
| `TOTAL: <500ms` | Warm/prefetched — excellent UX |
| `TOTAL: >5000ms` | Cold — acceptable but room for improvement |

---

## Edge Case Tests

### 403 Recovery (Stale CDN URL)

YouTube CDN stream URLs expire after ~6 hours. The proxy handles 403/410 by
re-resolving and retrying transparently.

Test via the debug API injected into the renderer:

```bash
# Corrupt the cache for a track that's already cached
# This triggers a 403 on next request
agent-browser eval "window.api.testCorruptCache('dQw4w9WgXcQ')"

# Now click the track — should recover and play
agent-browser click @e3
agent-browser wait 10000
agent-browser get text @e1
```

Expected: The proxy logs "CDN returned 403, re-resolving..." in stdout,
then falls through to a fresh yt-dlp resolve and audio plays normally.

### Skip Spam (Rapid Clicks)

The frontend uses `latestReq` ref to discard stale resolves.
Test by clicking multiple tracks rapidly:

```bash
agent-browser click @e3
agent-browser click @e4
agent-browser click @e5
agent-browser wait 8000
agent-browser get text @e1
```

Expected: Only the last clicked track (e5) should show final timing.
The earlier tracks' timings are discarded by the `if (latestReq.current !== idx) return` guards.

### Pending Count Verification

Check if yt-dlp processes are properly cleaned up:

```bash
agent-browser eval "await window.api.testPendingCount()"
```

Expected after all resolves complete: `0`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Connection refused` on port 9222 | App not running or no `--remote-debugging-port` flag | Start with `npm run dev`, verify flag in process args |
| `▶` buttons not clickable | Wrong element ref | Re-snapshot: `agent-browser snapshot -i` to get current refs |
| `Cannot connect` after app restart | Old process on the port | `kill $(lsof -ti :9222)` then restart |
| yt-dlp not found | Missing PATH or not installed | `which yt-dlp` and ensure on PATH |
| Audio never plays | VPN/network blocking YouTube | Disable VPN, check `curl` to YouTube works |
| `ERROR: Input is not a valid video ID` | Wrong track ID format | IDs are 11-char alphanumeric (YouTube standard) |
| Unexplained 502 from proxy | yt-dlp extraction failed | Check app stdout for yt-dlp error messages |
| Title shows "Loading..." forever | Background resolve failed | Check network, re-resolve by clicking again |
