// ── Layer 9: Canonical Ranking ──
import type { CandidateCluster, NormalizedCandidate, CanonicalRanking, RecordingClass } from '../types'

// Recording class scores (0.0-1.0) based on priority order
const RECORDING_CLASS_SCORES: Record<RecordingClass, number> = {
  topic: 1.0,
  official_audio: 0.95,
  official_video: 0.90,
  studio: 0.85,
  visualizer: 0.80,
  lyrics: 0.75,
  stereo: 0.70,
  mono: 0.65,
  remaster: 0.60,
  anniversary: 0.55,
  deluxe: 0.55,
  extended: 0.55,
  radio_edit: 0.50,
  demo: 0.45,
  acoustic: 0.45,
  remix: 0.35,
  mashup: 0.35,
  nightcore: 0.35,
  speed_up: 0.35,
  slowed: 0.35,
  performance: 0.30,
  live: 0.25,
  cover: 0.15,
  instrumental: 0.10,
  reaction: 0.05,
  podcast: 0.05,
  compilation: 0.05,
  unknown: 0.30,
}

/**
 * Score a single candidate by recording class
 */
export function scoreByRecordingClass(rc: RecordingClass): number {
  return RECORDING_CLASS_SCORES[rc] ?? 0.30
}

/**
 * Score by channel verification status
 */
export function scoreByChannel(uploaderType: string, channelVerified: boolean, isTopic: boolean): number {
  if (isTopic || uploaderType === 'verified_topic') return 1.0
  if (channelVerified) return 0.8
  return 0.0
}

/**
 * Score by title purity
 */
export function scoreByTitlePurity(candidate: NormalizedCandidate): number {
  const title = candidate.canonicalTitle || ''
  const hasAnnotations = /\(.*?\)|\[.*?\]/.test(title)
  if (!hasAnnotations) return 1.0
  const minorAnnotations = /lyrics?|audio?|hd/i.test(title)
  if (minorAnnotations) return 0.7
  const majorAnnotations = /official video|visualizer/i.test(title)
  if (majorAnnotations) return 0.5
  const versionMarkers = /remix|live|edit|radio|extended|demo|acoustic|cover|instrumental/i.test(title)
  if (versionMarkers) return 0.2
  return 0.0
}

/**
 * Main function: rank uploads by presentation quality
 */
export function rankByPresentation(cluster: CandidateCluster): CanonicalRanking[] {
  if (!cluster.candidates?.length) return []
  
  const rankings: CanonicalRanking[] = []
  
  for (const candidate of cluster.candidates) {
    const recordingClassScore = scoreByRecordingClass(candidate.recordingType)
    const channelScore = scoreByChannel(candidate.uploaderType, candidate.channelVerified, candidate.isTopic)
    const titleScore = scoreByTitlePurity(candidate)
    const metadataScore = candidate.metadataQuality >= 0.8 ? 1.0 : 
                         candidate.metadataQuality >= 0.5 ? 0.6 : 0.3
    
    const clusterSeedDuration = cluster.candidates[0]?.duration || 0
    const durationDiff = Math.abs(candidate.duration - clusterSeedDuration)
    const durationScore = durationDiff === 0 ? 1.0 :
                         durationDiff <= 1 ? 0.9 :
                         durationDiff <= 3 ? 0.7 :
                         durationDiff <= 5 ? 0.5 : 0.2
    
    const finalScore = (
      recordingClassScore * 0.50 +
      channelScore * 0.20 +
      titleScore * 0.15 +
      metadataScore * 0.10 +
      durationScore * 0.05
    )
    
    const reasons: string[] = []
    
    const typeMap: Record<RecordingClass, string> = {
      topic: 'YouTube Music auto-upload',
      official_audio: 'Official audio',
      official_video: 'Official video',
      studio: 'Studio recording',
      visualizer: 'Visualizer',
      lyrics: 'Lyrics version',
      stereo: 'Stereo version',
      mono: 'Mono version',
      remaster: 'Remastered',
      anniversary: 'Anniversary edition',
      deluxe: 'Deluxe edition',
      extended: 'Extended version',
      radio_edit: 'Radio edit',
      demo: 'Demo',
      acoustic: 'Acoustic version',
      remix: 'Remix',
      mashup: 'Mashup',
      nightcore: 'Nightcore',
      speed_up: 'Speed up',
      slowed: 'Slowed',
      performance: 'Performance',
      live: 'Live performance',
      cover: 'Cover',
      instrumental: 'Instrumental',
      reaction: 'Reaction',
      podcast: 'Podcast',
      compilation: 'Compilation',
      unknown: 'Unknown quality',
    }
    
    reasons.push(typeMap[candidate.recordingType] || 'Unknown quality')
    
    if (candidate.channelVerified) {
      reasons.push(candidate.isTopic ? 'Verified topic channel' : 'Verified artist channel')
    } else {
      reasons.push('Unverified channel')
    }
    
    rankings.push({
      videoId: candidate.videoId,
      canonicalScore: finalScore,
      reason: reasons.join(', '),
    })
  }
  
  rankings.sort((a, b) => b.canonicalScore - a.canonicalScore)
  return rankings
}

/**
 * Rank multiple clusters by their best candidate
 */
export function rankClustersByPresentation(
  clusters: CandidateCluster[]
): Array<{ clusterId: string; clusterLabel: string; bestVideoId: string; score: number }> {
  return clusters.map(cluster => {
    const rankings = rankByPresentation(cluster)
    const best = rankings[0]
    return {
      clusterId: cluster.id,
      clusterLabel: cluster.label,
      bestVideoId: best.videoId,
      score: best.canonicalScore,
    }
  }).sort((a, b) => b.score - a.score)
}