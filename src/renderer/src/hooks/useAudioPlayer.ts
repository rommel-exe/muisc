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
  load: (url: string) => void
  preload: (url: string) => void
  /** Preload a URL into the secondary audio element for instant swap */
  preloadNext: (url: string) => void
  /** Swap to the preloaded secondary element and play. Returns false if not ready. */
  swapToNext: () => Promise<boolean>
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
}

const INITIAL_VOLUME = 0.8

export function useAudioPlayer(): [AudioPlayerState, AudioPlayerControls] {
  // Primary audio element — actively playing
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Secondary audio element — pre-buffers the next track
  const nextAudioRef = useRef<HTMLAudioElement | null>(null)
  // Which element is "current" (actively playing). Toggled on swap.
  const isNextActive = useRef(false)

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

  // ── Create both audio elements on mount ──

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.style.display = 'none'
    audio.volume = INITIAL_VOLUME
    document.body.appendChild(audio)
    audioRef.current = audio

    const next = new Audio()
    next.preload = 'auto'
    next.style.display = 'none'
    next.volume = INITIAL_VOLUME
    document.body.appendChild(next)
    nextAudioRef.current = next

    // ── Event handlers for primary element ──

    const getActive = () => isNextActive.current ? next : audio

    const onTimeUpdate = () => {
      const el = getActive()
      setState((prev) => ({ ...prev, currentTime: el.currentTime }))
    }

    const onLoadedMetadata = () => {
      const el = getActive()
      setState((prev) => ({
        ...prev,
        duration: el.duration,
        loading: false,
      }))
    }

    const onPlay = () => {
      setState((prev) => ({ ...prev, isPlaying: true }))
    }

    const onPause = () => {
      setState((prev) => ({ ...prev, isPlaying: false }))
    }

    const onError = () => {
      const el = getActive()
      const error = el.error?.message ?? 'Unknown playback error'
      setState((prev) => ({ ...prev, error, loading: false, isPlaying: false }))
    }

    const onEnded = () => {
      setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }))
    }

    const onWaiting = () => {
      setState((prev) => ({ ...prev, loading: true }))
    }

    const onCanPlay = () => {
      setState((prev) => ({ ...prev, loading: false }))
    }

    // Events on primary
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)

    // Events on secondary (mirrored — keeps state consistent whichever is active)
    next.addEventListener('timeupdate', onTimeUpdate)
    next.addEventListener('loadedmetadata', onLoadedMetadata)
    next.addEventListener('play', onPlay)
    next.addEventListener('pause', onPause)
    next.addEventListener('error', onError)
    next.addEventListener('ended', onEnded)
    next.addEventListener('waiting', onWaiting)
    next.addEventListener('canplay', onCanPlay)

    // Track when secondary is ready to play
    const onNextReady = () => {
      setState((prev) => ({ ...prev, isNextReady: true }))
    }
    const onNextLoadStart = () => {
      setState((prev) => ({ ...prev, isNextReady: false }))
    }
    next.addEventListener('canplaythrough', onNextReady)
    next.addEventListener('canplay', onNextReady)
    next.addEventListener('loadstart', onNextLoadStart)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)

      next.removeEventListener('timeupdate', onTimeUpdate)
      next.removeEventListener('loadedmetadata', onLoadedMetadata)
      next.removeEventListener('play', onPlay)
      next.removeEventListener('pause', onPause)
      next.removeEventListener('error', onError)
      next.removeEventListener('ended', onEnded)
      next.removeEventListener('waiting', onWaiting)
      next.removeEventListener('canplay', onCanPlay)
      next.removeEventListener('canplaythrough', onNextReady)
      next.removeEventListener('canplay', onNextReady)
      next.removeEventListener('loadstart', onNextLoadStart)

      audio.pause()
      audio.src = ''
      audio.remove()
      next.pause()
      next.src = ''
      next.remove()
      audioRef.current = null
      nextAudioRef.current = null
    }
  }, [])

  // ── Controls ──

  /** Load a URL into the ACTIVE element and play */
  const load = useCallback((url: string) => {
    const audio = audioRef.current
    if (!audio) return
    // Ensure primary is the active element
    isNextActive.current = false
    // Stop secondary from interfering
    const next = nextAudioRef.current
    if (next && next.src === url) {
      next.pause()
      next.src = ''
      next.load()
    }
    loadElement(audio, url)
  }, [])

  /** Preload a URL into the primary element for future playback */
  const preload = useCallback((url: string) => {
    const audio = audioRef.current
    if (!audio || audio.src === url) return
    audio.src = url
    audio.load()
  }, [])

  /** Preload a URL into the SECONDARY element for instant swap-to-next */
  const preloadNext = useCallback((url: string) => {
    const next = nextAudioRef.current
    if (!next) return
    setState((prev) => ({ ...prev, nextUrl: url, isNextReady: false }))
    next.src = url
    next.load()
  }, [])

  /** Swap to the preloaded secondary element and play */
  const swapToNext = useCallback(async (): Promise<boolean> => {
    const next = nextAudioRef.current
    const current = audioRef.current
    if (!next || !current) return false

    // If secondary isn't loaded yet, return false
    if (!next.src || next.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false
    }

    // Pause and clear primary
    current.pause()
    current.src = ''
    current.load()

    // Swap: secondary becomes the active element
    isNextActive.current = true
    setState((prev) => ({
      ...prev,
      isNextReady: false,
      nextUrl: null,
    }))

    try {
      await next.play()
      return true
    } catch {
      // If play fails, fall through
      return false
    }
  }, [])

  const play = useCallback(async () => {
    const el = isNextActive.current ? nextAudioRef.current : audioRef.current
    if (!el) return

    try {
      await el.play()
    } catch (err: any) {
      if (err.name === 'AbortError') return
      setState((prev) => ({ ...prev, error: err.message }))
    }
  }, [])

  const pause = useCallback(() => {
    const el = isNextActive.current ? nextAudioRef.current : audioRef.current
    el?.pause()
  }, [])

  const seek = useCallback((time: number) => {
    const el = isNextActive.current ? nextAudioRef.current : audioRef.current
    if (!el) return
    el.currentTime = time
  }, [])

  const setVolume = useCallback((volume: number) => {
    if (audioRef.current) audioRef.current.volume = volume
    if (nextAudioRef.current) nextAudioRef.current.volume = volume
    setState((prev) => ({ ...prev, volume }))
  }, [])

  return [
    state,
    { load, preload, preloadNext, swapToNext, play, pause, seek, setVolume },
  ]
}

function loadElement(audio: HTMLAudioElement, url: string): void {
  if (audio.src === url && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return
  }
  audio.src = url
  audio.load()
}
