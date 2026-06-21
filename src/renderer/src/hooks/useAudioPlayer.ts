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
  /** Return the current audio error message, if any */
  getError: () => string | null
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
  /** Ref to latest error so memoized getError() always returns current value */
  const errorRef = useRef<string | null>(null)

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
    const onPlay = () => setState((prev) => ({ ...prev, isPlaying: true }))
    const onPause = () => setState((prev) => ({ ...prev, isPlaying: false }))
    const onError = () => {
      const el = activeIsA.current ? elA.current : elB.current
      const mediaError = el?.error
      let msg = mediaError?.message
      if (!msg && mediaError?.code) {
        const codes: Record<number, string> = {
          1: 'Playback aborted',
          2: 'Network error loading audio',
          3: 'Audio decode error',
          4: 'Audio format not supported',
        }
        msg = codes[mediaError.code] ?? 'Unknown audio error'
        console.warn(`[audio] onError code=${mediaError.code} src=${el?.src?.substring(0,60)}`)
      } else if (mediaError?.code) {
        console.warn(`[audio] onError code=${mediaError.code} msg=${msg?.substring(0,60)}`)
      } else {
        console.warn(`[audio] onError no code, src=${el?.src?.substring(0,60)}`)
      }
      msg ??= 'Unknown audio error'
      errorRef.current = msg
      setState((prev) => ({ ...prev, error: msg, loading: false, isPlaying: false }))
    }
    const fireTrackEnd = () => {
      if (trackEndedFiredRef.current) return
      trackEndedFiredRef.current = true
      setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, ended: true }))
      onTrackEndRef.current?.()
    }

    const onEnded = () => fireTrackEnd()
    const onWaiting = () => setState((prev) => ({ ...prev, loading: true }))
    const onCanPlay = () => setState((prev) => ({ ...prev, loading: false }))

    // Standby element ready events
    const onStandbyCanPlay = () => setState((prev) => ({ ...prev, isNextReady: true }))
    const onStandbyLoadStart = () => setState((prev) => ({ ...prev, isNextReady: false }))

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
      el.addEventListener('canplay', onStandbyCanPlay)
      el.addEventListener('loadstart', onStandbyLoadStart)
    }

    // ── Polling fallback: detect track end via currentTime/duration ──
    // YouTube proxy streams often don't fire the DOM ended event.
    // Check every 500ms if the active element has reached its end.
    const pollEnded = setInterval(() => {
      const el = activeIsA.current ? elA.current : elB.current
      if (!el || el.duration <= 0 || el.currentTime <= 0) return
      // Use el.ended (set by the UA) OR currentTime >= duration as a catch-all
      if (el.ended || el.currentTime >= el.duration - 0.5) {
        fireTrackEnd()
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
        el.removeEventListener('canplay', onStandbyCanPlay)
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

    // Clear standby to avoid conflict
    const standby = getStandby()
    if (standby) { standby.pause(); standby.src = ''; standby.load() }

    trackEndedFiredRef.current = false
    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null, ended: false }))

    el.src = url
    el.load()

    try {
      await el.play()
    } catch (err: any) {
      if (err.name === 'AbortError') return
      errorRef.current = err.message
      setState((prev) => ({ ...prev, error: err.message, isPlaying: false, loading: false }))
      throw err // Re-throw so the engine knows playback failed
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

    // Old active → cleared, becomes new standby
    active.pause()
    active.src = ''
    active.load()

    // Swap the roles
    activeIsA.current = !activeIsA.current

    trackEndedFiredRef.current = false
    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null, ended: false }))

    // Play the preloaded element
    try {
      await standby.play()
      return true
    } catch (err: any) {
      if (err.name === 'AbortError') return false
      setState((prev) => ({ ...prev, error: err.message }))
      return false
    }
  }, [])

  const play = useCallback(async () => {
    const el = getActive()
    if (!el) return
    trackEndedFiredRef.current = false
    setState((prev) => ({ ...prev, ended: false }))
    try { await el.play() } catch (err: any) { if (err.name !== 'AbortError') setState((prev) => ({ ...prev, error: err.message })) }
  }, [])

  const pause = useCallback(() => { getActive()?.pause() }, [])

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

  const getError = useCallback((): string | null => {
    return errorRef.current
  }, [])

  return [
    state,
    { loadAndPlay, preloadNext, swapToNext, play, pause, seek, setVolume, setOnTrackEnd, getError },
  ]
}
