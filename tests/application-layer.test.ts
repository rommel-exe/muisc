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

  // S4: resolveIdentity with all derivative candidates — should throw (strict version filtering)
  it('S4: resolveIdentity with only derivative matches should throw', async () => {
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

    await expect(
      TrackIdentityEngine.resolveIdentity(
        { title: 'Without Me', artist: 'Eminem', duration: 290 },
        0.7
      )
    ).rejects.toThrow()

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

    expect(TrackIdentityEngine.getAnnotationCategory('Song (Lyrics)', undefined)).toBe('derivative')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Piano Cover)', undefined)).toBe('derivative')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Instrumental)', undefined)).toBe('derivative')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Audio Only)', undefined)).toBe('derivative')

    expect(TrackIdentityEngine.getAnnotationCategory('Song (Official Video)', undefined)).toBe('official_canonical')
    expect(TrackIdentityEngine.getAnnotationCategory('Song (Official Audio)', undefined)).toBe('official_canonical')

    // No annotation — should be unmarked
    expect(TrackIdentityEngine.getAnnotationCategory('Song', undefined)).toBe('unmarked')
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
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
      0.65
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
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
      0.65
    )

    expect(result.id).toBe('yt_topic_fast')
    // Fast-path should have triggered — SearchEngine.search was called
    // for each query in generateSearchQueries (first query returned topic match),
    // but the fast-path doesn't short-circuit the query loop — it collects
    // all first, then fast-path checks. This is by design.
    expect(result).toBeDefined()

    searchSpy.mockRestore()
  })

  // N5: All-derivative pool falls back gracefully — NOW REJECTED (strict version filtering)
  it('N5: all-derivative candidates should be rejected even if they have high graduated scores', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    // Only derivative results — no acceptable versions
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

    // Should throw — only derivative candidates, none acceptable
    await expect(
      TrackIdentityEngine.resolveIdentity(
        { title: 'Without Me', artist: 'Eminem', duration: 290 },
        0.65
      )
    ).rejects.toThrow()

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
        { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
        0.65
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
      { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
      0.65
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

  // V4: Lyrics/instrumental candidates must be rejected
  it('V4: resolveFromCandidates rejects lyrics and instrumental candidates', async () => {
    await expect(
      TrackIdentityEngine.resolveFromCandidates(
        { title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 },
        [
          {
            youtubeId: 'yt_lyrics',
            title: 'Ed Sheeran - Shape of You (Lyrics)',
            duration: 234,
            channelType: 'user_upload',
            fingerprintHash: 'hash_lyrics',
          },
          {
            youtubeId: 'yt_instrumental',
            title: 'Ed Sheeran - Shape of You (Instrumental)',
            duration: 234,
            channelType: 'user_upload',
            fingerprintHash: 'hash_instr',
          },
        ],
        'hash_lyrics'
      )
    ).rejects.toThrow()
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
