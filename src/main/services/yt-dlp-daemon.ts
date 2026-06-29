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
  startTime: number
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

  /** Number of auto-restart attempts (resets on successful start) */
  private _restartCount = 0
  /** Mutex guard for start() — prevents concurrent spawns when
   *  an auto-restart races against an explicit start() call. */
  private _starting: Promise<void> | null = null

  /**
   * Start the yt-dlp daemon. Resolves when the Python process is
   * initialized and ready to accept requests.
   * Uses a mutex (_starting) so concurrent calls reuse the same promise,
   * preventing duplicate daemon spawns when restart races with new start().
   */
  async start(timeoutMs = 15000): Promise<void> {
    if (this.child) return
    if (this._starting) return this._starting

    const promise = this._startInternal(timeoutMs)
    this._starting = promise
    try {
      await promise
    } finally {
      this._starting = null
    }
  }

  /** Internal start implementation — called by start() under the _starting mutex. */
  private async _startInternal(timeoutMs: number): Promise<void> {
    const scriptPath = this.resolveScriptPath()
    const python = await this.findPython()

    this.child = spawn(python, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 🛡️ Isolate from Electron's process tree
      detached: true,
      env: { ...process.env, YTDLP_NO_UPDATE_CHECK: '1' },
    })
    this.child.unref()

    this.child.on('error', (err) => {
      console.error(`[yt-dlp-daemon] Spawn error: ${err.message}`)
      this.failAll(new YTDlpError(`yt-dlp daemon spawn failed: ${err.message}`, 'DAEMON_CRASH'))
    })

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

      // Reject startup promise if daemon crashed before emitting READY
      if (!this.ready && this._starting) {
        this._starting = Promise.reject(new YTDlpError(
          `yt-dlp daemon exited before READY (code=${exitCode})`,
          'DAEMON_CRASH'
        ))
        this._starting.catch(() => {}) // suppress unhandled rejection
      }

      // Limit auto-restart attempts to prevent infinite loop when Python env is broken
      if ((this._restartCount ?? 0) >= 3) {
        console.error(`[yt-dlp-daemon] Max restarts (3) reached, giving up`)
        return
      }
      this._restartCount = (this._restartCount ?? 0) + 1
      console.warn(`[yt-dlp-daemon] Process exited (code=${exitCode}), restarting... (attempt ${this._restartCount}/3)`)
      // Reject all pending requests
      this.failAll(new YTDlpError('yt-dlp daemon crashed', 'DAEMON_CRASH'))
        this.child = null
      this.rl?.close()
      this.rl = null
      this.ready = false
      const backoff = Math.min(1000 * Math.pow(2, this._restartCount - 1), 8000)
      setTimeout(() => {
        this.start().catch((err) => {
          console.error('[yt-dlp-daemon] Restart failed:', err.message)
        })
      }, backoff)
    })

    // Set up readline interface for stdout
    this.rl = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    })

    // ⚠️ CRITICAL: Register the response handler BEFORE awaiting READY.
    // If processNext() (triggered from the READY handler) writes a queued
    // request and the daemon responds before we register rl.on('line', ...),
    // the response 'line' event is lost forever (readline won't re-emit it).
    //
    // We filter out READY here since it's handled separately below.
    this.rl.on('line', (line) => {
      if (line === 'READY') return // handled by the startup promise
      this.handleResponse(line)
    })

    // Wait for the "READY" signal from the daemon.
    // ⚠️ CRITICAL: When startup times out and start() rejects, the Python
    // process may still be alive (warmup is slow). this.ready MUST be set
    // when READY eventually arrives, or every subsequent daemon request
    // silently queues up and times out (this.child is truthy so start()
    // isn't retried, but processNext() returns early because !this.ready).
    //
    // Solution: always set this.ready = true + call processNext() when
    // READY arrives, regardless of whether the promise already settled.
    await new Promise<void>((resolve, reject) => {
      let settled = false

      const timer = setTimeout(() => {
        settled = true
        // Kill the zombie process — it's still alive but we're giving up on it
        this.child?.kill('SIGKILL')
        reject(new YTDlpError('yt-dlp daemon startup timed out', 'TIMEOUT'))
      }, timeoutMs)

      this.rl!.once('line', (line) => {
        clearTimeout(timer)
        if (line === 'READY') {
          this.ready = true
          if (!settled) {
            resolve()
          } else {
            // READY arrived after timeout — daemon is still usable.
            // Flush any requests that queued up while it was starting.
            console.log('[yt-dlp-daemon] READY received (after timeout), daemon now usable')
          }
          this.processNext()
        } else if (!settled) {
          reject(new YTDlpError(
            `Unexpected daemon response: ${line}`,
            'DAEMON_ERROR'
          ))
        }
      })
    })

    this._restartCount = 0
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
        // If the timed-out request was the in-flight one, clear busy state
        // so the daemon can process subsequent queued requests
        if (this.currentRequest?.videoId === videoId) {
          this.busy = false
          this.currentRequest = null
        }
        reject(new YTDlpError(
          `yt-dlp daemon timed out for ${videoId}`,
          'TIMEOUT'
        ))
      }, timeoutMs)

      this.queue.push({ videoId, resolve, reject, timer, startTime: 0 })
      try {
        this.processNext()
      } catch (err) {
        // If processNext() throws, reject the promise so it doesn't hang forever
        clearTimeout(timer)
        this.removeFromQueue(videoId)
        reject(new YTDlpError(
          `yt-dlp daemon processNext error: ${(err as Error).message}`,
          'DAEMON_ERROR'
        ))
      }
    })
  }

  /**
   * Gracefully stop the daemon.
   */
  async stop(): Promise<void> {
    this.destroyed = true
    this.failAll(new YTDlpError('yt-dlp daemon stopped', 'DAEMON_CRASH'))

    if (this.child) {
      const child = this.child
      child.kill('SIGTERM')
      // Give it 2s to exit gracefully, then SIGKILL
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 2000)
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
    this.currentRequest.startTime = Date.now()
    this.child.stdin.write(this.currentRequest.videoId + '\n')
  }

  private handleResponse(line: string): void {
    const req = this.currentRequest
    this.currentRequest = null
    this.busy = false

    if (req) {
      const elapsed = Date.now() - req.startTime
      clearTimeout(req.timer)
      if (line === '') {
        this.stats.failed++
        console.log(`[yt-dlp-daemon] ${req.videoId}: FAILED ${elapsed}ms`)
        req.reject(new YTDlpError(
          `Daemon returned empty URL for ${req.videoId}`,
          'RESOLVE_FAILED'
        ))
      } else {
        this.stats.processed++
        console.log(`[yt-dlp-daemon] ${req.videoId}: ${elapsed}ms`)
        req.resolve(line)
      }
    }

    try {
      this.processNext()
    } catch (err) {
      console.error('[yt-dlp-daemon] processNext error:', err)
    }
  }

  private removeFromQueue(videoId: string): void {
    const removed: QueuedRequest[] = []
    this.queue = this.queue.filter((r) => {
      if (r.videoId === videoId) {
        removed.push(r)
        return false
      }
      return true
    })
    // Clear timers AND reject orphaned entries. Otherwise, when multiple
    // requests queue for the same videoId and one times out, the others
    // get removed but never rejected — their Promises hang forever.
    for (const r of removed) {
      clearTimeout(r.timer)
      r.reject(new YTDlpError(
        `Removed from queue (duplicate request for ${videoId})`,
        'RESOLVE_FAILED'
      ))
    }
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
    console.error('[yt-dlp-daemon] Warm failed:', (err as Error).message)
  }
}
