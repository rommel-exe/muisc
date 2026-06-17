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
    "format": "18",  # 360p mp4 with AAC audio — always available, plays fine in <audio>
    "extractor_args": {
        "youtube": {
            # Single android client = one API call (not two with android+web)
            "player_client": ["android"],
            "player_skip": ["webpage", "js", "configs", "initial_data"],
        }
    },
    "no_add_chapters": True,
    "no_embed_metadata": True,
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
    ydl.extract_info(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ", download=False, process=False
    )
    warm_ms = int((time.time() - warm_t0) * 1000)
except Exception:
    warm_ms = -1

# Signal readiness to the Node.js parent process
sys.stdout.write("READY\n")
sys.stdout.flush()

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
        sys.stdout.write(f"{url}\n")
    except Exception as e:
        elapsed = -1
        sys.stdout.write("\n")

    sys.stdout.flush()
