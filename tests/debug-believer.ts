/**
 * Diagnostic: trace the full pipeline for "Believer" by Imagine Dragons.
 * Run with: npx tsx tests/debug-believer.ts
 */
import { SearchEngine, cleanTitle, setSearchFunction } from '../src/application/SearchEngine'
import { normalizeTrackCandidate } from '../src/application/layers/candidate-normalization'
import { classifyRecording } from '../src/application/layers/recording-classification'
import { clusterCandidates } from '../src/application/layers/candidate-clustering'
import {
  resolveBestIdentity, scoreArtistMatch, scoreTitleMatch, scoreDurationMatch,
  resolveIdentityForCluster, isCandidateContradictory, extractArtistFromTitle,
} from '../src/application/layers/identity-resolution'
import { normalizeSpotifyMetadata } from '../src/application/layers/metadata-normalization'
import { getAnnotationCategory } from '../src/application/TrackIdentityEngine'
import { searchYouTube } from '../src/main/services/innertube'
import { collectCandidates } from '../src/application/layers/candidate-collection'
import { generateSearchQueries } from '../src/application/layers/search-strategy'
import type { Track } from '../src/shared/types'
import type { NormalizedCandidate } from '../src/application/types'
import type { InnertubeSearchResult } from '../src/main/services/innertube'

// Wire SearchEngine same as production (src/main/index.ts)
setSearchFunction(async (query: string) => {
  const results = await searchYouTube(query)
  return results.map((r: InnertubeSearchResult) => ({
    id: r.videoId,
    title: r.title,
    artist: r.artist,
    duration: r.duration,
    thumbnailUrl: r.thumbnail,
    source: 'youtube' as const,
    sourceId: r.videoId,
    channelType: r.channelType,
  }))
})

const incomingTrack = {
  title: 'Believer',
  artist: 'Imagine Dragons',
  duration: 204,
}

async function testSingleQuery(query: string, label: string) {
  console.log(`\n--- Query: "${query}" (${label}) ---`)
  const tracks = await SearchEngine.search(query)
  tracks.forEach((t: Track) => {
    const strong = t.channelType === 'verified_topic' || t.channelType === 'verified_artist' ? ' ★STRONG' : ''
    console.log(`  ${t.id} dur=${t.duration}s chType=${t.channelType ?? 'N/A'} artist=${t.artist}${strong}`)
  })
  return tracks
}

async function main() {
  console.log('=== INCOMING TRACK ===')
  console.log(`Title: "${incomingTrack.title}"`)
  console.log(`Artist: "${incomingTrack.artist}"`)
  console.log(`Duration: ${incomingTrack.duration}s`)
  console.log()

  // Check the search strategy queries
  const normalized = normalizeSpotifyMetadata(incomingTrack)
  const queries = generateSearchQueries(incomingTrack, normalized)
  console.log('=== SEARCH STRATEGY QUERIES ===')
  queries.forEach((q: string, i: number) => console.log(`[${i}] "${q}"`))
  console.log()

  // Test key queries independently to see which returns verified channels
  console.log('=== INDIVIDUAL QUERY TESTS ===')
  const testQueries = [
    'imagine dragons believer topic',
    'imagine dragons believer - topic',
    'believer imagine dragons',
    'believer',
  ]
  for (const q of testQueries) {
    const r = await SearchEngine.search(q)
    const strong = r.filter((t: Track) => t.channelType === 'verified_topic' || t.channelType === 'verified_artist')
    const total = r.length
    console.log(`"${q}" → ${total} results, ${strong.length} strong`)
    if (strong.length > 0) {
      strong.forEach((t: Track) => console.log(`  ★ id=${t.id} dur=${t.duration}s chType=${t.channelType} title="${t.title}"`))
    }
  }
  console.log()

  // Use normal thresholds for full collection
  console.log('=== FULL CANDIDATE COLLECTION ===')
  const allTracks = await collectCandidates(
    incomingTrack,
    async (q: string) => SearchEngine.search(q),
    { minUniqueCandidates: 60, earlyExitStrongCount: 20 }
  )
  console.log(`Total unique candidates: ${allTracks.length}`)
  allTracks.forEach((t: Track, i: number) => {
    const strong = t.channelType === 'verified_topic' || t.channelType === 'verified_artist' ? ' ★STRONG' : ''
    console.log(`[${i}] id=${t.id} dur=${t.duration}s chType=${t.channelType ?? 'N/A'} artist=${t.artist}${strong}`)
    console.log(`    title="${t.title}"`)
  })

  if (allTracks.length === 0) {
    console.log('NO CANDIDATES FOUND - aborting')
    return
  }

  // Normalize + classify
  console.log()
  console.log('=== NORMALIZE + CLASSIFY ===')
  const normCandidates: NormalizedCandidate[] = allTracks.map(t => {
    const nc = normalizeTrackCandidate(t)
    nc.recordingType = classifyRecording(nc.rawTitle, nc.channelType, nc.channelVerified, nc.isTopic)
    return nc
  })

  normCandidates.forEach((nc: NormalizedCandidate, i: number) => {
    console.log(`[${i}] canonical="${nc.canonicalTitle}" uploader="${nc.uploader}" type=${nc.uploaderType} isTopic=${nc.isTopic} chVerified=${nc.channelVerified}`)
    console.log(`    raw="${nc.rawTitle}"`)
  })
  console.log()

  // Fast-path check
  console.log('=== FAST-PATH CHECK ===')
  const targetClean = incomingTrack.title.toLowerCase()
  for (const nc of normCandidates) {
    const cleanRaw = cleanTitle(nc.rawTitle).toLowerCase()
    const durMatch = Math.abs(nc.duration - incomingTrack.duration) <= 1
    const titleMatch = cleanRaw === targetClean
    if (nc.isTopic && durMatch && titleMatch) {
      console.log(`  >>> FAST PATH TRIGGERS for "${nc.rawTitle}" <<<`)
    } else if (nc.isTopic) {
      console.log(`  ✗ FAST PATH: isTopic but durMatch=${durMatch} titleMatch=${titleMatch}`)
    }
  }
  console.log()

  // Filtering
  console.log('=== FILTERING (duration gate ±2s) ===')
  const DURATION_GATE_S = 2
  const filtered: NormalizedCandidate[] = normCandidates.filter(c => {
    const durOk = Math.abs(c.duration - incomingTrack.duration) <= DURATION_GATE_S
    const cat = getAnnotationCategory(c.rawTitle, c.channelType)
    const acceptable = cat === 'official_canonical' || cat === 'official_alternate' || cat === 'unmarked' || cat === 'lyrics_version'
    if (!durOk || !acceptable) {
      console.log(`  ✗ REJECTED: dur=${c.duration}s durOk=${durOk} cat=${cat} acceptable=${acceptable} "${c.rawTitle}"`)
    }
    return durOk && acceptable
  })
  console.log(`Filtered: ${filtered.length} / ${normCandidates.length}`)
  console.log()

  // Clustering
  console.log('=== CLUSTERING ===')
  const clusters = clusterCandidates(filtered)
  console.log(`Clusters: ${clusters.length}`)
  clusters.forEach((cl: any, i: number) => {
    console.log(`[${i}] label="${cl.label}" candidates=${cl.candidates.length}`)
    cl.candidates.forEach((c: NormalizedCandidate, j: number) => {
      const titleArtist = extractArtistFromTitle(c.rawTitle)
      console.log(`  [${j}] "${c.rawTitle}" titleArtist=${titleArtist} contradictory=${isCandidateContradictory(c, incomingTrack.artist)}`)
    })
  })
  console.log()

  // Identity resolution per cluster
  console.log('=== IDENTITY RESOLUTION ===')
  for (const cl of clusters) {
    const result = resolveIdentityForCluster(cl, normalized)
    const best = cl.candidates[0]
    console.log(`"${cl.label}" → confidence=${result.confidence.toFixed(4)} (${result.confidenceLabel}) best="${best.rawTitle}"`)
  }

  // Best identity
  console.log()
  console.log('=== BEST IDENTITY ===')
  const bestResult = resolveBestIdentity(clusters, normalized)
  const bestCandidate = bestResult.cluster.candidates[0]
  console.log(`Winner: "${bestCandidate.rawTitle}" (${bestCandidate.uploader})`)
  console.log(`Confidence: ${bestResult.confidence.toFixed(4)} (${bestResult.confidenceLabel})`)

  const uploader = bestCandidate.uploader.toLowerCase()
  const isCorrect = uploader.includes('imagine')
    || bestCandidate.channelType === 'verified_topic'
    || bestCandidate.channelType === 'verified_artist'
  console.log(`Correct match: ${isCorrect ? 'YES \u2713' : 'NO \u2717'}`)
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
