import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MediaEngine } from '../src/application/MediaEngine'
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

// ── Global Mocks for Hardware & Network boundaries ──
// vi.mock is hoisted, so we use vi.hoisted() to define the mock implementations

const { mockAudioService, mockMediaResolver } = vi.hoisted(() => ({
  mockAudioService: {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    onEndedCallback: () => {}
  },
  mockMediaResolver: {
    resolve: vi.fn().mockResolvedValue('http://localhost:8080/stream?id=dQw4w9WgXcQ')
  }
}))

vi.mock('../src/playback/AudioService', () => ({ AudioService: mockAudioService }))
vi.mock('../src/playback/MediaResolver', () => ({ MediaResolver: mockMediaResolver }))

// ── Test Suite 1: MediaEngine & QueueEngine Orchestration ──

describe('MediaEngine & QueueEngine Orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    QueueEngine.clear()
    // Reset MediaEngine state for clean test isolation
  })

  it('should initialize to IDLE and correctly transition to PLAYING when a track starts', async () => {
    expect(MediaEngine.getPlaybackState()).toBe('IDLE')

    const playPromise = MediaEngine.playTrack(mockTrack)
    expect(MediaEngine.getPlaybackState()).toBe('BUFFERING')

    await playPromise
    expect(MediaEngine.getPlaybackState()).toBe('PLAYING')
    expect(mockAudioService.play).toHaveBeenCalledWith('http://localhost:8080/stream?id=dQw4w9WgXcQ')
  })

  it('should cleanly handle a rapid spam of track plays (Concurrency Protection)', async () => {
    const track1 = { ...mockTrack, id: 'track_1' }
    const track2 = { ...mockTrack, id: 'track_2' }

    // User spams track 1 and instantly switches to track 2
    const p1 = MediaEngine.playTrack(track1)
    const p2 = MediaEngine.playTrack(track2)

    await Promise.all([p1, p2])

    // MediaEngine must safely discard the first stream and finish on the last request
    expect(MediaEngine.getActiveTrack()?.id).toBe('track_2')
  })

  it('should advance to the next track deterministically when AudioService triggers onEnded', () => {
    const trackList = [
      { ...mockTrack, id: 'song_1' },
      { ...mockTrack, id: 'song_2' }
    ]
    QueueEngine.setQueue(trackList, 0)

    // Simulate audio element naturally hitting the end of a file
    MediaEngine.handleAudioEnded()

    expect(QueueEngine.getCurrentIndex()).toBe(1)
    expect(MediaEngine.getActiveTrack()?.id).toBe('song_2')
  })

  it('should toggle between PLAYING and PAUSED states', async () => {
    await MediaEngine.playTrack(mockTrack)
    expect(MediaEngine.getPlaybackState()).toBe('PLAYING')

    MediaEngine.togglePlay()
    expect(MediaEngine.getPlaybackState()).toBe('PAUSED')
    expect(mockAudioService.pause).toHaveBeenCalled()

    MediaEngine.togglePlay()
    expect(MediaEngine.getPlaybackState()).toBe('PLAYING')
  })
})

// ── Test Suite 2: TrackIdentityEngine (The AI Self-Audit Test) ──

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
        fingerprintHash: 'a1b2c3d4e5'
      },
      'a1b2c3d4e5'
    )

    const endTime = performance.now()
    const processingTime = endTime - startTime

    // Must be near instantaneous (<50ms) to ensure the rest of the 500ms budget
    // is preserved exclusively for streaming audio chunks over the network proxy.
    expect(processingTime).toBeLessThan(50)
  })
})

// ── Test Suite 3: Resilience, Search, & Database Hydration ──

describe('Application Layer Resilience & Infrastructure Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    QueueEngine.clear()
  })

  it('should implement Silent Self-Healing if a streaming URL throws a network error', async () => {
    // Setup a queue of 2 tracks
    QueueEngine.setQueue(
      [
        { ...mockTrack, id: 'broken_track' },
        { ...mockTrack, id: 'working_track' }
      ],
      0
    )

    // Force MediaResolver to throw a 403 Forbidden or network failure
    mockMediaResolver.resolve.mockRejectedValueOnce(new Error('403 Forbidden Network Failure'))

    await MediaEngine.playTrack(QueueEngine.getCurrentTrack()!)

    // The MediaEngine must catch the error, flag 'broken_track' as toxic,
    // and instantly advance to 'working_track' without crashing the client app execution loop.
    expect(MediaEngine.getPlaybackState()).toBe('PLAYING')
    expect(MediaEngine.getActiveTrack()?.id).toBe('working_track')
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
    expect(MediaEngine.getVolume()).toBe(0.85)
    expect(endTime - startTime).toBeLessThan(100)
  })
})
