// src/main/services/yt-dlp-daemon.ts
//
// yt-dlp daemon manager. Keeps a Python process alive so yt-dlp
// module imports are paid exactly once per app lifetime.
//
// Without the daemon, every stream URL extraction spawns a fresh
// Python subprocess and imports yt-dlp from scratch (~945ms import
// overhead per call). With the daemon, the import is done once at
// startup and subsequent requests reuse the same warmed process.
//
// The daemon reads video IDs from stdin (one per line) and writes
// stream URLs to stdout. Responses are serialized — one request
// in-flight at a time; queued requests wait.

import { spawn, type ChildProcess } from 'child_process'
import path from 'node:path'
import readline from 'node:readline'
import { findYTDlp, YTDlpError } from './yt-dlp'

interface QueuedRequest {
  videoId: string
  resolve: (url: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class YtdlpDaemon {
  private child: ChildProcess | null = null
  private rl: readline.Interface | null = null
  private ready = false
  private destroyed = false

  /** True while a request is being processed by the daemon */
  private busy = false

  /** Queue of pending requests (processed FIFO) */
  private queue: QueuedRequest[] = []

  /** The request currently being processed, if any */
  private currentRequest: QueuedRequest | null = null

  /** Total requests processed since daemon start */
  private stats = { processed: 0, failed: 0 }

  /**
   * Start the yt-dlp daemon. Resolves when the Python process is
   * initialized and ready to accept requests.
   */
  async start(timeoutMs = 15000): Promise<void> {
    if (this.child) return

    const scriptPath = this.resolveScriptPath()
    const python = await this.findPython()

    this.child = spawn(python, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 🛡️ Isolate from Electron's process tree
      detached: true,
      env: { ...process.env, YTDLP_NO_UPDATE_CHECK: '1' },
    })
    this.child.unref()

    // Pipe stderr to our logger (daemon uses it for errors)
    this.child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.warn(`[yt-dlp-daemon] ${msg}`)
    })

    // Handle unexpected exit — 'close' event has the real exit code
    this.child.on('exit', () => {
      // 'close' event handles the actual cleanup
    })

    this.child.on('close', (exitCode) => {
      if (this.destroyed) return
      console.warn(`[yt-dlp-daemon] Process exited (code=${exitCode}), restarting...`)
      // Reject all pending requests
      this.failAll(new YTDlpError('yt-dlp daemon crashed', 'DAEMON_CRASH'))
      // Auto-restart on crash
      this.child = null
      this.rl = null
      this.ready = false
      this.start().catch((err) => {
        console.error('[yt-dlp-daemon] Restart failed:', err.message)
      })
    })

    // Set up readline interface for stdout
    this.rl = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    })

    // Wait for the "READY" signal from the daemon
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new YTDlpError('yt-dlp daemon startup timed out', 'TIMEOUT'))
      }, timeoutMs)

      this.rl!.once('line', (line) => {
        clearTimeout(timer)
        if (line === 'READY') {
          this.ready = true
          resolve()
        } else {
          reject(new YTDlpError(
            `Unexpected daemon response: ${line}`,
            'DAEMON_ERROR'
          ))
        }
      })
    })

    // Route subsequent lines to request handlers
    this.rl.on('line', (line) => this.handleResponse(line))

    console.log('[yt-dlp-daemon] Ready')
  }

  /**
   * Get a stream URL for a video ID via the daemon.
   * If the daemon is busy, the request is queued.
   */
  async getStreamUrl(videoId: string, timeoutMs = 20000): Promise<string> {
    if (this.destroyed) {
      throw new YTDlpError('yt-dlp daemon was destroyed', 'DAEMON_CRASH')
    }

    // Start the daemon lazily if not yet running
    if (!this.child) {
      await this.start()
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout — remove from queue
        this.removeFromQueue(videoId)
        reject(new YTDlpError(
          `yt-dlp daemon timed out for ${videoId}`,
          'TIMEOUT'
        ))
      }, timeoutMs)

      this.queue.push({ videoId, resolve, reject, timer })
      this.processNext()
    })
  }

  /**
   * Gracefully stop the daemon.
   */
  async stop(): Promise<void> {
    this.destroyed = true
    this.failAll(new YTDlpError('yt-dlp daemon stopped', 'DAEMON_CRASH'))

    if (this.child) {
      this.child.kill('SIGTERM')
      // Give it 2s to exit gracefully, then SIGKILL
      setTimeout(() => this.child?.kill('SIGKILL'), 2000)
      this.child = null
    }
    this.rl?.close()
    this.rl = null
    this.ready = false
  }

  // ── Private ────────────────────────────────────────────────

  private processNext(): void {
    if (this.busy || this.queue.length === 0 || !this.ready) return
    if (!this.child?.stdin?.writable) {
      this.failAll(new YTDlpError('yt-dlp daemon stdin closed', 'DAEMON_CRASH'))
      return
    }

    this.busy = true
    this.currentRequest = this.queue.shift()!
    this.child.stdin.write(this.currentRequest.videoId + '\n')
  }

  private handleResponse(line: string): void {
    const req = this.currentRequest
    this.currentRequest = null
    this.busy = false

    if (req) {
      clearTimeout(req.timer)
      if (line === '') {
        this.stats.failed++
        req.reject(new YTDlpError(
          `Daemon returned empty URL for ${req.videoId}`,
          'RESOLVE_FAILED'
        ))
      } else {
        this.stats.processed++
        req.resolve(line)
      }
    }

    this.processNext()
  }

  private removeFromQueue(videoId: string): void {
    this.queue = this.queue.filter((r) => r.videoId !== videoId)
  }

  private failAll(err: Error): void {
    // Fail current in-flight request
    if (this.currentRequest) {
      clearTimeout(this.currentRequest.timer)
      this.currentRequest.reject(err)
      this.currentRequest = null
    }
    // Fail queued requests
    for (const req of this.queue) {
      clearTimeout(req.timer)
      req.reject(err)
    }
    this.queue = []
    this.busy = false
  }

  /**
   * Resolve the path to the Python daemon script.
   * In dev: process.cwd() = project root, scripts/ is at project root.
   * In production: script should be bundled alongside the app resources.
   */
  private resolveScriptPath(): string {
    // Dev: scripts/ is at project root
    const devPath = path.join(process.cwd(), 'scripts', 'yt-dlp-daemon.py')
    try {
      require('fs').accessSync(devPath)
      return devPath
    } catch {
      // Production: bundled in app resources
      return path.join(process.resourcesPath ?? __dirname, 'scripts', 'yt-dlp-daemon.py')
    }
  }

  /**
   * Find the Python 3 interpreter (same one that has yt-dlp installed).
   * Falls back to bare "python3" on PATH.
   */
  private async findPython(): Promise<string> {
    try {
      const ytDlpPath = await findYTDlp()
      // yt-dlp is at: /Library/Frameworks/Python.framework/Versions/3.12/bin/yt-dlp
      // Python is at:   /Library/Frameworks/Python.framework/Versions/3.12/bin/python3
      // Derive from yt-dlp path
      if (ytDlpPath.includes('/bin/yt-dlp')) {
        const pythonPath = ytDlpPath.replace('/yt-dlp', '/python3')
        try {
          require('fs').accessSync(pythonPath)
          return pythonPath
        } catch {
          // fall through to bare python3
        }
      }
    } catch {
      // findYTDlp failed, fall through
    }
    return 'python3'
  }
}

/** Singleton daemon instance (shared across the app) */
let _daemon: YtdlpDaemon | null = null

export function getDaemon(): YtdlpDaemon {
  if (!_daemon) {
    _daemon = new YtdlpDaemon()
  }
  return _daemon
}

export async function warmDaemon(): Promise<void> {
  try {
    await getDaemon().start()
  } catch (err) {
    console.warn('[yt-dlp-daemon] Warm failed:', (err as Error).message)
  }
}
