import type { NormalizedCandidate, CandidateCluster, RecordingClass } from '../types'

/** Unique identifier for a recording identity. */
export interface RecordingNode {
  id: string
  label: string
  artist: string
  duration: number
  uploads: NormalizedCandidate[]
  recordingClass: RecordingClass
  bestUploadId?: string
  identityConfidence: number
  createdAt: number
  updatedAt: number
}

/** Edge in the recording identity graph. */
export interface RecordingEdge {
  sourceId: string
  targetId: string
  edgeType: 'same_recording' | 'same_artist' | 'same_album' | 'alternate_version' | 'derivative'
  weight: number
}

/** The Recording Identity Graph. */
export interface IRecordingGraph {
  readonly nodes: Map<string, RecordingNode>
  readonly edges: RecordingEdge[]

  addCandidate(candidate: NormalizedCandidate): string
  removeCandidate(videoId: string): boolean
  getRecordingForUpload(videoId: string): RecordingNode | undefined
  searchRecordings(query: string): RecordingNode[]
  findMatch(targetTitle: string, targetArtist: string, targetDuration: number): RecordingNode | undefined
  getBestUpload(nodeId: string): NormalizedCandidate | undefined
  toCluster(node: RecordingNode): CandidateCluster
  getAllRecordings(): RecordingNode[]
  get recordingCount(): number
  get uploadCount(): number
  clear(): void
}

/** Options for graph construction. */
export interface RecordingGraphOptions {
  durationTolerance?: number
  titleSimilarityThreshold?: number
  autoLinkSameArtist?: boolean
  linkAlternateVersions?: boolean
}

/** Result of a graph query operation. */
export interface GraphQueryResult {
  recordings: RecordingNode[]
  confidences: Map<string, number>
  queryTimeMs: number
}

/** Statistics about the graph state. */
export interface GraphStats {
  recordingCount: number
  uploadCount: number
  edgeCount: number
  avgUploadsPerRecording: number
  classDistribution: Partial<Record<RecordingClass, number>>
}