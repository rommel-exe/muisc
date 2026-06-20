import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useState, useCallback, useRef, useEffect } from 'react'

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

interface QueueTrackRef {
  queueId: string
  track: Track
}

function App() {
  const [playerState, playerControls] = useAudioPlayer()
  const [logs, setLogs] = useState<string[]>([])
  const [trackTitle, setTrackTitle] = useState('')
  const [customId, setCustomId] = useState('')
  const [customResolving, setCustomResolving] = useState(false)

  // ── Queue state (fetched from main process) ──
  const [queueList, setQueueList] = useState<QueueTrackRef[]>([])
  const [queueIndex, setQueueIndex] = useState(-1)
  const [shuffleActive, setShuffleActive] = useState(false)
  const [repeatMode, setRepeatMode] = useState<'none' | 'all' | 'one'>('all')
  const [queueResolving, setQueueResolving] = useState(false)

  // ── Playlist / Queue state ──
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [queuePlaylistName, setQueuePlaylistName] = useState('')

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Refs to handle rapid skip spam — only the latest request takes effect
  const latestReq = useRef(-1)

  // ── Background next-track pre-resolve ──
  const preloadedNextId = useRef<string | null>(null)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-50))
  }, [])

  // ── Refresh queue state from main process ──
  const refreshQueue = useCallback(async () => {
    try {
      const state = await window.api.getQueue()
      setQueueList(state.list)
      setQueueIndex(state.index)
      setShuffleActive(state.shuffleActive)
      setRepeatMode(state.repeatMode as 'none' | 'all' | 'one')
    } catch (err: any) {
      addLog(`queue refresh ERROR: ${err.message}`)
    }
  }, [addLog])

  // Refresh queue on mount
  useEffect(() => { refreshQueue() }, [refreshQueue])

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

  // ── Pre-resolve next track in background ──
  const preresolveNext = useCallback(async () => {
    try {
      const nextId = getNextTrackVideoId()
      if (!nextId || nextId === preloadedNextId.current) return

      preloadedNextId.current = nextId
      // Fire-and-forget: populates cache so next resolve is instant
      window.api.resolveTrack(nextId).then(() => {
        addLog(`pre-resolved next track: ${nextId}`)
      }).catch(() => {})
    } catch { /* best-effort */ }
  }, [queueList, queueIndex, shuffleActive, repeatMode, addLog])

  // ── Play from queue ──
  const playFromQueue = useCallback(async (idx: number) => {
    const track = queueList[idx]?.track
    if (!track) return
    const videoId = track.id || (track as any).sourceId

    latestReq.current = idx
    setQueueIndex(idx)
    setQueueResolving(true)
    setTrackTitle('')

    const t0 = Date.now()
    addLog(`⏳ Queue play #${idx}: ${videoId}`)

    try {
      const resolved = await window.api.resolveTrack(videoId)
      const t1 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      playerControls.load(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`load:    ${t2 - t1}ms`)

      await playerControls.play()
      const t3 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)

      // Fire-and-forget: get real song title from metadata
      if (latestReq.current === idx) {
        window.api.resolveTrackInfo(videoId).then((info) => {
          if (latestReq.current !== idx) return
          setTrackTitle(info.title)
          addLog(`title:  "${info.title}"`)
        }).catch(() => {})
      }

      // Background pre-resolve the next track for instant transition
      preresolveNext()
      // Also trigger prefetch for up to 3 upcoming tracks
      const upcomingIds = getUpcomingVideoIds(3)
      if (upcomingIds.length > 0) {
        window.api.prefetchQueue(upcomingIds).catch(() => {})
      }
    } catch (err: any) {
      if (latestReq.current === idx) {
        addLog(`ERROR: ${err.message}`)
      }
    } finally {
      setQueueResolving(false)
    }
  }, [queueList, playerControls, addLog, preresolveNext])

  // Helper: get video ID for next track
  const getNextTrackVideoId = useCallback((): string | null => {
    if (queueList.length === 0) return null
    const currentIdx = queueIndex

    if (repeatMode === 'one') {
      return queueList[currentIdx]?.track?.id ?? null
    }

    if (shuffleActive) {
      // Pick random different track
      let idx: number
      do {
        idx = Math.floor(Math.random() * queueList.length)
      } while (idx === currentIdx && queueList.length > 1)
      return queueList[idx]?.track?.id ?? null
    }

    const nextIdx = currentIdx + 1
    if (nextIdx < queueList.length) {
      return queueList[nextIdx]?.track?.id ?? null
    }

    if (repeatMode === 'all') {
      return queueList[0]?.track?.id ?? null
    }

    return null
  }, [queueList, queueIndex, shuffleActive, repeatMode])

  // Helper: get upcoming N track IDs for prefetch
  const getUpcomingVideoIds = useCallback((n: number): string[] => {
    const ids: string[] = []
    if (queueList.length === 0) return ids

    if (repeatMode === 'one') {
      // Just repeat the same track
      return [queueList[queueIndex]?.track?.id ?? ''].filter(Boolean)
    }

    if (shuffleActive) {
      // In shuffle, pick N random distinct tracks
      const pool = queueList.filter((_, i) => i !== queueIndex)
      const shuffled = [...pool].sort(() => Math.random() - 0.5)
      for (let i = 0; i < Math.min(n, shuffled.length); i++) {
        ids.push(shuffled[i].track.id)
      }
      return ids
    }

    // Sequential
    for (let i = 1; i <= n; i++) {
      const idx = queueIndex + i
      if (idx < queueList.length) {
        ids.push(queueList[idx].track.id)
      } else if (repeatMode === 'all') {
        ids.push(queueList[idx % queueList.length].track.id)
      }
    }
    return ids
  }, [queueList, queueIndex, repeatMode])

  // ── Play a search result ──
  const playSearchResult = useCallback(async (result: SearchTrack) => {
    latestReq.current = -3
    setQueueResolving(true)
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

      // Add to queue so it's trackable
      await window.api.addToQueue(result as any)

      window.api.resolveTrackInfo(result.videoId).then((info) => {
        if (latestReq.current !== -3) return
        setTrackTitle(info.title)
        addLog(`title:  "${info.title}"`)
      }).catch(() => {})
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setQueueResolving(false)
      refreshQueue()
    }
  }, [playerControls, addLog, refreshQueue])

  // ── Play via custom ID input ──
  const playCustomId = useCallback(async (id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return

    latestReq.current = -3
    setCustomResolving(true)
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

      window.api.resolveTrackInfo(trimmed).then((info) => {
        if (latestReq.current !== -3) return
        setTrackTitle(info.title)
        addLog(`title:  "${info.title}"`)
      }).catch(() => {})
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setCustomResolving(false)
    }
  }, [playerControls, addLog])

  // ── Queue navigation ──
  const goNext = useCallback(async () => {
    if (queueList.length === 0) return

    latestReq.current = -4
    setQueueResolving(true)
    setTrackTitle('')

    const t0 = Date.now()

    try {
      // Get next track from queue engine
      const nextVideoId = getNextTrackVideoId()
      if (!nextVideoId) {
        addLog('end of queue')
        setQueueResolving(false)
        return
      }

      addLog(`⏳ Next track: ${nextVideoId}`)

      let resolved = await window.api.resolveTrack(nextVideoId)
      const t1 = Date.now()
      addLog(`resolve: ${t1 - t0}ms  — ${resolved.title}`)
      setTrackTitle(resolved.title)

      playerControls.load(resolved.audioUrl)
      const t2 = Date.now()

      await playerControls.play()
      const t3 = Date.now()
      addLog(`play:    ${t3 - t2}ms  |  TOTAL: ${t3 - t0}ms`)

      window.api.resolveTrackInfo(nextVideoId).then((info) => {
        setTrackTitle(info.title)
      }).catch(() => {})

      // Advance the queue engine
      // We query it for next to advance internally, then refresh
      preresolveNext()
      refreshQueue()
    } catch (err: any) {
      addLog(`next ERROR: ${err.message}`)
      setQueueResolving(false)
    }
  }, [queueList, getNextTrackVideoId, addLog, preresolveNext, refreshQueue])

  const goPrev = useCallback(() => {
    // Simple previous: just reload current if no history
    if (queueIndex > 0) {
      playFromQueue(queueIndex - 1)
    }
  }, [queueIndex, playFromQueue])

  // ── Auto-advance on track ended ──
  useEffect(() => {
    if (!playerState.isPlaying && playerState.currentTime === 0 && queueList.length > 0 && trackTitle) {
      // Track finished naturally
      goNext()
    }
    // This effect fires when the ended event triggers the state to isPlaying=false, currentTime=0
  }, [playerState.isPlaying, playerState.currentTime])

  // ── Also listen via ended event callback ──
  // Actually, the useAudioPlayer hook already resets state on ended.
  // But we need a side-effect-triggered auto-advance.
  // The above effect will catch it: when isPlaying flips to false AND
  // currentTime is 0 AND we had a track loaded = it ended.

  // Actually this is not robust. Let's use a dedicated ref.
  const trackEndedRef = useRef(false)
  useEffect(() => {
    if (!playerState.isPlaying && playerState.currentTime === 0 && trackEndedRef.current) {
      trackEndedRef.current = false
      goNext()
    }
  }, [playerState.isPlaying, playerState.currentTime, goNext])

  useEffect(() => {
    // When a track was playing and goes to not-playing, it either ended or was paused
    // If currentTime is near duration, it ended
    if (!playerState.isPlaying && playerState.currentTime > 0 &&
        playerState.duration > 0 &&
        Math.abs(playerState.currentTime - playerState.duration) < 0.5) {
      trackEndedRef.current = true
    }
  }, [playerState.isPlaying, playerState.currentTime, playerState.duration])

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

  // ── Playlist management ──
  const handleLoadPlaylist = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: loading "${playlist.name}"...`)
      const tracks = await window.api.loadPlaylistIntoQueue(playlist.id)
      setQueuePlaylistName(playlist.name)
      addLog(`queue: loaded ${tracks.length} tracks from "${playlist.name}"`)
      refreshQueue()
    } catch (err: any) {
      addLog(`queue ERROR: ${err.message}`)
    }
  }, [addLog, refreshQueue])

  const handleAddPlaylistToQueue = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: appending "${playlist.name}"...`)
      const result = await window.api.addPlaylistToQueue(playlist.id)
      addLog(`queue: added ${result.length} tracks to queue from "${playlist.name}"`)
      refreshQueue()
    } catch (err: any) {
      addLog(`queue append ERROR: ${err.message}`)
    }
  }, [addLog, refreshQueue])

  // ── Shuffle toggle ──
  const handleToggleShuffle = useCallback(async () => {
    try {
      const result = await window.api.setShuffle()
      setShuffleActive(result.shuffleActive)
      setQueueList(result.list)
      setQueueIndex(result.index)
      addLog(`shuffle: ${result.shuffleActive ? 'ON' : 'OFF'}`)
    } catch (err: any) {
      addLog(`shuffle ERROR: ${err.message}`)
    }
  }, [addLog])

  // ── Repeat toggle ──
  const handleToggleRepeat = useCallback(async () => {
    const nextMode: Record<string, 'none' | 'all' | 'one'> = {
      'all': 'none',
      'none': 'one',
      'one': 'all',
    }
    const newMode = nextMode[repeatMode]
    try {
      await window.api.setRepeat(newMode)
      setRepeatMode(newMode)
      const labels: Record<string, string> = { 'all': '🔁 All', 'none': '⏹ Stop', 'one': '🔂 One' }
      addLog(`repeat: ${labels[newMode]}`)
    } catch (err: any) {
      addLog(`repeat ERROR: ${err.message}`)
    }
  }, [repeatMode, addLog])

  // Map queue track to display label
  const getTrackLabel = (qt: QueueTrackRef): string => {
    const t = qt.track
    if (t.artist && t.artist !== 'Unknown Artist') return `${t.artist} — ${t.title}`
    return t.title
  }

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
                    padding: '2px 8px',
                    background: '#36a',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  Load Queue
                </button>
                <button
                  onClick={() => handleAddPlaylistToQueue(pl)}
                  style={{
                    padding: '2px 8px',
                    background: '#2a6',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  + Queue
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
          onChange={(e) => setCustomId(e.target.value)}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#666' }}>
            Queue ({queueList.length} tracks)
            {queuePlaylistName ? ` — ${queuePlaylistName}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {/* Shuffle button */}
          <button
            onClick={handleToggleShuffle}
            style={{
              padding: '2px 8px',
              background: shuffleActive ? '#a80' : '#333',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
            }}
            title={shuffleActive ? 'Shuffle ON' : 'Shuffle OFF'}
          >
            {shuffleActive ? '🔀 ON' : '🔀'}
          </button>
          {/* Repeat button */}
          <button
            onClick={handleToggleRepeat}
            style={{
              padding: '2px 8px',
              background: repeatMode !== 'none' ? '#36a' : '#333',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
            }}
            title={repeatMode === 'all' ? 'Repeat All' : repeatMode === 'one' ? 'Repeat One' : 'No Repeat'}
          >
            {repeatMode === 'all' ? '🔁' : repeatMode === 'one' ? '🔂' : '⏹'}
          </button>
        </div>
        {queueList.length === 0 && (
          <div style={{ fontSize: 11, color: '#444', padding: '8px 0' }}>
            Queue is empty. Search for tracks or import a playlist.
          </div>
        )}
        {queueList.map((qt: QueueTrackRef, i: number) => {
          const label = getTrackLabel(qt)
          const isCurrent = i === queueIndex
          return (
            <div
              key={qt.queueId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                background: isCurrent ? '#222' : 'transparent',
                borderBottom: '1px solid #222',
              }}
            >
              <span style={{ width: 20, color: isCurrent ? '#4a4' : '#666' }}>
                {isCurrent ? '▶' : i + 1}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </span>
              <span style={{ fontSize: 11, color: '#555' }}>{formatDuration(qt.track.duration)}</span>
              <button
                onClick={() => playFromQueue(i)}
                disabled={queueResolving}
                style={{
                  padding: '2px 8px',
                  background: isCurrent ? '#2a2' : '#333',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {queueResolving && isCurrent ? '...' : isCurrent && playerState.isPlaying ? '▶' : '▶'}
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
          <button onClick={goPrev} disabled={queueIndex <= 0 || queueList.length === 0} style={btnStyle}>{'⏮'}</button>
          <button
            onClick={() => playerState.isPlaying ? playerControls.pause() : playerControls.play()}
            disabled={!trackTitle}
            style={btnStyle}
          >
            {playerState.isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={goNext} disabled={queueList.length === 0} style={btnStyle}>{'⏭'}</button>

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
