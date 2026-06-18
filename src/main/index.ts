import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createMediaResolver } from './services/media-resolver'
import { registerHandlers, unregisterHandlers } from './ipc/handlers'
import { warmInnerTube } from './services/innertube'
import { warmDaemon, getDaemon } from './services/yt-dlp-daemon'
import { warmYtdlp } from './services/yt-dlp'

// Run GPU in-process so there's no separate GPU process to crash (exit_code=15
// on this macOS version). The test UI renders fine without a dedicated GPU proc.
app.commandLine.appendSwitch('in-process-gpu')

// Don't crash the whole app when a child process dies
app.commandLine.appendSwitch('disable-breakpad')

// Create the media resolver — owns the proxy and cache
const mediaResolver = createMediaResolver()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer based on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAutoLaunch(false)

  // Start the media resolver (starts the proxy server)
  await mediaResolver.start()

  // Register IPC handlers
  registerHandlers(mediaResolver)

  // Create window before fire-and-forget warm-ups so the renderer loads
  // before yt-dlp / Innertube init consumes CPU.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  console.log('[App] Window created, app running')

  // Pre-warm yt-dlp daemon and InnerTube session so the first cold
  // resolve doesn't pay init overhead. Fire-and-forget.
  warmDaemon()
    .then(() => mediaResolver.prewarmCdn('9bZkp7q19f0'))
    .catch(() => {})
  warmInnerTube().catch(() => {})
  warmYtdlp().catch(() => {})

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Catch GPU/child process crashes — just log them.
app.on('child-process-gone', (_event, details) => {
  console.warn(`[App] Child process gone: type=${details.type} reason=${details.reason} exit_code=${details.exitCode}`)
})

// Suppress quit-on-crash. The renderer keeps running fine without GPU
// compositing for this test UI. The user can kill the process by pressing
// Ctrl+C in the terminal that ran `npm run dev`.
app.on('before-quit', (event) => {
  console.warn('[App] before-quit — preventing cascade')
  event.preventDefault()
})

// Clean shutdown on explicit quit
app.on('will-quit', async () => {
  console.warn('[App] will-quit — cleaning up')
  unregisterHandlers()
  await mediaResolver.stop()
  getDaemon().stop().catch(() => {})
})

// Quit when all windows are closed, except on macOS.
// It's common for applications and their menu bar to stay active until the user
// quits explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
