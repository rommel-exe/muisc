import { useMediaEngine } from './hooks/useMediaEngine'
import { useState, useCallback, useRef, useEffect } from 'react'
import type { Playlist, QueueTrackRef, SearchResult } from '../../shared/types'

function App() {
  const [logs, setLogs] = useState<string[]>([])
  const [customId, setCustomId] = useState('')

  // ── Playlist state ──
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [queuePlaylistName, setQueuePlaylistName] = useState('')

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-50))
  }, [])

  const { engineState, controls } = useMediaEngine(addLog)

  // ── Search ──
  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setSearchResults([]); return }
    setSearching(true)
    try {
      const results = await window.api.search(query.trim())
      setSearchResults(results)
      addLog(`search: ${results.length} results`)
    } catch (err: any) {
      addLog(`search ERROR: ${err.message}`)
    } finally {
      setSearching(false)
    }
  }, [addLog])

  const handleSearchChange = useCallback((val: string) => {
    setSearchQuery(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (val.trim().length >= 2) {
      searchTimer.current = setTimeout(() => doSearch(val), 400)
    } else {
      setSearchResults([])
    }
  }, [doSearch])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      doSearch(searchQuery)
    }
  }, [doSearch, searchQuery])

  const formatDuration = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  // ── Import state ──
  const [spotifyUrl, setSpotifyUrl] = useState('')
  const [spotifySpDc, setSpotifySpDc] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<{
    current: number
    total: number
    currentTitle: string
    status: string
  } | null>(null)
  const [importResult, setImportResult] = useState<{
    playlistName: string
    matchedCount: number
    totalCount: number
    skipped: Array<{ title: string; artist: string; reason: string }>
  } | null>(null)

  useEffect(() => {
    const cleanupProgress = window.api.onSpotifyImportProgress((progress) => {
      setImportProgress(progress)
    })
    return () => cleanupProgress()
  }, [])

  const handleImport = useCallback(async () => {
    const trimmed = spotifyUrl.trim()
    if (!trimmed) return
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    setImportProgress(null)
    const spDc = spotifySpDc.trim() || undefined
    addLog(`import: starting Spotify import...${spDc ? ' (sp_dc)' : ''}`)
    try {
      const result = await window.api.importSpotifyPlaylist(trimmed, spDc)
      setImporting(false)
      setImportResult(result)
      setImportProgress(null)
      addLog(`import: "${result.playlistName}" — ${result.matchedCount}/${result.totalCount}`)
      const pls = await window.api.getPlaylists()
      setPlaylists(pls)
    } catch (err: any) {
      setImporting(false)
      setImportProgress(null)
      if (err.message === 'Import cancelled') { addLog('import: cancelled'); return }
      setImportError(err.message)
      addLog(`import ERROR: ${err.message}`)
    }
  }, [spotifyUrl, addLog])

  const handleCancelImport = useCallback(async () => {
    await window.api.cancelSpotifyImport()
    setImporting(false)
    setImportProgress(null)
    addLog('import: cancelled')
  }, [addLog])

  // ── Playlist management ──
  const handleLoadPlaylist = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: loading "${playlist.name}"...`)
      controls.pause()
      controls.clearTrack()
      await window.api.loadPlaylistIntoQueue(playlist.id)
      setQueuePlaylistName(playlist.name)
      await controls.refreshState()
      addLog(`queue: loaded "${playlist.name}"`)
    } catch (err: any) { addLog(`queue ERROR: ${err.message}`) }
  }, [addLog, controls])

  const handleAddPlaylistToQueue = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: appending "${playlist.name}"...`)
      await window.api.addPlaylistToQueue(playlist.id)
      await controls.refreshState()
      addLog(`queue: added "${playlist.name}"`)
    } catch (err: any) { addLog(`queue append ERROR: ${err.message}`) }
  }, [addLog, controls])

  const getTrackLabel = (qt: QueueTrackRef): string => {
    const t = qt.track
    if (t.artist && t.artist !== 'Unknown Artist') return `${t.artist} — ${t.title}`
    return t.title
  }

  return (
    <div style={{ background: '#111', color: '#ddd', fontFamily: 'monospace', padding: 16, minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>muisc test</h1>

      {/* ── Search ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input value={searchQuery} onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder='Search YouTube (e.g. "Linkin Park Numb")...'
            style={{ flex: 1, padding: '8px 10px', background: '#1a1a1a', color: '#ddd', border: '1px solid #555', borderRadius: 0, fontFamily: 'monospace', fontSize: 13, outline: 'none' }} />
          <button onClick={() => doSearch(searchQuery)} disabled={searching || !searchQuery.trim()}
            style={{ padding: '8px 16px', background: searching ? '#333' : '#06a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>
            {searching ? '...' : 'Search'}
          </button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ background: '#1a1a1a', border: '1px solid #333', maxHeight: 300, overflowY: 'auto' }}>
            {searchResults.map((result) => (
              <div key={result.videoId} onClick={() => controls.playSearchResult(result)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid #222', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a2a')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <img src={result.thumbnail} alt="" style={{ width: 48, height: 36, objectFit: 'cover', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.title}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{result.artist}</div>
                </div>
                <span style={{ fontSize: 11, color: '#666', flexShrink: 0 }}>{formatDuration(result.duration)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Spotify Import ── */}
      <div style={{ marginBottom: 12, borderTop: '1px solid #333', paddingTop: 12 }}>
        <div style={{ fontSize: 12, color: '#1db954', marginBottom: 6 }}>Import from Spotify</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <input value={spotifyUrl} onChange={(e) => setSpotifyUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !importing) handleImport() }}
            placeholder="Paste Spotify playlist URL..." disabled={importing}
            style={{ flex: 1, padding: '8px 10px', background: '#1a1a1a', color: '#ddd', border: '1px solid #333', borderRadius: 0, fontFamily: 'monospace', fontSize: 13, outline: 'none' }} />
          {importing ? (
            <button onClick={handleCancelImport} style={{ padding: '8px 16px', background: '#a33', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          ) : (
            <button onClick={handleImport} disabled={!spotifyUrl.trim()}
              style={{ padding: '8px 16px', background: spotifyUrl.trim() ? '#1db954' : '#333', color: '#fff', border: 'none', cursor: spotifyUrl.trim() ? 'pointer' : 'default', fontSize: 12 }}>Import</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={spotifySpDc} onChange={(e) => setSpotifySpDc(e.target.value)}
            placeholder="sp_dc cookie (optional)" disabled={importing}
            style={{ flex: 1, padding: '6px 10px', background: '#151515', color: '#aaa', border: '1px solid #2a2a2a', borderRadius: 0, fontFamily: 'monospace', fontSize: 11, outline: 'none' }} />
          <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>? sp_dc</span>
        </div>

        {importProgress && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#888' }}>{importProgress.status === 'fetching' ? 'Fetching...' : importProgress.status === 'matching' ? `Matching ${importProgress.current + 1}/${importProgress.total}...` : 'Saving...'}</span>
              <span style={{ color: '#888' }}>{importProgress.total > 0 ? `${Math.round((importProgress.current / importProgress.total) * 100)}%` : ''}</span>
            </div>
            {importProgress.total > 0 && (
              <div style={{ height: 4, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(importProgress.current / importProgress.total) * 100}%`, background: '#1db954', transition: 'width 0.2s ease' }} />
              </div>
            )}
            {importProgress.currentTitle && <div style={{ marginTop: 4, color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{importProgress.currentTitle}</div>}
          </div>
        )}

        {importError && <div style={{ marginTop: 8, color: '#c33', fontSize: 12 }}>{importError}</div>}

        {importResult && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ color: '#1db954', marginBottom: 4 }}>Imported &quot;{importResult.playlistName}&quot;</div>
            <div style={{ color: '#888' }}>{importResult.matchedCount}/{importResult.totalCount} matched</div>
            {importResult.skipped.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ color: '#a80', marginBottom: 2, fontSize: 11 }}>Skipped ({importResult.skipped.length}):</div>
                {importResult.skipped.slice(0, 5).map((s, i) => (
                  <div key={i} style={{ color: '#666', fontSize: 11, lineHeight: 1.4 }}>{s.artist} — {s.title}: {s.reason}</div>
                ))}
                {importResult.skipped.length > 5 && <div style={{ color: '#555', fontSize: 11 }}>...and {importResult.skipped.length - 5} more</div>}
              </div>
            )}
          </div>
        )}

        {playlists.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ color: '#69f', marginBottom: 4, fontSize: 11 }}>Playlists ({playlists.length})</div>
            {playlists.map((pl) => (
              <div key={pl.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ flex: 1, color: '#ddd' }}>{pl.name}</span>
                <button onClick={() => handleLoadPlaylist(pl)}
                  style={{ padding: '2px 8px', background: '#36a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}>Load Queue</button>
                <button onClick={() => handleAddPlaylistToQueue(pl)}
                  style={{ padding: '2px 8px', background: '#2a6', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}>+ Queue</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Custom ID ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input value={customId} onChange={(e) => setCustomId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') controls.playCustomId(customId) }}
          placeholder="Paste YouTube video ID..."
          style={{ flex: 1, padding: '6px 8px', background: '#1a1a1a', color: '#ddd', border: '1px solid #333', borderRadius: 0, fontFamily: 'monospace', fontSize: 12, outline: 'none' }} />
        <button onClick={() => controls.playCustomId(customId)} disabled={engineState.state === 'loading' || !customId.trim()}
          style={{ padding: '6px 14px', background: engineState.state === 'loading' ? '#333' : '#06a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>
          {engineState.state === 'loading' ? '...' : '▶ Play'}
        </button>
      </div>

      {/* ── Queue ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#666' }}>
            Queue ({engineState.queueList.length} tracks){queuePlaylistName ? ` — ${queuePlaylistName}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => controls.toggleShuffle()}
            style={{ padding: '2px 8px', background: engineState.shuffleActive ? '#a80' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}
            title={engineState.shuffleActive ? 'Shuffle ON' : 'Shuffle OFF'}>{engineState.shuffleActive ? '🔀 ON' : '🔀'}</button>
          <button onClick={() => {
            const next: Record<string, string> = { all: 'none', none: 'one', one: 'all' }
            controls.toggleRepeat(next[engineState.repeatMode] as 'none' | 'all' | 'one')
          }}
            style={{ padding: '2px 8px', background: engineState.repeatMode !== 'none' ? '#36a' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}
            title={engineState.repeatMode === 'all' ? 'Repeat All' : engineState.repeatMode === 'one' ? 'Repeat One' : 'No Repeat'}>
            {engineState.repeatMode === 'all' ? '🔁' : engineState.repeatMode === 'one' ? '🔂' : '⏹'}
          </button>
        </div>
        {engineState.queueList.length === 0 && (
          <div style={{ fontSize: 11, color: '#444', padding: '8px 0' }}>Queue is empty. Search or import.</div>
        )}
        {engineState.queueList.map((qt: QueueTrackRef, i: number) => {
          const label = getTrackLabel(qt)
          const isCurrent = i === engineState.queueIndex
          const loading = engineState.state === 'loading'
          return (
            <div key={qt.queueId}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: isCurrent ? '#222' : 'transparent', borderBottom: '1px solid #222' }}>
              <span style={{ width: 20, color: isCurrent ? '#4a4' : '#666' }}>{isCurrent ? '▶' : i + 1}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ fontSize: 11, color: '#555' }}>{formatDuration(qt.track.duration)}</span>
              <button onClick={() => controls.playFromQueue(i)} disabled={loading}
                style={{ padding: '2px 8px', background: loading ? '#554' : isCurrent ? '#2a2' : '#333', color: '#fff', border: 'none', cursor: loading ? 'wait' : 'pointer', fontSize: 12 }}>
                {loading ? '...' : '▶'}
              </button>
            </div>
          )
        })}
      </div>

      {/* ── Now Playing ── */}
      <div style={{ padding: '8px 0', borderTop: '1px solid #333', marginBottom: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 6, color: '#888' }}>{engineState.currentTrack?.title || 'No track loaded'}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => controls.prev()} disabled={engineState.queueIndex <= 0 || engineState.queueList.length === 0} style={btnStyle}>{'⏮'}</button>
          <button onClick={() => engineState.state === 'playing' ? controls.pause() : controls.play()}
            disabled={!engineState.currentTrack?.title} style={btnStyle}>{engineState.state === 'playing' ? '⏸' : '▶'}</button>
          <button onClick={() => controls.next()} disabled={engineState.queueList.length === 0} style={btnStyle}>{'⏭'}</button>
          <input type="range" min={0} max={engineState.duration || 1} value={engineState.currentTime}
            onChange={(e) => controls.seek(Number(e.target.value))}
            style={{ flex: 1, margin: '0 4px' }} />
          <span style={{ fontSize: 11, color: '#888', minWidth: 80, textAlign: 'right' }}>
            {formatDuration(engineState.currentTime)} / {formatDuration(engineState.duration)}
          </span>
          <label style={{ fontSize: 11, color: '#666' }}>vol</label>
          <input type="range" min={0} max={1} step={0.05} value={engineState.volume}
            onChange={(e) => controls.setVolume(Number(e.target.value))} style={{ width: 60 }} />
        </div>
        {engineState.isNextReady && (
          <div style={{ fontSize: 10, color: '#484', marginTop: 4 }}>next track preloaded ✓</div>
        )}
      </div>

      {engineState.error && <div style={{ color: '#c33', fontSize: 12 }}>{engineState.error}</div>}

      {/* ── Console ── */}
      <div style={{ marginTop: 12, borderTop: '1px solid #333', paddingTop: 8 }}>
        {logs.length === 0 && <span style={{ color: '#444', fontSize: 11 }}>no events</span>}
        {logs.map((log, i) => (
          <div key={i} style={{ fontSize: 11, color: log.includes('ERROR') ? '#c33' : '#777', lineHeight: 1.5 }}>{log}</div>
        ))}
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px', background: '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 14,
}

export default App
