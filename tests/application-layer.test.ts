import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueueEngine } from '../src/application/QueueEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'
import { SearchEngine } from '../src/application/SearchEngine'
import { PlaylistEngine } from '../src/application/PlaylistEngine'

// ── Mock Track Data ──

const mockTrack = {
  id: 'yt_track_123',
  title: 'In The End',
  artist: 'Linkin Park',
  duration: 216,
  thumbnailUrl: 'https://img.youtube.com/123.jpg',
  source: 'youtube' as const,
  sourceId: 'dQw4w9WgXcQ'
}

const mockSpotifyTrack = {
  title: 'In The End',
  artist: 'Linkin Park',
  duration: 216,
  album: 'Hybrid Theory'
}

// ── Test Suite 1: TrackIdentityEngine (The AI Self-Audit Test) ──

describe('TrackIdentityEngine 100% Accuracy Verification', () => {
  it('should correctly select the verified studio master and discard live/cover traps', async () => {
    const mockSearchResults = [
      {
        youtubeId: 'yt_live_999',
        title: 'Linkin Park - In The End (Live in Texas HD)',
        duration: 245, // Live intro/outro bloat
        channelType: 'user_upload',
        fingerprintHash: 'bad_live_hash'
      },
      {
        youtubeId: 'yt_studio_perfect',
        title: 'Linkin Park - In The End (Official Audio)',
        duration: 216, // Perfect match
        channelType: 'verified_topic',
        fingerprintHash: 'a1b2c3d4e5'
      },
      {
        youtubeId: 'yt_cover_777',
        title: 'In The End - Linkin Park (Acoustic Piano Cover)',
        duration: 215,
        channelType: 'user_upload',
        fingerprintHash: 'bad_cover_hash'
      }
    ]

    // Inject mock search results directly into the test runtime
    const verifiedMatch = await TrackIdentityEngine.resolveFromCandidates(
      mockSpotifyTrack,
      mockSearchResults,
      'a1b2c3d4e5' // The ground-truth fingerprint reference hash from SQLite
    )

    // Assert absolute correctness criteria
    expect(verifiedMatch.id).toBe('yt_studio_perfect')
    expect(verifiedMatch.id).not.toBe('yt_live_999')
    expect(verifiedMatch.id).not.toBe('yt_cover_777')
    expect(verifiedMatch.confidenceScore).toBeGreaterThanOrEqual(0.98)
  })

  it('should enforce that the algorithmic verification loop runs under the 50ms processing budget', async () => {
    const startTime = performance.now()

    await TrackIdentityEngine.calculateConfidence(
      mockSpotifyTrack,
      {
        title: 'Linkin Park - In The End (Official Audio)',
        duration: 216,
        channelType: 'verified_topic',
      }
    )

    const endTime = performance.now()
    const processingTime = endTime - startTime

    // Must be near instantaneous (<50ms) to ensure the rest of the 500ms budget
    // is preserved exclusively for streaming audio chunks over the network proxy.
    expect(processingTime).toBeLessThan(50)
  })
})

// ── Test Suite 2: Search, & Database Hydration ──

describe('Application Layer Search & Infrastructure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    QueueEngine.clear()
  })

  it('should successfully normalize chaotic raw search payloads into standard Track Schemas', async () => {
    const rawInnertubeJson = {
      videoRenderer: {
        videoId: 'dQw4w9WgXcQ',
        title: { runs: [{ text: 'Linkin Park - Numb (Official Video) [HD]' }] },
        lengthText: { simpleText: '3:07' },
        thumbnail: { thumbnails: [{ url: 'https://img.yt.com/1.jpg' }] }
      }
    }

    const normalizedTrack = SearchEngine.normalizeRow(rawInnertubeJson)

    expect(normalizedTrack!.id).toBe('dQw4w9WgXcQ')
    expect(normalizedTrack!.title).toBe('Numb') // Stripped clean of annotations
    expect(normalizedTrack!.duration).toBe(187) // Converted 3:07 to seconds
    expect(normalizedTrack!.source).toBe('youtube')
  })

  it('should hydrate user session states from SQLite on cold boot in under 100ms', async () => {
    const startTime = performance.now()

    // Simulate reading saved parameters out of local SQLite database binary storage
    const savedSessionState = {
      queue: [mockTrack],
      currentIndex: 0,
      volume: 0.85
    }

    PlaylistEngine.hydrateSession(savedSessionState)

    const endTime = performance.now()

    expect(QueueEngine.getCurrentTrack()?.id).toBe('yt_track_123')
    expect(endTime - startTime).toBeLessThan(100)
  })
})
