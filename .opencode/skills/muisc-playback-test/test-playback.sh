#!/usr/bin/env bash
# muisc Playback Timing Test — automated via agent-browser
#
# Usage: bash .opencode/skills/muisc-playback-test/test-playback.sh
# Prerequisites: app running with `npm run dev`, agent-browser installed
#
# Tests:
#   1. Cold playback (first click, no cache)
#   2. Prefetched queue track (background preloader)
#   3. Warm playback (cache hit)
#   4. Far queue track (cold, outside preload window)

set -euo pipefail

echo ""
echo "═══════════════════════════════════════"
echo "  muisc Playback Timing Test"
echo "═══════════════════════════════════════"
echo ""

# Connect to the running Electron app
echo "--- Connecting to app ---"
agent-browser connect 9222
agent-browser snapshot -i
echo ""

# --- B2: Cold Playback ---
echo "───────────────────────────────────────"
echo "  B2: COLD PLAYBACK (Track 1)"
echo "───────────────────────────────────────"
agent-browser click @e3
agent-browser wait 8000
echo "--- Timing ---"
agent-browser get text @e1 | tail -10
echo ""

# --- B4: Prefetched Queue Track ---
echo "───────────────────────────────────────"
echo "  B4: PREFETCHED TRACK (Track 2)"
echo "───────────────────────────────────────"
agent-browser click @e4
agent-browser wait 5000
echo "--- Timing ---"
agent-browser get text @e1 | tail -10
echo ""

# --- B3: Warm Cached Track ---
echo "───────────────────────────────────────"
echo "  B3: WARM CACHED (Track 1 again)"
echo "───────────────────────────────────────"
agent-browser click @e3
agent-browser wait 3000
echo "--- Timing ---"
agent-browser get text @e1 | tail -10
echo ""

# --- B4: Far Queue Cold Track ---
echo "───────────────────────────────────────"
echo "  B4: FAR QUEUE COLD (Track 10)"
echo "───────────────────────────────────────"
agent-browser click @e12
agent-browser wait 12000
echo "--- Timing ---"
agent-browser get text @e1 | tail -10
echo ""

echo "═══════════════════════════════════════"
echo "  TEST COMPLETE"
echo "═══════════════════════════════════════"
