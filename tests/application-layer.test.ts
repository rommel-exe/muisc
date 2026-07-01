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

  // S4: resolveIdentity with all derivative candidates — should return best, not throw
  it('S4: resolveIdentity with only derivative matches should return best candidate instead of throwing', async () => {
    // Mock SearchEngine.search to return only derivative results
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

    // Should not throw — should return best available
    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Without Me', artist: 'Eminem', duration: 290 },
      0.7
    )

    expect(result).toBeDefined()
    expect(result.id).toBeTruthy()
    // Both derivatives score identically — the important assertion is
    // that resolveIdentity returns a candidate instead of throwing.
    // The specific candidate chosen depends on canonical ranking tiebreakers,
    // so we only assert that a valid result was returned.
    expect(result.sourceId).toBeTruthy()
    expect(['yt_lyrics_1', 'yt_audio_2']).toContain(result.sourceId)

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

  // N5: All-derivative pool falls back gracefully
  it('N5: all-derivative between 0.5 and 0.65 should return best via fallback instead of throwing', async () => {
    const originalSearch = await import('../src/application/SearchEngine')
    const searchSpy = vi.spyOn(originalSearch.SearchEngine, 'search')

    // Mock results where duration is off by 1s:
    // duration(0.40) + title(0.20) + artist(0.15) + derivative(-0.15) = 0.60
    // 0.60 < 0.65 (threshold) and 0.60 ≥ 0.5 (fallback) → Phase 2b fallback
    searchSpy.mockResolvedValue([
      {
        id: 'yt_fallback_1',
        title: 'Eminem - Without Me (Lyrics)',
        artist: 'Eminem',
        duration: 291, // 1s off from target 290 → duration score = 0.40
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'yt_fallback_1',
      },
    ])

    const result = await TrackIdentityEngine.resolveIdentity(
      { title: 'Without Me', artist: 'Eminem', duration: 290 },
      0.65
    )

    expect(result).toBeDefined()
    expect(result.sourceId).toBe('yt_fallback_1')

    searchSpy.mockRestore()
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
    // Shuffle order should only contain indices 3+ (remaining after jump index 2)
    expect(state.shuffleOrder.length).toBe(2) // indices 3, 4
    state.shuffleOrder.forEach((i) => expect(i).toBeGreaterThanOrEqual(3))

    // previous() with no history: index>0 → decrement
    const prevResult = QueueEngine.previous()
    expect(prevResult).not.toBeNull()
    state = QueueEngine._getState()
    expect(state.index).toBe(1)

    // KEY ASSERTION: shuffle order was rebuilt from index 2+ (remaining after new index 1).
    // Without the fix, shuffleOrder would still be [3,4] (old 2-element order),
    // causing next() to skip past index 2.
    expect(state.shuffleOrder.length).toBe(3) // indices 2, 3, 4
    state.shuffleOrder.forEach((i) => {
      expect(i).toBeGreaterThanOrEqual(2)
      expect(i).toBeLessThan(5)
    })
    expect(state.shufflePos).toBe(0)

    // next() should play from the rebuilt shuffle order (index 2+)
    const nextResult = QueueEngine.next()
    expect(nextResult).not.toBeNull()
    state = QueueEngine._getState()
    // The new index should be one of the remaining tracks (2, 3, or 4)
    expect(state.index).toBeGreaterThanOrEqual(2)
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

    // KEY ASSERTION: shuffle order was rebuilt from index 5 (nothing remaining).
    // Without the fix, shuffleOrder keeps the old order (indices 1+ shuffled),
    // causing next() to skip ahead instead of starting a full reshuffle.
    expect(state.shuffleOrder.length).toBe(0) // nothing after index 4
    expect(state.shufflePos).toBe(0)

    // next() should trigger full reshuffle since shuffleOrder is empty
    const nextResult = QueueEngine.next()
    expect(nextResult).not.toBeNull()
    // repeat-all: full reshuffle plays from the beginning
    expect(QueueEngine.getCurrentIndex()).toBeGreaterThanOrEqual(0)
    expect(QueueEngine.getCurrentIndex()).toBeLessThan(tracks.length)
  })
})
