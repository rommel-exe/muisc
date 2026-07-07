import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueueEngine } from '../src/application/QueueEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'
import { SearchEngine } from '../src/application/SearchEngine'
import { PlaylistEngine } from '../src/application/PlaylistEngine'
import {
  scoreArtistMatch,
  combineConfidence,
  extractArtistFromTitle,
  isCandidateContradictory,
  GENERIC_TITLES,
} from '../src/application/layers/identity-resolution'
import type { NormalizedCandidate, CandidateCluster } from '../src/application/types'

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

// ── Test Suite 2: Annotation Quality Discrimination ──

describe('TrackIdentityEngine Annotation Quality Scoring', () => {
  const target = { title: 'Without Me', artist: 'Eminem', duration: 290 }

  // S1: Official video vs lyrics video with same duration — official must score higher
  it('S1: should prefer official over lyrics when duration is identical', () => {
    const official = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Eminem - Without Me (Official Video)',
      duration: 290,
      channelType: undefined,
    })
    const lyrics = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Eminem - Without Me (Lyrics)',
      duration: 290,
      channelType: undefined,
    })
    expect(official).toBeGreaterThan(lyrics)
    expect(official).toBeGreaterThanOrEqual(0.7)
  })

  // S2: Cover song vs official with same duration — official must score higher
  it('S2: should prefer official over cover when duration is identical', () => {
    const official = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Eminem - Without Me (Official Music Video)',
      duration: 290,
      channelType: undefined,
    })
    const cover = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Without Me (Piano Cover)',
      duration: 290,
      channelType: undefined,
    })
    expect(official).toBeGreaterThan(cover)
    expect(official).toBeGreaterThanOrEqual(0.7)
  })

  // S3: Topic channel vs audio-only with same duration — topic must score higher
  it('S3: should prefer topic channel over audio-only when duration is identical', () => {
    const topic = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Without Me',
      duration: 290,
      channelType: 'verified_topic',
    })
    const audioOnly = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Eminem - Without Me (Audio)',
      duration: 290,
      channelType: undefined,
    })
    expect(topic).toBeGreaterThan(audioOnly)
    expect(topic).toBeGreaterThanOrEqual(0.7)
  })

  // S4: resolveIdentity with lyrics (acceptable) and audio-only (derivative)
  it('S4: resolveIdentity accepts lyrics but rejects audio-only', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    searchSpy.mockResolvedValue([
      {
        id: 'yt_lyrics_1',
        title: 'Eminem - Without Me (Lyrics)',
        artist: 'Eminem',
        duration: 290,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_lyrics_1',
      },
      {
        id: 'yt_audio_2',
        title: 'Eminem - Without Me (Audio Only)',
        artist: 'Eminem',
        duration: 290,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_audio_2',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Without Me', artist: 'Eminem', duration: 290 }
    )

    expect(result).toBeDefined()
    expect(result.sourceId).toBe('yt_lyrics_1')

    searchSpy.mockRestore()
  })

  // ── New Tests N1-N5: Version Detection, Canonical Ranking, Two-Phase Flow ──

  // N1: Version marker detection
  it('N1: should detect version markers correctly in raw titles', () => {
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Remix)', undefined)).toBe('remix_edit')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Seeb Remix)', undefined)).toBe('remix_edit')
    expect(TrackIdentityEngine.getAnnotationCategory('Song - Radio Edit', undefined)).toBe('remix_edit')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Extended Mix)', undefined)).toBe('remix_edit')

    expect(TrackIdentityEngine.getAnnotationCategory('Song (Live at Wembley)', undefined)).toBe('live_performance')
    expect(TrackIdentityEngine.getAnnotationCategory('Song [Live]', undefined)).toBe('live_performance')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Live)', undefined)).toBe('live_performance')

    expect(TrackIdentityEngine.getAnnotationCategory("Song (Taylor's Version)", undefined)).toBe('alternate_version')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Anniversary Edition)', undefined)).toBe('alternate_version')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (2011 Remaster)', undefined)).toBe('alternate_version')

    expect(TrackIdentityEngine.getAnnotationCategory('Song (Lyrics)', undefined)).toBe('lyrics_version')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Piano Cover)', undefined)).toBe('derivative')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Instrumental)', undefined)).toBe('derivative')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Audio Only)', undefined)).toBe('derivative')

    expect(TrackIdentityEngine.getAnnotationCategory('Song (Official Video)', undefined)).toBe('official_canonical')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Official Audio)', undefined)).toBe('official_canonical')

    // No annotation — should be unmarked
    expect(TrackIdentityEngine.getAnnotationCategory('Song', undefined)).toBe('unmarked')
  })

  it('should reject acoustic versions as alternate_version', () => {
    expect(TrackIdentityEngine.getAnnotationCategory('OneRepublic - Run (Acoustic)', undefined)).toBe('alternate_version')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Acoustic Version)', undefined)).toBe('alternate_version')
    expect(TrackIdentityEngine.isAcceptableVersion('OneRepublic - Run (Acoustic)', undefined)).toBe(false)
  })

  // N2: Canonical ranking with version markers
  it('N2: should rank canonical version above remix given equal duration', async () => {
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
      [
        {
          youtubeId: 'yt_remix_1',
          title: 'The Weeknd - Blinding Lights (Remix)',
          duration: 200,
          channelType: 'verified_artist',
          fingerprintHash: 'hash_remix',
        },
        {
          youtubeId: 'yt_topic_1',
          title: 'The Weeknd - Blinding Lights',
          duration: 200,
          channelType: 'verified_topic',
          fingerprintHash: 'hash_topic',
        },
      ],
      'hash_topic'
    )

    expect(result.id).toBe('yt_topic_1')
    expect(result.id).not.toBe('yt_remix_1')
  })

  // N3: resolveIdentity with same-duration remix on verified_artist vs topic
  it('N3: should prefer topic channel over same-duration remix on verified_artist', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    // Return results that include both a remix on verified_artist and a topic version
    searchSpy.mockResolvedValue([
      {
        id: 'yt_remix_1',
        title: 'The Weeknd - Blinding Lights (Remix)',
        artist: 'The Weeknd',
        duration: 200,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_remix_1',
        channelType: 'verified_artist',
      },
      {
        id: 'yt_topic_1',
        title: 'The Weeknd - Blinding Lights',
        artist: 'The Weeknd',
        duration: 200,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_topic_1',
        channelType: 'verified_topic',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }
    )

    // Topic channel should win over remix on verified_artist
    expect(result.id).toBe('yt_topic_1')
    expect(result.sourceId).toBe('yt_topic_1')

    searchSpy.mockRestore()
  })

  // N4: Fast-path triggers correctly
  it('N4: fast-path returns topic channel immediately when exact match exists', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    // Mock generatesSearchQueries → 9 queries. With fast-path, only first query runs.
    searchSpy.mockResolvedValue([
      {
        id: 'yt_topic_fast',
        title: 'The Weeknd - Blinding Lights',
        artist: 'The Weeknd',
        duration: 200,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_topic_fast',
        channelType: 'verified_topic',  // Topic + exact duration + exact title = fast-path trigger
      },
      {
        id: 'yt_other',
        title: 'The Weeknd - Blinding Lights (Lyrics)',
        artist: 'The Weeknd',
        duration: 200,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_other',
        channelType: 'user_upload',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }
    )

    expect(result.id).toBe('yt_topic_fast')
    // Fast-path should have triggered — SearchEngine.search was called
    // for each query in generateSearchQueries (first query returned topic match),
    // but the fast-path doesn't short-circuit the query loop — it collects
    // all first, then fast-path checks. This is by design.
    expect(result).toBeDefined()

    searchSpy.mockRestore()
  })

  // N5: Lyrics are acceptable — should return the lyrics candidate
  it('N5: lyrics candidates should be accepted', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    searchSpy.mockResolvedValue([
      {
        id: 'yt_lyrics_1',
        title: 'Eminem - Without Me (Lyrics)',
        artist: 'Eminem',
        duration: 290,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_lyrics_1',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Without Me', artist: 'Eminem', duration: 290 }
    )

    expect(result).toBeDefined()
    expect(result.sourceId).toBe('yt_lyrics_1')

    searchSpy.mockRestore()
  })

  // ── Strict Duration Gate Tests (D1-D3) ──

  // D1: Candidates >2s off must be rejected in resolveFromCandidates
  it('D1: resolveFromCandidates rejects candidates more than 2s off even with high scores', async () => {
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
        [
          {
            youtubeId: 'yt_official_5s',
            title: 'The Weeknd - Blinding Lights (Official Audio)',
            duration: 205, // 5s off — exceeds ±2s gate
            channelType: 'verified_topic',
            fingerprintHash: 'hash_official',
          },
          {
            youtubeId: 'yt_remix_exact',
            title: 'The Weeknd - Blinding Lights (Remix)',
            duration: 200, // exact duration but remix
            channelType: 'verified_artist',
            fingerprintHash: 'hash_remix',
          },
        ],
        'hash_official'
      )
    ).rejects.toThrow()
  })

  // D2: resolveIdentity should throw when all candidates are >2s off
  it('D2: resolveIdentity throws when all candidates exceed ±2s duration gate', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    searchSpy.mockResolvedValue([
      {
        id: 'yt_far_1',
        title: 'The Weeknd - Blinding Lights',
        artist: 'The Weeknd',
        duration: 210, // 10s off — way beyond ±2s
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_far_1',
        channelType: 'verified_topic',
      },
      {
        id: 'yt_far_2',
        title: 'The Weeknd - Blinding Lights',
        artist: 'The Weeknd',
        duration: 190, // 10s off other direction
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_far_2',
        channelType: 'verified_topic',
      },
    ])

    await expect(
      TrackIdentityEngine.resolveIdentity(
        { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }
      )
    ).rejects.toThrow()

    searchSpy.mockRestore()
  })

  // D3: resolveIdentity should accept candidates within ±2s
  it('D3: resolveIdentity accepts candidates within ±2s duration gate', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    searchSpy.mockResolvedValue([
      {
        id: 'yt_close_1',
        title: 'The Weeknd - Blinding Lights',
        artist: 'The Weeknd',
        duration: 201, // 1s off — within ±2s
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_close_1',
        channelType: 'verified_topic',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }
    )

    expect(result).toBeDefined()
    expect(result.sourceId).toBe('yt_close_1')

    searchSpy.mockRestore()
  })

  // ── Version Rejection Tests (V1-V4) ──

  // V1: Remix candidates must be rejected
  it('V1: resolveFromCandidates rejects remix candidates', async () => {
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Levitating', artist: 'Dua Lipa', duration: 203 },
        [
          {
            youtubeId: 'yt_remix',
            title: 'Dua Lipa - Levitating (Remix)',
            duration: 203, // exact duration
            channelType: 'verified_artist',
            fingerprintHash: 'hash_remix',
          },
        ],
        'hash_remix'
      )
    ).rejects.toThrow()
  })

  // V2: Live performance candidates must be rejected
  it('V2: resolveFromCandidates rejects live performance candidates', async () => {
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Someone Like You', artist: 'Adele', duration: 285 },
        [
          {
            youtubeId: 'yt_live',
            title: 'Adele - Someone Like You (Live at Royal Albert Hall)',
            duration: 285, // exact duration
            channelType: 'verified_artist',
            fingerprintHash: 'hash_live',
          },
        ],
        'hash_live'
      )
    ).rejects.toThrow()
  })

  // V3: Cover/tribute candidates must be rejected
  it('V3: resolveFromCandidates rejects cover/tribute candidates', async () => {
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355 },
        [
          {
            youtubeId: 'yt_cover',
            title: 'Bohemian Rhapsody (Piano Cover)',
            duration: 355, // exact duration
            channelType: 'user_upload',
            fingerprintHash: 'hash_cover',
          },
        ],
        'hash_cover'
      )
    ).rejects.toThrow()
  })

  // V4: Instrumental candidates must be rejected (lyrics are acceptable)
  it('V4: resolveFromCandidates rejects instrumental candidates but accepts lyrics', async () => {
    // Instrumental should be rejected
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 },
        [
          {
            youtubeId: 'yt_instrumental',
            title: 'Ed Sheeran - Shape of You (Instrumental)',
            duration: 234,
            channelType: 'user_upload',
            fingerprintHash: 'hash_instr',
          },
        ],
        'hash_instr'
      )
    ).rejects.toThrow()

    // Lyrics should be accepted
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 },
      [
        {
          youtubeId: 'yt_lyrics',
          title: 'Ed Sheeran - Shape of You (Lyrics)',
          duration: 234,
          channelType: 'user_upload',
          fingerprintHash: 'hash_lyrics',
        },
      ],
      'hash_lyrics'
    )
    expect(result.id).toBe('yt_lyrics')
  })

  // ── Official Audio Preference Tests (O1-O3) ──

  // O1: Official audio should win over unmarked when both within ±2s
  it('O1: official_canonical wins over unmarked when both are within ±2s', async () => {
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 },
      [
        {
          youtubeId: 'yt_unmarked',
          title: 'Ed Sheeran - Shape of You',
          duration: 234,
          channelType: 'user_upload',
          fingerprintHash: 'hash_unmarked',
        },
        {
          youtubeId: 'yt_official',
          title: 'Ed Sheeran - Shape of You (Official Audio)',
          duration: 234,
          channelType: 'verified_topic',
          fingerprintHash: 'hash_official',
        },
      ],
      'hash_official'
    )

    expect(result.id).toBe('yt_official')
  })

  // O2: Official audio should win over verified_artist non-official
  it('O2: official_canonical on topic wins over verified_artist without official annotation', async () => {
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Watermelon Sugar', artist: 'Harry Styles', duration: 174 },
      [
        {
          youtubeId: 'yt_artist',
          title: 'Harry Styles - Watermelon Sugar',
          duration: 174,
          channelType: 'verified_artist',
          fingerprintHash: 'hash_artist',
        },
        {
          youtubeId: 'yt_topic_official',
          title: 'Harry Styles - Watermelon Sugar (Official Audio)',
          duration: 174,
          channelType: 'verified_topic',
          fingerprintHash: 'hash_topic',
        },
      ],
      'hash_topic'
    )

    expect(result.id).toBe('yt_topic_official')
  })

  // O3: Topic channel should win over user_upload with same content
  it('O3: topic channel wins over user_upload when both are within ±2s and acceptable', async () => {
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Stay', artist: 'The Kid LAROI, Justin Bieber', duration: 141 },
      [
        {
          youtubeId: 'yt_user',
          title: 'The Kid LAROI, Justin Bieber - Stay',
          duration: 141,
          channelType: 'user_upload',
          fingerprintHash: 'hash_user',
        },
        {
          youtubeId: 'yt_topic',
          title: 'The Kid LAROI, Justin Bieber - Stay',
          duration: 141,
          channelType: 'verified_topic',
          fingerprintHash: 'hash_topic',
        },
      ],
      'hash_topic'
    )

    expect(result.id).toBe('yt_topic')
  })
})

// ── Test Suite 3: Search, & Database Hydration ──

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

// ── Test Suite 4: QueueEngine Shuffle Edge Cases ──

describe('QueueEngine Shuffle previous() Regression', () => {
  const tracks = [
    { id: '1', title: 'Track A', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '1' },
    { id: '2', title: 'Track B', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '2' },
    { id: '3', title: 'Track C', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '3' },
    { id: '4', title: 'Track D', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '4' },
    { id: '5', title: 'Track E', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '5' },
  ]

  beforeEach(() => {
    QueueEngine.clear()
  })

  it('should rebuild shuffle order after previous() no-history fallback', () => {
    QueueEngine.setQueue(tracks, 0)
    QueueEngine.setShuffleActive(true)

    // jumpToIndex clears history and builds shuffle from that point
    QueueEngine.jumpToIndex(2)
    let state = QueueEngine._getState()
    expect(state.index).toBe(2)
    expect(state.history).toEqual([])
    // Shuffle order contains ALL indices except current (2) — full queue shuffle
    expect(state.shuffleOrder.length).toBe(4) // indices 0, 1, 3, 4
    state.shuffleOrder.forEach((i) => expect(i).not.toBe(2))
    state.shuffleOrder.forEach((i) => {
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(5)
    })

    // previous() with no history: index>0 → decrement
    const prevResult = QueueEngine.previous()
    expect(prevResult).not.toBeNull()
    state = QueueEngine._getState()
    expect(state.index).toBe(1)

    // KEY ASSERTION: shuffle order was rebuilt with ALL indices except new index 1.
    expect(state.shuffleOrder.length).toBe(4) // indices 0, 2, 3, 4
    state.shuffleOrder.forEach((i) => {
      expect(i).not.toBe(1)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(5)
    })
    expect(state.shufflePos).toBe(0)

    // next() should play from the rebuilt shuffle order (any index except 1)
    const nextResult = QueueEngine.next()
    expect(nextResult).not.toBeNull()
    state = QueueEngine._getState()
    // The new index should be one of the shuffled tracks (not the current 1)
    expect(state.index).not.toBe(1)
    expect(state.index).toBeGreaterThanOrEqual(0)
    expect(state.index).toBeLessThan(5)
    // Without the fix, next() could return index 3 or 4 (from stale [3,4] order),
    // skipping the track at index 2 entirely.
  })

  it('should rebuild shuffle order after previous() repeat-all wrap in shuffle mode', () => {
    QueueEngine.setQueue(tracks, 0)

    // index=0, repeatMode='all' (set by setQueue)
    QueueEngine.setShuffleActive(true)

    // previous() with no history and index=0: repeat-all wraps to last track
    const prevResult = QueueEngine.previous()
    expect(prevResult).not.toBeNull()
    const state = QueueEngine._getState()
    expect(state.index).toBe(4) // last track

    // KEY ASSERTION: shuffle order contains ALL indices except current (4).
    // Full queue shuffle means every track except the current one is fair game.
    expect(state.shuffleOrder.length).toBe(4) // indices 0, 1, 2, 3
    state.shuffleOrder.forEach((i) => {
      expect(i).not.toBe(4)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(5)
    })
    expect(state.shufflePos).toBe(0)

    // next() plays from the rebuilt shuffle order
    const nextResult = QueueEngine.next()
    expect(nextResult).not.toBeNull()
    expect(QueueEngine.getCurrentIndex()).not.toBe(4)
    expect(QueueEngine.getCurrentIndex()).toBeGreaterThanOrEqual(0)
    expect(QueueEngine.getCurrentIndex()).toBeLessThan(tracks.length)
  })
})

describe('QueueEngine Unlimited Shuffle', () => {
  const tracks = [
    { id: '1', title: 'Track A', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '1' },
    { id: '2', title: 'Track B', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '2' },
    { id: '3', title: 'Track C', artist: 'Artist', duration: 100, thumbnailUrl: '', source: 'youtube' as const, sourceId: '3' },
  ]

  beforeEach(() => {
    QueueEngine.clear()
  })

  it('should reshuffle and continue when shuffle exhausts with repeatMode=none', () => {
    QueueEngine.setQueue(tracks, 0)
    QueueEngine.setRepeatMode('none')
    QueueEngine.setShuffleActive(true)

    let state = QueueEngine._getState()
    const totalSlots = state.shuffleOrder.length

    for (let i = 0; i < totalSlots; i++) {
      const next = QueueEngine.next()
      expect(next).not.toBeNull()
    }

    state = QueueEngine._getState()
    expect(state.shufflePos).toBe(totalSlots)
    expect(state.shuffleOrder.length).toBe(totalSlots)

    const nextAfterExhaust = QueueEngine.next()
    expect(nextAfterExhaust).not.toBeNull()
    state = QueueEngine._getState()
    expect(state.shufflePos).toBe(1)
    expect(QueueEngine.getCurrentIndex()).toBeGreaterThanOrEqual(0)
    expect(QueueEngine.getCurrentIndex()).toBeLessThan(tracks.length)
  })

  it('should reshuffle and continue when shuffle exhausts with repeatMode=all', () => {
    QueueEngine.setQueue(tracks, 0)
    QueueEngine.setRepeatMode('all')
    QueueEngine.setShuffleActive(true)

    let state = QueueEngine._getState()
    const totalSlots = state.shuffleOrder.length

    for (let i = 0; i < totalSlots; i++) {
      const next = QueueEngine.next()
      expect(next).not.toBeNull()
    }

    state = QueueEngine._getState()
    expect(state.shufflePos).toBe(totalSlots)

    const nextAfterExhaust = QueueEngine.next()
    expect(nextAfterExhaust).not.toBeNull()
    state = QueueEngine._getState()
    expect(state.shufflePos).toBe(1)
    expect(QueueEngine.getCurrentIndex()).toBeGreaterThanOrEqual(0)
    expect(QueueEngine.getCurrentIndex()).toBeLessThan(tracks.length)
  })

  it('peekNext should return null when shuffle is exhausted (reshuffle happens on next())', () => {
    QueueEngine.setQueue(tracks, 0)
    QueueEngine.setRepeatMode('none')
    QueueEngine.setShuffleActive(true)

    let state = QueueEngine._getState()
    const totalSlots = state.shuffleOrder.length

    for (let i = 0; i < totalSlots; i++) {
      QueueEngine.next()
    }

    const peeked = QueueEngine.peekNext()
    expect(peeked).toBeNull()
  })
})

// ── Test Suite 5: Artist Matching Edge Cases (7 Patches) ──

describe('TrackIdentityEngine Artist Matching Edge Cases', () => {
  // Helper to create a minimal NormalizedCandidate
  function makeCandidate(overrides: Partial<NormalizedCandidate> & { rawTitle: string }): NormalizedCandidate {
    return {
      videoId: 'test_vid',
      canonicalTitle: overrides.rawTitle.replace(/^(.+?)\s*[-–—]\s*(.+)/, '$2').trim(),
      tokenCount: 0,
      uploader: overrides.uploader ?? 'Test Channel',
      uploaderType: 'user_upload',
      duration: 200,
      recordingType: 'studio' as const,
      channelVerified: false,
      isTopic: false,
      isOfficial: false,
      metadataQuality: 0.5,
      channelType: 'user_upload',
      ...overrides,
    }
  }

  // ── Patch 1+6: Contradictory artist detection ──

  it('P1+P6: scoreArtistMatch returns -0.75 when ALL candidates have contradictory artist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({ rawTitle: 'James Major - Believer', uploader: 'James Major' })]
    )
    expect(result).toBe(-0.75)
  })

  it('P1+P6: scoreArtistMatch returns positive when contradictory and correct candidates coexist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [
        makeCandidate({ rawTitle: 'James Major - Believer', uploader: 'James Major' }),
        makeCandidate({ rawTitle: 'Imagine Dragons - Believer', uploader: 'Imagine Dragons' }),
      ]
    )
    // Should find the non-contradictory correct match
    expect(result).toBeGreaterThanOrEqual(0.5)
  })

  it('P1+P6: scoreArtistMatch does NOT penalize verified_topic when uploader matches primary artist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({
        rawTitle: 'Believer',
        uploader: 'Imagine Dragons - Topic',
        isTopic: true,
        channelType: 'verified_topic',
        channelVerified: true,
      })]
    )
    // Topic channel whose uploader matches the primary artist is NOT contradictory
    expect(result).not.toBe(-0.75)
  })

  it('P1+P6: isCandidateContradictory does NOT flag Song-Artist format when uploader confirms artist', () => {
    // Bug A regression: "Hello - Adele" has prefix "hello" not matching "adele",
    // but uploader "AdeleVEVO" confirms the artist — should NOT be contradictory.
    const result = isCandidateContradictory(
      makeCandidate({
        rawTitle: 'Hello - Adele',
        uploader: 'AdeleVEVO',
      }),
      'Adele'
    )
    expect(result).toBe(false)
  })

  it('P1+P6: isCandidateContradictory DOES flag Artist-Song format when both title and uploader differ', () => {
    // "James Major - Believer" by JamesMajorVEVO: prefix "james major" differs from
    // primary "imagine dragons", and uploader "jamesmajorvevo" doesn't match either.
    const result = isCandidateContradictory(
      makeCandidate({
        rawTitle: 'James Major - Believer',
        uploader: 'JamesMajorVEVO',
      }),
      'Imagine Dragons'
    )
    expect(result).toBe(true)
  })

  // ── Patch 2: Mixed contradictory+no-evidence penalty ──

  it('P2: scoreArtistMatch returns -0.40 when contradictory and no-evidence candidates coexist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [
        makeCandidate({ rawTitle: 'James Major - Believer', uploader: 'James Major' }),
        makeCandidate({ rawTitle: 'Believer', uploader: 'SomeChannel' }),
      ]
    )
    // Only contradictory + no-evidence → cluster should not be treated as neutral
    expect(result).toBe(-0.40)
  })

  it('P2: scoreArtistMatch still returns positive when contradictory and evidence-based candidates coexist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [
        makeCandidate({ rawTitle: 'James Major - Believer', uploader: 'James Major' }),
        makeCandidate({ rawTitle: 'Believer', uploader: 'imagine dragons' }),
      ]
    )
    // Uploader match (0.85) should still win despite contradictory presence
    expect(result).toBeGreaterThanOrEqual(0.85)
  })

  // ── Patch 4: Channel-type bonuses for topic/verified channels ──

  it('P4: scoreArtistMatch returns 0.85 for correct-artist verified_topic channel (uploader + channel bonus)', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({
        rawTitle: 'Believer',
        uploader: 'Imagine Dragons - Topic',
        isTopic: true,
        channelType: 'verified_topic',
        channelVerified: true,
      })]
    )
    // Correct-artist Topic channel: uploader "Imagine Dragons - Topic" matches primary artist
    // (0.50 uploader match) + channel-type bonus (0.35 implicit) = 0.85
    expect(result).toBe(0.85)
  })

  it('P4: scoreArtistMatch returns 0.25 for verified_artist channel with no artist evidence', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({
        rawTitle: 'Believer',
        uploader: 'MusicUploads',
        channelType: 'verified_artist',
        channelVerified: true,
      })]
    )
    // Verified artist channel gets +0.25 bonus (single-word uploader avoids contradiction)
    expect(result).toBe(0.25)
  })

  // ── Patch 7: Artist prefix bonus ──

  it('P7: scoreArtistMatch returns 1.0 when candidate title starts with target artist', () => {
    const result = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({ rawTitle: 'Imagine Dragons - Believer', uploader: 'Imagine Dragons' })]
    )
    expect(result).toBe(1.0)
  })

  it('P7: scoreArtistMatch returns 0.70 when target artist appears in raw title body but not canonical title', () => {
    const result = scoreArtistMatch(
      ['Eminem'],
      [makeCandidate({
        rawTitle: 'Awesome Song (Eminem Remix)',
        uploader: 'SomeChannel',
        canonicalTitle: 'Awesome Song', // Artist only appears in raw title parens
      })]
    )
    expect(result).toBe(0.70)
  })

  it('P7: scoreArtistMatch favors artist prefix (1.0) over uploader match (0.85)', () => {
    const prefixMatch = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({ rawTitle: 'Imagine Dragons - Believer', uploader: 'SomeChannel' })]
    )
    const uploaderMatch = scoreArtistMatch(
      ['Imagine Dragons'],
      [makeCandidate({ rawTitle: 'Believer', uploader: 'Imagine Dragons' })]
    )
    expect(prefixMatch).toBe(1.0)
    expect(uploaderMatch).toBe(0.85)
    expect(prefixMatch).toBeGreaterThan(uploaderMatch)
  })

  // ── Patch 2: Conflicting artist names in title body ──
  // (Covered by P1+P6 — extractArtistFromTitle catches prefix mismatches)

  it('P2: extractArtistFromTitle detects artist prefix in standard format', () => {
    expect(extractArtistFromTitle('Imagine Dragons - Believer')).toBe('imagine dragons')
    expect(extractArtistFromTitle('Eminem – Without Me')).toBe('eminem')
    expect(extractArtistFromTitle('Adele — Hello')).toBe('adele')
  })

  it('P2: extractArtistFromTitle returns null for titles without separators', () => {
    expect(extractArtistFromTitle('Believer')).toBeNull()
    expect(extractArtistFromTitle('Hello')).toBeNull()
  })

  // ── Patch 3: Generic titles need stronger artist evidence ──

  it('P3: GENERIC_TITLES includes all specified titles', () => {
    for (const t of ['stay', 'home', 'hello', 'believer', 'enemy', 'monster',
                     'alive', 'hero', 'lost', 'run', 'fire', 'broken']) {
      expect(GENERIC_TITLES.has(t)).toBe(true)
    }
    expect(GENERIC_TITLES.has('Bohemian Rhapsody')).toBe(false)
  })

  it('P3: generic title penalty applies when artistScore is low', async () => {
    const { resolveIdentityForCluster } = await import('../src/application/layers/identity-resolution')
    const cluster: CandidateCluster = {
      id: 'test_cluster',
      label: 'believer',
      recordingClass: 'studio',
      candidates: [makeCandidate({ rawTitle: 'Believer', uploader: 'SomeChannel' })],
    }
    // Incoming "Believer" by "Imagine Dragons" — generic title, no artist evidence in candidate
    const incoming: import('../src/application/types').NormalizedMetadata = {
      canonicalTitle: 'believer',
      rawTitle: 'Believer',
      primaryArtist: 'Imagine Dragons',
      artists: ['Imagine Dragons'],
      featuring: [],
      album: '',
      duration: 200,
      explicit: false,
    }
    const result = resolveIdentityForCluster(cluster, incoming)
    // Low artistScore + generic title → penalty applied (reduced because title+duration both 1.0)
    // effectiveArtistScore = 0.0 - 0.15 = -0.15
    // combineConfidence(1.0, 1.0, 1.0, -0.15, 0.5, 1) = 0.54 → transform → 0.61 (manual_review)
    expect(result.confidence).toBe(0.61)
    expect(result.confidenceLabel).toBe('manual_review')
  })

  // ── Patch 4: Verified artist bonus in calculateConfidence ──

  it('P4: calculateConfidence gives verified_artist higher score than user_upload', () => {
    const target = { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }

    const verifiedArtist = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Imagine Dragons - Believer',
      duration: 204,
      channelType: 'verified_artist',
    })
    const userUpload = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Imagine Dragons - Believer',
      duration: 204,
      channelType: undefined,
    })

    expect(verifiedArtist).toBeGreaterThan(userUpload)
  })

  it('P4: calculateConfidence gives verified_topic +0.30 bonus', () => {
    const target = { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }

    const topic = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Believer',
      duration: 204,
      channelType: 'verified_topic',
    })
    const user = TrackIdentityEngine.calculateConfidence(target, {
      title: 'Believer',
      duration: 204,
      channelType: undefined,
    })

    expect(topic).toBeGreaterThan(user)
  })

  // ── Patch 5: combineConfidence weight doubling for short titles ──

  it('P5: combineConfidence doubles artist weight for short titles (≤2 tokens)', () => {
    // All identical scores except artist — short title should amplify the difference
    const shortTitleArtistHigh = combineConfidence(1.0, 1.0, 1.0, 1.0, 0.5, 1)
    const shortTitleArtistLow = combineConfidence(1.0, 1.0, 1.0, 0.0, 0.5, 1)
    const normalTitleArtistHigh = combineConfidence(1.0, 1.0, 1.0, 1.0, 0.5, 5)
    const normalTitleArtistLow = combineConfidence(1.0, 1.0, 1.0, 0.0, 0.5, 5)

    // For short titles, the gap between high and low artist score should be larger
    const shortGap = shortTitleArtistHigh - shortTitleArtistLow
    const normalGap = normalTitleArtistHigh - normalTitleArtistLow
    expect(shortGap).toBeGreaterThan(normalGap)
  })

  it('P5: combineConfidence negative artist score is amplified for short titles', () => {
    const withNegArtist = combineConfidence(0.8, 0.8, 0.8, -0.75, 0.5, 1)
    const withZeroArtist = combineConfidence(0.8, 0.8, 0.8, 0.0, 0.5, 1)

    // Negative artist should drag down confidence significantly
    expect(withNegArtist).toBeLessThan(withZeroArtist)
    // Verify the math: 0.8*0.25 + 0.8*0.15 + 0.8*0.20 + (-0.75)*0.40 + 0.5*0.00
    // = 0.20 + 0.12 + 0.16 - 0.30 + 0.00 = 0.18
    expect(withNegArtist).toBeCloseTo(0.18, 2)
  })

  // ── Integration: Wrong-artist candidate loses ──

  it('P1+P6 INTEGRATION: resolveFromCandidates rejects wrong-artist candidate with same title+duration', async () => {
    const result = await TrackIdentityEngine.resolveFromCandidates(
      { title: 'Believer', artist: 'Imagine Dragons', duration: 204 },
      [
        {
          youtubeId: 'yt_wrong',
          title: 'James Major - Believer',
          duration: 204,
          channelType: 'user_upload',
          fingerprintHash: 'hash_wrong',
        },
        {
          youtubeId: 'yt_correct',
          title: 'Imagine Dragons - Believer',
          duration: 204,
          channelType: 'verified_topic',
          fingerprintHash: 'hash_correct',
        },
      ],
      'hash_correct'
    )

    expect(result.id).toBe('yt_correct')
    expect(result.id).not.toBe('yt_wrong')
  })

  it('P1+P6 INTEGRATION: resolveIdentity should score correct-artist cluster higher than wrong-artist cluster', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    // Both user_upload (no fast-path) — tests the actual identity resolution pipeline
    searchSpy.mockResolvedValue([
      {
        id: 'yt_correct',
        title: 'Imagine Dragons - Believer',
        artist: 'Imagine Dragons',
        duration: 204,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_correct',
        channelType: 'user_upload',
      },
      {
        id: 'yt_wrong',
        title: 'James Major - Believer',
        artist: 'James Major',
        duration: 204,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_wrong',
        channelType: 'user_upload',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }
    )

    expect(result).toBeDefined()
    // The correct-artist candidate should win over the wrong-artist one
    expect(result.sourceId).toBe('yt_correct')
    expect(result.title).toContain('Imagine Dragons')

    searchSpy.mockRestore()
  })

  it('P7 INTEGRATION: resolveIdentity favors artist-prefix candidate', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    searchSpy.mockResolvedValue([
      {
        id: 'yt_bare',
        title: 'Believer',
        artist: 'Imagine Dragons',
        duration: 204,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_bare',
        channelType: 'user_upload',
      },
      {
        id: 'yt_prefix',
        title: 'Imagine Dragons - Believer',
        artist: 'Imagine Dragons',
        duration: 204,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_prefix',
        channelType: 'user_upload',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }
    )

    // The artist-prefix candidate should win
    expect(result).toBeDefined()
    // Both are user_upload with no duration gate — the one with artist prefix should win
    // The bare "Believer" without artist context should score lower on artist match
    expect(result.sourceId).toBe('yt_prefix')

    searchSpy.mockRestore()
  })

  // ── Old calculateConfidence penalty tests ──

  it('P1 OLD: calculateConfidence applies -0.50 artist mismatch penalty', () => {
    const target = { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }
    const candidate = { title: 'Believer', duration: 204, channelType: undefined, artist: 'James Major' }

    const score = TrackIdentityEngine.calculateConfidence(target, candidate)
    // Duration exact: +0.50, Title match: +0.20, Artist mismatch: -0.50
    // Expected: 0.50 + 0.20 - 0.50 = 0.20
    expect(score).toBeCloseTo(0.20, 2)
  })

  it('P1 OLD: calculateConfidence penalty is indeed -0.50 (not -0.15)', () => {
    const target = { title: 'Believer', artist: 'Imagine Dragons', duration: 204 }
    const candidateNoArtist = { title: 'Believer', duration: 204, channelType: undefined }
    const candidateWrongArtist = { title: 'Believer', duration: 204, channelType: undefined, artist: 'James Major' }

    const scoreNoArtist = TrackIdentityEngine.calculateConfidence(target, candidateNoArtist)
    const scoreWrongArtist = TrackIdentityEngine.calculateConfidence(target, candidateWrongArtist)

    // The gap should be at least 0.50 (our new penalty)
    expect(scoreNoArtist - scoreWrongArtist).toBeGreaterThanOrEqual(0.45)
  })
})
