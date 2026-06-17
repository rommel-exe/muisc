import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createMediaResolver } from './services/media-resolver'
import { registerHandlers, unregisterHandlers } from './ipc/handlers'
import { warmInnerTube } from './services/innertube'

// Prevent GPU/utility process crash cascade on macOS.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
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

  // Pre-warm InnerTube session so the first cold resolve doesn't wait for init.
  // Fire-and-forget — failure is caught and retried on first resolve.
  warmInnerTube().catch(() => {})

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  console.log('[App] Window created, app running')

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Catch GPU/child process crashes so they don't cascade into app termination
app.on('child-process-gone', (_event, details) => {
  console.warn(`[App] Child process gone: type=${details.type} reason=${details.reason} exit_code=${details.exitCode}`)
})

// Graceful shutdown: stop proxy and cleanup
app.on('will-quit', async (event) => {
  console.warn('[App] will-quit triggered')
  unregisterHandlers()
  await mediaResolver.stop()
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
