import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState } from 'react'

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [videoId, setVideoId] = useState('kXYiU_JCYtU') // Numb — Linkin Park
  const [resolving, setResolving] = useState(false)
  const [trackInfo, setTrackInfo] = useState<{ title: string; artist: string } | null>(null)

  const handlePlay = async () => {
    setResolving(true)
    try {
      // Resolve the video ID through the MediaResolver pipeline
      const resolved = await window.api.resolveTrack(videoId)

      // Load the proxy URL into the audio player
      playerControls.load(resolved.audioUrl)

      setTrackInfo({ title: resolved.title, artist: 'YouTube' })

      // Start playback
      await playerControls.play()
    } catch (err: any) {
      console.error('Playback failed:', err)
    } finally {
      setResolving(false)
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', color: '#fff', background: '#1a1a2e', minHeight: '100vh' }}>
      <h1>Muisc</h1>
      <p>A free desktop music streaming player</p>

      {/* Test controls */}
      <div style={{ marginTop: '2rem', padding: '1rem', background: '#16213e', borderRadius: '8px' }}>
        <h2>Test Playback</h2>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: '#a0a0a0' }}>
            YouTube Video ID:
          </label>
          <input
            type="text"
            value={videoId}
            onChange={(e) => setVideoId(e.target.value)}
            style={{
              padding: '0.5rem',
              width: '300px',
              background: '#0f3460',
              border: '1px solid #533483',
              color: '#fff',
              borderRadius: '4px',
            }}
          />
        </div>

        <button
          onClick={handlePlay}
          disabled={resolving || playerState.loading}
          style={{
            padding: '0.75rem 1.5rem',
            background: playerState.isPlaying ? '#e94560' : '#533483',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          {resolving ? 'Resolving...' : playerState.loading ? 'Loading...' : playerState.isPlaying ? 'Pause' : 'Play'}
        </button>

        {playerState.error && (
          <p style={{ color: '#e94560', marginTop: '1rem' }}>Error: {playerState.error}</p>
        )}

        {trackInfo && (
          <div style={{ marginTop: '1rem' }}>
            <p style={{ margin: 0 }}>
              <strong>{trackInfo.title}</strong> — {trackInfo.artist}
            </p>
          </div>
        )}

        {playerState.duration > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <input
              type="range"
              min={0}
              max={playerState.duration}
              value={playerState.currentTime}
              onChange={(e) => playerControls.seek(Number(e.target.value))}
              style={{ width: '300px' }}
            />
            <span style={{ marginLeft: '0.5rem' }}>
              {formatTime(playerState.currentTime)} / {formatTime(playerState.duration)}
            </span>
          </div>
        )}

        <div style={{ marginTop: '1rem' }}>
          <label style={{ color: '#a0a0a0' }}>Volume: </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={playerState.volume}
            onChange={(e) => playerControls.setVolume(Number(e.target.value))}
            style={{ width: '150px' }}
          />
        </div>
      </div>
    </div>
  )
}

export default App
