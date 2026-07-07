// ── Layer 1: Metadata Normalization ──
import { SpotifyTrack, NormalizedMetadata } from '../types'
import { extractCanonicalTitleAndAnnotations } from '../title-identity-engine'

/** NFD Unicode normalization: lowercase, NFD decompose, strip diacritics, keep alphanumerics/hyphens/apostrophes/periods, trim */
function nfdNormalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^\u0000-\u007F\u0080-\u00FF\u0100-\u017F\u0180-\u024F\u1E00-\u1EFF]/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\-'.\s]/g, '')
    .trim();
}

/** Normalize a single artist name using NFD rules */
export function normalizeArtistName(name: string): string {
  return nfdNormalize(name);
}

/** Extract primary artist and featuring artists from raw artist string */
export function extractArtists(rawArtist: string): { primary: string; featuring: string[] } {
  const normalized = nfdNormalize(rawArtist);
  const separators = [' feat. ', ' featuring ', ' ft. ', ' with '];
  let primary = normalized;
  const featuring: string[] = [];

  for (const sep of separators) {
    const index = normalized.indexOf(sep);
    if (index !== -1) {
      primary = normalized.substring(0, index).trim();
      const featuringPart = normalized.substring(index + sep.length).trim();
      const additional = featuringPart.split(new RegExp(separators.map(s => s.replace('.', '\.')).join('|'), 'i'))
        .map(s => s.trim())
        .filter(s => s && s !== primary);
      featuring.push(...additional);
      break;
    }
  }

  return { primary, featuring };
}

/** Strip version markers from track title */
export function stripVersionMarkers(title: string): string {
  let result = title;
  const patterns = [
    /\s*\(\s*(?:remix|radio edit|extended mix|acoustic|instrumental|live|bonus track)\s*\)\s*/gi,
    /\s*-\s*(?:remix|radio edit)\s*/gi,
    /\s*\(\s*taylor's version\s*\)\s*/gi,
    /\s*\(\s*anniversary edition\s*\)\s*/gi,
    /\s*\(\s*remastered\s*\)\s*/gi,
    /\s*\(\s*deluxe edition\s*\)\s*/gi,
    /\s*\(\s*expanded edition\s*\)\s*/gi,
    /\s*\(\s*bonus track\s*\)\s*/gi,
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, '');
  }

  return result.trim();
}

/** Main normalization function */
export function normalizeSpotifyMetadata(track: SpotifyTrack): NormalizedMetadata {
  const { primary: primaryArtist, featuring } = extractArtists(track.artist);
  const artists = [primaryArtist, ...featuring];

  const rawTitle = track.title;
  const { canonical: canonicalTitle } = extractCanonicalTitleAndAnnotations(track.title);

  const album = track.album ? nfdNormalize(track.album) : '';

  let releaseYear: number | undefined = undefined;
  if (album) {
    const yearMatch = album.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      releaseYear = parseInt(yearMatch[0], 10);
    }
  }

  return {
    canonicalTitle,
    rawTitle,
    primaryArtist,
    artists,
    featuring,
    album,
    duration: track.duration,
    releaseYear,
    explicit: track.explicit ?? false,
    isrc: undefined,
    discNumber: undefined,
    trackNumber: undefined,
  };
}