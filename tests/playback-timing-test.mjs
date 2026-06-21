/**
 * muisc Performance Benchmark — full queue test
 * 
 * Measures: search → play, skip to next, playlist load, skip-spam
 * 
 * Usage: node tests/playback-timing-test.mjs
 */
import WebSocket from 'ws';
import http from 'http';
import { execSync } from 'child_process';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

class CDP {
  #id = 0;
  #pending = new Map();
  #ws = null;

  connect() {
    return new Promise((resolve, reject) => {
      http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          const page = JSON.parse(data).find(t => t.title === 'Muisc');
          if (!page) return reject(new Error('No Muisc target'));
          this.#ws = new WebSocket(page.webSocketDebuggerUrl);
          this.#ws.on('open', resolve);
          this.#ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && this.#pending.has(msg.id)) {
              this.#pending.get(msg.id)(msg);
              this.#pending.delete(msg.id);
            }
          });
          this.#ws.on('error', reject);
        });
      }).on('error', reject);
    });
  }

  send(method, params = {}) { return new Promise((resolve) => {
    const id = ++this.#id;
    this.#pending.set(id, resolve);
    this.#ws.send(JSON.stringify({ id, method, params }));
  });}

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  }

  close() { this.#ws?.close(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tailLogs(lines = 20) {
  try {
    const out = execSync('tail -20 /tmp/muisc-dev.log 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

async function getEngineLogs(cdp) {
  const body = await cdp.eval('document.body.innerText');
  return body?.split('\n').filter(l => l.includes('[engine]')) || [];
}

let testNum = 0;
async function runTest(cdp, name, fn) {
  testNum++;
  console.log(`\n─── Test ${testNum}: ${name} ───`);
  const t0 = Date.now();
  try { await fn(); }
  catch (e) { console.log(`  ✗ ERROR: ${e.message}`); }
  const elapsed = Date.now() - t0;
  console.log(`  ⏱ Test wall time: ${elapsed}ms`);
  
  // Show engine timing logs (last 3)
  const logs = await getEngineLogs(cdp);
  const relevant = logs.filter(l => l.includes('[+') || l.includes('playing') || l.includes('error') || l.includes('done'));
  relevant.slice(-5).forEach(l => console.log('  ' + l.trim()));
  return elapsed;
}

async function main() {
  console.log('═══ muisc Performance Benchmark ═══\n');
  const cdp = new CDP();
  await cdp.connect();
  console.log('✓ Connected to Muisc CDP\n');

  const results = {};

  // ── Test 1: Search → Play (cold, first click) ──
  results.searchPlay = {};
  await runTest(cdp, 'Search + Cold Play (solo, no queue)', async () => {
    // Set search input
    await cdp.eval(`(() => {
      const i = document.querySelector('input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(i, 'Never Gonna Give You Up');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);

    // Click Search button
    await cdp.eval(`(() => {
      for (const b of document.querySelectorAll('button'))
        if (b.textContent.trim() === 'Search') { b.click(); break; }
    })()`);
    await sleep(3500);

    // Click first result
    await cdp.eval(`(() => {
      const allDivs = document.querySelectorAll('div');
      for (const d of allDivs) {
        if (d.style.maxHeight === '300px') {
          if (d.children[0]) { d.children[0].click(); }
          break;
        }
      }
    })()`);

    // Poll for audio playing
    const clickTime = Date.now();
    let audioTime = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const b = await cdp.eval('document.body.innerText');
      if (b) {
        const m = b.match(/(\d+):(\d+) \/ \d+:\d+/);
        if (m) {
          const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
          if (secs > 0) { audioTime = Date.now() - clickTime; break; }
        }
      }
    }
    const engineLogs = await getEngineLogs(cdp);
    const timingLine = engineLogs.find(l => l.includes('playing')) || '';
    const match = timingLine.match(/\[\+(\d+)ms\]/);
    results.searchPlay.engineTimingMs = match ? parseInt(match[1]) : 0;
    results.searchPlay.pollTimingMs = audioTime;
    console.log(`  Engine log shows +${results.searchPlay.engineTimingMs}ms from op start`);
    console.log(`  Polling detected audio after ${audioTime}ms`);
    console.log(`  → Sub-1s: ${results.searchPlay.engineTimingMs < 1000 ? '✅ YES' : '❌ NO'}`);
  });

  // ── Test 2: Build a queue with multiple tracks ──
  results.buildQueue = {};
  await runTest(cdp, 'Build Queue (play 3 tracks via custom ID + search)', async () => {
    // Play a custom video by ID (builds queue)
    await cdp.eval(`(() => {
      const inputs = document.querySelectorAll('input');
      // Second input is custom ID field
      if (inputs.length >= 2) {
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(inputs[1], 'jNQXAC9IVRw'); // Me at the zoo (short)
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await sleep(300);
    
    // Click ▶ Play button
    await cdp.eval(`(() => {
      for (const b of document.querySelectorAll('button'))
        if (b.textContent.includes('▶ Play')) { b.click(); break; }
    })()`);
    await sleep(2000);
    
    // Now search and click another track (adds to queue)
    await cdp.eval(`(() => {
      const i = document.querySelector('input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(i, 'Rick Astley Never Gonna Give You Up');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    await cdp.eval(`(() => {
      for (const b of document.querySelectorAll('button'))
        if (b.textContent.trim() === 'Search') { b.click(); break; }
    })()`);
    await sleep(3500);
    await cdp.eval(`(() => {
      const allDivs = document.querySelectorAll('div');
      for (const d of allDivs) {
        if (d.style.maxHeight === '300px') {
          if (d.children[0]) { d.children[0].click(); }
          break;
        }
      }
    })()`);
    await sleep(2000);

    // Get queue count
    const body = await cdp.eval('document.body.innerText');
    const qMatch = body?.match(/Queue \((\d+) tracks/);
    results.buildQueue.count = qMatch ? parseInt(qMatch[1]) : 0;
    console.log(`  Queue has ${results.buildQueue.count} tracks`);
  });

  // ── Test 3: Skip to next track ──
  results.skip = {};
  await runTest(cdp, 'Skip (⏭) — warm cache', async () => {
    const skipStart = Date.now();
    await cdp.eval(`(() => {
      for (const b of document.querySelectorAll('button'))
        if (b.textContent.includes('⏭')) { b.click(); break; }
    })()`);

    let detected = 0;
    for (let i = 0; i < 15; i++) {
      await sleep(200);
      const b = await cdp.eval('document.body.innerText');
      if (b) {
        const m = b.match(/(\d+):(\d+) \/ \d+:\d+/);
        if (m) {
          const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
          if (secs > 0) { detected = Date.now() - skipStart; break; }
        }
      }
    }
    results.skip.pollMs = detected;
    const engineLogs = await getEngineLogs(cdp);
    const timingLine = engineLogs.filter(l => l.includes('[+')).slice(-1)[0] || '';
    const match = timingLine.match(/\[\+(\d+)ms\]/);
    results.skip.engineMs = match ? parseInt(match[1]) : 0;
    console.log(`  Engine: +${results.skip.engineMs}ms, Polling: ${detected}ms`);
    console.log(`  → Sub-1s: ${results.skip.engineMs < 1000 ? '✅ YES' : '❌ NO'}`);
  });

  // ── Test 4: Skip-spam (3 rapid clicks) ──
  results.skipSpam = {};
  await runTest(cdp, 'Skip-Spam (3 rapid ⏭ clicks)', async () => {
    await sleep(1000);
    const spamStart = Date.now();
    for (let c = 0; c < 3; c++) {
      await cdp.eval(`(() => {
        for (const b of document.querySelectorAll('button'))
          if (b.textContent.includes('⏭')) { b.click(); break; }
      })()`);
      await sleep(50); // rapid clicks
    }

    let lastEngineMs = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const b = await cdp.eval('document.body.innerText');
      if (b) {
        const m = b.match(/(\d+):(\d+) \/ \d+:\d+/);
        if (m) {
          const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
          if (secs > 0 && secs > 1) { // music playing for >1s
            results.skipSpam.pollMs = Date.now() - spamStart;
            const logs = await getEngineLogs(cdp);
            const timingLines = logs.filter(l => l.includes('[+'));
            const last = timingLines.slice(-1)[0] || '';
            const match = last.match(/\[\+(\d+)ms\]/);
            lastEngineMs = match ? parseInt(match[1]) : 0;
            break;
          }
        }
      }
    }
    results.skipSpam.engineMs = lastEngineMs;
    console.log(`  Engine: +${lastEngineMs}ms, Polling: ${results.skipSpam.pollMs}ms`);
    console.log(`  → Sub-1s per skip: ${lastEngineMs < 1000 ? '✅ YES' : '❌ NO'}`);
  });

  // ── Results Summary ──
  console.log('\n═══════════════════════════════════════');
  console.log('         RESULTS SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`  Cold Play (search → play):   ${results.searchPlay.engineTimingMs || '?'}ms engine / ${results.searchPlay.pollTimingMs || '?'}ms poll  ${results.searchPlay.engineTimingMs < 1000 ? '✅' : '❌'}`);
  console.log(`  Skip (warm):                  ${results.skip.engineMs || '?'}ms engine / ${results.skip.pollMs || '?'}ms poll  ${results.skip.engineMs < 1000 ? '✅' : '❌'}`);
  console.log(`  Skip-spam (3 rapid):          ${results.skipSpam.engineMs || '?'}ms engine / ${results.skipSpam.pollMs || '?'}ms poll  ${results.skipSpam.engineMs < 1000 ? '✅' : '❌'}`);
  console.log(`  Queue tracks:                 ${results.buildQueue.count}`);
  console.log('═══════════════════════════════════════\n');

  // Show proxy logs
  console.log('─── Proxy Logs (tail) ───');
  tailLogs(40).filter(l => l.includes('[Proxy]') || l.includes('[MediaResolver]') || l.includes('[yt-dlp]') || l.includes('error') || l.includes('Error'))
    .forEach(l => console.log('  ' + l.trim()));

  cdp.close();
  const allPass = results.searchPlay.engineTimingMs < 1000 && results.skip.engineMs < 1000 && results.skipSpam.engineMs < 1000;
  console.log(`\n═══ ${allPass ? 'ALL TESTS PASSED ✅' : 'SOME TESTS FAILED ❌'} ═══`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
