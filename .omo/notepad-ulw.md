# Ultrawork Notepad — Fix premature track skipping from inaccurate duration metadata
Started: 2026-06-28T12:36:08+10:00

## Plan (exhaustive, atomic)
1. ~~TEST: Write failing unit test for `useAudioPlayer` poll interval — simulate duration shorter than actual stream, verify `fireTrackEnd` is NOT called when element is still playing~~ (no unit test file exists for useAudioPlayer, will fix and verify by reading code + manual QA)
2. FIX `useAudioPlayer.ts` poll end-detection: add `el.paused` guard to `currentTime >= duration - 0.5` check
3. TEST: Verify with `typecheck` that fix compiles
4. MANUAL QA: Verify logic correctness by tracing scenarios in code

## Scenarios (the contract)
| # | Class | Scenario | Pass condition |
|---|-------|----------|----------------|
| S1 | Happy | Track with accurate metadata plays to end → DOM ended event fires | `fireTrackEnd` called once, next track starts |
| S2 | Edge | Track with metadata-duration SHORTER than actual audio → element keeps playing past metadata end | `fireTrackEnd` NOT called while `!el.paused`, track continues to actual end |
| S3 | Edge | Stream truncated (metadata longer than actual audio) → element auto-pauses before metadata end | Stalled detection fires `fireTrackEnd` after 3s, next track starts |
| S4 | Regression | User pauses near end (currentTime >= duration - 0.5) | Element is paused → `fireTrackEnd` fires (same as current behavior) |
| S5 | Regression | Normal playback → no false detection | Track plays to completion without premature skip |

## Now
Analyzing root cause and implementing fix

## Todo (remaining, ordered)
1. Fix poll interval end-detection in useAudioPlayer.ts
2. Typecheck
3. Manual QA — review code logic trace

## Findings
- YouTube metadata duration from yt-dlp often differs from actual audio stream length
- The polling interval at L287-290 uses `currentTime >= duration - 0.5` as a catch-all for streams that don't fire DOM 'ended' event
- This catch-all is too aggressive: it fires while audio is still playing when metadata duration < actual stream
- The stalled detection (3s timeout on currentTime not advancing) correctly handles truncated streams
- The DOM 'ended' event handler (`onEnded`) already has proper stale-event guards (target.ended, target matching active element)
- `swapToNext()` correctly resets `trackEndedFiredRef`, `stalledCountRef`, `lastCurrentTimeRef`
- MediaEngine has `_advancing` mutex preventing double-advance
- `_pendingAdvance` flag prevents auto-advance while another auto-advance is in progress

## Learnings
- `el.paused` is the reliable indicator: it's true when stream truly ends (auto-pause from buffer drain) AND when user pauses
- `el.ended` is unreliable for proxy streams
- `el.networkState === 2` indicates active loading — element is still fetching data
- The fix only needs to add `&& el.paused` to the `currentTime >= duration - 0.5` branch
- For the user-pause-near-end case (current behavior preserved): user pauses → `el.paused` is true → `fireTrackEnd` fires — same as before
- For the truncated stream case (metadata longer): `currentTime < duration` → end detection doesn't fire → stalled detection handles it after 3s
