import { useRef, useState, useEffect, useCallback } from 'react'

export interface AudioPlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  error: string | null
  loading: boolean
}

export interface AudioPlayerControls {
  load: (url: string) => void
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
}

export function useAudioPlayer(): [AudioPlayerState, AudioPlayerControls] {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<AudioPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    error: null,
    loading: false,
  })

  // Create audio element on mount
  useEffect(() => {
    const audio = new Audio()
    audio.crossOrigin = 'anonymous'
    audio.preload = 'metadata'
    audioRef.current = audio

    const onTimeUpdate = () => {
      setState((prev) => ({ ...prev, currentTime: audio.currentTime }))
    }

    const onLoadedMetadata = () => {
      setState((prev) => ({
        ...prev,
        duration: audio.duration,
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
      const error = audio.error?.message ?? 'Unknown playback error'
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

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [])

  const load = useCallback((url: string) => {
    const audio = audioRef.current
    if (!audio) return

    audio.src = url
    audio.load()
    setState((prev) => ({ ...prev, loading: true, error: null, currentTime: 0, duration: 0 }))
  }, [])

  const play = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return

    try {
      await audio.play()
    } catch (err: any) {
      // Ignore AbortError — happens when load() is called before play() resolves
      // (e.g. user skips to next track while current one is still starting)
      if (err.name === 'AbortError') return
      setState((prev) => ({ ...prev, error: err.message }))
    }
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const seek = useCallback((time: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = time
  }, [])

  const setVolume = useCallback((volume: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    setState((prev) => ({ ...prev, volume }))
  }, [])

  return [state, { load, play, pause, seek, setVolume }]
}
