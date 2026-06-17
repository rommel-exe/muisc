// IPC Channel Names
export const IPC_CHANNELS = {
  // Search
  MUSIC_SEARCH: 'music-search',

  // Playback
  PLAY_TRACK: 'play-track',
  PAUSE_TRACK: 'pause-track',
  RESUME_TRACK: 'resume-track',
  NEXT_TRACK: 'next-track',
  PREV_TRACK: 'prev-track',
  SET_REPEAT: 'set-repeat',
  SET_SHUFFLE: 'set-shuffle',
  SET_VOLUME: 'set-volume',
  SEEK: 'seek',

  // Queue
  GET_QUEUE: 'get-queue',
  ADD_TO_QUEUE: 'add-to-queue',
  REMOVE_FROM_QUEUE: 'remove-from-queue',
  REORDER_QUEUE: 'reorder-queue',
  CLEAR_QUEUE: 'clear-queue',

  // Playlists
  CREATE_PLAYLIST: 'create-playlist',
  RENAME_PLAYLIST: 'rename-playlist',
  DELETE_PLAYLIST: 'delete-playlist',
  ADD_TRACK_TO_PLAYLIST: 'add-track-to-playlist',
  REMOVE_TRACK_FROM_PLAYLIST: 'remove-track-from-playlist',
  REORDER_PLAYLIST: 'reorder-playlist',
  GET_PLAYLISTS: 'get-playlists',
  GET_PLAYLIST_TRACKS: 'get-playlist-tracks',

  // Library
  GET_SONGS: 'get-songs',
  ADD_TRACK: 'add-track',

  // Updater
  CHECK_FOR_UPDATES: 'check-for-updates',
  UPDATE_DOWNLOADED: 'update-downloaded',

  // Preloader
  PREFETCH_QUEUE: 'prefetch-queue'
} as const

// Default playback config
export const DEFAULT_VOLUME = 0.8
export const PROXY_PORT = 18938
export const DB_FILENAME = 'muisc.db'
