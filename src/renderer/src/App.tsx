import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState, useCallback, useRef, useEffect } from 'react'

interface QueueTrack {
  id: string
  label: string
}

interface SearchTrack {
  videoId: string
  title: string
  artist: string
  duration: number
  thumbnail: string
}

interface Track {
  id: string
  title: string
  artist: string
  album?: string
  duration: number
  thumbnailUrl: string
  source: string
  sourceId: string
}

interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
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
  const [customId, setCustomId] = useState('')
  const [customResolving, setCustomResolving] = useState(false)

  // ── Playlist / Queue state ──
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loadedTracks, setLoadedTracks] = useState<Track[]>([])
  const [queuePlaylistName, setQueuePlaylistName] = useState('')

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const preResolveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Refs to handle rapid skip spam — only the latest request takes effect
  const latestReq = useRef(-1)

  // ── Background audio pre-load ──
  const preloadedUrl = useRef<string | null>(null)
  const userInitiatedPlayback = useRef(false)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20))
  }, [])

  // ── Search ──
  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const results = await window.api.search(query.trim())
      setSearchResults(results)
      if (results.length > 0) {
        addLog(`search: ${results.length} results for "${query.trim()}"`)
      } else {
        addLog(`search: no results for "${query.trim()}"`)
      }
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

  // ── Play a resolved stream (queue or imported playlist track) ──
  const playTrack = useCallback(async (idx: number) => {
    const queue = loadedTracks.length > 0 ? loadedTracks : QUEUE
    const track = queue[idx]
    if (!track) return
    const videoId = track.id || (track as any).sourceId

    userInitiatedPlayback.current = true
    latestReq.current = idx
    setCurrentIdx(idx)
    setResolving(true)

    const t0 = Date.now()
    addLog(`⏳ Resolving ${videoId}...`)

    try {
      const resolved = await window.api.resolveTrack(videoId)
      const t1 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      const wasPreloaded = idx === 0 && preloadedUrl.current === resolved.audioUrl
      if (!wasPreloaded) {
        playerControls.load(resolved.audioUrl)
      }
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      await playerControls.play()
      const t3 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)

      // Fire-and-forget: get real song title from metadata (background resolves concurrently)
      if (latestReq.current === idx) {
        window.api.resolveTrackInfo(videoId).then((info) => {
          if (latestReq.current !== idx) return
          setTrackTitle(info.title)
          addLog(`title:  "${info.title}"`)
        }).catch(() => {})
      }
    } catch (err: any) {
      if (latestReq.current === idx) {
        addLog(`ERROR: ${err.message}`)
      }
    } finally {
      setResolving(false)
    }
  }, [playerControls, addLog])

  // ── Play a search result by video ID ──
  const playSearchResult = useCallback(async (result: SearchTrack) => {
    userInitiatedPlayback.current = true
    latestReq.current = -2 // use a sentinel to distinguish from queue tracks
    setCurrentIdx(-1)
    setResolving(true)
    setTrackTitle('')

    const t0 = Date.now()
    addLog(`⏳ Resolving search result ${result.videoId}...`)

    try {
      const resolved = await window.api.resolveTrack(result.videoId)
      const t1 = Date.now()
      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      playerControls.load(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      await playerControls.play()
      const t3 = Date.now()
      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)

      // Fire-and-forget: get real song title from metadata
      window.api.resolveTrackInfo(result.videoId).then((info) => {
        if (latestReq.current !== -2) return
        setTrackTitle(info.title)
        addLog(`title:  "${info.title}"`)
      }).catch(() => {})
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setResolving(false)
    }
  }, [playerControls, addLog])

  // ── Play via custom ID input ──
  const playCustomId = useCallback(async (id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return

    userInitiatedPlayback.current = true
    latestReq.current = -2 // same sentinel as search results
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

      // Fire-and-forget: get real song title from metadata
      window.api.resolveTrackInfo(trimmed).then((info) => {
        if (latestReq.current !== -2) return
        setTrackTitle(info.title)
        addLog(`title:  "${info.title}"`)
      }).catch(() => {})
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setResolving(false)
    }
  }, [playerControls, addLog, loadedTracks])

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

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  // ── Spotify Import state ──
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

  // Listen for Spotify import progress events (main → renderer)
  useEffect(() => {
    const cleanupProgress = window.api.onSpotifyImportProgress((progress) => {
      setImportProgress(progress)
    })
    return () => {
      cleanupProgress()
    }
  }, [])

  const handleImport = useCallback(async () => {
    const trimmed = spotifyUrl.trim()
    if (!trimmed) return

    setImporting(true)
    setImportError(null)
    setImportResult(null)
    setImportProgress(null)

    const spDc = spotifySpDc.trim() || undefined
    addLog(`import: starting Spotify import...${spDc ? ' (using sp_dc auth)' : ''}`)

    try {
      const result = await window.api.importSpotifyPlaylist(trimmed, spDc)
      setImporting(false)
      setImportResult(result)
      setImportProgress(null)
      addLog(`import: "${result.playlistName}" — ${result.matchedCount}/${result.totalCount} matched`)
      // Refresh playlist list
      const pls = await window.api.getPlaylists()
      setPlaylists(pls)
    } catch (err: any) {
      setImporting(false)
      setImportProgress(null)
      // Don't show "cancelled" as an error — user did it intentionally
      if (err.message === 'Import cancelled') {
        addLog('import: cancelled')
        return
      }
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

  const handleLoadPlaylist = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: loading "${playlist.name}"...`)
      const tracks = await window.api.loadPlaylistIntoQueue(playlist.id)
      setLoadedTracks(tracks)
      setQueuePlaylistName(playlist.name)
      addLog(`queue: loaded ${tracks.length} tracks from "${playlist.name}"`)
    } catch (err: any) {
      addLog(`queue ERROR: ${err.message}`)
    }
  }, [addLog])

  return (
    <div style={{ background: '#111', color: '#ddd', fontFamily: 'monospace', padding: 16, minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>muisc test</h1>

      {/* ── Search Section ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search YouTube (e.g. &quot;Linkin Park Numb&quot;)..."
            style={{
              flex: 1,
              padding: '8px 10px',
              background: '#1a1a1a',
              color: '#ddd',
              border: '1px solid #555',
              borderRadius: 0,
              fontFamily: 'monospace',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            onClick={() => doSearch(searchQuery)}
            disabled={searching || !searchQuery.trim()}
            style={{
              padding: '8px 16px',
              background: searching ? '#333' : '#06a',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #333',
            maxHeight: 300,
            overflowY: 'auto',
          }}>
            {searchResults.map((result) => (
              <div
                key={result.videoId}
                onClick={() => playSearchResult(result)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderBottom: '1px solid #222',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a2a')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <img
                  src={result.thumbnail}
                  alt=""
                  style={{ width: 48, height: 36, objectFit: 'cover', flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {result.title}
                  </div>
                  <div style={{ fontSize: 11, color: '#888' }}>{result.artist}</div>
                </div>
                <span style={{ fontSize: 11, color: '#666', flexShrink: 0 }}>
                  {formatDuration(result.duration)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Spotify Import Section ── */}
      <div style={{ marginBottom: 12, borderTop: '1px solid #333', paddingTop: 12 }}>
        <div style={{ fontSize: 12, color: '#1db954', marginBottom: 6 }}>
          Import from Spotify
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <input
            value={spotifyUrl}
            onChange={(e) => setSpotifyUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !importing) handleImport() }}
            placeholder="Paste Spotify playlist URL..."
            disabled={importing}
            style={{
              flex: 1,
              padding: '8px 10px',
              background: '#1a1a1a',
              color: '#ddd',
              border: '1px solid #333',
              borderRadius: 0,
              fontFamily: 'monospace',
              fontSize: 13,
              outline: 'none',
            }}
          />
          {importing ? (
            <button
              onClick={handleCancelImport}
              style={{
                padding: '8px 16px',
                background: '#a33',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={handleImport}
              disabled={!spotifyUrl.trim()}
              style={{
                padding: '8px 16px',
                background: spotifyUrl.trim() ? '#1db954' : '#333',
                color: '#fff',
                border: 'none',
                cursor: spotifyUrl.trim() ? 'pointer' : 'default',
                fontSize: 12,
              }}
            >
              Import
            </button>
          )}
        </div>

        {/* sp_dc cookie input */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={spotifySpDc}
            onChange={(e) => setSpotifySpDc(e.target.value)}
            placeholder="sp_dc cookie (optional — from browser DevTools)"
            disabled={importing}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: '#151515',
              color: '#aaa',
              border: '1px solid #2a2a2a',
              borderRadius: 0,
              fontFamily: 'monospace',
              fontSize: 11,
              outline: 'none',
            }}
          />
          <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>
            ? sp_dc
          </span>
        </div>

        {/* Import Progress */}
        {importProgress && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#888' }}>
                {importProgress.status === 'fetching'
                  ? 'Fetching playlist...'
                  : importProgress.status === 'matching'
                  ? `Matching track ${importProgress.current + 1} of ${importProgress.total}...`
                  : 'Saving playlist...'}
              </span>
              <span style={{ color: '#888' }}>
                {importProgress.total > 0
                  ? `${Math.round((importProgress.current / importProgress.total) * 100)}%`
                  : ''}
              </span>
            </div>
            {importProgress.total > 0 && (
              <div style={{
                height: 4,
                background: '#222',
                borderRadius: 2,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${(importProgress.current / importProgress.total) * 100}%`,
                  background: '#1db954',
                  transition: 'width 0.2s ease',
                }} />
              </div>
            )}
            {importProgress.currentTitle && (
              <div style={{ marginTop: 4, color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {importProgress.currentTitle}
              </div>
            )}
          </div>
        )}

        {/* Import Error */}
        {importError && (
          <div style={{ marginTop: 8, color: '#c33', fontSize: 12 }}>
            {importError}
          </div>
        )}

        {/* Import Results */}
        {importResult && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ color: '#1db954', marginBottom: 4 }}>
              Imported &quot;{importResult.playlistName}&quot;
            </div>
            <div style={{ color: '#888' }}>
              {importResult.matchedCount} of {importResult.totalCount} tracks matched
            </div>
            {importResult.skipped.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ color: '#a80', marginBottom: 2, fontSize: 11 }}>
                  Skipped ({importResult.skipped.length}):
                </div>
                {importResult.skipped.slice(0, 5).map((s, i) => (
                  <div key={i} style={{ color: '#666', fontSize: 11, lineHeight: 1.4 }}>
                    {s.artist} — {s.title}: {s.reason}
                  </div>
                ))}
                {importResult.skipped.length > 5 && (
                  <div style={{ color: '#555', fontSize: 11 }}>
                    ...and {importResult.skipped.length - 5} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Playlists */}
        {playlists.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ color: '#69f', marginBottom: 4, fontSize: 11 }}>
              Playlists ({playlists.length})
            </div>
            {playlists.map((pl) => (
              <div
                key={pl.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                }}
              >
                <span style={{ flex: 1, color: '#ddd' }}>{pl.name}</span>
                <button
                  onClick={() => handleLoadPlaylist(pl)}
                  style={{
                    padding: '2px 10px',
                    background: '#36a',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  Load into Queue
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Custom ID input ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input
          value={customId}
          onChange={(e) => {
            const val = e.target.value
            setCustomId(val)
            if (preResolveTimer.current) clearTimeout(preResolveTimer.current)
            if (val.trim().length === 11) {
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

      {/* ── Queue ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>
          {loadedTracks.length > 0 ? `Queue: ${queuePlaylistName} (${loadedTracks.length} tracks)` : 'Demo Queue'}
        </div>
        {(loadedTracks.length > 0 ? loadedTracks : QUEUE).map((track: any, i: number) => {
          const label = track.label || `${track.artist} — ${track.title}`
          const id = track.id || track.sourceId
          return (
            <div
              key={id}
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
                {label}
              </span>
              <span style={{ fontSize: 11, color: '#555' }}>{id}</span>
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
          )
        })}
      </div>

      {/* ── Now Playing Controls ── */}
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

      {/* ── Console ── */}
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
