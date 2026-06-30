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
  /** Max consecutive truncated-stream replays before giving up and advancing (prevents infinite loop). */
  private readonly MAX_TRUNCATED_RETRIES = 3

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
        const swapped = await this.audio.swapToNext()
        if (swapped) {
          if (this._requestCounter !== opRequestId) return
          this._currentVideoId = videoId
          this._state.currentTrack = queueRef.track
          this._state.queueIndex = idx
          this._state.currentTime = 0
          this._state.duration = queueRef.track.duration || 0
          this._state.state = 'playing'
          this._state.error = null
          this._preloadedVideoId = ''
          this.emit()
          this._truncatedRetries.delete(this._currentVideoId)
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

      // If audio fails, loadAndPlay now throws — caught below.
      // Retry once with forceRefresh for stale CDN URL recovery.
      try {
        await this.audio.loadAndPlay(resolved.audioUrl)
      } catch {
        this.log('playFromQueue: retrying with forceRefresh')
        const retried = await this.api.resolveTrack(videoId, { forceRefresh: true })
        if (this._requestCounter !== opRequestId) return
        await this.audio.loadAndPlay(retried.audioUrl)
      }
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
    this.log(`playSearchResult: ${result.title}`)

    this.setMediaState('loading')

    try {
      const resolved = await this.api.resolveTrack(result.videoId)
      if (this._requestCounter !== opRequestId) return

      // Fresh manual play — clear any stale truncated-stream retry counter
      this._truncatedRetries.delete(result.videoId)

      const track: Track = {
        id: result.videoId,
        title: result.title,
        artist: result.artist,
        duration: result.duration,
        thumbnailUrl: result.thumbnail,
        source: 'youtube',
        sourceId: result.videoId,
      }

      // If audio fails, loadAndPlay now throws — caught below.
      // Retry once with forceRefresh for stale CDN URL recovery.
      try {
        await this.audio.loadAndPlay(resolved.audioUrl)
      } catch {
        this.log('playSearchResult: retrying with forceRefresh')
        const retried = await this.api.resolveTrack(result.videoId, { forceRefresh: true })
        if (this._requestCounter !== opRequestId) return
        await this.audio.loadAndPlay(retried.audioUrl)
      }
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

      // Fresh manual play — clear any stale truncated-stream retry counter
      this._truncatedRetries.delete(id)

      // If audio fails, loadAndPlay now throws — caught below.
      // Retry once with forceRefresh for stale CDN URL recovery.
      try {
        await this.audio.loadAndPlay(resolved.audioUrl)
      } catch {
        this.log('playCustomId: retrying with forceRefresh')
        const retried = await this.api.resolveTrack(id, { forceRefresh: true })
        if (this._requestCounter !== opRequestId) return
        await this.audio.loadAndPlay(retried.audioUrl)
      }
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
    // 🚨 Log caller stack to catch direct calls that bypass next().
    // The cascade bug shows `next: requesting next track` WITHOUT a
    // preceding `auto-advance: track ended` or `next: CALLED` — meaning
    // _nextImpl() was called directly outside the mutex. This diagnostic
    // captures who that caller is.
    const implStack = new Error().stack?.split('\n').slice(2, 5).join(' → ') ?? 'no stack'
    this.log(`next: requesting next track (caller: ${implStack})`)
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
          // 🔥 Guard: user may have navigated to a different track while
          // swapToNext was executing. If the queue index changed, abort
          // the auto-advance — the user's explicit navigation takes priority.
          await this.refreshState()
          if (this._state.queueIndex !== result.index) {
            this.log('next: queue changed during swap, aborting auto-advance')
            return
          }
          this._currentVideoId = videoId
          this._state.currentTrack = result.track
          // queueIndex was already set by refreshState() — no need to
          // overwrite since it already matches result.index (guard above).
          this._state.currentTime = 0
          this._state.duration = result.track.duration || 0
          this._state.state = 'playing'
          this._state.error = null
          this._preloadedVideoId = ''
          this.emit()
          this._truncatedRetries.delete(this._currentVideoId)
          this._trackStartedAt = performance.now()
          this.preloadNext()
          // refreshState() already called above — skip duplicate
          return
        }
        this.log('next: swap failed, falling through to resolve')
      }

      // 🔥 Abort guard: the user may have navigated to a different track
      // while queueNext() was resolving (slow IPC round-trip). If the
      // queue index changed since the call, the user's explicit navigation
      // takes priority — abort the auto-advance without overriding their
      // selection. playFromQueue calls jumpToQueueIndex which would
      // overwrite the user's chosen index, clear history, and rebuild
      // shuffle order — all of which we must avoid.
      await this.refreshState()
      if (this._state.queueIndex !== result.index) {
        this.log(`next: queue changed since advance (expected=${result.index}, actual=${this._state.queueIndex}), aborting auto-advance`)
        return
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

    // 🚨 Truncated-stream detection: YouTube CDN can return preview-only
    // streams that play ~24s then end. If the track played for < 30s,
    // re-resolve with forceRefresh and retry instead of advancing.
    //
    // ⚠️ Capture the videoId at call time. If the user navigates to a
    // different track during the async re-resolve (clicked a different
    // search result or queue entry), _currentVideoId changes — the
    // navigation guard below prevents the stale replay from overriding
    // the user's selection.
    const MIN_PLAY_MS = 30000
    const elapsed = performance.now() - this._trackStartedAt
    const truncatedVideoId = this._currentVideoId
    if (truncatedVideoId && elapsed < MIN_PLAY_MS && this._trackStartedAt > 0) {
      // ⚠️ Retry limit: if the CDN consistently returns truncated URLs, give up
      // after MAX_TRUNCATED_RETRIES consecutive replays and advance instead of
      // looping the same ~24s snippet forever.
      const retries = (this._truncatedRetries.get(truncatedVideoId) ?? 0) + 1
      this._truncatedRetries.set(truncatedVideoId, retries)
      if (retries > this.MAX_TRUNCATED_RETRIES) {
        this.log(`auto-advance: truncated retry limit (${this.MAX_TRUNCATED_RETRIES}) for ${truncatedVideoId}, advancing`)
        this._truncatedRetries.delete(truncatedVideoId)
        this._pendingAdvance = true
        this.next()
          .catch((err) => { this.log(`auto-advance error: ${err.message}`) })
          .finally(() => { this._pendingAdvance = false })
        return
      }
      this.log(`auto-advance: truncated end at ${(elapsed/1000).toFixed(1)}s (retry ${retries}/${this.MAX_TRUNCATED_RETRIES}) — re-resolving ${truncatedVideoId} with forceRefresh`)
      this._pendingAdvance = true
      this.api.resolveTrack(truncatedVideoId, { forceRefresh: true })
        .then((resolved) => {
          // 🚨 Navigation guard: if the user navigated to a different track
          // during the async re-resolve, discard this stale replay.
          if (this._currentVideoId !== truncatedVideoId) {
            this.log('auto-advance: forceRefresh stale — user navigated away')
            return
          }
          return this.audio.loadAndPlay(resolved.audioUrl)
        })
        .then(() => {
          if (this._currentVideoId !== truncatedVideoId) return
          // ⚠️ Do NOT delete the retry counter on forceRefresh success —
          // the track may be getting the same truncated CDN URL again.
          // Only playFromQueue (which gets a fresh non-forceRefresh URL)
          // resets the counter when it starts playing this videoId.
          // Without this guard, the truncated-stream retry limit is
          // never reached and the track loops 2-3s forever.
          this._trackStartedAt = performance.now()
          this.log('auto-advance: forceRefresh replay succeeded')
        })
        .catch(() => {
          if (this._currentVideoId !== truncatedVideoId) return
          this.log('auto-advance: forceRefresh re-resolve failed, advancing')
          this.next()
            .catch((err) => { this.log(`auto-advance error: ${err.message}`) })
        })
        .finally(() => { this._pendingAdvance = false })
      return
    }

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
