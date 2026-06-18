import type { Track } from '../shared/types'
import type { RepeatMode } from '../shared/types'

// ── Types ──

export type { RepeatMode }

export interface QueueTrack {
  queueId: string
  track: Track
}

export interface QueueEngineState {
  list: QueueTrack[]
  index: number
  history: string[]
  shuffleActive: boolean
  repeatMode: RepeatMode
}

// ── Internal Mutable State ──

let _queueIdCounter = 0
const state: QueueEngineState = {
  list: [],
  index: -1,
  history: [],
  shuffleActive: false,
  repeatMode: 'none',
}

// ── Helpers ──

function nextQueueId(): string {
  return `q_${Date.now()}_${++_queueIdCounter}`
}

function wrapTrack(track: Track): QueueTrack {
  return { queueId: nextQueueId(), track }
}

// ── Core Methods ──

function clear(): void {
  state.list = []
  state.index = -1
  state.history = []
}

function setQueue(tracks: Track[], startIndex: number): void {
  state.list = tracks.map(wrapTrack)
  state.index = startIndex >= 0 && startIndex < state.list.length ? startIndex : 0
  state.history = []
}

function next(): QueueTrack | null {
  if (state.list.length === 0) return null

  // Record current position in history before moving
  const current = state.list[state.index]
  if (current) {
    state.history.push(current.queueId)
  }

  if (state.repeatMode === 'one') {
    // Repeat current track — index stays the same
    return state.list[state.index]
  }

  if (state.shuffleActive) {
    const nextIndex = Math.floor(Math.random() * state.list.length)
    state.index = nextIndex
    return state.list[nextIndex]
  }

  if (state.index < state.list.length - 1) {
    state.index++
    return state.list[state.index]
  }

  // End of queue
  if (state.repeatMode === 'all') {
    state.index = 0
    return state.list[0]
  }

  // 'NONE' — stop at end
  state.index = state.list.length // beyond last
  return null
}

function previous(): QueueTrack | null {
  if (state.list.length === 0) return null

  if (state.history.length > 0) {
    const prevQueueId = state.history.pop()!
    const prevIndex = state.list.findIndex(qt => qt.queueId === prevQueueId)
    if (prevIndex >= 0) {
      state.index = prevIndex
      return state.list[prevIndex]
    }
  }

  // No history fallback: go to previous index
  if (state.index > 0) {
    state.index--
    return state.list[state.index]
  }

  if (state.repeatMode === 'all') {
    state.index = state.list.length - 1
    return state.list[state.index]
  }

  return null
}

function reorder(fromIndex: number, toIndex: number): void {
  if (fromIndex < 0 || fromIndex >= state.list.length) return
  if (toIndex < 0 || toIndex >= state.list.length) return

  const [moved] = state.list.splice(fromIndex, 1)
  state.list.splice(toIndex, 0, moved)

  // Adjust current index if needed
  if (state.index === fromIndex) {
    state.index = toIndex
  } else if (fromIndex < state.index && toIndex >= state.index) {
    state.index--
  } else if (fromIndex > state.index && toIndex <= state.index) {
    state.index++
  }
}

function getCurrentTrack(): Track | null {
  if (state.index < 0 || state.index >= state.list.length) return null
  return state.list[state.index]?.track ?? null
}

function peekNext(): Track | null {
  if (state.list.length === 0) return null

  if (state.repeatMode === 'one') {
    return state.list[state.index]?.track ?? null
  }

  if (state.shuffleActive) {
    // Pick a random track different from current
    let idx: number
    do {
      idx = Math.floor(Math.random() * state.list.length)
    } while (idx === state.index && state.list.length > 1)
    return state.list[idx]?.track ?? null
  }

  const nextIdx = state.index + 1
  if (nextIdx < state.list.length) {
    return state.list[nextIdx]?.track ?? null
  }

  if (state.repeatMode === 'all') {
    return state.list[0]?.track ?? null
  }

  return null
}

function getCurrentIndex(): number {
  return state.index
}

function getRepeatMode(): RepeatMode {
  return state.repeatMode
}

function setRepeatMode(mode: RepeatMode): void {
  state.repeatMode = mode
}

function isShuffleActive(): boolean {
  return state.shuffleActive
}

function setShuffleActive(active: boolean): void {
  state.shuffleActive = active
}

function getStateForTest(): QueueEngineState {
  return { ...state, list: [...state.list], history: [...state.history] }
}

// ── Exported Singleton ──

export const QueueEngine = {
  clear,
  setQueue,
  next,
  previous,
  reorder,
  getCurrentTrack,
  peekNext,
  getCurrentIndex,
  getRepeatMode,
  setRepeatMode,
  isShuffleActive,
  setShuffleActive,
  /** Exposed for testing only */
  _getState: getStateForTest,
}
