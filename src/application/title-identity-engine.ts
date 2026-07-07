// ── Title Identity Engine ──
// Separates raw titles into canonical title + structured annotations,
// then compares using token equality instead of word-overlap.
//
// Prevents "I Made Believer" from matching "Believer" by rejecting
// candidates whose canonical token set doesn't exactly match the target.
//
// API:
//   extractCanonicalTitleAndAnnotations(raw)   → { canonical, annotations, tokenCount }
//   compareTitles(targetRaw, candidateRaw)     → 'exact' | 'annotation_match' | 'title_mismatch'
//   isTitleIntegrityPass(targetRaw, candidateRaw) → boolean

export type TitleMatchResult = 'exact' | 'annotation_match' | 'title_mismatch'

export interface CanonicalTitleResult {
  /** Lowercase, NFD-normalized canonical title with annotations stripped */
  canonical: string
  /** Normalized annotation tags extracted from the raw title */
  annotations: string[]
  /** Number of tokens in the canonical title */
  tokenCount: number
}

// ═══════════════════════════════════════════════════════════════
// ANNOTATION PATTERNS
// Consolidated from candidate-normalization.ts + metadata-normalization stripVersionMarkers
// Every pattern here is a KNOWN annotation — everything else is content.
// ═══════════════════════════════════════════════════════════════

export const ANNOTATION_PATTERNS: RegExp[] = [
  // Official markers
  /\(Official\s+(Audio|Video|Music\s*Video|Lyric\s*Video|4K\s*Remaster|HD)\)/gi,
  /\(Official\)/gi,
  /\[Official\s+(Audio|Video|Music\s*Video|Lyric\s*Video)\]/gi,
  /\[HD\]/gi,
  /\[4K\]/gi,

  // Lyrics / Visualizer / Audio-only
  /\(Lyrics?\s*(Video)?\)/gi,
  /\[Lyrics?\]/gi,
  /\(Audio\s*Only\)/gi,
  /\(Audio\)/gi,                // bare "(Audio)" without Official
  /\(Visualizer\)/gi,
  /\(4K\s*(Remaster)?\)/gi,
  /\(HD\)/gi,

  // Version markers (parenthesized)
  /\((.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*\)/gi,
  /\(\s*(Live|Live\s+(at|in|from|concert|performance|session|recording|version))\s*\)/gi,
  /\(\s*Remastered\s*\)/gi,
  /\(\s*Bonus\s+Track\s*\)/gi,
  /\(\w+[']\s*Version\)/gi,
  /\((Expanded|Deluxe|Anniversary)\s+Edition\)/gi,

  // Version markers (dash-separated suffixes)
  /\s*[-–—]\s*(.+?\s+)?(Remix|Radio\s*Edit|Extended\s*Mix|Instrumental|Acoustic)\s*$/gi,
  /\s*[-–—]\s*.+?\s+Version\s*$/gi,
  /\s*[-–—]\s*Studio\s+Recording\s+from\s+.+?Performance\s*$/gi,
  /\s*[-–—]\s*(Bonus\s+Track|From\s+.+?)\s*$/gi,
  /\s*[-–—]\s*From\s+.+?$/gi,

  // Featured artists
  /\(ft\.?\s+.*?\)/gi,
  /\(feat\.?\s+.*?\)/gi,
  /\(with\s+.*?\)/gi,

  // Contextual parentheticals
  /\(from\s+[^)]+\)/gi,

  // Topic suffix
  /\s*-\s*(Topic)\s*$/gi,

  // Multi-space normalization
  /\s{2,}/g,
]

// ═══════════════════════════════════════════════════════════════
// NFD Normalization (consistent with rest of application layer)
// ═══════════════════════════════════════════════════════════════

function nfdNormalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')         // strip combining diacritical marks
    .replace(/[^a-z0-9\s\-'._]/g, '')        // keep only relevant characters
    .replace(/\s+/g, ' ')
    .trim()
}

// ═══════════════════════════════════════════════════════════════
// extractCanonicalTitleAndAnnotations
// ═══════════════════════════════════════════════════════════════

/**
 * Split a raw title into its canonical form and extracted annotations.
 *
 * "Believer (Official Audio)"
 *   → { canonical: "believer", annotations: ["(Official Audio)"], tokenCount: 1 }
 *
 * "I Made Believer"
 *   → { canonical: "i made believer", annotations: [], tokenCount: 3 }
 *
 * "Imagine Dragons - Believer (Official Music Video)"
 *   → { canonical: "believer", annotations: ["(Official Music Video)"], tokenCount: 1 }
 *
 * Strips artist prefixes ("Artist - Title") and known annotation patterns.
 */
export function extractCanonicalTitleAndAnnotations(rawTitle: string): CanonicalTitleResult {
  let title = rawTitle.trim()
  const annotations: string[] = []

  // Step 1: Strip artist prefix ("Artist - Title" → "Title")
  const artistSepMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)/)
  if (artistSepMatch) {
    title = artistSepMatch[2]
  }

  // Step 2: Strip known annotation patterns, capturing each match as an annotation
  for (const pattern of ANNOTATION_PATTERNS) {
    // Global regex: loop until no more matches
    let match: RegExpExecArray | null
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    while ((match = re.exec(title)) !== null) {
      annotations.push(match[0].trim())
    }
    title = title.replace(pattern, '')
  }

  // Step 3: Normalize the remaining canonical title
  const canonical = nfdNormalize(title)

  // Step 4: Tokenize
  const tokens = canonical.split(/\s+/).filter(Boolean)

  return {
    canonical,
    annotations: [...new Set(annotations)], // deduplicate
    tokenCount: tokens.length,
  }
}

// ═══════════════════════════════════════════════════════════════
// compareTitles
// ═══════════════════════════════════════════════════════════════

/**
 * Compare two raw titles using token equality instead of word overlap.
 *
 * Returns:
 *   'exact'           — Canonical titles are identical (same tokens).
 *   'annotation_match' — Canonical titles match; candidate may have annotations
 *                        that were successfully stripped. (Same as 'exact' for
 *                        practical purposes — both reach the same canonical form.)
 *   'title_mismatch'  — Canonical titles differ. Reject.
 *
 * Rules (tiered by token count):
 *   1 token  → candidate must have exactly 1 token, and it must match.
 *   2 tokens → candidate must have exactly 2 tokens, both must match.
 *   3+ tokens → exact token-set equality (order-independent).
 */
export function compareTitles(targetRaw: string, candidateRaw: string): TitleMatchResult {
  const target = extractCanonicalTitleAndAnnotations(targetRaw)
  const candidate = extractCanonicalTitleAndAnnotations(candidateRaw)

  // Same canonical string = match (handles all annotation-stripped cases)
  if (target.canonical === candidate.canonical) {
    return 'exact'
  }

  // ── Token-count tiered checks ──

  const targetTokens = target.canonical.split(/\s+/).filter(Boolean)
  const candidateTokens = candidate.canonical.split(/\s+/).filter(Boolean)

  // Tier 1: Single-word titles — must be single-word, same word
  if (target.tokenCount === 1) {
    return 'title_mismatch'
  }

  // Tier 2: Two-word titles — must be two-word, same two words
  if (target.tokenCount === 2) {
    if (candidate.tokenCount !== 2) return 'title_mismatch'
    const match = targetTokens.every(t => candidateTokens.includes(t))
    return match ? 'exact' : 'title_mismatch'
  }

  // Tier 3: Multi-word titles (3+) — exact token-set equality
  if (target.tokenCount !== candidate.tokenCount) return 'title_mismatch'
  const targetSet = new Set(targetTokens)
  const allMatch = candidateTokens.every(t => targetSet.has(t))
  return allMatch ? 'exact' : 'title_mismatch'
}

// ═══════════════════════════════════════════════════════════════
// isTitleIntegrityPass
// ═══════════════════════════════════════════════════════════════

/**
 * Boolean gate for pipeline integration.
 * Returns true only when the candidate title canonically refers
 * to the same base song as the target title.
 *
 * This check happens BEFORE duration, artist, and version signals —
 * if the base title doesn't match, nothing else matters.
 */
export function isTitleIntegrityPass(targetRawTitle: string, candidateRawTitle: string): boolean {
  const result = compareTitles(targetRawTitle, candidateRawTitle)
  return result !== 'title_mismatch'
}
