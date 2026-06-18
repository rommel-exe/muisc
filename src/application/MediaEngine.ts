import { AudioService } from '../playback/AudioService'
import { MediaResolver } from '../playback/MediaResolver'
import { QueueEngine } from './QueueEngine'
import type { Track } from '../shared/types'
import type { PlaybackStateType } from '../shared/types'

// ── Types ──

export type PlaybackStateValue = PlaybackStateType

// ── Internal Mutable State ──

let _playbackState: PlaybackStateValue = 'IDLE'
let _activeTrack: Track | null = null
let _volume = 0.8
let _currentTime = 0

/** Monotonically increasing request counter for concurrency protection */
let _requestSeq = 0

/** Cached stream URL for the current active track (used by togglePlay resume) */
let _currentStreamUrl = ''

/** Guard flag prevents concurrent resolve chains in handleAudioEnded */
let _isHandleAudioEndedResolving = false

// ── Core Methods ──

function getPlaybackState(): PlaybackStateValue {
  return _playbackState
}

function getActiveTrack(): Track | null {
  return _activeTrack
}

function getVolume(): number {
  return _volume
}

function setVolume(vol: number): void {
  _volume = Math.max(0, Math.min(1, vol))
}

function getCurrentTime(): number {
  return _currentTime
}

/**
 * Play a track, handling concurrency and error recovery.
 *
 * Concurrency protection: if playTrack is called while a previous resolve
 * is in-flight, the previous request is superseded. Only the last call's
 * result affects the active state.
 *
 * Error recovery: if the stream URL cannot be resolved, the engine
 * auto-advances to the next track in the queue and tries again.
 */
async function playTrack(track: Track, _options?: { seekTo?: number }): Promise<void> {
  const seq = ++_requestSeq
  await executePlay(track, seq)
}

async function executePlay(track: Track, seq: number): Promise<void> {
  // Cancel previous audio
  AudioService.stop()
  _playbackState = 'BUFFERING'
  _activeTrack = track
  _currentTime = 0

  try {
    const url = await MediaResolver.resolve(track.id)

    // If a newer playTrack call has superseded this one, don't update state
    if (seq !== _requestSeq) return

    _currentStreamUrl = url
    AudioService.play(url)
    _playbackState = 'PLAYING'
    _currentTime = 0
  } catch (_err) {
    // If superseded, don't handle error — the newer request is in charge
    if (seq !== _requestSeq) return

    // Self-healing: advance queue and try next track
    const nextTrack = QueueEngine.next()
    if (nextTrack) {
      await executePlay(nextTrack.track, seq)
    } else {
      _playbackState = 'ERRORED'
      _activeTrack = null
    }
  }
}

/**
 * Toggle between PLAYING and PAUSED.
 */
function togglePlay(): void {
  if (_playbackState === 'PLAYING') {
    AudioService.pause()
    _playbackState = 'PAUSED'
  } else if (_playbackState === 'PAUSED') {
    const url = _currentStreamUrl || _activeTrack?.id || ''
    AudioService.play(url)
    _playbackState = 'PLAYING'
  }
}

/**
 * Seek to a specific position in the current track.
 */
function seek(seconds: number): void {
  _currentTime = Math.max(0, seconds)
  AudioService.seek(_currentTime)
}

/**
 * Handle the natural end of the current audio track.
 * Advances the queue and starts playing the next track.
 *
 * Uses a resolving guard to prevent concurrent resolve chains
 * (e.g., if handleAudioEnded fires again while a previous
 * resolve is still pending).
 */
function handleAudioEnded(): void {
  if (_isHandleAudioEndedResolving) return
  _isHandleAudioEndedResolving = true

  const nextTrack = QueueEngine.next()
  if (nextTrack) {
    _activeTrack = nextTrack.track
    _playbackState = 'PLAYING'
    _currentTime = 0

    // Resolve for the next track
    MediaResolver.resolve(nextTrack.track.id)
      .then((url) => {
        _currentStreamUrl = url
        AudioService.play(url)
      })
      .catch(() => {
        // If next track fails, try the one after
        handleAudioEnded()
      })
      .finally(() => {
        _isHandleAudioEndedResolving = false
      })
  } else {
    // End of queue with no repeat — go idle
    _playbackState = 'IDLE'
    _activeTrack = null
    _currentTime = 0
    _isHandleAudioEndedResolving = false
  }
}

// ── Internal helpers (for PlaylistEngine hydration) ──

function _setVolumeDirect(vol: number): void {
  _volume = vol
}

// ── Exported Singleton ──

export const MediaEngine = {
  getPlaybackState,
  getActiveTrack,
  getVolume,
  setVolume,
  getCurrentTime,
  playTrack,
  togglePlay,
  seek,
  handleAudioEnded,
  /** Internal: used by PlaylistEngine.hydrateSession */
  _setVolumeDirect,
}
