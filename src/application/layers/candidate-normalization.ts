// ── Layer 4: Candidate Normalization ──
import type { RawCandidate } from '../types'
import type { Track } from '../../shared/types'
import type { NormalizedCandidate } from '../types'
import { extractCanonicalTitleAndAnnotations } from '../title-identity-engine'

/** NFD Unicode normalization */
function nfdNormalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^\u0000-\u007F\u0080-\u00FF\u0100-\u017F\u0180-\u024F\u1E00-\u1EFF]/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\-\'.\s]/g, '')
    .trim();
}

/** Strip artist prefix from YouTube title ("Artist - Title" → "Title") */
export function stripArtistPrefix(rawTitle: string): { artistFromTitle?: string } {
  const match = rawTitle.match(/^(.+?)\s*[-–—]\s*(.+)/)
  return match ? { artistFromTitle: match[1].trim() } : { artistFromTitle: undefined }
}

/** Extract year from title string */
export function extractYearFromTitle(rawTitle: string): number | undefined {
  const yearMatch = rawTitle.match(/\b(19|20)\d{2}\b/)
  return yearMatch ? parseInt(yearMatch[0], 10) : undefined
}

/** Detect if title has official annotation */
export function hasOfficialAnnotation(rawTitle: string): boolean {
  const normalized = rawTitle.toLowerCase()
  return ANNOTATION_PATTERNS.some(pattern => pattern.test(normalized))
}

/** Score metadata quality based on available signals */
export function scoreMetadataQuality(
  uploaderType: string,
  channelVerified: boolean,
  isOfficial: boolean,
  hasArtist: boolean
): number {
  if (channelVerified && isOfficial && hasArtist) return 1.0
  if (uploaderType === 'topic') return 0.8
  if (channelVerified) return 0.6
  if (hasArtist) return 0.4
  if (!hasArtist) return 0.2
  return 0.1
}

/** Strip common annotations from a YouTube title */
function cleanTitle(rawTitle: string): string {
  let title = rawTitle.trim()
  const artistSeparator = title.match(/^(.+?)\s*[-–—]\s*(.+)/)
  if (artistSeparator) title = artistSeparator[2]
  for (const pattern of ANNOTATION_PATTERNS) title = title.replace(pattern, '')
  return title.trim()
}

/** Strip annotations without removing artist prefix */
export function cleanTrackTitle(rawTitle: string): string {
  let title = rawTitle.trim()
  for (const pattern of ANNOTATION_PATTERNS) title = title.replace(pattern, '')
  return title.trim()
}

/** Shared annotation patterns for title cleaning */
export const ANNOTATION_PATTERNS: RegExp[] = [
  /\(Official\s+(Audio|Video|Music\s*Video|Lyric\s*Video|4K\s*Remaster|HD)\)/gi,
  /\(Official\)/gi,
  /\(Lyrics?\s*(Video)?\)/gi,
  /\(Audio\s*Only\)/gi,
  /\(Visualizer\)/gi,
  /\(4K\s*(Remaster)?\)/gi,
  /\(HD\)/gi,
  /\[Official\s+(Audio|Video|Music\s*Video|Lyric\s*Video)\]/gi,
  /\[HD\]/gi,
  /\[4K\]/gi,
  /\[Lyrics?\]/gi,
  /\s*-\s*(Topic)\s*$/gi,
  /\(ft\.?\s+.*?\)/gi,
  /\(feat\.?\s+.*?\)/gi,
  /\(with\s+.*?\)/gi,
  /\s*[-–—]\s*(.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*$/gi,
  /\s*[-–—]\s*.+?\s+Version\s*$/gi,
  /\s*[-–—]\s*Studio\s+Recording\s+from\s+.+?Performance\s*$/gi,
  /\s*[-–—]\s*(Bonus\s+Track|From\s+.+?)\s*$/gi,
  /\((.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*\)/gi,
  /\(from\s+[^)]+\)/gi,
  /\(\w+[']\s*Version\)/gi,
  /\((Expanded|Deluxe|Anniversary)\s+Edition\)/gi,
  /\s*[-–—]\s*From\s+.+?$/gi,
  /\s{2,}/g,
]

/** Main normalization function for raw YouTube search results */
export function normalizeCandidate(
  raw: RawCandidate,
): NormalizedCandidate {
  const { artistFromTitle } = stripArtistPrefix(raw.title)
  const hasArtist = !!artistFromTitle
  const { canonical: canonicalTitle, tokenCount } = extractCanonicalTitleAndAnnotations(raw.title)

  const uploader = raw.artist ?? raw.uploader ?? 'Unknown'
  const channelType = raw.channelType

  const uploaderType = channelType === 'verified_topic' ? 'topic' :
    channelType === 'verified_artist' ? 'artist' : 'user'

  const channelVerified = channelType === 'verified_artist' || channelType === 'verified_topic'
  const isTopic = channelType === 'verified_topic' ||
    raw.title.toLowerCase().endsWith(' - topic') ||
    uploaderType === 'topic'
  const isOfficial = hasOfficialAnnotation(raw.title)
  const year = extractYearFromTitle(raw.title)
  const metadataQuality = scoreMetadataQuality(uploaderType, channelVerified, isOfficial, hasArtist)

  return {
    videoId: raw.videoId,
    rawTitle: raw.title,
    canonicalTitle,
    tokenCount,
    uploader,
    uploaderType,
    duration: raw.duration,
    recordingType: 'unknown',
    year,
    channelVerified,
    isTopic,
    isOfficial,
    metadataQuality,
    channelType,
  }
}

// Suppress TS6133 for intentionally-retained local functions
void nfdNormalize;
void cleanTitle;

/** Alternative entry for production pipeline (accepts Track directly) */
export function normalizeTrackCandidate(
  track: Track,
): NormalizedCandidate {
  const raw: RawCandidate = {
    videoId: track.id,
    title: track.title,
    duration: track.duration,
    channelType: track.channelType,
    artist: track.artist,
    uploader: track.artist,
  }
  return normalizeCandidate(raw)
}
