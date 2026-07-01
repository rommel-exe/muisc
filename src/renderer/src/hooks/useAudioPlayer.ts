import { useRef, useState, useEffect, useCallback } from 'react'

export interface AudioPlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  error: string | null
  loading: boolean
  isNextReady: boolean
  nextUrl: string | null
  ended: boolean
}

export interface AudioPlayerControls {
  /** Load and play a URL in the active element */
  loadAndPlay: (url: string) => Promise<void>
  /** Preload a URL into the INACTIVE (standby) element */
  preloadNext: (url: string) => void
  /** Swap active/standby and play the preloaded element. Returns false if nothing loaded */
  swapToNext: () => Promise<boolean>
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  /** Register a callback fired directly from the DOM ended event (not through React state) */
  setOnTrackEnd: (cb: () => void) => void
  /** Register a callback fired from the DOM error event for mid-playback errors */
  setOnError(cb: (() => void) | null): void
  /** Return the current audio error message, if any */
  getError: () => string | null
  /** Abort any pending play() on the active element by clearing its src.
   *  The pending play() promise rejects with AbortError (caught silently by
   *  loadAndPlay), allowing the caller to proceed without hanging. */
  cancelPendingPlay: () => void
}

const INITIAL_VOLUME = 0.8

/**
 * Dual-element audio player.
 *
 * Two <audio> elements: one is ACTIVE (playing), one is STANDBY (preloading next).
 * On transition, they swap roles — the preloaded element becomes active instantly.
 */
export function useAudioPlayer(): [AudioPlayerState, AudioPlayerControls] {
  const elA = useRef<HTMLAudioElement | null>(null)
  const elB = useRef<HTMLAudioElement | null>(null)
  const activeIsA = useRef(true) // true = elA is active, false = elB is active
  /** Ref-based callback fired directly from the DOM ended event — no React state round-trip */
  const onTrackEndRef = useRef<(() => void) | null>(null)
  /** Guard ref to prevent duplicate track-end triggers (both ended event + polling fallback) */
  const trackEndedFiredRef = useRef(false)
  /** Per-track poll state refs. Reset on every track change to prevent stale
   *  values from the previous track causing false stall detection on the new
   *  track (e.g. lastCurrentTime from the old track making the diff check
   *  appear normal when the new track hasn't started advancing yet). */
  const lastCurrentTimeRef = useRef(0)
  const stalledCountRef = useRef(0)
  /** Ref to latest error so memoized getError() always returns current value */
  const errorRef = useRef<string | null>(null)
  /** Ref-based callback fired from the DOM error event — notifies MediaEngine
   *  of mid-playback errors so it can retry with a fresh CDN URL. */
  const onErrorRef = useRef<(() => void) | null>(null)

  /** Distinguishes user-initiated pause from buffer-drain auto-pause.
   *  Set true by the pause() control; cleared by onPlay (user pressed play
   *  or a new track started). When the poll interval sees el.paused but this
   *  flag is false, it means the element paused itself (buffer drained) —
   *  treat as a stall and fire auto-advance. */
  const userPausedRef = useRef(false)

  const [state, setState] = useState<AudioPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: INITIAL_VOLUME,
    error: null,
    loading: false,
    isNextReady: false,
    nextUrl: null,
    ended: false,
  })

  // ── Create both elements on mount ──

  useEffect(() => {
    const a = new Audio()
    a.preload = 'auto'
    a.style.display = 'none'
    a.volume = INITIAL_VOLUME
    document.body.appendChild(a)
    elA.current = a

    const b = new Audio()
    b.preload = 'auto'
    b.style.display = 'none'
    b.volume = INITIAL_VOLUME
    document.body.appendChild(b)
    elB.current = b

    // Shared state updater
    const onTimeUpdate = () => {
      const el = activeIsA.current ? elA.current : elB.current
      if (el) setState((prev) => ({ ...prev, currentTime: el.currentTime }))
    }
    const onLoadedMetadata = () => {
      const el = activeIsA.current ? elA.current : elB.current
      if (el) setState((prev) => ({ ...prev, duration: el.duration, loading: false }))
    }
    const onPlay = () => {
      userPausedRef.current = false
      setState((prev) => ({ ...prev, isPlaying: true }))
    }
    const onPause = () => setState((prev) => ({ ...prev, isPlaying: false }))
    const onError = (e: Event) => {
      // 🔥 Use the element that ACTUALLY fired the event (e.target),
      // not the current active element (activeIsA.current). After an
      // instant swap (swapToNext toggles activeIsA), the old active
      // element now has standby status but may still fire pending
      // error events. The old code checked activeIsA.current which
      // points to the NEW active element (no error) — suppressing
      // real errors and leaving the UI in a stale 'playing' state.
      const target = e.target as HTMLAudioElement
      const mediaError = target?.error
      // ⚠️ mediaError can be null even when the 'error' event fires.
      // This happens when a previous load failed, the 'error' event
      // was queued in the event loop, but by the time this handler
      // runs, a new src was set (clearing the element's error state).
      // In that case target.error is null — the error is stale, ignore it.
      // Check if the element still has a src to distinguish stale events
      // from cross-swap errors (where target has a non-empty src but
      // target.error is transiently null).
      if (!mediaError) {
        if (!target.src || target.src === '' || target.src === window.location.href) {
          console.warn(`[audio] onError suppressed — element was reloaded (src=${target?.src?.substring(0, 60)})`)
          return
        }
        // Element has a non-empty src but no error? This can happen when
        // the error event fired on a swapped-out element whose src was
        // NOT cleared (the swap cleared the OLD active, but the standby
        // that received the error still has its src). Fall through to
        // check both elements for any real error.
        console.warn(`[audio] onError on target with src but no error — checking both elements`)
      }
      // Try the target element's error first, then fall back to active
      let realError = mediaError
      if (!realError) {
        const active = activeIsA.current ? elA.current : elB.current
        realError = active?.error ?? null
      }
      if (!realError) {
        console.warn(`[audio] onError — no error on target or active, suppressing`)
        return
      }
      let msg = realError?.message
      if (!msg && realError?.code) {
        const codes: Record<number, string> = {
          1: 'Playback aborted',
          2: 'Network error loading audio',
          3: 'Audio decode error',
          4: 'Audio format not supported',
        }
        msg = codes[realError.code] ?? `Unknown audio error (code=${realError.code})`
        console.warn(`[audio] onError code=${realError.code} target=${target?.src?.substring(0,60)}`)
      }
      msg ??= `Unknown audio error (code=${realError?.code ?? 'none'})`
      errorRef.current = msg
      setState((prev) => ({ ...prev, error: msg, loading: false, isPlaying: false }))
      // Notify MediaEngine of mid-playback error so it can retry with a fresh CDN URL
      onErrorRef.current?.()
    }
    const fireTrackEnd = (source: string) => {
      if (trackEndedFiredRef.current) return
      console.warn(`[audio] fireTrackEnd: ${source}`)
      trackEndedFiredRef.current = true
      lastCurrentTimeRef.current = 0
      stalledCountRef.current = 0
      setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, ended: true }))
      onTrackEndRef.current?.()
    }

    const onEnded = (e: Event) => {
      // 🔥 Stale ended event detection — two checks:
      // 1. Element mismatch: swapToNext clears the old active element and
      //    starts a new track. The browser may have queued an 'ended' event
      //    for the old element. By the time this callback runs,
      //    trackEndedFiredRef has already been reset for the new track, so
      //    the ref guard doesn't catch it. Check the event target against
      //    the current active element — if a swapped-out element fired
      //    ended, ignore it.
      // 2. State mismatch: loadAndPlay reuses the same element — the
      //    browser queues 'ended', then loadAndPlay calls el.load() which
      //    resets ended to false. When the callback fires, the element is
      //    no longer in an ended state. Check target.ended — if the
      //    element was reloaded (new src), ended is false.
      const target = e.target as HTMLAudioElement
      if (!target.ended) return
      const active = getActive()
      if (target !== active) return
      fireTrackEnd('dom-ended')
    }
    const onWaiting = () => setState((prev) => ({ ...prev, loading: true }))
    const onCanPlay = () => setState((prev) => ({ ...prev, loading: false }))

    // ⚠️ Standby-only events: canplaythrough/loadstart must only fire on the
    // element that is currently the standby. If we add them to both elements,
    // the active element's canplaythrough incorrectly sets isNextReady=true.
    //
    // Solution: verify the event originates from the current standby element
    // by checking which ref it corresponds to before updating isNextReady.
    const onStandbyCanPlay = () => {
      const standby = activeIsA.current ? elB.current : elA.current
      // Only report standby-ready if the standby element actually has content loaded
      // (readyState >= HAVE_FUTURE_DATA = 3). The active element's canplaythrough
      // will NOT match since the standby has no src or is in loading state.
      if (standby?.readyState && standby.readyState >= 3) {
        // Double-check: if the active also reports readyState >= 3, verify
        // it's truly the standby by checking the standby has a non-empty src
        if (standby.src && standby.src.length > 0) {
          setState((prev) => ({ ...prev, isNextReady: true }))
        }
      }
    }
    const onStandbyLoadStart = (ev: Event) => {
      // Only mark next-track-not-ready if the standby element itself is
      // loading. When the active element fires loadstart (e.g. seeking or
      // rebuffering), the standby's preloaded content is still ready.
      const target = ev.target as HTMLAudioElement
      const standby = activeIsA.current ? elB.current : elA.current
      if (target === standby) {
        setState((prev) => ({ ...prev, isNextReady: false }))
      }
    }

    for (const el of [a, b]) {
      el.addEventListener('timeupdate', onTimeUpdate)
      el.addEventListener('loadedmetadata', onLoadedMetadata)
      el.addEventListener('play', onPlay)
      el.addEventListener('pause', onPause)
      el.addEventListener('error', onError)
      el.addEventListener('ended', onEnded)
      el.addEventListener('waiting', onWaiting)
      el.addEventListener('canplay', onCanPlay)
      el.addEventListener('canplaythrough', onStandbyCanPlay)
      el.addEventListener('loadstart', onStandbyLoadStart)
    }

    // ── Polling fallback: detect track end via currentTime/duration ──
    // YouTube proxy streams often don't fire the DOM ended event.
    // Check every 500ms if the active element has reached its end.
    // Uses refs (not local vars) so loadAndPlay/swapToNext can reset
    // poll state on track change, preventing false stall detection.
    const pollEnded = setInterval(() => {
      const el = activeIsA.current ? elA.current : elB.current
      if (!el || el.duration <= 0 || el.currentTime <= 0) {
        // Element not ready — still counts toward stall detection reset
        // so a buffering new track doesn't inherit a stale count.
        lastCurrentTimeRef.current = 0
        stalledCountRef.current = 0
        return
      }

      // 🔥 Stalled playback detection: if audio has been playing but
      // currentTime hasn't advanced for 5s AND we're not near the end,
      // the CDN stream was truncated — the audio buffer ran out but
      // the element never fired 'ended' because its duration metadata
      // is longer than the actual data received.
      // Without this, truncated songs just hang silently forever.
      //
      // ⚠️ Also handles auto-paused elements: when the CDN stream ends
      // mid-track, the audio buffer drains and the browser sets el.paused
      // to true. Without detection here, the track hangs silently forever.
      // The userPausedRef distinguishes user-initiated pause from buffer
      // drain — only the latter triggers auto-advance.
      //
      // ⚠️ Run stalled detection for the entire track lifetime. The 5s
      // counter (10 polls × 500ms) for playing and 7s (14 polls) for
      // auto-pause provides better protection against false positives
      // from brief CDN interruptions while still catching truncations.
      //
      // ⚠️ No networkState check in the !el.paused path! YouTube truncated
      // streams often stay in NETWORK_LOADING (2) forever — the element
      // keeps trying to fetch more data that will never arrive. Checking
      // networkState would bypass stall detection entirely. The 5s
      // threshold handles genuine buffering bursts.
      //
      // ⚠️ No near-end exclusion because metadata duration from yt-dlp can
      // be LONGER than the actual stream (proxy streams ending early).
      // Excluding near-end time would create a dead zone where neither
      // stalled detection nor end detection catches the completion.
      const STALL_TIMEOUT_PLAYING = 10   // 10 polls × 500ms = 5s
      const STALL_TIMEOUT_PAUSED  = 14   // 14 polls × 500ms = 7s
      if (!el.ended) {
        if (!el.paused) {
          const diff = Math.abs(el.currentTime - lastCurrentTimeRef.current)
          if (diff < 0.01) {
            if (++stalledCountRef.current >= STALL_TIMEOUT_PLAYING) {
              console.warn(`[audio] Playback stalled at ${el.currentTime.toFixed(1)}s/${el.duration.toFixed(1)}s, force ending`)
              fireTrackEnd('stalled')
              stalledCountRef.current = 0
              return
            }
          } else {
            stalledCountRef.current = 0
          }
          lastCurrentTimeRef.current = el.currentTime
        } else if (lastCurrentTimeRef.current > 0 && !el.ended && !userPausedRef.current) {
          // ⚠️ Element auto-paused mid-track (buffer drained, not user pause).
          // Use a longer threshold (7s) for auto-pause because temporary CDN
          // interruptions often manifest as browser-initiated pauses, not as
          // stalled time. The truncation case (stream truly ended) would still
          // trigger auto-advance after 7s of silence.
          if (++stalledCountRef.current >= STALL_TIMEOUT_PAUSED) {
            console.warn(`[audio] Buffer drained at ${el.currentTime.toFixed(1)}s/${el.duration.toFixed(1)}s, auto-advancing`)
            fireTrackEnd('buffer-drained')
            stalledCountRef.current = 0
            return
          }
        } else {
          // User paused or no playback history — reset stall counter
          stalledCountRef.current = 0
        }
      }

      // Use el.ended (set by the UA) as the primary end signal.
      // Fallback to currentTime >= duration ONLY when the element has
      // stopped playing (el.paused). YouTube metadata duration from yt-dlp
      // is often SHORTER than the actual audio stream — checking only
      // currentTime >= duration would cause tracks to be skipped mid-song
      // while the audio is still playing. The stalled detection above
      // handles the opposite case (metadata longer than actual stream).
      //
      // 🔥 Guard against false time-reached triggers: the metadata duration
      // can be WRONG (shorter than actual audio). If the element has
      // buffered data ahead of currentTime, the stream hasn't truly ended
      // — the pause is a temporary buffer hiccup, not an end condition.
      // Only fire time-reached if there's NO buffered data ahead.
      if (el.ended) {
        fireTrackEnd('dom-ended-poll')
      } else if (el.currentTime >= el.duration - 0.5 && el.paused && !userPausedRef.current) {
        // Double-check: if the element still has buffered data ahead,
        // the pause is temporary — don't auto-advance.
        let hasDataAhead = false
        try {
          if (el.buffered.length > 0) {
            const bufferedEnd = el.buffered.end(el.buffered.length - 1)
            if (bufferedEnd > el.currentTime + 1) hasDataAhead = true
          }
        } catch {
          // Cross-origin buffered access may throw — proceed without guard
        }
        if (!hasDataAhead) {
          fireTrackEnd('time-reached')
        }
      }
    }, 500)

    return () => {
      clearInterval(pollEnded)
      for (const el of [a, b]) {
        el.removeEventListener('timeupdate', onTimeUpdate)
        el.removeEventListener('loadedmetadata', onLoadedMetadata)
        el.removeEventListener('play', onPlay)
        el.removeEventListener('pause', onPause)
        el.removeEventListener('error', onError)
        el.removeEventListener('ended', onEnded)
        el.removeEventListener('waiting', onWaiting)
        el.removeEventListener('canplay', onCanPlay)
        el.removeEventListener('canplaythrough', onStandbyCanPlay)
        el.removeEventListener('loadstart', onStandbyLoadStart)
        el.pause()
        el.src = ''
        el.remove()
      }
      elA.current = null
      elB.current = null
    }
  }, [])

  // ── Helpers ──

  const getActive = (): HTMLAudioElement | null => activeIsA.current ? elA.current : elB.current
  const getStandby = (): HTMLAudioElement | null => activeIsA.current ? elB.current : elA.current

  // ── Controls ──

  /** Load a URL into the ACTIVE element and play. Used for initial / cold play. */
  const loadAndPlay = useCallback(async (url: string): Promise<void> => {
    const el = getActive()
    if (!el) return

    // ⚠️ Clear stale error from previous playback. errorRef is never
    // reset elsewhere — without this, a prior onError sets it to
    // "Unknown audio error" and every subsequent loadAndPlay that
    // resolves (including AbortError) inherits the stale error.
    errorRef.current = null

    // 🔥 Reset poll state so stall detection doesn't inherit stale
    // lastCurrentTime/stalledCount from the previous track. Without this,
    // a new track loading slowly could trigger false stall detection.
    lastCurrentTimeRef.current = 0
    stalledCountRef.current = 0

    // ⚠️ Reset user pause flag — if the user previously paused, a subsequent
    // track that buffer-drains (short stream) would suppress auto-advance
    // because the poll checks userPausedRef. A new loadAndPlay means a fresh
    // track — the user didn't pause this one.
    userPausedRef.current = false

    // Clear standby to avoid conflict
    const standby = getStandby()
    if (standby) { standby.pause(); standby.src = ''; standby.load() }

    trackEndedFiredRef.current = false
    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null, ended: false }))

    el.src = url
    el.load()

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    // Track the error listener so we can remove it after successful play.
    // Without cleanup, a mid-stream error event would call reject() on the
    // dangling errorOnLoad promise — an unhandled rejection.
    let onErrorListener: ((ev: Event) => void) | null = null
    try {
      // 🔥 If the element errors during loading (bad URL, network failure),
      // the play() promise may hang forever instead of rejecting. Race it
      // against the error event and a 30s timeout so we always reject.
      const errorOnLoad = new Promise<never>((_, reject) => {
        const handler = () => {
          const mediaError = el.error
          if (!mediaError) return
          const msg = mediaError.message || `Audio error code ${mediaError.code}`
          reject(new Error(msg))
        }
        onErrorListener = handler
        el.addEventListener('error', handler, { once: true })
        timeoutId = setTimeout(() => reject(new Error('Playback timeout after 30s')), 30000)
      })
      await Promise.race([el.play(), errorOnLoad])
    } catch (err: any) {
      // ⚠️ Do NOT swallow AbortError here. If el.play() is aborted (e.g.
      // because a stale preloaded URL prevented playback from starting),
      // the engine MUST know playback failed so it can retry with a fresh
      // resolve or surface the error to the user. A silent AbortError catch
      // causes playFromQueue to think playback succeeded — the engine shows
      // 'playing' state but the user hears nothing.
      errorRef.current = err.message
      setState((prev) => ({ ...prev, error: err.message, isPlaying: false, loading: false }))
      throw err // Re-throw so the engine knows playback failed
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      // ⚠️ Remove the error listener after play() settled, whether it
      // succeeded or failed (we already caught the error). Without this,
      // a later 'error' event on this element calls reject() on the now-
      // dangling errorOnLoad promise — an unhandled promise rejection.
      if (onErrorListener) {
        el.removeEventListener('error', onErrorListener)
        onErrorListener = null
      }
    }
  }, [])

  /** Preload a URL into the STANDBY element. Safe to call while active is playing. */
  const preloadNext = useCallback((url: string): void => {
    const standby = getStandby()
    if (!standby) return

    setState((prev) => ({ ...prev, nextUrl: url, isNextReady: false }))
    standby.src = url
    standby.load()
  }, [])

  /**
   * Swap active ↔ standby and play the preloaded standby element.
   * The old active element is cleared and becomes the new standby (ready for next preload).
   * Returns true if swap succeeded.
   */
  const swapToNext = useCallback(async (): Promise<boolean> => {
    const standby = getStandby()
    const active = getActive()
    if (!standby || !active) return false

    // 🔥 Gapless transition: start the NEW track BEFORE stopping the old one.
    // The preloaded standby element should already have buffered data, so
    // play() resolves near-instantly while the old track is still audible.
    // Pausing + clearing the old element first would create a gap of silence.
    try {
      await standby.play()
    } catch (err: any) {
      if (err.name === 'AbortError') return false
      setState((prev) => ({ ...prev, error: err.message }))
      return false
    }

    // New track is now playing — swap roles and clear the old element quietly
    activeIsA.current = !activeIsA.current

    active.pause()
    active.src = ''
    active.load()

    // 🔥 Reset poll state for the new track. swapToNext is called after
    // the old track ended, so lastCurrentTime/stalledCount are stale.
    // Without this, the new track's first few poll cycles could see
    // currentTime not advancing and falsely trigger stall detection.
    lastCurrentTimeRef.current = 0
    stalledCountRef.current = 0
    trackEndedFiredRef.current = false
    userPausedRef.current = false
    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null, ended: false }))

    return true
  }, [])

  const play = useCallback(async () => {
    const el = getActive()
    if (!el) return
    trackEndedFiredRef.current = false
    setState((prev) => ({ ...prev, ended: false }))
    try { await el.play() } catch (err: any) { if (err.name !== 'AbortError') setState((prev) => ({ ...prev, error: err.message })) }
  }, [])

  const pause = useCallback(() => {
    userPausedRef.current = true
    getActive()?.pause()
  }, [])

  const seek = useCallback((time: number) => {
    const el = getActive()
    if (el) el.currentTime = time
  }, [])

  const setVolume = useCallback((volume: number) => {
    if (elA.current) elA.current.volume = volume
    if (elB.current) elB.current.volume = volume
    setState((prev) => ({ ...prev, volume }))
  }, [])

  const setOnTrackEnd = useCallback((cb: () => void) => {
    onTrackEndRef.current = cb
  }, [])

  const setOnError = useCallback((cb: (() => void) | null) => {
    onErrorRef.current = cb
  }, [])

  const getError = useCallback((): string | null => {
    // Read from the active element, not the shared errorRef — the standby's
    // MEDIA_ELEMENT_ERROR from being cleared can pollute errorRef.
    const el = getActive()
    if (el?.error) {
      return el.error.message || `Audio error code ${el.error.code}`
    }
    return null
  }, [])

  /** Abort any pending play() promise on the active element by clearing its
   *  source and calling load(). This causes the pending play() to reject with
   *  AbortError, which loadAndPlay catches silently — so the caller (e.g.
   *  playFromQueue) doesn't hang waiting for a stale audio load. */
  const cancelPendingPlay = useCallback((): void => {
    const el = getActive()
    if (!el) return
    // Setting src = '' + load() resets the element and rejects any pending
    // play() promise with AbortError. The error handler in loadAndPlay
    // catches AbortError silently and returns without throwing.
    el.src = ''
    el.load()
  }, [])

  return [
    state,
    { loadAndPlay, preloadNext, swapToNext, play, pause, seek, setVolume, setOnTrackEnd, setOnError, getError, cancelPendingPlay },
  ]
}
