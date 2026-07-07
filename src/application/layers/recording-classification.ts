// ── Layer 5: Recording Classification ──
import { RecordingClass, AnnotationCategory } from '../types'

// Priority patterns for classification
const PATTERNS = {
  topic: /^verified_topic$/i,
  official_audio: /\(official\s+audio\)|\[official\s+audio\]/i,
  official_video: /\(official\s+(video|music\s*video)\)|\[official\s+(video|music\s*video)\]/i,
  remix: /\b(Remix|Bootleg)\b/i,
  nightcore: /\b(Nightcore|Sped\s*Up)\b/i,
  speed_up: /\b(Speed\s*Up)\b/i,
  slowed: /\b(Slowed|Reverb)\b/i,
  mashup: /\b(Mashup|Mash.?up)\b/i,
  radio_edit: /\b(Radio\s*Edit)\b/i,
  extended: /\b(Extended\s*(Mix|Version))\b/i,
  acoustic: /\b(Acoustic)\b/i,
  cover: /\b(Cover|Tribute)\b/i,
  instrumental: /\b(Instrumental|Karaoke)\b/i,
  demo: /\b(Demo)\b/i,
  live: /\((Live|Live\s+(at|in|from|concert|performance))\)|\[(Live|Live\s+(at|in|from|concert))\]|\blive\s+(at|in|from|concert|performance)\b/i,
  performance: /\((Concert|Tour|Stage)\s+(Version|Performance|Recording)\)/i,
  remaster: /\b(Remaster(ed)?)\b/i,
  anniversary: /\b(Anniversary\s+(Edition|Version|Remaster))\b/i,
  deluxe: /\b(Deluxe\s+Edition|Expanded\s+Edition|Bonus\s+Track)\b/i,
  lyrics: /\b(Lyrics?\s*(Video)?)\b/i,
  visualizer: /\b(Visualizer)\b/i,
  mono: /\b(Mono)\b/i,
  stereo: /\b(Stereo)\b/i,
  compilation: /\(\w+\s*Version\)/i,
  reaction: /\b(Reaction|Reacting\s+to)\b/i,
  podcast: /\b(Podcast)\b/i,
}

/**
 * Classifies every YouTube upload into ONE of 30+ recording classes
 * by examining the raw title, channel type, and uploader metadata.
 */
export function classifyRecording(
  rawTitle: string,
  channelType?: string,
  channelVerified?: boolean,
  isTopic?: boolean
): RecordingClass {
  const title = rawTitle?.trim() || ''
  const verified = channelVerified ?? false
  const topic = isTopic ?? false

  // Priority 1: topic
  if (topic || channelType === 'verified_topic') return 'topic'

  // Priority 2-28: Check patterns in order
  if (PATTERNS.official_audio.test(title)) return 'official_audio'
  if (PATTERNS.official_video.test(title)) return 'official_video'
  if (PATTERNS.remix.test(title)) return 'remix'
  if (PATTERNS.nightcore.test(title)) return 'nightcore'
  if (PATTERNS.speed_up.test(title)) return 'speed_up'
  if (PATTERNS.slowed.test(title)) return 'slowed'
  if (PATTERNS.mashup.test(title)) return 'mashup'
  if (PATTERNS.radio_edit.test(title)) return 'radio_edit'
  if (PATTERNS.extended.test(title)) return 'extended'
  if (PATTERNS.acoustic.test(title)) return 'acoustic'
  if (PATTERNS.cover.test(title) && !/Cover\s+(Artist|Band|Name)/i.test(title)) return 'cover'
  if (PATTERNS.instrumental.test(title)) return 'instrumental'
  if (PATTERNS.demo.test(title)) return 'demo'
  if (PATTERNS.live.test(title) && !PATTERNS.performance.test(title)) return 'live'
  if (PATTERNS.performance.test(title)) return 'performance'
  if (PATTERNS.remaster.test(title)) return 'remaster'
  if (PATTERNS.anniversary.test(title)) return 'anniversary'
  if (PATTERNS.deluxe.test(title)) return 'deluxe'
  if (PATTERNS.lyrics.test(title)) return 'lyrics'
  if (PATTERNS.visualizer.test(title)) return 'visualizer'
  if (PATTERNS.mono.test(title) && /version/i.test(title)) return 'mono'
  if (PATTERNS.stereo.test(title) && /version/i.test(title)) return 'stereo'
  if (PATTERNS.compilation.test(title) && !/remix/i.test(title)) return 'compilation'
  if (PATTERNS.reaction.test(title)) return 'reaction'
  if (PATTERNS.podcast.test(title)) return 'podcast'

  // Priority 27: studio (fallback)
  if (verified) return 'studio'

  // Priority 28: unknown (everything else)
  return 'unknown'
}

// Map new RecordingClass → old AnnotationCategory for backward compat
export function recordingClassToAnnotationCategory(rc: RecordingClass): AnnotationCategory {
  const map: Record<RecordingClass, AnnotationCategory> = {
    studio: 'official_canonical',
    topic: 'official_canonical',
    official_audio: 'official_canonical',
    official_video: 'official_canonical',
    visualizer: 'official_alternate',
    mono: 'official_alternate',
    stereo: 'official_alternate',
    remix: 'remix_edit',
    mashup: 'remix_edit',
    nightcore: 'remix_edit',
    speed_up: 'remix_edit',
    slowed: 'remix_edit',
    radio_edit: 'remix_edit',
    extended: 'remix_edit',
    live: 'live_performance',
    performance: 'live_performance',
    remaster: 'alternate_version',
    deluxe: 'alternate_version',
    anniversary: 'alternate_version',
    acoustic: 'alternate_version',
    demo: 'alternate_version',
    lyrics: 'lyrics_version',
    cover: 'derivative',
    instrumental: 'derivative',
    reaction: 'derivative',
    compilation: 'derivative',
    podcast: 'derivative',
    unknown: 'unmarked',
  }
  return map[rc] ?? 'unmarked'
}

// Check if a recording class counts as "acceptable" for hard constraint stage
export function isAcceptableRecordingClass(rc: RecordingClass): boolean {
  return ['studio', 'topic', 'official_audio', 'official_video', 'visualizer', 'lyrics', 'stereo', 'mono', 'unknown'].includes(rc)
}

// Check if recording classes are compatible (e.g., studio vs official_audio = compatible)
export function areRecordingClassesCompatible(targetClass: RecordingClass, candidateClass: RecordingClass): boolean {
  if (targetClass === candidateClass) return true

  const compatiblePairs: Record<string, string[]> = {
    'studio': ['official_audio', 'official_video', 'topic', 'lyrics'],
    'official_audio': ['official_video'],
    'official_video': ['official_audio'],
    'lyrics': ['studio', 'official_audio', 'official_video', 'topic'],
    'visualizer': ['official_audio'],
  }

  return compatiblePairs[targetClass]?.includes(candidateClass) || false
}

// Get priority order number (lower = more canonical/desirable)
export function getRecordingClassPriority(rc: RecordingClass): number {
  const priorityOrder: RecordingClass[] = [
    'topic',
    'official_audio',
    'official_video',
    'studio',
    'visualizer',
    'lyrics',
    'stereo',
    'mono',
    'remaster',
    'anniversary',
    'deluxe',
    'extended',
    'radio_edit',
    'demo',
    'acoustic',
    'remix',
    'mashup',
    'nightcore',
    'speed_up',
    'slowed',
    'performance',
    'live',
    'cover',
    'instrumental',
    'reaction',
    'podcast',
    'compilation',
    'unknown',
  ]

  return priorityOrder.indexOf(rc)
}
