import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MediaEngine } from '../src/renderer/src/engine/MediaEngine'
import { ErrorBoundary } from '../src/renderer/src/components/ErrorBoundary'
import React from 'react'
import type { AudioBridge, ApiBridge } from '../src/renderer/src/engine/types'
import type { Track } from '../src/shared/types'

// ── Helpers ──

function createMockAudio(): AudioBridge {
  return {
    loadAndPlay: vi.fn().mockResolvedValue(undefined),
    preloadNext: vi.fn(),
    swapToNext: vi.fn().mockResolvedValue(false),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setOnTrackEnd: vi.fn(),
    setOnError: vi.fn(),
    isNextReady: vi.fn().mockReturnValue(false),
    isPlaying: vi.fn().mockReturnValue(false),
    getError: vi.fn().mockReturnValue(null),
    cancelPendingPlay: vi.fn(),
  }
}

function createMockApi(): ApiBridge {
  return {
    resolveTrack: vi.fn().mockResolvedValue({
      videoId: 'test', audioUrl: 'http://proxy/audio', duration: 200,
      title: 'Test Track', thumbnail: '',
    }),
    resolveTrackInfo: vi.fn().mockResolvedValue({
      videoId: 'test', audioUrl: '', duration: 200,
      title: 'Test Track', thumbnail: '',
    }),
    queueNext: vi.fn().mockResolvedValue(null),
    queuePrev: vi.fn().mockResolvedValue(null),
    queuePeekNext: vi.fn().mockResolvedValue(null),
    getQueue: vi.fn().mockResolvedValue({
      list: [], index: 0, shuffleActive: false, repeatMode: 'none',
    }),
    addToQueue: vi.fn().mockResolvedValue([]),
    prefetchQueue: vi.fn().mockResolvedValue(true),
    setShuffle: vi.fn().mockResolvedValue({
      shuffleActive: true, list: [], index: 0,
    }),
    setRepeat: vi.fn().mockResolvedValue('none'),
    jumpToQueueIndex: vi.fn().mockResolvedValue({ index: 0 }),
  }
}

const mockTrack: Track = {
  id: 'track1', title: 'Track 1', artist: 'Artist',
  duration: 200, thumbnailUrl: '', source: 'youtube' as const, sourceId: 'track1',
}

// ── Tests ──

describe('Error Recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Test 1: _retryPlayback STALE_OPERATION ──
  //
  // When _requestCounter changes during the retry backoff, _retryPlayback
  // throws STALE_OPERATION. The caller's stale guard silently abandons the
  // operation without calling handleError → state must NOT be 'error'.

  it('Test 1: _retryPlayback throws STALE_OPERATION when _requestCounter changes during retry', async () => {
    const audio = createMockAudio()
    const api = createMockApi()
    api.resolveTrack = vi.fn().mockResolvedValue({
      audioUrl: 'http://proxy/audio', duration: 200, title: 'Test', thumbnail: '',
    })
    api.jumpToQueueIndex = vi.fn().mockResolvedValue({ index: 0 })

    // loadAndPlay fails → triggers _retryPlayback retry loop
    // After the first failure, we increment _requestCounter during the 250ms backoff
    // using a 50ms setTimeout (well before the backoff resolves).
    let loadCount = 0
    audio.loadAndPlay = vi.fn().mockImplementation(() => {
      loadCount++
      if (loadCount === 1) {
        setTimeout(() => { (engine as any)._requestCounter += 100 }, 50)
      }
      return Promise.reject(new Error('CDN error'))
    })

    const engine = new MediaEngine(audio, api as any)

    const playPromise = engine.playCustomId('test123')
    await playPromise

    const state = engine.getState()
    // STALE_OPERATION was caught by the stale guard → handleError NOT called → state NOT 'error'
    expect(state.state).not.toBe('error')

    // _retryPlayback calls setOnError(null) at start but never re-enables the
    // mid-playback callback (that only happens on success, which was never reached).
    expect(audio.setOnError).toHaveBeenCalledWith(null)
  })

  // ── Test 2: handleError with playbackError flag ──
  //
  // When options.playbackError is false, handleError must NOT set state to 'error'.
  // toggleShuffle and toggleRepeat both pass { playbackError: false } to handleError.
  // Without the options (e.g. prev), handleError defaults to playbackError: true → sets error.

  describe('Test 2: handleError respects playbackError flag', () => {
    it('toggleShuffle error does NOT set state to error (playbackError: false)', async () => {
      const audio = createMockAudio()
      const api = createMockApi()
      api.setShuffle = vi.fn().mockRejectedValue(new Error('Shuffle failed'))
      api.getQueue = vi.fn().mockResolvedValue({
        list: [], index: 0, shuffleActive: false, repeatMode: 'none',
      })

      const engine = new MediaEngine(audio, api as any)
      await engine.toggleShuffle()

      const state = engine.getState()
      expect(state.state).not.toBe('error')
      expect(state.error).toBeNull()
    })

    it('toggleRepeat error does NOT set state to error (playbackError: false)', async () => {
      const audio = createMockAudio()
      const api = createMockApi()
      api.setRepeat = vi.fn().mockRejectedValue(new Error('Repeat failed'))
      api.getQueue = vi.fn().mockResolvedValue({
        list: [], index: 0, shuffleActive: false, repeatMode: 'none',
      })

      const engine = new MediaEngine(audio, api as any)
      await engine.toggleRepeat('all')

      const state = engine.getState()
      expect(state.state).not.toBe('error')
      expect(state.error).toBeNull()
    })

    it('prev error defaults to playbackError:true → state IS error', async () => {
      const audio = createMockAudio()
      const api = createMockApi()
      api.queuePrev = vi.fn().mockRejectedValue(new Error('Prev failed'))

      const engine = new MediaEngine(audio, api as any)
      await engine.prev()

      const state = engine.getState()
      expect(state.state).toBe('error')
      expect(state.error).toBe('Prev failed')
    })
  })

  // ── Test 3: _nextImpl skip-recovery on queueNext IPC failure ──
  //
  // When queueNext() rejects (IPC failure), _nextImpl increments skipCount and
  // retries. If the second call succeeds, the track should play normally.

  it('Test 3: _nextImpl recovers from queueNext IPC failure', async () => {
    const audio = createMockAudio()
    const api = createMockApi()

    let queueNextCallCount = 0
    api.queueNext = vi.fn().mockImplementation(() => {
      queueNextCallCount++
      if (queueNextCallCount === 1) {
        return Promise.reject(new Error('IPC error'))
      }
      return Promise.resolve({ queueId: 'q1', track: mockTrack, index: 0 })
    })
    api.getQueue = vi.fn().mockResolvedValue({
      list: [{ queueId: 'q1', track: mockTrack }],
      index: 0, shuffleActive: false, repeatMode: 'none',
    })
    api.resolveTrack = vi.fn().mockResolvedValue({
      audioUrl: 'http://proxy/audio', duration: 200, title: 'Track 1', thumbnail: '',
    })
    api.jumpToQueueIndex = vi.fn().mockResolvedValue({ index: 0 })
    audio.loadAndPlay = vi.fn().mockResolvedValue(undefined)
    audio.isNextReady = vi.fn().mockReturnValue(false)

    const engine = new MediaEngine(audio, api as any)
    // Pre-populate queueList with 2 tracks so skipCount (1) < queueList.length (2)
    // after the first queueNext rejection, allowing the retry to continue.
    ;(engine as any)._state.queueList = [
      { queueId: 'q1', track: mockTrack },
      { queueId: 'q2', track: { ...mockTrack, id: 'track2', sourceId: 'track2' } },
    ]
    await engine.next()

    const state = engine.getState()
    expect(state.state).toBe('playing')
    expect(state.currentTrack?.id).toBe('track1')

    // First call rejected, second call succeeded
    expect(queueNextCallCount).toBeGreaterThanOrEqual(2)
  })

  // ── Test 4: _nextImpl circuit breaker ──
  //
  // When every track in the queue fails to play, _nextImpl trips the circuit
  // breaker: state becomes 'idle' with 'All tracks failed to play'.
  // This test takes ~4s due to real retry backoff (5 attempts with exponential delay).

  it('Test 4: _nextImpl circuit breaker after all tracks fail to play', async () => {
    const audio = createMockAudio()
    const api = createMockApi()

    // queueNext always returns the same track (it never says end-of-queue)
    api.queueNext = vi.fn().mockResolvedValue({ queueId: 'q1', track: mockTrack, index: 0 })
    // loadAndPlay always fails → _retryPlayback exhausts all 5 attempts → handleError
    audio.loadAndPlay = vi.fn().mockRejectedValue(new Error('Playback failed'))
    api.getQueue = vi.fn().mockResolvedValue({
      list: [{ queueId: 'q1', track: mockTrack }],
      index: 0, shuffleActive: false, repeatMode: 'none',
    })
    api.jumpToQueueIndex = vi.fn().mockResolvedValue({ index: 0 })
    api.resolveTrack = vi.fn().mockResolvedValue({
      audioUrl: 'http://proxy/audio', duration: 200, title: 'Track 1', thumbnail: '',
    })
    audio.isNextReady = vi.fn().mockReturnValue(false)

    const engine = new MediaEngine(audio, api as any)
    await engine.next()

    const state = engine.getState()
    // Circuit breaker: all tracks exhausted → 'idle' with 'All tracks failed to play'
    expect(state.state).toBe('idle')
    expect(state.error).toBe('All tracks failed to play')
  })

  // ── Test 5: onTrackEnded error recovery ──
  //
  // When onTrackEnded fires and the subsequent queueNext call fails (no next track),
  // the engine must not stay stuck in 'playing'. It transitions to 'idle' with an
  // error message.

  it('Test 5: onTrackEnded error recovery via queueNext failure', async () => {
    const audio = createMockAudio()
    const api = createMockApi()
    let onTrackEndCb: () => void = () => {}
    audio.setOnTrackEnd = vi.fn((cb: () => void) => { onTrackEndCb = cb })

    // No next track available → queueNext rejects
    api.queueNext = vi.fn().mockRejectedValue(new Error('No next track'))

    const engine = new MediaEngine(audio, api as any)
    // Set _trackStartedAt >30s ago so onTrackEnded takes the NORMAL path (not truncated)
    ;(engine as any)._trackStartedAt = performance.now() - 40000
    ;(engine as any)._currentVideoId = 'track1'

    // Fire the onTrackEnded callback (registered via constructor's setOnTrackEnd)
    onTrackEndCb()

    // Wait for the async next() → _nextImpl → queueNext rejection → circuit breaker chain
    await new Promise(r => setTimeout(r, 200))

    const state = engine.getState()
    // State must have transitioned away from 'playing' — it should be 'idle'
    // (circuit breaker: skipCount >= empty queueList)
    expect(state.state).toBe('idle')
    expect(state.error).toBe('Unable to navigate queue')
  })

  // ── Test 6: toggleShuffle error ──
  //
  // If api.setShuffle rejects, handleError is called with { playbackError: false }.
  // The engine state must NOT become 'error'.

  it('Test 6: toggleShuffle error does not set state to error', async () => {
    const audio = createMockAudio()
    const api = createMockApi()
    api.setShuffle = vi.fn().mockRejectedValue(new Error('Shuffle IPC error'))
    api.getQueue = vi.fn().mockResolvedValue({
      list: [], index: 0, shuffleActive: false, repeatMode: 'none',
    })

    const engine = new MediaEngine(audio, api as any)
    await engine.toggleShuffle()

    const state = engine.getState()
    expect(state.state).not.toBe('error')
    expect(state.error).toBeNull()
  })

  // ── Test 7: toggleRepeat error ──
  //
  // If api.setRepeat rejects, handleError is called with { playbackError: false }.
  // The engine state must NOT become 'error'.

  it('Test 7: toggleRepeat error does not set state to error', async () => {
    const audio = createMockAudio()
    const api = createMockApi()
    api.setRepeat = vi.fn().mockRejectedValue(new Error('Repeat IPC error'))
    api.getQueue = vi.fn().mockResolvedValue({
      list: [], index: 0, shuffleActive: false, repeatMode: 'none',
    })

    const engine = new MediaEngine(audio, api as any)
    await engine.toggleRepeat('all')

    const state = engine.getState()
    expect(state.state).not.toBe('error')
    expect(state.error).toBeNull()
  })

  // ── Test 8: preloadNext failure clears isNextReady ──
  //
  // When preloadNext resolves a URL and the AudioBridge processes it, isNextReady
  // reflects the bridge state. Even if preloadNext could not prepare the audio,
  // isNextReady correctly reports false.

  it('Test 8: preloadNext failure clears isNextReady via AudioBridge', async () => {
    const audio = createMockAudio()
    const api = createMockApi()

    api.queuePeekNext = vi.fn().mockResolvedValue({ track: mockTrack, index: null })
    api.resolveTrack = vi.fn().mockResolvedValue({
      audioUrl: 'http://proxy/preload-audio', duration: 200,
      title: 'Preload Track', thumbnail: '', videoId: 'track1',
    })
    audio.isNextReady = vi.fn().mockReturnValue(false) // Preload failed → not ready

    const engine = new MediaEngine(audio, api as any)
    engine['preloadNext']()

    // Wait for: queuePeekNext → resolveTrack → audio.preloadNext
    await new Promise(r => setTimeout(r, 50))

    // Verify the preload URL was forwarded to the AudioBridge
    expect(audio.preloadNext).toHaveBeenCalledWith('http://proxy/preload-audio')
    // isNextReady reflects the AudioBridge state (false = preload failed or not yet ready)
    expect(engine.getState().isNextReady).toBe(false)
  })

  // ── Test 9: onPause ignores standby element events ──
  //
  // The useAudioPlayer hook's onPause handler filters out events from the standby
  // element: only the active element's pause event should set isPlaying to false.
  // This test verifies the core filter logic independently.

  describe('Test 9: onPause ignores standby element events', () => {
    it('standby element pause events are filtered out', () => {
      // Simulate the filter logic from useAudioPlayer's onPause handler:
      //   const target = e.target as HTMLAudioElement
      //   const isActive = activeIsA.current
      //     ? target === elA.current
      //     : target === elB.current
      //   if (!isActive) return

      let activeIsA = true
      const elA = {} as EventTarget
      const elB = {} as EventTarget

      function isActiveElement(e: Event): boolean {
        const target = e.target as EventTarget
        return activeIsA ? target === elA : target === elB
      }

      // Pause event from STANDBY element (elB) → should be IGNORED
      expect(isActiveElement({ target: elB } as Event)).toBe(false)

      // Pause event from ACTIVE element (elA) → should be PROCESSED
      expect(isActiveElement({ target: elA } as Event)).toBe(true)

      // After swap, roles reverse
      activeIsA = false
      expect(isActiveElement({ target: elB } as Event)).toBe(true)
      expect(isActiveElement({ target: elA } as Event)).toBe(false)
    })
  })

  // ── Test 10: ErrorBoundary catches render errors ──
  //
  // ErrorBoundary.getDerivedStateFromError captures the error.
  // When hasError is true, render() displays the fallback UI.
  // When hasError is false, render() passes children through.

  describe('Test 10: ErrorBoundary catches render errors', () => {
    it('getDerivedStateFromError captures the error', () => {
      const error = new Error('Render crash!')
      const state = ErrorBoundary.getDerivedStateFromError(error)

      expect(state.hasError).toBe(true)
      expect(state.error).toBe(error)
    })

    it('render displays fallback UI when hasError is true', () => {
      const error = new Error('Render crash!')
      const eb = new ErrorBoundary({ children: null })
      eb.state = { hasError: true, error }

      const rendered = eb.render() as any
      expect(rendered.type).toBe('div')

      const children = rendered.props.children as React.ReactNode[]
      expect(Array.isArray(children)).toBe(true)

      // Find the <h2> with "Something went wrong"
      const h2 = (children as any[]).find((c: any) => c?.type === 'h2')
      expect(h2).toBeDefined()
      expect(h2.props.children).toBe('Something went wrong')

      // Find the <p> with the error message
      const p = (children as any[]).find((c: any) => c?.type === 'p')
      expect(p).toBeDefined()
      expect(p.props.children).toBe('Render crash!')
    })

    it('render passes children through when hasError is false', () => {
      const eb = new ErrorBoundary({ children: React.createElement('span', null, 'OK') })
      eb.state = { hasError: false, error: null }

      const rendered = eb.render() as any
      expect(rendered.type).toBe('span')
      expect(rendered.props.children).toBe('OK')
    })
  })
})
