import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState } from 'react'

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [videoId, setVideoId] = useState('dQw4w9WgXcQ') // Rick Astley - Never Gonna Give You Up
  const [resolving, setResolving] = useState(false)
  const [trackInfo, setTrackInfo] = useState<{ title: string; artist: string } | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-50))
  }

  const handlePlay = async () => {
    setResolving(true)
    addLog(`Resolving: ${videoId}`)
    try {
      const resolved = await window.api.resolveTrack(videoId)
      playerControls.load(resolved.audioUrl)
      setTrackInfo({ title: resolved.title, artist: 'YouTube' })
      addLog(`Resolved: ${resolved.title} (${resolved.duration}s)`)
      await playerControls.play()
      addLog('Playback started')
    } catch (err: any) {
      console.error('Playback failed:', err)
      addLog(`ERROR: ${err.message}`)
    } finally {
      setResolving(false)
    }
  }

  const handleSimulateExpiration = async () => {
    addLog(`Corrupting cache for: ${videoId}`)
    try {
      const corrupted = await window.api.testCorruptCache(videoId)
      if (corrupted) {
        addLog('Cache corrupted. Next play will trigger 403 recovery.')
        // Auto-play to test recovery
        await handlePlay()
      } else {
        addLog('No cache entry found. Play first, then try again.')
      }
    } catch (err: any) {
      addLog(`ERROR corrupting cache: ${err.message}`)
    }
  }

  const handleAggressiveSeek = async () => {
    if (!playerState.duration) {
      addLog('No track loaded. Play first.')
      return
    }
    addLog('Aggressive seek test: jumping to 25%, 75%, 50%, 10%, 0%')
    const positions = [
      playerState.duration * 0.25,
      playerState.duration * 0.75,
      playerState.duration * 0.5,
      playerState.duration * 0.1,
      0,
    ]
    for (const pos of positions) {
      playerControls.seek(pos)
      addLog(`Seeked to ${formatTime(pos)}`)
      await new Promise((r) => setTimeout(r, 200))
    }
    addLog('Aggressive seek test complete')
  }

  const handleRapidSkip = async () => {
    addLog('Rapid skip test: 10 rapid plays on different IDs')
    const testIds = [
      'dQw4w9WgXcQ', // Rick Astley
      'kXYiU_JCYtU', // Numb - Linkin Park
      'kJQP7kiw5Fk', // Despacito
      'RgKAFK5djSk', // See You Again
      'OPf0YbXqDm0', // Uptown Funk
      'fJ9rUzIMcZQ', // Bohemian Rhapsody
      'JGwWNGJdvx8', // Shape of You
      'hTWKbfoikeg', // Sorry
      '09R8_2nJtjg', // Sugar
      'RgKAFK5djSk', // See You Again (repeat)
    ]

    for (let i = 0; i < testIds.length; i++) {
      setVideoId(testIds[i])
      addLog(`Skip ${i + 1}/10: ${testIds[i]}`)
      try {
        await window.api.resolveTrack(testIds[i])
      } catch {
        // Ignore errors - we're testing abort behavior
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const pending = await window.api.testPendingCount()
    addLog(`Rapid skip complete. Pending resolves: ${pending}`)
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

      {/* Video ID Input */}
      <div style={{ marginTop: '2rem', padding: '1rem', background: '#16213e', borderRadius: '8px' }}>
        <h2>Debug Dashboard</h2>

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

        {/* Test Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
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
              fontSize: '0.9rem',
            }}
          >
            {resolving ? 'Resolving...' : playerState.loading ? 'Loading...' : playerState.isPlaying ? 'Pause' : 'Play'}
          </button>

          <button
            onClick={handleSimulateExpiration}
            disabled={resolving}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#e94560',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Simulate Expiration
          </button>

          <button
            onClick={handleAggressiveSeek}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#f39c12',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Aggressive Seek
          </button>

          <button
            onClick={handleRapidSkip}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#27ae60',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Rapid Skip Test
          </button>
        </div>

        {playerState.error && (
          <p style={{ color: '#e94560', marginTop: '0.5rem' }}>Error: {playerState.error}</p>
        )}

        {trackInfo && (
          <div style={{ marginBottom: '1rem' }}>
            <p style={{ margin: 0 }}>
              <strong>{trackInfo.title}</strong> — {trackInfo.artist}
            </p>
          </div>
        )}

        {playerState.duration > 0 && (
          <div style={{ marginBottom: '1rem' }}>
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

        <div style={{ marginBottom: '1rem' }}>
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

        {/* Log Output */}
        <div style={{ marginTop: '1rem' }}>
          <h3 style={{ color: '#a0a0a0', fontSize: '0.9rem' }}>Console Log</h3>
          <div style={{
            background: '#0a0a1a',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '0.5rem',
            maxHeight: '200px',
            overflow: 'auto',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
          }}>
            {logs.length === 0 && <p style={{ color: '#666' }}>No logs yet...</p>}
            {logs.map((log, i) => (
              <div key={i} style={{ color: log.includes('ERROR') ? '#e94560' : '#a0a0a0' }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
