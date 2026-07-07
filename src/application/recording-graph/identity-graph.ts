// ── Recording Identity Graph ──
// Connects all YouTube uploads for the SAME underlying recording.
// Prevents the engine from bouncing between equivalent uploads
// just because one has a slightly higher heuristic score.
//
// Edge: recordingNode --[same_recording]--> upload (videoId)

import type { NormalizedCandidate, CandidateCluster, RecordingClass } from '../types'
import type { RecordingNode, RecordingEdge, IRecordingGraph, RecordingGraphOptions } from './types'
import { getRecordingClassPriority } from '../layers/recording-classification'

function nfdNormalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s\-'._]/g, '')
    .trim()
}

function generateRecordingId(canonicalTitle: string, artist: string): string {
  const raw = `${nfdNormalize(canonicalTitle)}:${nfdNormalize(artist)}`
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return `rec_${Math.abs(hash).toString(16).padStart(8, '0')}`
}

// Recording classes that represent the same canonical/official recording
const _PRIMARY_CLASSES: readonly RecordingClass[] = [
  'studio', 'topic', 'official_audio', 'official_video',
]

function _isSamePrimaryType(a: RecordingClass, b: RecordingClass): boolean {
  if (a === b) return true
  return _PRIMARY_CLASSES.includes(a) && _PRIMARY_CLASSES.includes(b)
}

export class RecordingGraph implements IRecordingGraph {
  private _nodes: Map<string, RecordingNode>
  private _edges: RecordingEdge[]
  private _options: Required<RecordingGraphOptions>
  private _videoToNode: Map<string, string>

  constructor(options?: RecordingGraphOptions) {
    this._options = {
      durationTolerance: options?.durationTolerance ?? 2,
      titleSimilarityThreshold: options?.titleSimilarityThreshold ?? 0.8,
      autoLinkSameArtist: options?.autoLinkSameArtist ?? true,
      linkAlternateVersions: options?.linkAlternateVersions ?? false,
    }
    this._nodes = new Map()
    this._edges = []
    this._videoToNode = new Map()
  }

  get nodes(): Map<string, RecordingNode> {
    return this._nodes
  }

  get edges(): RecordingEdge[] {
    return this._edges
  }

  get recordingCount(): number {
    return this._nodes.size
  }

  get uploadCount(): number {
    let count = 0
    for (const node of this._nodes.values()) {
      count += node.uploads.length
    }
    return count
  }

  addCandidate(candidate: NormalizedCandidate): string {
    // Duplicate guard
    const existingId = this._videoToNode.get(candidate.videoId)
    if (existingId) return existingId

    // Try to link into an existing recording node
    const matchedNode = this._findMatchingNode(candidate)
    let nodeId: string

    if (matchedNode) {
      nodeId = matchedNode.id
      matchedNode.uploads.push(candidate)
      matchedNode.updatedAt = Date.now()
      if (this._hasHigherPriority(candidate, matchedNode)) {
        matchedNode.bestUploadId = candidate.videoId
        matchedNode.recordingClass = candidate.recordingType
      }
    } else {
      nodeId = generateRecordingId(candidate.canonicalTitle, candidate.uploader)
      const now = Date.now()
      this._nodes.set(nodeId, {
        id: nodeId,
        label: candidate.canonicalTitle,
        artist: candidate.uploader,
        duration: candidate.duration,
        uploads: [candidate],
        recordingClass: candidate.recordingType,
        bestUploadId: candidate.videoId,
        identityConfidence: 0,
        createdAt: now,
        updatedAt: now,
      })
    }

    this._videoToNode.set(candidate.videoId, nodeId)
    this._edges.push({
      sourceId: nodeId,
      targetId: candidate.videoId,
      edgeType: 'same_recording',
      weight: 1.0,
    })

    return nodeId
  }

  removeCandidate(videoId: string): boolean {
    const nodeId = this._videoToNode.get(videoId)
    if (!nodeId) return false

    const node = this._nodes.get(nodeId)
    if (!node) return false

    const idx = node.uploads.findIndex(u => u.videoId === videoId)
    if (idx === -1) return false

    node.uploads.splice(idx, 1)

    // Remove incident edges
    this._edges = this._edges.filter(
      e => !(e.sourceId === nodeId && e.targetId === videoId)
    )

    // If the best upload was removed, promote the next best
    if (node.bestUploadId === videoId) {
      node.bestUploadId = node.uploads.length > 0
        ? this._pickBest(node.uploads).videoId
        : undefined
    }

    // Tear down empty recording nodes
    if (node.uploads.length === 0) {
      this._nodes.delete(nodeId)
    }

    this._videoToNode.delete(videoId)
    return true
  }

  getRecordingForUpload(videoId: string): RecordingNode | undefined {
    const nodeId = this._videoToNode.get(videoId)
    return nodeId ? this._nodes.get(nodeId) : undefined
  }

  searchRecordings(query: string): RecordingNode[] {
    if (!query.trim()) return []

    const tokens = nfdNormalize(query).split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []

    return Array.from(this._nodes.values()).filter(node => {
      const label = nfdNormalize(node.label)
      const artist = nfdNormalize(node.artist)
      const matched = tokens.filter(
        t => label.includes(t) || artist.includes(t)
      )
      return matched.length >= Math.ceil(tokens.length / 2)
    })
  }

  findMatch(
    targetTitle: string,
    targetArtist: string,
    targetDuration: number,
  ): RecordingNode | undefined {
    const normTitle = nfdNormalize(targetTitle)
    const normArtist = nfdNormalize(targetArtist)
    let bestNode: RecordingNode | undefined
    let bestScore = 0

    for (const node of this._nodes.values()) {
      const nodeTitle = nfdNormalize(node.label)
      const nodeArtist = nfdNormalize(node.artist)
      const durDiff = Math.abs(targetDuration - node.duration)

      // Title similarity (0-0.5)
      const titleTokens = normTitle.split(/\s+/).filter(Boolean)
      let score = 0
      if (titleTokens.length > 0) {
        const titleMatch = titleTokens.filter(t => nodeTitle.includes(t))
        score += (titleMatch.length / titleTokens.length) * 0.5
      }

      // Duration proximity (0-0.3)
      if (durDiff <= this._options.durationTolerance) {
        score += 0.3
      } else if (durDiff <= this._options.durationTolerance * 2) {
        score += 0.15
      }

      // Artist overlap (0-0.2)
      const artistTokens = normArtist.split(/\s+/).filter(Boolean)
      if (artistTokens.length > 0) {
        const artistMatch = artistTokens.filter(t => nodeArtist.includes(t))
        score += (artistMatch.length / artistTokens.length) * 0.2
      }

      score = Math.min(score, 1.0)
      if (score > bestScore && score >= this._options.titleSimilarityThreshold) {
        bestScore = score
        bestNode = node
      }
    }

    return bestNode
  }

  getBestUpload(nodeId: string): NormalizedCandidate | undefined {
    const node = this._nodes.get(nodeId)
    if (!node || node.uploads.length === 0) return undefined

    // Fast path: cached best upload is still valid
    if (node.bestUploadId) {
      const best = node.uploads.find(u => u.videoId === node.bestUploadId)
      if (best) return best
    }

    // Recompute: pick by recording class priority → metadata quality
    const best = this._pickBest(node.uploads)
    node.bestUploadId = best.videoId
    return best
  }

  toCluster(node: RecordingNode): CandidateCluster {
    return {
      id: node.id,
      label: node.label,
      candidates: [...node.uploads],
      recordingClass: node.recordingClass,
    }
  }

  getAllRecordings(): RecordingNode[] {
    return Array.from(this._nodes.values())
  }

  clear(): void {
    this._nodes.clear()
    this._edges = []
    this._videoToNode.clear()
  }

  // ── Private helpers ──

  private _findMatchingNode(candidate: NormalizedCandidate): RecordingNode | undefined {
    const normTitle = nfdNormalize(candidate.canonicalTitle)
    for (const node of this._nodes.values()) {
      if (nfdNormalize(node.label) !== normTitle) continue
      if (Math.abs(node.duration - candidate.duration) > this._options.durationTolerance) continue
      if (!_isSamePrimaryType(node.recordingClass, candidate.recordingType)) continue
      return node
    }
    return undefined
  }

  private _hasHigherPriority(candidate: NormalizedCandidate, node: RecordingNode): boolean {
    const cp = getRecordingClassPriority(candidate.recordingType)
    const np = getRecordingClassPriority(node.recordingClass)
    if (cp < np) return true
    if (cp > np) return false
    // Same priority class → compare metadata quality
    if (!node.bestUploadId) return true
    const currentBest = node.uploads.find(u => u.videoId === node.bestUploadId)
    return (currentBest?.metadataQuality ?? 0) < candidate.metadataQuality
  }

  private _pickBest(uploads: NormalizedCandidate[]): NormalizedCandidate {
    return [...uploads].sort((a, b) => {
      const pa = getRecordingClassPriority(a.recordingType)
      const pb = getRecordingClassPriority(b.recordingType)
      return pa !== pb ? pa - pb : b.metadataQuality - a.metadataQuality
    })[0]
  }
}
