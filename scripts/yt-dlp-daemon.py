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
            "player_client": ["android,web"],
            "player_skip": ["webpage", "js", "configs", "initial_data"],
        }
    },
    "no_add_chapters": True,
    "no_embed_metadata": True,
}

ydl = YoutubeDL(YDL_OPTS)

# Signal readiness to the Node.js parent process
sys.stdout.write("READY\n")
sys.stdout.flush()

for line in sys.stdin:
    video_id = line.strip()
    if not video_id:
        continue

    try:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
        url = info.get("url", "")
        if not url and info.get("formats"):
            for f in info["formats"]:
                if f.get("url"):
                    url = f["url"]
                    break
        sys.stdout.write(url + "\n")
    except Exception:
        # Empty line signals error to the caller
        sys.stdout.write("\n")

    sys.stdout.flush()
