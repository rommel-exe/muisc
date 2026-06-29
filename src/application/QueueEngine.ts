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
  shuffleOrder: number[]  // Fisher-Yates shuffled indices
  shufflePos: number      // current position in shuffle order
  repeatMode: RepeatMode
}

// ── Internal Mutable State ──

let _queueIdCounter = 0
const state: QueueEngineState = {
  list: [],
  index: -1,
  history: [],
  shuffleActive: false,
  shuffleOrder: [],
  shufflePos: 0,
  repeatMode: 'all',
}

// ── Helpers ──

function nextQueueId(): string {
  return `q_${Date.now()}_${++_queueIdCounter}`
}

function wrapTrack(track: Track): QueueTrack {
  return { queueId: nextQueueId(), track }
}

/**
 * Fisher-Yates shuffle of an array of indices.
 * Returns a new array shuffled in place.
 */
function fisherYatesShuffle(arr: number[]): number[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * Build a fresh shuffle order.
 *
 * Normal path: indices after the current index (remaining tracks).
 * Full reshuffle: ALL indices — used when repeat-all exhausts the shuffle
 * order and we loop back.
 */
function buildShuffleOrder(fullReshuffle: boolean = false): void {
  if (state.list.length === 0) {
    state.shuffleOrder = []
    state.shufflePos = 0
    return
  }

  if (fullReshuffle) {
    const all: number[] = Array.from({ length: state.list.length }, (_, i) => i)
    state.shuffleOrder = fisherYatesShuffle(all)
    state.shufflePos = 0
    return
  }

  const remaining: number[] = []
  for (let i = state.index + 1; i < state.list.length; i++) {
    remaining.push(i)
  }
  if (remaining.length > 0) {
    state.shuffleOrder = fisherYatesShuffle(remaining)
    state.shufflePos = 0
  } else {
    state.shuffleOrder = []
    state.shufflePos = 0
  }
}

// ── Core Methods ──

function clear(): void {
  state.list = []
  state.index = -1
  state.history = []
  state.shuffleOrder = []
  state.shufflePos = 0
}

function setQueue(tracks: Track[], startIndex: number): void {
  state.list = tracks.map(wrapTrack)
  state.index = startIndex >= 0 && startIndex < state.list.length ? startIndex : 0
  state.history = []
  state.repeatMode = 'all'
  buildShuffleOrder()
}

/**
 * Append tracks to the end of the queue.
 * Does NOT change the current playback index.
 */
function appendTracks(tracks: Track[]): void {
  if (tracks.length === 0) return
  const wrapped = tracks.map(wrapTrack)
  state.list.push(...wrapped)
  // If shuffle is active, extend shuffle order with a shuffled block of new indices
  if (state.shuffleActive && state.list.length > 0) {
    const startIdx = state.list.length - wrapped.length
    const newIndices: number[] = []
    for (let i = startIdx; i < state.list.length; i++) {
      newIndices.push(i)
    }
    state.shuffleOrder.push(...fisherYatesShuffle(newIndices))
  }
}

/**
 * Remove a track from the queue by index.
 * Adjusts current index and shuffle state accordingly.
 */
function removeTrack(index: number): void {
  if (index < 0 || index >= state.list.length) return

  const wasCurrent = index === state.index

  // Remove from list
  state.list.splice(index, 1)

  // Adjust shuffle order
  state.shuffleOrder = state.shuffleOrder
    .filter(i => i !== index)
    .map(i => i > index ? i - 1 : i)

  // Adjust current index
  if (wasCurrent) {
    // If we removed the current track, stay at same logical position
    // (the next track slides into this index)
    if (state.list.length === 0) {
      state.index = -1
    } else if (state.index >= state.list.length) {
      state.index = state.list.length - 1
    }
    // 🔥 Shuffle mode: the shuffle order was modified (indices filtered + shifted)
    // but shufflePos was not adjusted. The stale shufflePos would cause next()
    // to pick a wrong track from the shuffled order. Rebuild from current index
    // to ensure shuffle order is consistent with the new queue state.
    if (state.shuffleActive) {
      buildShuffleOrder()
    }
  } else if (index < state.index) {
    state.index--
  }
}

/**
 * Get a shallow copy of the current queue list (for UI rendering).
 */
function getList(): QueueTrack[] {
  return [...state.list]
}

function getCurrentIndex(): number {
  return state.index
}

function next(): QueueTrack | null {
  if (state.list.length === 0) return null

  if (state.repeatMode === 'one') {
    // Repeat current track — index stays the same, no history bloat
    return state.list[state.index]
  }

  // Record current position in history before moving
  const current = state.list[state.index]
  if (current) {
    state.history.push(current.queueId)
  }

  if (state.shuffleActive) {
    // Advance through pre-built Fisher-Yates shuffle order
    if (state.shufflePos < state.shuffleOrder.length) {
      state.index = state.shuffleOrder[state.shufflePos]
      state.shufflePos++
      return state.list[state.index]
    }
    // End of shuffle order
    if (state.repeatMode === 'all') {
      // Re-shuffle all tracks and restart (not just remaining indices)
      buildShuffleOrder(true)
      state.index = state.shuffleOrder[0] ?? 0
      state.shufflePos = 1
      return state.list[state.index] ?? null
    }
    // No repeat — stop
    state.index = state.list.length
    return null
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
  state.index = state.list.length
  return null
}

function previous(): QueueTrack | null {
  if (state.list.length === 0) return null

  if (state.history.length > 0) {
    const prevQueueId = state.history.pop()!
    const prevIndex = state.list.findIndex(qt => qt.queueId === prevQueueId)
    if (prevIndex >= 0) {
      state.index = prevIndex
      // Sync shufflePos so next() advances correctly from the historical position.
      // Without this, shufflePos stays stale after previous() in shuffle mode,
      // and next() plays a wrong track from the shuffled order.
      if (state.shuffleActive) {
        const pos = state.shuffleOrder.indexOf(prevIndex)
        if (pos >= 0) state.shufflePos = pos + 1
      }
      return state.list[prevIndex]
    }
  }

  // No history fallback: go to previous index
  if (state.index > 0) {
    state.index--
    // In shuffle mode, rebuild the shuffle order from the new position.
    // The old shuffle was built from the jump-in point — it doesn't
    // contain this earlier index, so next() would skip ahead.
    if (state.shuffleActive) buildShuffleOrder()
    return state.list[state.index]
  }

  if (state.repeatMode === 'all') {
    state.index = state.list.length - 1
    if (state.shuffleActive) buildShuffleOrder()
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

  // Rebuild shuffle order since indices changed
  if (state.shuffleActive) {
    buildShuffleOrder()
  }
}

/**
 * Replace a track at a given index (used for background rematch updates).
 * Does NOT change the playback index or history.
 */
function updateTrackAt(index: number, track: Track): void {
  if (index < 0 || index >= state.list.length) return
  state.list[index] = { ...state.list[index], track }
}

/**
 * Jump to a specific index in the queue (user clicked a queue track).
 * Unlike next()/previous(), this directly sets the index without
 * modifying history — the user is explicitly choosing a track.
 * Also rebuilds shuffle order from the new position.
 */
function jumpToIndex(index: number): void {
  if (index < 0 || index >= state.list.length) return
  // No-op if already at the target index — called from _nextImpl after
  // queueNext() already advanced the index. Without this guard, every
  // auto-advance through playFromQueue would clear history.
  if (index === state.index) return
  state.index = index
  state.history = []
  buildShuffleOrder()
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
    if (state.shufflePos < state.shuffleOrder.length) {
      return state.list[state.shuffleOrder[state.shufflePos]]?.track ?? null
    }
    if (state.repeatMode === 'all') {
      return state.list[0]?.track ?? null // will reshuffle
    }
    return null
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
  if (state.shuffleActive === active) return
  state.shuffleActive = active
  if (active) {
    buildShuffleOrder()
  } else {
    state.shuffleOrder = []
    state.shufflePos = 0
  }
}

function toggleShuffle(): boolean {
  setShuffleActive(!state.shuffleActive)
  return state.shuffleActive
}

function getStateForTest(): QueueEngineState {
  return { ...state, list: [...state.list], history: [...state.history], shuffleOrder: [...state.shuffleOrder] }
}

// ── Exported Singleton ──

export const QueueEngine = {
  clear,
  setQueue,
  appendTracks,
  removeTrack,
  updateTrackAt,
  getList,
  next,
  previous,
  jumpToIndex,
  reorder,
  getCurrentTrack,
  peekNext,
  getCurrentIndex,
  getRepeatMode,
  setRepeatMode,
  isShuffleActive,
  setShuffleActive,
  toggleShuffle,
  /** Exposed for testing only */
  _getState: getStateForTest,
}
