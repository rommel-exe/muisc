import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState, useCallback, useRef, useEffect } from 'react'

interface QueueTrack {
  id: string
  label: string
}

const QUEUE: QueueTrack[] = [
  { id: '9bZkp7q19f0', label: 'PSY — Gangnam Style' },
  { id: 'CevxZvSJLk8', label: 'Katy Perry — Roar' },
  { id: 'e-ORhEE9VVg', label: 'Taylor Swift — Blank Space' },
  { id: '0KSOMA3QBU0', label: 'Katy Perry — Dark Horse' },
  { id: 'hT_nvWreIhg', label: 'OneRepublic — Counting Stars' },
  { id: 'YQHsXMglC9A', label: 'Adele — Hello' },
  { id: 'kXYiU_JCYtU', label: 'Linkin Park — Numb' },
  { id: 'RgKAFK5djSk', label: 'Wiz Khalifa — See You Again' },
  { id: 'JGwWNGJdvx8', label: 'Ed Sheeran — Shape of You' },
  { id: 'fJ9rUzIMcZQ', label: 'Queen — Bohemian Rhapsody' },
]

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [resolving, setResolving] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [logs, setLogs] = useState<string[]>([])
  const [trackTitle, setTrackTitle] = useState('')
  const [prefetchedUpTo, setPrefetchedUpTo] = useState(-1)
  const [customId, setCustomId] = useState('')
  const [customResolving, setCustomResolving] = useState(false)
  const preResolveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Refs to handle rapid skip spam — only the latest request takes effect
  const latestReq = useRef(-1)
  const inflightCount = useRef(0)

  // ── Background audio pre-load ──
  // Pre-fetch the first track's proxy URL at mount so the browser's
  // audio decoder pipeline (~800ms) runs during the 20s window before
  // the user clicks. On click, play() resolves in <10ms.
  const preloadedUrl = useRef<string | null>(null)

  useEffect(() => {
    window.api.resolveTrack(QUEUE[0].id).then((resolved) => {
      preloadedUrl.current = resolved.audioUrl
      playerControls.preload(resolved.audioUrl)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

    const t0 = Date.now()
    addLog(`⏳ Resolving ${track.id}...`)

    try {
      // ── Segment 1: IPC resolve-track ──
      const resolved = await window.api.resolveTrack(track.id)
      const t1 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      // ── Segment 2: audio load ──
      // If this track was pre-loaded during startup, skip load
      const wasPreloaded = idx === 0 && preloadedUrl.current === resolved.audioUrl
      if (!wasPreloaded) {
        playerControls.load(resolved.audioUrl)
      }
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      // ── Segment 3: audio play (resolves when playback starts) ──
      await playerControls.play()
      const t3 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)

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

  const playCustomId = useCallback(async (id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return

    setCustomResolving(true)
    setCurrentIdx(-1)
    setTrackTitle('')

    const t0 = Date.now()
    addLog(`⏳ Custom resolve ${trimmed}...`)

    try {
      const resolved = await window.api.resolveTrack(trimmed)
      const t1 = Date.now()
      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      playerControls.load(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      await playerControls.play()
      const t3 = Date.now()
      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setCustomResolving(false)
    }
  }, [playerControls, addLog])

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  return (
    <div style={{ background: '#111', color: '#ddd', fontFamily: 'monospace', padding: 16, minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>muisc test</h1>

      {/* Custom ID input */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input
          value={customId}
          onChange={(e) => {
            const val = e.target.value
            setCustomId(val)
            // Debounced pre-resolve: start daemon + audio buffering before user clicks Play
            if (preResolveTimer.current) clearTimeout(preResolveTimer.current)
            if (val.trim().length === 11) {
              // Pre-resolve immediately so daemon + audio buffering start ASAP
              preResolveTimer.current = setTimeout(() => {
                window.api.resolveTrack(val.trim()).catch(() => {})
              }, 100)
            }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') playCustomId(customId) }}
          placeholder="Paste YouTube video ID..."
          style={{
            flex: 1,
            padding: '6px 8px',
            background: '#1a1a1a',
            color: '#ddd',
            border: '1px solid #333',
            borderRadius: 0,
            fontFamily: 'monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={() => playCustomId(customId)}
          disabled={customResolving || !customId.trim()}
          style={{
            padding: '6px 14px',
            background: customResolving ? '#333' : '#06a',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {customResolving ? '...' : '▶ Play'}
        </button>
      </div>

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
