import type { AudioBridge, ApiBridge, MediaEngineState, MediaEngineListener, MediaState } from './types'
import type { Track, RepeatMode, SearchResult, ResolvedStream } from '../../../shared/types'

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
  /** Flag: set when a user navigation (playFromQueue, next, etc.) is in progress.
   *  Suppresses _onMidPlaybackError to prevent the error handler from incrementing
   *  _requestCounter and invalidating the navigation's operation guard. */
  private _navigating = false
  /** Pending skip count accumulated during an in-progress advance.
   *  When the user rapidly clicks ⏭ N times, we count them here and
   *  fast-forward the queue in one batch instead of processing each
   *  skip sequentially with a full resolve+load cycle. */
  private _pendingSkips = 0
  /** Advance generation counter. Incremented on every next() call.
   *  Guards _advancing in the finally block: only the most recent
   *  advance's finally may reset _advancing. Prevents a zombie
   *  _nextImpl() (that recovered after hang-timer reset) from
   *  clobbering the mutex of a subsequent advance. */
  private _advanceGen = 0
  /** Mutex: prevents concurrent prev() calls from racing against each other or next(). */
  private _prevInProgress = false
  private _currentVideoId = ''
  private _preloadedVideoId = ''
  private _listeners = new Set<MediaEngineListener>()
  /** Timestamp when the current operation started (for elapsed timing in logs) */
  private _opStart = 0
  /** Timestamp when the current track started playing (performance.now).
   *  Used by onTrackEnded to detect truncated streams that end before the
   *  expected duration — if the track ends in < 30s, it's likely a YouTube
   *  preview/stale URL, and we re-resolve with forceRefresh instead of advancing. */
  private _trackStartedAt = 0
  /** Per-video retry count for truncated-stream replay. Reset when a track plays past MIN_PLAY_MS. */
  private _truncatedRetries = new Map<string, number>()
  /** Per-video retry count for mid-playback errors (CDN truncation after play() resolved). */
  private _midPlaybackErrorCount = new Map<string, number>()
  /** Max mid-playback retries per track before giving up. Each retry runs
   *  _retryPlayback with 5 attempts and exponential backoff (total ~3.75s).
   *  Retrying 3× means up to ~11s of dead backoff before advancing — too slow.
   *  Set to 1: one retry cycle, then advance to the next track immediately. */
  private readonly MAX_MID_PLAYBACK_RETRIES = 1

  constructor(
    private audio: AudioBridge,
    private api: ApiBridge,
    private logger?: (msg: string) => void
  ) {
    this.audio.setOnTrackEnd(() => this.onTrackEnded())
  }

  /**
   * Called when the audio element errors mid-playback (after play() already resolved).
   * Retries the current track with a fresh CDN URL (forceRefresh) up to MAX_MID_PLAYBACK_RETRIES times.
   * Cleared during retry loop in _retryPlayback to prevent concurrent retries.
   */
  private _onMidPlaybackError = (): void => {
    const videoId = this._currentVideoId
    if (!videoId) return

    // If a user navigation (playFromQueue, next, etc.) is in progress,
    // suppress this stale error. Without this guard, ++this._requestCounter
    // below steals the operation ID and causes the navigation to bail out
    // via its stale-operation guard, leaving the old track's broken stream.
    if (this._navigating) {
      console.warn(`[media] _onMidPlaybackError suppressed — navigation in progress`)
      return
    }

    const errorCount = (this._midPlaybackErrorCount.get(videoId) ?? 0) + 1
    if (errorCount > this.MAX_MID_PLAYBACK_RETRIES) {
      this.log(`mid-playback: retry limit reached for ${videoId}, advancing to next track`)
      this.audio.setOnError(null)
      this._midPlaybackErrorCount.delete(videoId)
      // Advance to the next track instead of entering error state and
      // waiting ~11s for the poll-based truncated-stream recovery to
      // detect the stall. When a track's CDN URLs all serve truncated
      // streams or are consistently expired, the fastest recovery is
      // to skip it and play the next track in the queue.
      this.next()
        .catch((err) => { this.log(`mid-playback: next() after retry limit error: ${err.message}`) })
      return
    }
    this._midPlaybackErrorCount.set(videoId, errorCount)

    this.log(`mid-playback error for ${videoId}, retrying (${errorCount}/${this.MAX_MID_PLAYBACK_RETRIES})`)

    // Prevent re-entry — _retryPlayback will re-enable on success
    this.audio.setOnError(null)
    const retryOpId = ++this._requestCounter
    // 🔥 For mid-playback errors, ALWAYS use forceRefresh. The cached CDN URL
    // already served a truncated stream — retrying with it hits the same
    // broken CDN edge (attempt 0 in _retryPlayback uses no forceRefresh, and
    // since loadAndPlay resolves instantly when the stream starts, the error
    // fires AFTER loadAndPlay returns — so attempt 0 ALWAYS succeeds and the
    // forceRefresh attempts 1-4 are never reached).
    // forceRefresh clears the proxy cache and gets a fresh URL that routes to
    // a different CDN edge, giving us a chance at a full stream.
    const refreshResolve = (id: string, _opts?: { forceRefresh?: boolean }) =>
      this.api.resolveTrack(id, { forceRefresh: true })
    this._retryPlayback(videoId, refreshResolve, retryOpId)
      .then(() => {
        // 🔥 Restore the preloaded next track. _retryPlayback calls loadAndPlay
        // which clears the standby element. Without preloadNext here, the
        // standby stays empty until the next track ends — forcing a slow
        // resolve path (~600ms gap) instead of instant swap.
        if (this._requestCounter === retryOpId) {
          this.preloadNext()
        }
      })
      .catch((err: any) => {
        if (err?.message === 'STALE_OPERATION') {
          this.log('Retry abandoned — new operation started')
          return
        }
        if (this._requestCounter !== retryOpId) return
        this.log(`mid-playback: all retries exhausted for ${videoId}, advancing — last error: ${err?.message}`)
        this.next()
          .catch((nextErr: any) => { this.log(`mid-playback: next() after retry exhaustion error: ${nextErr?.message}`) })
      })
  }

  /**
   * Retry playback with forceRefresh + exponential backoff.
   * Handles the YouTube CDN truncated-stream edge case where a CDN edge
   * returns a stream that plays ~3s then errors. Each retry gets a fresh
   * CDN URL (forceRefresh clears the proxy cache), routing to a different
   * edge. Retries up to 4 times with backoff: 250ms, 500ms, 1000ms, 2000ms
   * between attempts.
   *
   * Returns normally on success. Throws if all attempts fail (caught by
   * the caller's outer catch).
   */
  private async _retryPlayback(
    videoId: string,
    resolveFn: (id: string, opts?: { forceRefresh?: boolean }) => Promise<ResolvedStream>,
    opRequestId: number
  ): Promise<void> {
    let lastError: Error | undefined

    // Disable mid-playback error callback during retry loop.
    // Re-enabled below on success so future mid-playback errors trigger a fresh retry.
    this.audio.setOnError(null)

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (this._requestCounter !== opRequestId) throw new Error('STALE_OPERATION')

        const opts = attempt === 0 ? undefined : { forceRefresh: true }
        const resolved = await resolveFn(videoId, opts)

        if (this._requestCounter !== opRequestId) throw new Error('STALE_OPERATION')
        await this.audio.loadAndPlay(resolved.audioUrl)

        if (this._requestCounter !== opRequestId) throw new Error('STALE_OPERATION')

        // Set _currentVideoId BEFORE registering the mid-playback error handler.
        // The callers (playFromQueue, playSearchResult, playCustomId) also set
        // _currentVideoId after _retryPlayback returns, but there's a race window
        // between onError handler registration and the caller's set — if the audio
        // errors in that window, _onMidPlaybackError sees empty _currentVideoId and
        // silently gives up instead of retrying.
        this._currentVideoId = videoId

        // Success — enable mid-playback error handler for future CDN truncation errors
        this.audio.setOnError(this._onMidPlaybackError)
        return
      } catch (err) {
        if (err instanceof Error && err.message === 'STALE_OPERATION') throw err
        this.audio.setOnError(null) // Keep disabled on failed attempt
        lastError = err instanceof Error ? err : new Error(String(err))
        this.log(`_retryPlayback: attempt ${attempt + 1}/5 failed for ${videoId}`)

        if (this._requestCounter !== opRequestId) return
        if (attempt < 4) {
          await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)))
        }
      }
    }

    // All attempts exhausted — keep mid-playback error handler disabled
    this.audio.setOnError(null)
    throw lastError ?? new Error(`Playback failed after 5 attempts for ${videoId}`)
  }

  // ── Public API ──

  async playFromQueue(idx: number): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this._navigating = true
    this.log(`playFromQueue: idx=${idx}`)

    const qList = this._state.queueList
    if (idx < 0 || idx >= qList.length) {
      this.log(`playFromQueue: index ${idx} out of range (queue length ${qList.length})`)
      this._navigating = false
      return
    }

    this.setMediaState('loading')

    // Sync QueueEngine index on main process so next()/previous()
    // advance from the correct position and refreshState() returns
    // the right queueIndex (~2ms IPC round-trip, negligible latency).
    await this.api.jumpToQueueIndex(idx)

    // 🔥 Stop current audio. Without this, setting a new src in loadAndPlay
    // while a previous track is still playing causes Chromium to hang the
    // new play() promise (the old play() gets rejected but the element stays
    // in a bad state). Pause + yield is sufficient — setting el.src = url
    // inside loadAndPlay aborts any pending play() per the HTML spec.
    this.audio.pause()

    // ⏳ Yield to the event loop so Chromium can settle any pending audio
    // event handlers (pause, error, etc.) from the previous track before
    // we start loadAndPlay on a new URL. Without this yield, stale events
    // from the old playback can race against the new load and put the
    // audio element in a bad state.
    //
    // ⚠️ Do NOT use cancelPendingPlay (el.src='' + load()) here: it fires
    // an error event asynchronously that races against loadAndPlay's own
    // error listener, causing new tracks to fail immediately. Pause + yield
    // is sufficient — setting el.src = url inside loadAndPlay already aborts
    // any pending play() per the HTML spec.
    await new Promise((r) => setTimeout(r, 0))

    try {
      const queueRef = qList[idx]
      const videoId = queueRef.track.id || queueRef.track.sourceId

      // Instant swap path: if preloaded matches, try swap
      if (videoId === this._preloadedVideoId && this.audio.isNextReady()) {
        this.log(`playFromQueue: instant swap (preloaded hit)`)
        // 🔥 Same fix as _nextImpl: disable old error handler before swap
        // to prevent stale clearing events from retrying the previous track.
        this.audio.setOnError(null)
        this._currentVideoId = videoId
        const swapped = await this.audio.swapToNext()
        if (swapped) {
          if (this._requestCounter !== opRequestId) return
          // Re-enable error handler for the new track
          this.audio.setOnError(this._onMidPlaybackError)
          this._state.currentTrack = queueRef.track
          this._state.queueIndex = idx
          this._state.currentTime = 0
          this._state.duration = queueRef.track.duration || 0
          this._state.state = 'playing'
          this._state.error = null
          this._preloadedVideoId = ''
          this.emit()
          this._truncatedRetries.delete(this._currentVideoId)
          this._midPlaybackErrorCount.delete(this._currentVideoId)
          this._trackStartedAt = performance.now()
          this.preloadNext()
          await this.refreshState()
          return
        }
        // Swap failed, fall through to normal path
      }

      // Normal resolve path
      const resolved = await this.api.resolveTrack(videoId)
      if (this._requestCounter !== opRequestId) return

      await this._retryPlayback(videoId, this.api.resolveTrack.bind(this.api), opRequestId)
      if (this._requestCounter !== opRequestId) return

      // Re-check the audio element didn't land in error state
      // (defensive — loadAndPlay should have thrown, but some
      //  browser edge-cases resolve play() then immediately error)
      if (this.audio.getError?.()) {
        throw new Error(this.audio.getError()!)
      }

      this._currentVideoId = videoId
      // Use the queue track's existing title immediately. The resolved.title
      // is 'Loading...' until background metadata resolves — don't show that.
      const initialTitle = queueRef.track.title || resolved.title
      this._state.currentTrack = { ...queueRef.track, title: initialTitle }
      this._state.queueIndex = idx
      this._state.currentTime = 0
      this._state.duration = queueRef.track.duration || 0
      this._state.state = 'playing'
      this._state.error = null
      this.emit()
      this._truncatedRetries.delete(this._currentVideoId)
      this._midPlaybackErrorCount.delete(this._currentVideoId)
      this._trackStartedAt = performance.now()
      this.log(`playFromQueue: playing "${initialTitle}"`)

      // Background: try to get a more accurate title from yt-dlp/Innertube metadata.
      // If this fails (yt-dlp timeout, etc.), we keep the queue track's title.
      this.api.resolveTrackInfo(videoId).then((info) => {
        if (this._requestCounter !== opRequestId) return
        if (!this._state.currentTrack || this._state.currentTrack.id !== videoId) return
        const betterTitle = info.title && info.title !== 'Unknown' ? info.title : initialTitle
        this._state.currentTrack = { ...this._state.currentTrack, title: betterTitle }
        this.emit()
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
      this._navigating = false
      // If THIS operation is the latest and state is stuck at 'loading'
      // (e.g. because loadAndPlay's play() hung on a bad URL), reset to 'idle'
      // so the UI is responsive and the user can try again.
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async playSearchResult(result: SearchResult): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this._navigating = true
    this.log(`playSearchResult: ${result.title}`)

    this.setMediaState('loading')

    try {
      if (this._requestCounter !== opRequestId) return

      // Fresh manual play — clear any stale truncated-stream retry counter
      this._truncatedRetries.delete(result.videoId)
      this._midPlaybackErrorCount.delete(result.videoId)

      const track: Track = {
        id: result.videoId,
        title: result.title,
        artist: result.artist,
        duration: result.duration,
        thumbnailUrl: result.thumbnail,
        source: 'youtube',
        sourceId: result.videoId,
      }

      await this._retryPlayback(result.videoId, this.api.resolveTrack.bind(this.api), opRequestId)
      if (this._requestCounter !== opRequestId) return

      this._currentVideoId = result.videoId
      // Use the search-result title immediately. The resolved.title is 'Loading...'
      // placeholder until background metadata resolves — don't show that to the user.
      this._state.currentTrack = { ...track, title: result.title || track.title }
      this._state.currentTime = 0
      this._state.state = 'playing'
      this._state.error = null
      this.emit()
      this.log(`playSearchResult: playing "${result.title}"`)

      // Add to queue in background
      this.api.addToQueue(track).catch(() => {})

      // Background: try to get a more accurate title from yt-dlp/Innertube metadata.
      // If this fails (yt-dlp timeout, etc.), we keep the search result title instead
      // of letting it regress to 'Unknown'.
      this.api.resolveTrackInfo(result.videoId).then((info) => {
        if (this._requestCounter !== opRequestId) return
        if (!this._state.currentTrack || this._state.currentTrack.id !== result.videoId) return
        const betterTitle = info.title && info.title !== 'Unknown' ? info.title : result.title
        this._state.currentTrack = { ...this._state.currentTrack, title: betterTitle }
        this.emit()
      }).catch(() => {})

      this.preloadNext()
      await this.refreshState()
    } catch (err: any) {
      if (this._requestCounter !== opRequestId) return
      this.handleError(err)
    } finally {
      this._navigating = false
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async playCustomId(id: string): Promise<void> {
    this.t0()
    const opRequestId = ++this._requestCounter
    this._navigating = true
    this.log(`playCustomId: ${id}`)

    this.setMediaState('loading')

    try {
      const resolved = await this.api.resolveTrack(id)
      if (this._requestCounter !== opRequestId) return

      // Fresh manual play — clear any stale truncated-stream retry counter
      this._truncatedRetries.delete(id)
      this._midPlaybackErrorCount.delete(id)

      await this._retryPlayback(id, this.api.resolveTrack.bind(this.api), opRequestId)
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
      this._navigating = false
      if (this._requestCounter === opRequestId && this._state.state === 'loading') {
        this._state.state = 'idle'
        this.emit()
      }
    }
  }

  async next(): Promise<void> {
    this.t0()
    // 🚨 DIAGNOSTIC: log EVERY next() call with caller stack trace,
    // regardless of _pendingAdvance state. This catches callers
    // that bypass onTrackEnded() entirely — the user's bug shows
    // next: requesting next track with NO preceding auto-advance log.
    const stack = new Error().stack?.split('\n').slice(2, 5).join(' → ') ?? 'no stack'
    this.log(`next: CALLED (pendingAdvance=${this._pendingAdvance}) — stack: ${stack}`)

    // ⚠️ Mutex: prevent concurrent next() calls.
    // Without this, if auto-advance fires next() and the user clicks ⏭
    // before it resolves, QueueEngine.next() runs twice, skipping a track.
      if (this._advancing) {
        this._pendingSkips++
        // 🚨 Log the caller of queued advances. Despite the mutex guard,
        // _pendingSkips accumulates to 5+ during a single _nextImpl() via
        // an unidentified path. The stack trace identifies the mystery caller.
        const qStack = new Error().stack?.split('\n').slice(2, 5).join(' → ') ?? 'no stack'
        this.log(`next: queued advance (pending=${this._pendingSkips}) — caller: ${qStack}`)
        return
      }

    // Advance generation: guards _advancing in finally against zombie resets.
    // If a hang-timer-recovered _nextImpl finishes after a new advance started,
    // its stale finally can't clobber the new advance's mutex.
    const advanceGen = ++this._advanceGen
    this._advancing = true
    this._navigating = true
    // Advance-hang recovery: auto-reset _advancing if _nextImpl takes >10s.
    // Prevents permanent ⏭ lockout if IPC hangs or swapToNext never settles.
    const hangTimer = setTimeout(() => {
      if (this._advancing) {
        this.log('next: hang recovery — _advancing auto-reset after 10s')
        this._advancing = false
        this._pendingSkips = 0
      }
    }, 10000)
    try {
      // Process ONE advance (full resolve + load)
      await this._nextImpl()
    } finally {
      this._navigating = false
      clearTimeout(hangTimer)
      // Only reset _advancing if we're still the current generation.
      // A zombie _nextImpl (recovered after hang-timer + new advance)
      // must not clobber the new advance's mutex.
      if (this._advanceGen === advanceGen) this._advancing = false
      // 🚫 ZERO pending skips — prevent ANY cascade.
      // The cascade bug (tracks skipping every 24s) is caused by
      // _pendingSkips accumulating during _nextImpl() through an
      // unidentified path. Our earlier fix of "process at most 1"
      // STILL caused a skip (one recursive advance). The only safe
      // fix is to discard all pending skips — user ⏭ clicks during
      // the ~100ms advance window are lost, which is far better than
      // tracks skipping mid-song.
      if (this._pendingSkips > 0) {
        this.log(`next: discarded ${this._pendingSkips} queued advances (cascade prevention)`)
        this._pendingSkips = 0
      }
    }
  }

  /** Internal next() implementation — NO mutex, called by next() and by error-recovery recursion. */
  private async _nextImpl(errorSkipCount = 0): Promise<void> {
    const implStack = new Error().stack?.split('\n').slice(2, 5).join(' → ') ?? 'no stack'
    this.log(`next: requesting next track (caller: ${implStack})`)

    let skipCount = errorSkipCount

    while (true) {
      // queueNext with its own error handling
      let result: any = null
      try {
        result = await this.api.queueNext()
      } catch (err: any) {
        this.log('Failed to get next track from queue: ' + (err instanceof Error ? err.message : String(err)))
        skipCount++
        if (skipCount >= (this._state.queueList?.length ?? 0)) {
          this.log('All queue navigation attempts exhausted')
          this._state.state = 'idle'
          this._state.error = 'Unable to navigate queue'
          this.emit()
          return
        }
        this.log(`Skipping failed queue navigation (${skipCount} skips)`)
        continue
      }

      if (!result) {
        this.log('next: end of queue')
        this._state.state = 'ended'
        this.emit()
        return
      }

      const videoId = result.track.id || result.track.sourceId

      // Check if preloaded matches — instant swap
      if (videoId === this._preloadedVideoId && this.audio.isNextReady()) {
        this.log(`next: instant swap (preloaded ${videoId})`)
        this.audio.setOnError(null)
        try {
          const swapped = await this.audio.swapToNext()
          if (swapped) {
            this._preloadedVideoId = ''
            this._currentVideoId = videoId
            this._state.queueIndex = result.index
            this._state.state = 'playing'
            this._state.error = null
            this.emit()
            this.audio.setOnError(this._onMidPlaybackError)
            this.preloadNext()
            return
          }
        } catch (err: any) {
          this.log(`next: swap failed: ${err?.message}`)
        }
        this.audio.setOnError(this._onMidPlaybackError)
        this.log('next: swap failed, falling through to resolve')
      }

      // Abort guard 1
      await this.refreshState()
      if (this._state.queueIndex !== result.index) {
        this.log(`next: queue changed (now ${this._state.queueIndex}), aborting`)
        return
      }

      // Normal resolve path
      await this.playFromQueue(result.index)

      // Abort guard 2
      await this.refreshState()
      if (this._state.queueIndex !== result.index) {
        this.log(`next: queue changed (now ${this._state.queueIndex}) after playFromQueue, aborting`)
        return
      }

      // Track failed to play — skip ahead
      if (this._state.state === 'error') {
        skipCount++
        this.log(`next: track at index ${result.index} failed, skipping ahead (skip ${skipCount}/${this._state.queueList.length})`)
        if (skipCount >= this._state.queueList.length) {
          this.log('next: all tracks failed, stopping')
          this._state.state = 'idle'
          this._state.error = 'All tracks failed to play'
          this.emit()
          return
        }
        this._state.state = 'idle'
        this._state.error = null
        this.emit()
        continue
      }

      return
    }
  }

  async prev(): Promise<void> {
    this.t0()
    if (this._prevInProgress || this._advancing) return
    this._prevInProgress = true
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
    } finally {
      this._prevInProgress = false
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
      this.handleError(err, { playbackError: false })
    }
  }

  async toggleRepeat(nextMode: RepeatMode): Promise<void> {
    this.log(`toggleRepeat: ${nextMode}`)
    try {
      await this.api.setRepeat(nextMode)
      await this.refreshState()
    } catch (err: any) {
      this.handleError(err, { playbackError: false })
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
    if (this._pendingAdvance) {
      this.log('auto-advance: blocked (pending advance in progress)')
      return
    }
    // 🔥 Prevent double-advance: if a next() call is already in progress
    // (user clicked ⏭ or a previous auto-advance), don't queue another
    // advance. Without this guard, the DOM 'ended' event or poll interval
    // can fire during _nextImpl execution (detecting the old track's end),
    // accumulating _pendingSkips. After _nextImpl completes, the pending
    // skip causes the newly started track to immediately advance to the
    // next one — the user hears nothing and the song appears to "skip."
    //
    // This also prevents stale 'ended' events from a cleared element
    // (queued by the browser before swapToNext cleared it) from causing
    // an unwanted advance after the new track is already playing.
    if (this._advancing) {
      this.log('auto-advance: skipped (already advancing)')
      return
    }

    // If the track ended very early (<30s), the CDN served a truncated
    // stream. Don't retry — the mid-playback error handler already tried
    // force-refresh retries. Advancing to the next track is better UX
    // than replaying the same truncated snippet from the beginning.
    // Track ended at a reasonable point — normal auto-advance.
    const MIN_PLAY_MS = 30000
    const elapsed = performance.now() - this._trackStartedAt
    if (this._currentVideoId && elapsed < MIN_PLAY_MS && this._trackStartedAt > 0) {
      this.log(`auto-advance: truncated stream (<30s) for ${this._currentVideoId}, advancing`)
      this._pendingAdvance = true
      this.next()
        .catch((err: any) => {
          this.log('Failed to advance to next track: ' + (err instanceof Error ? err.message : String(err)))
          this.handleError(err instanceof Error ? err : new Error(String(err)))
        })
        .finally(() => { this._pendingAdvance = false })
      return
    }

    this._pendingAdvance = true
    this.log('auto-advance: track ended')
    this.next()
      .catch((err: any) => {
        this.log('Failed to advance to next track: ' + (err instanceof Error ? err.message : String(err)))
        this.handleError(err instanceof Error ? err : new Error(String(err)))
      })
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

      // Set ahead of async resolve so the race guard below works correctly
      this._preloadedVideoId = videoId

      // No forceRefresh needed: the proxy's 403/410 handler re-resolves stale
      // stream URLs automatically, and playFromQueue retries with forceRefresh
      // if the first resolve fails. Preload is speculative — let the cache serve.
      this.api.resolveTrack(videoId).then((resolved) => {
        // Skip-spam: check we're still on the same preload request
        if (this._preloadCounter !== capturedId) return
        // Double-check the preload target hasn't changed
        if (videoId !== this._preloadedVideoId) return

        this.audio.preloadNext(resolved.audioUrl)
        this.log(`preloadNext: loaded ${videoId} in ${Date.now()-this._opStart}ms`)
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

  private handleError(err: unknown, options?: { playbackError?: boolean }): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.log('Error: ' + msg)
    if (options?.playbackError !== false) {
      this._state.state = 'error'
      this._state.error = msg
    }
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
