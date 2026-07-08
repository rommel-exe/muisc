/**
 * Regression test for the "Believer -> James Major" wrong-artist import bug.
 *
 * Bug: when the correct-artist YouTube candidates (Imagine Dragons) were dropped
 * by the tight ±2s duration gate or rate-limited search, the only surviving
 * candidate was James Major's Topic upload — and resolveIdentity returned it
 * even though its artist contradicts the target track.
 *
 * Fix: resolveIdentity never returns a candidate whose artist contradicts the
 * target; if the correct artist is missing within the tight gate, it widens the
 * gate (±10s) to recover it before giving up.
 *
 * Uses a mocked search function (no network) so the guard is verified
 * deterministically and never flakes on rate limits.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setSearchFunction } from '../src/application/SearchEngine'
import { TrackIdentityEngine } from '../src/application/TrackIdentityEngine'

describe('TrackIdentityEngine — wrong-artist rejection (Believer bug)', () => {
  beforeEach(() => {
    // Reset to a no-op search; each test installs its own mock.
    setSearchFunction(async () => [])
  })

  it('never returns a contradictory-artist candidate when it is the sole survivor', async () => {
    setSearchFunction(async () => [
      {
        id: 'jamesMajorId',
        title: 'Believer',
        artist: 'James Major - Topic',
        duration: 202,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'jamesMajorId',
        channelType: 'verified_topic',
      },
    ])

    await expect(
      TrackIdentityEngine.resolveIdentity({
        title: 'Believer',
        artist: 'Imagine Dragons',
        duration: 204,
      })
    ).rejects.toThrow(/contradicting target artist/)
  })

  it('recovers the correct artist via the widened-gate fallback', async () => {
    setSearchFunction(async () => [
      {
        id: 'jamesMajorId',
        title: 'Believer',
        artist: 'James Major - Topic',
        duration: 202,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'jamesMajorId',
        channelType: 'verified_topic',
      },
      {
        id: 'imagineDragonsId',
        title: 'Imagine Dragons - Believer (Official Music Video)',
        artist: 'ImagineDragons',
        duration: 209,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'imagineDragonsId',
        channelType: 'user_upload',
      },
    ])

    const track = await TrackIdentityEngine.resolveIdentity({
      title: 'Believer',
      artist: 'Imagine Dragons',
      duration: 204,
    })

    expect(track.title.toLowerCase()).toContain('imagine dragons')
    expect((track.artist || '').toLowerCase()).not.toContain('james')
    expect(track.id).toBe('imagineDragonsId')
  })

  it('still matches the correct artist on a normal search result', async () => {
    setSearchFunction(async () => [
      {
        id: 'imagineDragonsLyrics',
        title: 'Imagine Dragons - Believer (Lyrics)',
        artist: 'Taj Tracks',
        duration: 204,
        thumbnailUrl: '',
        source: 'youtube' as const,
        sourceId: 'imagineDragonsLyrics',
        channelType: 'user_upload',
      },
    ])

    const track = await TrackIdentityEngine.resolveIdentity({
      title: 'Believer',
      artist: 'Imagine Dragons',
      duration: 204,
    })

    expect(track.title.toLowerCase()).toContain('imagine dragons')
    expect((track.artist || '').toLowerCase()).not.toContain('james')
  })
})
