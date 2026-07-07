// ── Re-exported types from TrackIdentityEngine.ts (backward compatibility) ──

export interface SpotifyTrack {
  title: string
  artist: string
  duration: number
  album?: string
  explicit?: boolean
}

export interface MockCandidate {
  youtubeId: string
  title: string
  duration: number
  channelType: string
  fingerprintHash: string
}

export interface ResolvedMatchResult {
  id: string
  title: string
  artist: string
  duration: number
  thumbnailUrl: string
  source: string
  sourceId: string
  confidenceScore: number
}

export type AnnotationCategory = 'official_canonical' | 'official_alternate' | 'remix_edit' | 'live_performance' | 'alternate_version' | 'lyrics_version' | 'derivative' | 'unmarked'

// ── New internal types for the 10-layer Track Identity Resolution Engine ──

export interface NormalizedMetadata {
  canonicalTitle: string
  rawTitle: string
  primaryArtist: string
  artists: string[]
  featuring: string[]
  album: string
  duration: number
  releaseYear?: number
  explicit: boolean
  isrc?: string
  discNumber?: number
  trackNumber?: number
}

export interface RawCandidate {
  videoId: string
  title: string
  duration: number
  channelType?: string
  artist?: string
  uploader?: string
  thumbnailUrl?: string
}

export interface NormalizedCandidate {
  videoId: string
  rawTitle: string
  canonicalTitle: string
  tokenCount: number
  uploader: string
  uploaderType: string
  duration: number
  recordingType: RecordingClass
  year?: number
  channelVerified: boolean
  isTopic: boolean
  isOfficial: boolean
  metadataQuality: number
  channelType?: string
}

export type RecordingClass = 
  | 'studio'
  | 'topic'
  | 'official_audio'
  | 'official_video'
  | 'visualizer'
  | 'lyrics'
  | 'performance'
  | 'live'
  | 'remaster'
  | 'deluxe'
  | 'anniversary'
  | 'mono'
  | 'stereo'
  | 'acoustic'
  | 'demo'
  | 'radio_edit'
  | 'extended'
  | 'remix'
  | 'mashup'
  | 'nightcore'
  | 'speed_up'
  | 'slowed'
  | 'cover'
  | 'instrumental'
  | 'reaction'
  | 'podcast'
  | 'compilation'
  | 'unknown'

export interface CandidateCluster {
  id: string
  label: string
  candidates: NormalizedCandidate[]
  recordingClass: RecordingClass
}

export interface IdentityResult {
  confidence: number
  confidenceLabel: 'accepted' | 'manual_review' | 'rejected'
  cluster: CandidateCluster
  matchedTitle: boolean
  matchedDuration: boolean
  matchedArtist: boolean
  matchedRecordingClass: boolean
}

export interface CanonicalRanking {
  videoId: string
  canonicalScore: number
  reason: string
}

export interface ConfidenceValidation {
  validatedConfidence: number
  label: 'accepted' | 'manual_review' | 'rejected'
  adjusted: boolean
  reason?: string
}

export interface MetadataEnrichment {
  album?: string
  releaseYear?: number
  trackNumber?: number
  discNumber?: number
  isrc?: string
  explicit: boolean
  videoUrl?: string
}
