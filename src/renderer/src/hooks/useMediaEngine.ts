import { useState, useEffect, useRef, useMemo } from 'react'
import { useAudioPlayer } from './useAudioPlayer'
import { MediaEngine } from '../engine/MediaEngine'
import type { AudioBridge, ApiBridge, MediaEngineState } from '../engine/types'
import type { RepeatMode, SearchResult } from '../../../shared/types'

export interface MediaEngineControls {
  next: () => Promise<void>
  prev: () => Promise<void>
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  playFromQueue: (idx: number) => Promise<void>
  playSearchResult: (result: SearchResult) => Promise<void>
  playCustomId: (id: string) => Promise<void>
  toggleShuffle: () => Promise<void>
  toggleRepeat: (nextMode: RepeatMode) => Promise<void>
  refreshState: () => Promise<void>
  clearTrack: () => void
}

const INITIAL_ENGINE_STATE: MediaEngineState = {
  currentTrack: null,
  state: 'idle',
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  error: null,
  isNextReady: false,
  queueList: [],
  queueIndex: -1,
  shuffleActive: false,
  repeatMode: 'none',
}

export function useMediaEngine(logger?: (msg: string) => void): {
  engineState: MediaEngineState
  controls: MediaEngineControls
} {
  const [playerState, playerControls] = useAudioPlayer()
  const playerStateRef = useRef(playerState)
  playerStateRef.current = playerState
  const [engineState, setEngineState] = useState<MediaEngineState>(INITIAL_ENGINE_STATE)
  const engineRef = useRef<MediaEngine | null>(null)

  // Stable logger ref — avoids re-creating engine when logger changes
  const loggerRef = useRef(logger)
  loggerRef.current = logger

  // Build bridges (stable references)
  const apiBridge = useMemo<ApiBridge>(() => ({
    resolveTrack: (videoId, opts?) => window.api.resolveTrack(videoId, opts),
    resolveTrackInfo: (videoId) => window.api.resolveTrackInfo(videoId),
    queueNext: () => window.api.queueNext(),
    queuePrev: () => window.api.queuePrev(),
    queuePeekNext: () => window.api.queuePeekNext(),
    getQueue: () => window.api.getQueue(),
    addToQueue: (tracks) => window.api.addToQueue(tracks),
    prefetchQueue: (ids) => window.api.prefetchQueue(ids),
    setShuffle: (active?) => window.api.setShuffle(active),
    setRepeat: (mode) => window.api.setRepeat(mode),
  }), [])

  const audioBridge = useMemo<AudioBridge>(() => ({
    loadAndPlay: (url) => playerControls.loadAndPlay(url),
    preloadNext: (url) => playerControls.preloadNext(url),
    swapToNext: () => playerControls.swapToNext(),
    play: () => playerControls.play(),
    pause: () => playerControls.pause(),
    seek: (t) => playerControls.seek(t),
    setVolume: (v) => playerControls.setVolume(v),
    setOnTrackEnd: (cb) => playerControls.setOnTrackEnd(cb),
    isNextReady: () => playerStateRef.current.isNextReady,
    isPlaying: () => playerStateRef.current.isPlaying,
    getError: () => playerControls.getError(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [])

  // Create engine on mount, tear down on unmount
  useEffect(() => {
    const engine = new MediaEngine(
      audioBridge,
      apiBridge,
      (msg) => loggerRef.current?.(msg)
    )
    engineRef.current = engine

    const unsub = engine.subscribe((state) => {
      setEngineState(state)
    })

    // Seed initial queue state — must go through engine so _state is populated
    engine.refreshState()

    return () => {
      unsub()
      engineRef.current = null
    }
    // audioBridge and apiBridge are stable (useMemo with [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBridge, apiBridge])

  // Sync real-time audio properties (currentTime, duration) from useAudioPlayer
  // These update on every timeupdate event (~4Hz), same as old direct playerState access
  useEffect(() => {
    setEngineState((prev) => {
      // Only update if values actually changed to avoid unnecessary re-renders
      if (prev.currentTime === playerState.currentTime && prev.duration === playerState.duration) return prev
      return { ...prev, currentTime: playerState.currentTime, duration: playerState.duration }
    })
  }, [playerState.currentTime, playerState.duration])

  // Stable controls object — engine ref is always up to date
  const controls = useMemo<MediaEngineControls>(() => ({
    next: () => engineRef.current!.next(),
    prev: () => engineRef.current!.prev(),
    play: () => engineRef.current!.play(),
    pause: () => engineRef.current!.pause(),
    seek: (t) => engineRef.current!.seek(t),
    setVolume: (v) => engineRef.current!.setVolume(v),
    playFromQueue: (idx) => engineRef.current!.playFromQueue(idx),
    playSearchResult: (r) => engineRef.current!.playSearchResult(r),
    playCustomId: (id) => engineRef.current!.playCustomId(id),
    toggleShuffle: () => engineRef.current!.toggleShuffle(),
    toggleRepeat: (m) => engineRef.current!.toggleRepeat(m),
    refreshState: () => engineRef.current!.refreshState(),
    clearTrack: () => engineRef.current!.clearTrack(),
  }), [])

  return { engineState, controls }
}
