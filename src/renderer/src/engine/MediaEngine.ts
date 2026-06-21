import type { AudioBridge, ApiBridge, MediaEngineState, MediaEngineListener, MediaState } from './types'
import type { Track, RepeatMode, SearchResult } from '../../../shared/types'

const INITIAL_STATE: MediaEngineState = {
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

export class MediaEngine {
  private _state: MediaEngineState = { ...INITIAL_STATE }
  private _requestCounter = 0
  /** Dedicated counter for preloadNext — prevents stale resolves from
   *  wasting yt-dlp work when next() advances without incrementing
   *  _requestCounter (e.g. instant-swap path in next()). */
  private _preloadCounter = 0
  private _pendingAdvance = false
  /** Mutex: prevents concurrent next() calls (auto-advance + user clicking ⏭). */
  private _advancing = false
  private _currentVideoId = ''
  private _preloadedVideoId = ''
  private _listeners = new Set<MediaEngineListener>()
  /** Timestamp when the current operation started (for elapsed timing in logs) */
  private _opStart = 0

  constructor(
    private audio: AudioBridge,
    private api: ApiBridge,
    private logger?: (msg: string) => void
  ) {
    this.audio.setOnTrackEnd(() => this.onTrackEnded())
  }

  // ── Public API ──

  async playFromQueue(idx: number): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this.log(`playFromQueue: idx=${idx}`)

    const qList = this._state.queueList
    if (idx < 0 || idx >= qList.length) {
      this.log(`playFromQueue: index ${idx} out of range (queue length ${qList.length})`)
      return
    }

    this.setMediaState('loading')

    try {
      const queueRef = qList[idx]
      const videoId = queueRef.track.id || queueRef.track.sourceId

      // Instant swap path: if preloaded matches, try swap
      if (videoId === this._preloadedVideoId && this.audio.isNextReady()) {
        this.log(`playFromQueue: instant swap (preloaded hit)`)
        const swapped = await this.audio.swapToNext()
        if (swapped) {
          if (this._requestCounter !== opRequestId) return
          this._currentVideoId = videoId
          this._state.currentTrack = queueRef.track
          this._state.queueIndex = idx
          this._state.currentTime = 0
          this.emit()
          this.preloadNext()
          await this.refreshState()
          return
        }
        // Swap failed, fall through to normal path
      }

      // Normal resolve path
      const resolved = await this.api.resolveTrack(videoId)
      if (this._requestCounter !== opRequestId) return

      // If audio fails, loadAndPlay now throws — caught below
      await this.audio.loadAndPlay(resolved.audioUrl)
      if (this._requestCounter !== opRequestId) return

      // Re-check the audio element didn't land in error state
      // (defensive — loadAndPlay should have thrown, but some
      //  browser edge-cases resolve play() then immediately error)
      if (this.audio.getError?.()) {
        throw new Error(this.audio.getError()!)
      }

      this._currentVideoId = videoId
      this._state.currentTrack = { ...queueRef.track, title: resolved.title }
      this._state.queueIndex = idx
      this._state.currentTime = 0
      this._state.state = 'playing'
      this._state.error = null
      this.emit()
      this.log(`playFromQueue: playing "${resolved.title}"`)

      // Background: resolve real title (may differ from initial)
      this.api.resolveTrackInfo(videoId).then((info) => {
        if (this._requestCounter !== opRequestId) return
        if (this._state.currentTrack && this._state.currentTrack.id === videoId) {
          this._state.currentTrack = { ...this._state.currentTrack, title: info.title }
          this.emit()
        }
      }).catch(() => {})

      this.preloadNext()

      // Prefetch upcoming tracks
      const upcoming = this.computeUpcomingVideoIds(idx, 3)
      if (upcoming.length > 0) {
        this.api.prefetchQueue(upcoming).catch(() => {})
      }

      await this.refreshState()
    } catch (err: any) {
      if (this._requestCounter !== opRequestId) return
      this.handleError(err)
    } finally {
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async playSearchResult(result: SearchResult): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this.log(`playSearchResult: ${result.title}`)

    this.setMediaState('loading')

    try {
      const resolved = await this.api.resolveTrack(result.videoId)
      if (this._requestCounter !== opRequestId) return

      const track: Track = {
        id: result.videoId,
        title: result.title,
        artist: result.artist,
        duration: result.duration,
        thumbnailUrl: result.thumbnail,
        source: 'youtube',
        sourceId: result.videoId,
      }

      await this.audio.loadAndPlay(resolved.audioUrl)
      if (this._requestCounter !== opRequestId) return

      this._currentVideoId = result.videoId
      this._state.currentTrack = { ...track, title: resolved.title }
      this._state.currentTime = 0
      this._state.state = 'playing'
      this._state.error = null
      this.emit()
      this.log(`playSearchResult: playing "${resolved.title}"`)

      // Add to queue in background
      this.api.addToQueue(track).catch(() => {})

      // Background: resolve real title
      this.api.resolveTrackInfo(result.videoId).then((info) => {
        if (this._requestCounter !== opRequestId) return
        if (this._state.currentTrack && this._state.currentTrack.id === result.videoId) {
          this._state.currentTrack = { ...this._state.currentTrack, title: info.title }
          this.emit()
        }
      }).catch(() => {})

      this.preloadNext()
      await this.refreshState()
    } catch (err: any) {
      if (this._requestCounter !== opRequestId) return
      this.handleError(err)
    } finally {
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async playCustomId(id: string): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this.log(`playCustomId: ${id}`)

    this.setMediaState('loading')

    try {
      const resolved = await this.api.resolveTrack(id)
      if (this._requestCounter !== opRequestId) return

      await this.audio.loadAndPlay(resolved.audioUrl)
      if (this._requestCounter !== opRequestId) return

      this._currentVideoId = id
      this._state.currentTrack = {
        id,
        title: resolved.title,
        artist: '',
        duration: resolved.duration,
        thumbnailUrl: resolved.thumbnail,
        source: 'youtube',
        sourceId: id,
      }
      this._state.currentTime = 0
      this._state.state = 'playing'
      this._state.error = null
      this.emit()
      this.log(`playCustomId: playing "${resolved.title}"`)

      this.preloadNext()
      await this.refreshState()
    } catch (err: any) {
      if (this._requestCounter !== opRequestId) return
      this.handleError(err)
    } finally {
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async next(): Promise<void> {
    this.t0()
    // ⚠️ Mutex: prevent concurrent next() calls.
    // Without this, if auto-advance fires next() and the user clicks ⏭
    // before it resolves, QueueEngine.next() runs twice, skipping a track.
    if (this._advancing) {
      this.log('next: already advancing, queuing another advance')
      // Wait for the current advance to settle, then retry.
      // This ensures the user's click advances past the auto-advance target.
      while (this._advancing) {
        await new Promise((r) => setTimeout(r, 10))
      }
      this.log('next: retrying after pending advance')
      return this.next()
    }

    this._advancing = true
    try {
      return await this._nextImpl()
    } finally {
      this._advancing = false
    }
  }

  /** Internal next() implementation — NO mutex, called by next() and by error-recovery recursion. */
  private async _nextImpl(errorSkipCount = 0): Promise<void> {
    this.log('next: requesting next track')
    try {
      const result = await this.api.queueNext()
      if (!result) {
        this.log('next: end of queue')
        this._state.state = 'ended'
        this.emit()
        return
      }

      const videoId = result.track.id || result.track.sourceId

      // Check if preloaded matches — instant swap
      if (videoId === this._preloadedVideoId && this.audio.isNextReady()) {
        this.log('next: instant swap (preloaded hit)')
        const swapped = await this.audio.swapToNext()
        if (swapped) {
          this._currentVideoId = videoId
          this._state.currentTrack = result.track
          this._state.queueIndex = result.index
          this._state.currentTime = 0
          this._state.error = null
          this._preloadedVideoId = ''
          this.emit()
          this.preloadNext()
          await this.refreshState()
          return
        }
        this.log('next: swap failed, falling through to resolve')
      }

      // Fallback: resolve and play
      await this.playFromQueue(result.index)

      // Track failed to play — skip ahead to the next one.
      // This handles yt-dlp extraction failures, geoblocked videos,
      // and transient proxy errors during auto-advance.
      //
      // ⚠️ Circuit breaker: track how many tracks we've skipped.
      // When repeatMode is 'all' (the default), queueNext() wraps
      // around forever — without this guard we'd loop infinitely
      // across the entire queue.
      // Repeat-one adds the same issue: next() never advances the index,
      // so skipCount would never reach list.length without this guard.
      if (this._state.state === 'error') {
        const nextSkipCount = errorSkipCount + 1
        this.log(`next: track at index ${result.index} failed, skipping ahead (skip ${nextSkipCount}/${this._state.queueList.length})`)
        if (nextSkipCount >= this._state.queueList.length) {
          this.log('next: all tracks failed, stopping')
          this._state.state = 'idle'
          this._state.error = 'All tracks failed to play'
          this.emit()
          return
        }
        this._state.state = 'idle'
        this._state.error = null
        this.emit()
        // Use _nextImpl to avoid deadlocking on the mutex
        await this._nextImpl(nextSkipCount)
      }
    } catch (err: any) {
      this.handleError(err)
    }
  }

  async prev(): Promise<void> {
    this.t0()
    this.log('prev: requesting previous track')
    try {
      const result = await this.api.queuePrev()
      if (!result) {
        this.log('prev: already at start of queue')
        return
      }

      await this.playFromQueue(result.index)
    } catch (err: any) {
      this.handleError(err)
    }
  }

  async play(): Promise<void> {
    await this.audio.play()
    this._state.state = 'playing'
    this.emit()
  }

  pause(): void {
    this.audio.pause()
    this._state.state = 'paused'
    this.emit()
  }

  clearTrack(): void {
    this._state.currentTrack = null
    this._state.state = 'idle'
    this._state.currentTime = 0
    this._state.error = null
    this.emit()
  }

  seek(time: number): void {
    this.audio.seek(time)
  }

  setVolume(volume: number): void {
    this.audio.setVolume(volume)
    this._state.volume = volume
    this.emit()
  }

  async toggleShuffle(): Promise<void> {
    this.log('toggleShuffle')
    try {
      await this.api.setShuffle()
      await this.refreshState()
    } catch (err: any) {
      this.handleError(err)
    }
  }

  async toggleRepeat(nextMode: RepeatMode): Promise<void> {
    this.log(`toggleRepeat: ${nextMode}`)
    try {
      await this.api.setRepeat(nextMode)
      await this.refreshState()
    } catch (err: any) {
      this.handleError(err)
    }
  }

  getState(): MediaEngineState {
    return { ...this._state }
  }

  subscribe(listener: MediaEngineListener): () => void {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  // ── Internal ──

  private onTrackEnded(): void {
    if (this._pendingAdvance) return
    this._pendingAdvance = true
    this.log('auto-advance: track ended')
    this.next()
      .catch((err) => { this.log(`auto-advance error: ${err.message}`) })
      .finally(() => { this._pendingAdvance = false })
  }

  private preloadNext(): void {
    this.t0()
    const capturedId = ++this._preloadCounter

    // Read current queue from api (not cached state)
    this.api.queuePeekNext().then((peeked) => {
      if (!peeked) {
        this._preloadedVideoId = ''
        this.audio.preloadNext('')  // clear
        return
      }

      const videoId = peeked.track.id || peeked.track.sourceId
      if (!videoId) return

      // Already preloaded this one
      if (videoId === this._preloadedVideoId) return

      this.api.resolveTrack(videoId).then((resolved) => {
        // Skip-spam: check we're still on the same preload request
        if (this._preloadCounter !== capturedId) return
        // Double-check the preload target hasn't changed
        if (videoId !== this._preloadedVideoId) return

        this._preloadedVideoId = videoId
        this.audio.preloadNext(resolved.audioUrl)
        this.log(`preloadNext: loaded ${videoId}`)
      }).catch(() => {
        this.log(`preloadNext: failed to resolve ${videoId}`)
      })
    }).catch(() => {})
  }

  async refreshState(): Promise<void> {
    try {
      const q = await this.api.getQueue()
      this._state.queueList = q.list
      this._state.queueIndex = q.index
      this._state.shuffleActive = q.shuffleActive
      this._state.repeatMode = q.repeatMode as RepeatMode
      this.emit()
    } catch (err: any) {
      this.log(`refreshState error: ${err.message}`)
    }
  }

  private handleError(err: any): void {
    const msg = err?.message || String(err)
    this.log(`error: ${msg}`)
    this._state.state = 'error'
    this._state.error = msg
    this.emit()
  }

  private setMediaState(state: MediaState): void {
    this._state.state = state
    this._state.error = null
    this.emit()
  }

  private emit(): void {
    const snapshot: MediaEngineState = {
      ...this._state,
      isNextReady: this.audio.isNextReady(),
    }

    for (const listener of this._listeners) {
      listener(snapshot)
    }
  }

  private computeUpcomingVideoIds(fromIndex: number, count: number): string[] {
    const result: string[] = []
    const list = this._state.queueList
    for (let i = fromIndex + 1; i < list.length && result.length < count; i++) {
      const ref = list[i]
      const videoId = ref.track.id || ref.track.sourceId
      if (videoId) result.push(videoId)
    }
    return result
  }

  private log(msg: string): void {
    const elapsed = this._opStart > 0 ? `[+${Date.now() - this._opStart}ms] ` : ''
    this.logger?.(`[engine] ${elapsed}[vid=${this._currentVideoId}] ${msg}`)
  }

  /** Start timing for elapsed log prefixes. Call at entry of each public operation. */
  private t0(): void { this._opStart = Date.now() }
}
