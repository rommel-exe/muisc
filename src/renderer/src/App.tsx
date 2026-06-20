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

  // ── Playlist state ──
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [queuePlaylistName, setQueuePlaylistName] = useState('')

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Refs to handle rapid skip spam
  const latestReq = useRef(-1)

  // Track which videoId is preloaded in the secondary element + which queue index
  const preloadedQueueIndex = useRef(-1)
  const preloadedVideoId = useRef<string | null>(null)

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

  useEffect(() => { refreshQueue() }, [refreshQueue])

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

  // ── Preload next track into secondary audio element ──
  const preloadNextTrack = useCallback(async () => {
    const peeked = await window.api.queuePeekNext()
    if (!peeked) return

    const videoId = peeked.track.id || peeked.track.sourceId
    if (videoId === preloadedVideoId.current) return

    addLog(`preloading next: ${videoId} ...`)
    preloadedQueueIndex.current = -1  // unknown until queueNext
    preloadedVideoId.current = videoId

    // Resolve the stream URL (triggers proxy prewarm + cache)
    window.api.resolveTrack(videoId).then((resolved) => {
      if (preloadedVideoId.current !== videoId) return
      playerControls.preloadNext(resolved.audioUrl)
      addLog(`preloaded: ${videoId}`)
    }).catch(() => {
      addLog(`preload FAILED: ${videoId}`)
    })
  }, [playerControls, addLog])

  // ── Play track by queue index ──
  const playFromQueue = useCallback(async (idx: number) => {
    const qt = queueList[idx]
    if (!qt) return
    const track = qt.track
    const videoId = track.id || track.sourceId

    latestReq.current = idx
    setQueueIndex(idx)
    setQueueResolving(true)
    setTrackTitle('')

    const t0 = Date.now()
    addLog(`▶ Queue #${idx}: ${videoId}`)

    try {
      // Check if this is the preloaded next track → instant swap
      const isPreloadedTarget = idx === preloadedQueueIndex.current &&
        videoId === preloadedVideoId.current

      if (isPreloadedTarget && playerState.isNextReady) {
        // INSTANT SWAP: secondary element is already buffered
        addLog(`swap-to-next: already preloaded`)
        const swapped = await playerControls.swapToNext()
        if (swapped) {
          const t1 = Date.now()
          addLog(`swap: ${t1 - t0}ms — INSTANT`)
          setTrackTitle(track.title)
          setQueueResolving(false)
          // Preload the NEXT-next track
          preloadVideoId(videoId)
          preloadNextTrack()
          refreshQueue()
          return
        }
      }

      // Normal path: resolve + load + play
      addLog(`resolve: ${videoId}...`)
      const resolved = await window.api.resolveTrack(videoId)
      const t1 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`resolve: ${t1 - t0}ms — ${resolved.title}`)
      setTrackTitle(resolved.title)

      await playerControls.loadAndPlay(resolved.audioUrl)
      const t2 = Date.now()
      if (latestReq.current !== idx) return

      addLog(`load+play: ${t2 - t1}ms  |  TOTAL: ${t2 - t0}ms`)

      // Get real title from metadata (background)
      window.api.resolveTrackInfo(videoId).then((info) => {
        if (latestReq.current !== idx) return
        setTrackTitle(info.title)
      }).catch(() => {})

      // Preload next track
      preloadVideoId(videoId)
      preloadNextTrack()
      // Also trigger prefetch for upcoming tracks
      const upcomingIds = getUpcomingVideoIds(3)
      if (upcomingIds.length > 0) {
        window.api.prefetchQueue(upcomingIds).catch(() => {})
      }
      refreshQueue()
    } catch (err: any) {
      if (latestReq.current === idx) {
        addLog(`ERROR: ${err.message}`)
      }
    } finally {
      setQueueResolving(false)
    }
  }, [queueList, playerControls, addLog, preloadNextTrack, refreshQueue, playerState.isNextReady])

  // Track current videoId for preload logic
  const currentVideoIdRef = useRef('')

  const preloadVideoId = useCallback((videoId: string) => {
    currentVideoIdRef.current = videoId
  }, [])

  // ── Helper: get upcoming N track IDs (from local queue state, best-effort) ──
  const getUpcomingVideoIds = useCallback((n: number): string[] => {
    const ids: string[] = []
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
    addLog(`⏳ Search: ${result.videoId}`)

    try {
      const resolved = await window.api.resolveTrack(result.videoId)
      const t1 = Date.now()
      addLog(`resolve: ${t1 - t0}ms — ${resolved.title}`)
      setTrackTitle(resolved.title)

      await playerControls.loadAndPlay(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`play: ${t2 - t1}ms  |  TOTAL: ${t2 - t0}ms`)

      // Add to queue
      await window.api.addToQueue(result as any)

      window.api.resolveTrackInfo(result.videoId).then((info) => {
        if (latestReq.current !== -3) return
        setTrackTitle(info.title)
      }).catch(() => {})

      preloadNextTrack()
      refreshQueue()
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setQueueResolving(false)
    }
  }, [playerControls, addLog, preloadNextTrack, refreshQueue])

  // ── Play custom ID ──
  const playCustomId = useCallback(async (id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return

    latestReq.current = -3
    setCustomResolving(true)
    setTrackTitle('')

    const t0 = Date.now()
    addLog(`⏳ Custom: ${trimmed}`)

    try {
      const resolved = await window.api.resolveTrack(trimmed)
      const t1 = Date.now()
      addLog(`resolve: ${t1 - t0}ms`)
      setTrackTitle(resolved.title)

      await playerControls.loadAndPlay(resolved.audioUrl)
      const t2 = Date.now()
      addLog(`play: ${t2 - t1}ms  |  TOTAL: ${t2 - t0}ms`)

      window.api.resolveTrackInfo(trimmed).then((info) => {
        if (latestReq.current !== -3) return
        setTrackTitle(info.title)
      }).catch(() => {})
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`)
    } finally {
      setCustomResolving(false)
    }
  }, [playerControls, addLog])

  // ── Queue navigation ──
  const goNext = useCallback(async () => {
    const result = await window.api.queueNext()
    if (!result) {
      addLog('end of queue')
      return
    }

    const { track, index: newIndex } = result
    const videoId = track.id || track.sourceId

    // Try instant swap if standby element is preloaded for this track
    if (preloadedVideoId.current === videoId && playerState.isNextReady) {
      const swapped = await playerControls.swapToNext()
      if (swapped) {
        addLog('next: INSTANT swap')
        setTrackTitle(track.title)
        setQueueIndex(newIndex)
        currentVideoIdRef.current = videoId
        preloadedVideoId.current = null
        preloadedQueueIndex.current = -1
        // Preload the next-next track
        preloadNextTrack()
        refreshQueue()
        return
      }
    }

    // Fallback: resolve + play
    playFromQueue(newIndex)
  }, [playerControls, playerState.isNextReady, addLog, preloadNextTrack, refreshQueue, playFromQueue])

  const goPrev = useCallback(async () => {
    const result = await window.api.queuePrev()
    if (!result) {
      addLog('no previous track')
      return
    }
    playFromQueue(result.index)
  }, [addLog, playFromQueue])

  // ── Auto-advance on track ended (fires directly from DOM ended event) ──
  const isAdvancing = useRef(false)

  useEffect(() => {
    playerControls.setOnTrackEnd(() => {
      if (isAdvancing.current) return
      isAdvancing.current = true
      addLog('auto-advance: track ended')
      goNext().finally(() => {
        isAdvancing.current = false
      })
    })
  }, [playerControls, addLog, goNext])

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

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
      // Stop current audio before replacing queue
      playerControls.pause()
      await window.api.loadPlaylistIntoQueue(playlist.id)
      setQueueIndex(0)
      setQueuePlaylistName(playlist.name)
      setTrackTitle('')
      refreshQueue()
      addLog(`queue: loaded "${playlist.name}"`)
    } catch (err: any) { addLog(`queue ERROR: ${err.message}`) }
  }, [addLog, refreshQueue, playerControls])

  const handleAddPlaylistToQueue = useCallback(async (playlist: Playlist) => {
    try {
      addLog(`queue: appending "${playlist.name}"...`)
      await window.api.addPlaylistToQueue(playlist.id)
      refreshQueue()
      addLog(`queue: added "${playlist.name}"`)
    } catch (err: any) { addLog(`queue append ERROR: ${err.message}`) }
  }, [addLog, refreshQueue])

  // ── Shuffle / Repeat ──
  const handleToggleShuffle = useCallback(async () => {
    try {
      const result = await window.api.setShuffle()
      setShuffleActive(result.shuffleActive)
      setQueueList(result.list)
      setQueueIndex(result.index)
      addLog(`shuffle: ${result.shuffleActive ? 'ON' : 'OFF'}`)
    } catch (err: any) { addLog(`shuffle ERROR: ${err.message}`) }
  }, [addLog])

  const handleToggleRepeat = useCallback(async () => {
    const nextMode: Record<string, 'none' | 'all' | 'one'> = { 'all': 'none', 'none': 'one', 'one': 'all' }
    const newMode = nextMode[repeatMode]
    try {
      await window.api.setRepeat(newMode)
      setRepeatMode(newMode)
      const labels: Record<string, string> = { 'all': '🔁 All', 'none': '⏹ Stop', 'one': '🔂 One' }
      addLog(`repeat: ${labels[newMode]}`)
    } catch (err: any) { addLog(`repeat ERROR: ${err.message}`) }
  }, [repeatMode, addLog])

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
              <div key={result.videoId} onClick={() => playSearchResult(result)}
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
          onKeyDown={(e) => { if (e.key === 'Enter') playCustomId(customId) }}
          placeholder="Paste YouTube video ID..."
          style={{ flex: 1, padding: '6px 8px', background: '#1a1a1a', color: '#ddd', border: '1px solid #333', borderRadius: 0, fontFamily: 'monospace', fontSize: 12, outline: 'none' }} />
        <button onClick={() => playCustomId(customId)} disabled={customResolving || !customId.trim()}
          style={{ padding: '6px 14px', background: customResolving ? '#333' : '#06a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>
          {customResolving ? '...' : '▶ Play'}
        </button>
      </div>

      {/* ── Queue ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#666' }}>
            Queue ({queueList.length} tracks){queuePlaylistName ? ` — ${queuePlaylistName}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={handleToggleShuffle}
            style={{ padding: '2px 8px', background: shuffleActive ? '#a80' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}
            title={shuffleActive ? 'Shuffle ON' : 'Shuffle OFF'}>{shuffleActive ? '🔀 ON' : '🔀'}</button>
          <button onClick={handleToggleRepeat}
            style={{ padding: '2px 8px', background: repeatMode !== 'none' ? '#36a' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}
            title={repeatMode === 'all' ? 'Repeat All' : repeatMode === 'one' ? 'Repeat One' : 'No Repeat'}>
            {repeatMode === 'all' ? '🔁' : repeatMode === 'one' ? '🔂' : '⏹'}
          </button>
        </div>
        {queueList.length === 0 && (
          <div style={{ fontSize: 11, color: '#444', padding: '8px 0' }}>Queue is empty. Search or import.</div>
        )}
        {queueList.map((qt: QueueTrackRef, i: number) => {
          const label = getTrackLabel(qt)
          const isCurrent = i === queueIndex
          return (
            <div key={qt.queueId}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: isCurrent ? '#222' : 'transparent', borderBottom: '1px solid #222' }}>
              <span style={{ width: 20, color: isCurrent ? '#4a4' : '#666' }}>{isCurrent ? '▶' : i + 1}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ fontSize: 11, color: '#555' }}>{formatDuration(qt.track.duration)}</span>
              <button onClick={() => playFromQueue(i)} disabled={queueResolving}
                style={{ padding: '2px 8px', background: isCurrent ? '#2a2' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>
                {queueResolving && isCurrent ? '...' : '▶'}
              </button>
            </div>
          )
        })}
      </div>

      {/* ── Now Playing ── */}
      <div style={{ padding: '8px 0', borderTop: '1px solid #333', marginBottom: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 6, color: '#888' }}>{trackTitle || 'No track loaded'}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={goPrev} disabled={queueIndex <= 0 || queueList.length === 0} style={btnStyle}>{'⏮'}</button>
          <button onClick={() => playerState.isPlaying ? playerControls.pause() : playerControls.play()}
            disabled={!trackTitle} style={btnStyle}>{playerState.isPlaying ? '⏸' : '▶'}</button>
          <button onClick={goNext} disabled={queueList.length === 0} style={btnStyle}>{'⏭'}</button>
          <input type="range" min={0} max={playerState.duration || 1} value={playerState.currentTime}
            onChange={(e) => playerControls.seek(Number(e.target.value))}
            style={{ flex: 1, margin: '0 4px' }} />
          <span style={{ fontSize: 11, color: '#888', minWidth: 80, textAlign: 'right' }}>
            {formatTime(playerState.currentTime)} / {formatTime(playerState.duration)}
          </span>
          <label style={{ fontSize: 11, color: '#666' }}>vol</label>
          <input type="range" min={0} max={1} step={0.05} value={playerState.volume}
            onChange={(e) => playerControls.setVolume(Number(e.target.value))} style={{ width: 60 }} />
        </div>
        {playerState.isNextReady && playerState.nextUrl && (
          <div style={{ fontSize: 10, color: '#484', marginTop: 4 }}>next track preloaded ✓</div>
        )}
      </div>

      {playerState.error && <div style={{ color: '#c33', fontSize: 12 }}>{playerState.error}</div>}

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
