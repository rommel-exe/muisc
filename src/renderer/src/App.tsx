import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState, useCallback, useRef } from 'react'

interface QueueTrack {
  id: string
  label: string
}

const QUEUE: QueueTrack[] = [
  { id: 'dQw4w9WgXcQ', label: 'Rick Astley — Never Gonna Give You Up' },
  { id: 'kJQP7kiw5Fk', label: 'Luis Fonsi — Despacito' },
  { id: 'JGwWNGJdvx8', label: 'Ed Sheeran — Shape of You' },
  { id: 'fJ9rUzIMcZQ', label: 'Queen — Bohemian Rhapsody' },
  { id: 'kXYiU_JCYtU', label: 'Linkin Park — Numb' },
  { id: 'RgKAFK5djSk', label: 'Wiz Khalifa — See You Again' },
  { id: 'OPf0YbXqDm0', label: 'Mark Ronson — Uptown Funk' },
  { id: 'hTWKbfoikeg', label: 'Justin Bieber — Sorry' },
  { id: '09R8_2nJtjg', label: 'Maroon 5 — Sugar' },
  { id: 'HP-MbfHFUqs', label: 'The Chainsmokers — Closer' },
]

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [resolving, setResolving] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [logs, setLogs] = useState<string[]>([])
  const [trackTitle, setTrackTitle] = useState('')
  const [prefetchedUpTo, setPrefetchedUpTo] = useState(-1)

  // Refs to handle rapid skip spam — only the latest request takes effect
  const latestReq = useRef(-1)
  const inflightCount = useRef(0)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20))
  }, [])

  const playTrack = useCallback(async (idx: number) => {
    const track = QUEUE[idx]
    if (!track) return

    latestReq.current = idx
    inflightCount.current++
    setCurrentIdx(idx)
    setResolving(true)
    addLog(`Resolving ${track.id}...`)

    try {
      const start = Date.now()
      const resolved = await window.api.resolveTrack(track.id)
      if (latestReq.current !== idx) return // superseded by newer skip

      addLog(`Resolved in ${Date.now() - start}ms — ${resolved.title}`)
      setTrackTitle(resolved.title)
      playerControls.load(resolved.audioUrl)
      await playerControls.play()
      if (latestReq.current !== idx) return // superseded during play()

      // Prefetch remaining queue once per forward pass
      if (idx >= prefetchedUpTo) {
        const upcoming = QUEUE.slice(idx + 1).map((t) => t.id)
        if (upcoming.length > 0) {
          window.api.prefetchQueue(upcoming).catch(() => {})
          setPrefetchedUpTo(idx + upcoming.length)
        }
      }
    } catch (err: any) {
      if (latestReq.current === idx) {
        addLog(`ERROR: ${err.message}`)
      }
    } finally {
      inflightCount.current--
      if (inflightCount.current === 0) {
        setResolving(false)
      }
    }
  }, [playerControls, addLog, prefetchedUpTo])

  const goNext = useCallback(() => {
    const next = currentIdx + 1
    if (next < QUEUE.length) playTrack(next)
  }, [currentIdx, playTrack])

  const goPrev = useCallback(() => {
    const prev = currentIdx - 1
    if (prev >= 0) playTrack(prev)
  }, [currentIdx, playTrack])

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  return (
    <div style={{ background: '#111', color: '#ddd', fontFamily: 'monospace', padding: 16, minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>muisc test</h1>

      {/* Queue */}
      <div style={{ marginBottom: 12 }}>
        {QUEUE.map((track, i) => (
          <div
            key={track.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              background: i === currentIdx ? '#222' : 'transparent',
              borderBottom: '1px solid #222',
            }}
          >
            <span style={{ width: 20, color: '#666' }}>{i + 1}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {track.label}
            </span>
            <span style={{ fontSize: 11, color: '#555' }}>{track.id}</span>
            <button
              onClick={() => playTrack(i)}
              disabled={resolving}
              style={{
                padding: '2px 8px',
                background: i === currentIdx ? '#2a2' : '#333',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {resolving && i === currentIdx ? '...' : '▶'}
            </button>
          </div>
        ))}
      </div>

      {/* Now Playing Controls */}
      <div style={{ padding: '8px 0', borderTop: '1px solid #333', marginBottom: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 6, color: '#888' }}>
          {trackTitle || 'No track loaded'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={goPrev} disabled={currentIdx <= 0} style={btnStyle}>{'◀'}</button>
          <button
            onClick={() => playerState.isPlaying ? playerControls.pause() : playerControls.play()}
            disabled={!trackTitle}
            style={btnStyle}
          >
            {playerState.isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={goNext} disabled={currentIdx < 0 || currentIdx >= QUEUE.length - 1} style={btnStyle}>{'▶'}</button>

          <input
            type="range"
            min={0}
            max={playerState.duration || 1}
            value={playerState.currentTime}
            onChange={(e) => playerControls.seek(Number(e.target.value))}
            style={{ flex: 1, margin: '0 4px' }}
          />
          <span style={{ fontSize: 11, color: '#888', minWidth: 80, textAlign: 'right' }}>
            {formatTime(playerState.currentTime)} / {formatTime(playerState.duration)}
          </span>

          <label style={{ fontSize: 11, color: '#666' }}>vol</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={playerState.volume}
            onChange={(e) => playerControls.setVolume(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
      </div>

      {playerState.error && <div style={{ color: '#c33', fontSize: 12 }}>{playerState.error}</div>}

      {/* Console */}
      <div style={{ marginTop: 12, borderTop: '1px solid #333', paddingTop: 8 }}>
        {logs.length === 0 && <span style={{ color: '#444', fontSize: 11 }}>no events</span>}
        {logs.map((log, i) => (
          <div key={i} style={{ fontSize: 11, color: log.includes('ERROR') ? '#c33' : '#777', lineHeight: 1.5 }}>
            {log}
          </div>
        ))}
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#333',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  fontSize: 14,
}

export default App
