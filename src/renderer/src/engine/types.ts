import type {
  Track,
  RepeatMode,
  QueueTrackRef,
  ResolvedStream
} from '../../../shared/types'

// ── Audio abstraction (wraps useAudioPlayer) ──
// Engine reads audio state via getters, commands via methods.
export interface AudioBridge {
  loadAndPlay(url: string): Promise<void>
  preloadNext(url: string): void
  swapToNext(): Promise<boolean>
  play(): Promise<void>
  pause(): void
  seek(time: number): void
  setVolume(volume: number): void
  setOnTrackEnd(cb: () => void): void
  // Read side — engine needs these for swap/toggle decisions
  isNextReady(): boolean
  isPlaying(): boolean
  /** Return the current audio error message, if any */
  getError(): string | null
  /** Abort pending play() by clearing the active element's src.
   *  Next loadAndPlay will resolve cleanly without racing stale play(). */
  cancelPendingPlay(): void
}

// ── IPC abstraction (wraps window.api subset) ──
// Engine calls these to interact with main process (QueueEngine, media-resolver, proxy).
export interface ApiBridge {
  resolveTrack(videoId: string, opts?: { forceRefresh?: boolean }): Promise<ResolvedStream>
  resolveTrackInfo(videoId: string): Promise<ResolvedStream>
  queueNext(): Promise<{ queueId: string; track: Track; index: number } | null>
  queuePrev(): Promise<{ queueId: string; track: Track; index: number } | null>
  queuePeekNext(): Promise<{ track: Track; index: null } | null>
  getQueue(): Promise<{
    list: QueueTrackRef[]
    index: number
    shuffleActive: boolean
    repeatMode: string
  }>
  addToQueue(tracks: Track | Track[]): Promise<QueueTrackRef[]>
  prefetchQueue(upcomingVideoIds: string[]): Promise<boolean>
  setShuffle(active?: boolean): Promise<{
    shuffleActive: boolean
    list: QueueTrackRef[]
    index: number
  }>
  setRepeat(mode: RepeatMode): Promise<string>
}

// ── Engine observable state ──

export type MediaState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface MediaEngineState {
  currentTrack: Track | null
  state: MediaState
  currentTime: number
  duration: number
  volume: number
  error: string | null
  isNextReady: boolean
  queueList: QueueTrackRef[]
  queueIndex: number
  shuffleActive: boolean
  repeatMode: RepeatMode
}

export type MediaEngineListener = (state: MediaEngineState) => void