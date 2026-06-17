import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState, useCallback, useRef } from 'react'
import type { SearchResult } from '../../shared/types'

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [currentTrack, setCurrentTrack] = useState<SearchResult | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  // Refs to handle rapid skip spam — only the latest request takes effect
  const latestReq = useRef(-1)
  const inflightCount = useRef(0)
  const searchReqId = useRef(0)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20))
  }, [])

  // ── Search ──

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }

    const reqId = ++searchReqId.current
    setSearchQuery(query)
    setSearching(true)
    addLog(`🔍 Searching: "${query}"`)

    try {
      const results = await window.api.searchMusic(query)
      // Only take latest search results
      if (reqId !== searchReqId.current) return
      setSearchResults(results)
      addLog(`Found ${results.length} results`)
    } catch (err: any) {
      if (reqId === searchReqId.current) {
        addLog(`Search ERROR: ${err.message}`)
      }
    } finally {
      if (reqId === searchReqId.current) {
        setSearching(false)
      }
    }
  }, [addLog])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      doSearch((e.target as HTMLInputElement).value)
    }
  }, [doSearch])

  // ── Playback ──

  const playTrack = useCallback(async (result: SearchResult) => {
    latestReq.current++
    const reqIdx = latestReq.current
    inflightCount.current++
    setResolving(true)
    setCurrentTrack(result)

    const t0 = Date.now()
    addLog(`⏳ Resolving ${result.videoId}...`)

    try {
      // ── Segment 1: IPC resolve-track ──
      const resolved = await window.api.resolveTrack(result.videoId)
      const t1 = Date.now()
      if (latestReq.current !== reqIdx) return

      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)

      // ── Segment 2: audio load ──
      playerControls.load(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      // ── Segment 3: audio play (resolves when playback starts) ──
      await playerControls.play()
      const t3 = Date.now()
      if (latestReq.current !== reqIdx) return

      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)
    } catch (err: any) {
      if (latestReq.current === reqIdx) {
        addLog(`ERROR: ${err.message}`)
      }
    } finally {
      inflightCount.current--
      if (inflightCount.current === 0) {
        setResolving(false)
      }
    }
  }, [playerControls, addLog])

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  const formatDuration = (s: number): string => {
    const min = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${min}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div style={{ background: '#111', color: '#ddd', fontFamily: 'monospace', padding: 16, minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>muisc test</h1>

      {/* Search Bar */}
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search YouTube Music..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: '#222',
            color: '#ddd',
            border: '1px solid #444',
            borderRadius: 4,
            fontSize: 14,
            fontFamily: 'monospace',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>
          {searching ? 'Searching...' : `Type query and press Enter`}
        </div>
      </div>

      {/* Search Results */}
      <div style={{ marginBottom: 12, maxHeight: 300, overflowY: 'auto' }}>
        {searchResults.length === 0 && !searching && (
          <div style={{ color: '#444', fontSize: 11, padding: '8px 0' }}>
            {searchQuery ? 'No results found' : 'Search for a song to get started'}
          </div>
        )}
        {searchResults.map((result) => (
          <div
            key={result.videoId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              background: currentTrack?.videoId === result.videoId ? '#222' : 'transparent',
              borderBottom: '1px solid #222',
              cursor: 'pointer',
            }}
            onClick={() => playTrack(result)}
          >
            {result.thumbnail && (
              <img
                src={result.thumbnail}
                alt=""
                style={{ width: 32, height: 32, borderRadius: 2, objectFit: 'cover', flexShrink: 0 }}
              />
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                {result.title}
              </div>
              <div style={{ fontSize: 11, color: '#888' }}>{result.artist}</div>
            </div>
            <span style={{ fontSize: 11, color: '#555', flexShrink: 0 }}>
              {formatDuration(result.duration)}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); playTrack(result) }}
              disabled={resolving}
              style={{
                padding: '2px 8px',
                background: currentTrack?.videoId === result.videoId ? '#2a2' : '#333',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              {resolving && currentTrack?.videoId === result.videoId ? '...' : '▶'}
            </button>
          </div>
        ))}
      </div>

      {/* Now Playing Controls */}
      <div style={{ padding: '8px 0', borderTop: '1px solid #333', marginBottom: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 6, color: '#888' }}>
          {currentTrack ? `${currentTrack.title} — ${currentTrack.artist}` : 'No track loaded'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={playerControls.pause}
            disabled={!playerState.isPlaying}
            style={btnStyle}
          >
            ⏸
          </button>
          <button
            onClick={() => playerControls.play()}
            disabled={!currentTrack || playerState.isPlaying}
            style={btnStyle}
          >
            ▶
          </button>

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
