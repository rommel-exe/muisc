#!/usr/bin/env python3
"""yt-dlp daemon for muisc Electron music player.

Receives video IDs on stdin (one per line), returns stream URLs
on stdout (one per line, first line is "READY" after initialization).

Keeps the Python process alive so yt-dlp module imports are only
paid once — the critical optimization for cold playback <2s.

Usage (muisc spawns this automatically):
  echo "dQw4w9WgXcQ" | python3 scripts/yt-dlp-daemon.py
"""

import sys
import os
import time

# Suppress update check noise
os.environ["YTDLP_NO_UPDATE_CHECK"] = "1"

from yt_dlp import YoutubeDL

YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "no_check_certificate": True,
    # ⚡ Format filter: extract the LOWEST bitrate format for fastest
    # CDN buffering. DASH/HLS manifests are skipped, so audio-only formats
    # (which only exist in DASH manifests) aren't available — worstaudio
    # would always fall back to worst. Use 'worst' directly to avoid the
    # wasted audio-only search overhead (~50-100ms).
    "format": "worst",
    "extractor_args": {
        "youtube": {
            "player_client": ["android", "web"],
            # ⚡ Skip expensive network requests: webpage fetch, JS download,
            # configs, and initial webpage data. Configs fetch adds ~1500ms
            # overhead per extraction without preventing session expiry.
            # Session expiry is handled by extractor_retries=5 + session refresh.
            "player_skip": ["webpage", "js", "configs", "initial_data"],
        }
    },
    "no_add_chapters": True,
    "no_embed_metadata": True,
    # ⚡ Skip DASH/HLS manifest parsing — these are large (100KB+) XML manifests
    # that list all available video/audio qualities. We use format selection
    # (bestaudio/best) which doesn't need the full manifest, just the player
    # response's url field. Skipping cuts extraction time by ~30-50%.
    "youtube_include_dash_manifest": False,
    "youtube_include_hls_manifest": False,
    # Enable yt-dlp's disk cache — caches player responses per YouTube session.
    # Reduces repeat extractions from ~450ms to ~50ms.
    "cachedir": os.path.expanduser("~/.cache/yt-dlp-daemon"),
    # 🔄 Auto-retry extraction up to 5 times with fresh visitor data when
    # YouTube returns "page needs to be reloaded" (session token expired).
    # Each retry uses a different client identifier to bypass rate-limiting.
    "extractor_retries": 5,
}

ydl = YoutubeDL(YDL_OPTS)

# 🌐 Pre-warm the YouTube API connection pool by making a process=False
# extraction request. This makes the YouTube API call(s) to establish the
# TCP + TLS connection and warm the HTTP connection pool — WITHOUT resolving
# any stream URL (no format selection, no URL extraction).
#
# The API call goes to the same youtubei endpoint that real extractions use,
# so the connection pool (managed by yt-dlp's internal RequestsRH) is shared.
# Connection reuse drops extraction time from ~737ms to ~246ms.
#
# The result is discarded. This is NOT pre-resolving user data.
try:
    warm_t0 = time.time()
    # process=False skips format URL extraction but still makes the YouTube API
    # call, establishing the HTTP connection pool. Use a different video from the
    # default queue so process=False doesn't poison any cache for user queries.
    # dQw4w9WgXcQ used to be here — using a different ID to avoid cache conflicts.
    ydl.extract_info(
        "https://www.youtube.com/watch?v=jNQXAC9IVRw", download=False, process=False
    )
    warm_ms = int((time.time() - warm_t0) * 1000)
except Exception as exc:
    warm_ms = -1
    print(f"WARMUP_ERROR: {exc}", file=sys.stderr, flush=True)

# Signal readiness to the Node.js parent process
sys.stdout.write("READY\n")
sys.stdout.flush()

# 🔄 Session refresh counter — do a lightweight warmup every N successful
# extractions to prevent YouTube session token expiry.
# YouTube's player response session token expires after ~20-30 requests
# (manifesting as "The page needs to be reloaded" errors from yt-dlp).
# A periodic process=False extraction refreshes the session without resolving
# any stream URL (non-blocking, fire-and-forget).
# 🔧 With extractor_retries=5, even when refresh misses, yt-dlp auto-retries
# with fresh visitor data. Set refresh every 5 to stay well ahead of expiry.
SESSION_REFRESH_INTERVAL = 5
request_count = 0

for line in sys.stdin:
    video_id = line.strip()
    if not video_id:
        continue

    try:
        t0 = time.time()
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
        t1 = time.time()
        url = info.get("url", "")
        if not url and info.get("formats"):
            for f in info["formats"]:
                if f.get("url"):
                    url = f["url"]
                    break
        elapsed = int((t1 - t0) * 1000)
        print(f"RESOLVE_DETAIL:{video_id} extract={elapsed}ms url_len={len(url)} warm_ms={warm_ms}", file=sys.stderr, flush=True)
        sys.stdout.write(f"{url}\n")

        # 🔄 Periodic session refresh — after every SESSION_REFRESH_INTERVAL
        # successful requests, do a lightweight process=False extraction to
        # refresh the YouTube session token. This prevents the daemon's
        # session from expiring (which causes "page needs to be reloaded" errors
        # and 5000-8000ms fallback overhead).
        request_count += 1
        if request_count >= SESSION_REFRESH_INTERVAL:
            request_count = 0
            try:
                ydl.extract_info(
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    download=False, process=False
                )
            except Exception:
                pass  # Refresh is best-effort; don't fail the request
    except Exception as e:
        elapsed = -1
        print(f"RESOLVE_ERROR:{video_id} {e}", file=sys.stderr, flush=True)
        sys.stdout.write("\n")

    sys.stdout.flush()
