/**
 * CDP latency test — types video ID, clicks Play, measures TOTAL time.
 * Usage: node tests/cdp-test.mjs [videoId]
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const CDP_PORT = 9222
const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForCDP(timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const pages = await res.json()
        const page = pages.find(p => p.type === 'page') || pages[0]
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP not ready')
}

async function cdpCommand(ws, method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000)
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString())
        if (parsed.id === id) {
          ws.removeListener('message', handler)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed.result)
        }
      } catch {}
    }
    ws.on('message', handler)
    ws.send(JSON.stringify(msg))
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error(`Timeout: ${method}`)) }, 15000)
  })
}

async function runTest() {
  console.log(`[CDP] Starting dev server...`)
  const dev = spawn('npx', ['electron-vite', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    detached: false,
  })

  try {
    const wsUrl = await waitForCDP(25000)
    console.log(`[CDP] CDP ready`)
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('WS timeout')), 5000)
    })
    console.log(`[CDP] Connected`)

    const targets = await cdpCommand(ws, 'Target.getTargets')
    const pageTarget = targets.targetInfos.find(t => t.type === 'page')
    if (!pageTarget) throw new Error('No page target')
    const attach = await cdpCommand(ws, 'Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })
    const sid = attach.sessionId
    console.log(`[CDP] Attached`)

    const cmd = (m, p) => cdpCommand(ws, m, p, sid)

    // Phase 1: Type video ID using CDP Input.insertText (triggers React onChange)
    console.log(`\n[TEST] Setting video ID to ${VIDEO_ID}...`)
    // First focus the textbox
    await cmd('Runtime.evaluate', {
      expression: `(() => {
        const tb = document.querySelector('input[type="text"]');
        if (!tb) return 'no textbox';
        tb.focus();
        tb.select();
        return 'focused';
      })()`,
      returnByValue: true,
    })
    await sleep(100)
    // Clear existing text and type new ID
    await cmd('Input.insertText', { text: VIDEO_ID })
    await sleep(200)
    // Verify the value was set
    const verify = await cmd('Runtime.evaluate', {
      expression: `document.querySelector('input[type="text"]')?.value || 'empty'`,
      returnByValue: true,
    })
    console.log(`  Textbox value: ${verify?.result?.value || verify?.value || '?'}`)

    // Phase 2: Click Play
    console.log(`\n[TEST] Clicking Play...`)
    await cmd('Runtime.evaluate', {
      expression: `(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '\u25B6 Play');
        if (b) { b.click(); return 'clicked'; }
        return 'not found';
      })()`,
      returnByValue: true,
    })
    console.log(`  OK`)

    // Phase 3: Wait for timing
    console.log(`\n[TEST] Waiting for playback (20s)...`)
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try {
        const state = await cmd('Runtime.evaluate', {
          expression: `(() => {
            const t = document.body.innerText || '';
            const lines = t.split('\\n');
            const timing = lines.filter(l => l.includes('TOTAL') || l.includes('play:'));
            // Check state
            const slider = document.querySelector('input[type="range"]');
            const playBtn = Array.from(document.querySelectorAll('button'))
              .find(b => b.textContent === '⏸' || b.textContent === '▶');
            const errDiv = document.querySelector('div[style*="color: #c33"]');
            return JSON.stringify({
              timing,
              slider: slider ? slider.value : 'none',
              playState: playBtn ? playBtn.textContent : '?',
              error: errDiv ? errDiv.textContent : null,
              lines: lines.filter(l => l.includes('ERROR') || l.includes('Error') || l.includes('Failed')),
              textLines: lines.slice(-5),
            });
          })()`,
          returnByValue: true,
        })
        const info = JSON.parse(state?.result?.value || state?.value || '{}')
        if (info.timing?.length > 0) {
          console.log(`\n[RESULT] Timing found:`)
          info.timing.forEach(l => console.log(`  ${l}`))
          break
        }
        if (i % 4 === 0) {
          console.log(`  [${(i+1)*0.5}s] slider=${info.slider} state=${info.playState}${info.error ? ' ERR='+info.error : ''}`)
        }
      } catch (e) {
        console.log(`  [${(i+1)*0.5}s] CDP error: ${e.message} (app may have crashed)`)
        break
      }
    }

    // Final read
    const pageRaw = await cmd('Runtime.evaluate', {
      expression: `document.body.innerText || ''`,
      returnByValue: true,
    })
    const pageText = (pageRaw?.result?.value || '')
    const hits = pageText.split('\n').filter(l => l.includes('TOTAL') || l.includes('play:') || l.includes('resolve:') || l.includes('load:'))
    if (hits.length > 0) {
      console.log(`\n[RESULT] Final timing:`)
      hits.forEach(l => console.log(`  ${l}`))
      const m = hits.join(' ').match(/TOTAL:\s*(\d+)ms/)
      if (m) console.log(`\n***** LATENCY: ${m[1]}ms *****`)
    } else {
      console.log(`\n[INFO] No timing logged within window`)
    }

    ws.close()
    console.log(`\n[CDP] Complete`)

  } finally {
    dev.kill('SIGTERM')
    setTimeout(() => { try { dev.kill('SIGKILL') } catch {} }, 3000).unref()
    setTimeout(() => process.exit(0), 1000)
  }
}

runTest().catch(err => {
  console.error(`[CDP] Error: ${err.message}`)
  process.exit(1)
})
