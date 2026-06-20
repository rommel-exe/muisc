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

  const [state, setState] = useState<AudioPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: INITIAL_VOLUME,
    error: null,
    loading: false,
    isNextReady: false,
    nextUrl: null,
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
      setState((prev) => ({ ...prev, error: el?.error?.message ?? 'Unknown error', loading: false, isPlaying: false }))
    }
    const onEnded = () => setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }))
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

    return () => {
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

    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null }))

    el.src = url
    el.load()

    return el.play().catch((err) => {
      if (err.name === 'AbortError') return
      setState((prev) => ({ ...prev, error: err.message }))
    })
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

    setState((prev) => ({ ...prev, isNextReady: false, nextUrl: null }))

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

  return [
    state,
    { loadAndPlay, preloadNext, swapToNext, play, pause, seek, setVolume },
  ]
}
