/**
 * muisc 100-Song Cold Play Stress Test
 *
 * Searches for and plays 100 different songs, measuring engine timing
 * for each one. Reports pass/fail statistics for sub-1s cold play.
 *
 * Usage: node tests/100-song-benchmark.mjs
 */

import WebSocket from 'ws';
import http from 'http';
import { execSync } from 'child_process';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

// ── 100 well-known songs across genres ──
const SONGS = [
  // Pop
  "Shape of You Ed Sheeran",
  "Blinding Lights The Weeknd",
  "Billie Jean Michael Jackson",
  "Like a Prayer Madonna",
  "Thriller Michael Jackson",
  "Bad Guy Billie Eilish",
  "Bohemian Rhapsody Queen",
  "Hotel California Eagles",
  "Smells Like Teen Spirit Nirvana",
  "Sweet Child O Mine Guns N Roses",
  "Yesterday The Beatles",
  "Hey Jude The Beatles",
  "Imagine John Lennon",
  "Purple Rain Prince",
  "Dancing Queen ABBA",
  "Mamma Mia ABBA",
  "I Will Survive Gloria Gaynor",
  "Billie Jean Michael Jackson",
  "Beat It Michael Jackson",
  "Smooth Criminal Michael Jackson",

  // Rock
  "Stairway to Heaven Led Zeppelin",
  "Back in Black AC DC",
  "Welcome to the Jungle Guns N Roses",
  "Enter Sandman Metallica",
  "Nothing Else Matters Metallica",
  "November Rain Guns N Roses",
  "Dream On Aerosmith",
  "Livin on a Prayer Bon Jovi",
  "We Will Rock You Queen",
  "Another One Bites the Dust Queen",
  "Comfortably Numb Pink Floyd",
  "Wish You Were Here Pink Floyd",
  "Whole Lotta Love Led Zeppelin",
  "Paranoid Black Sabbath",
  "Highway to Hell AC DC",
  "Thunderstruck AC DC",
  "Paint It Black Rolling Stones",
  "Satisfaction Rolling Stones",
  "Born to Run Bruce Springsteen",
  "Every Breath You Take The Police",

  // Hip Hop / R&B
  "Sicko Mode Travis Scott",
  "Gods Plan Drake",
  "Humble Kendrick Lamar",
  "Alright Kendrick Lamar",
  "Lose Yourself Eminem",
  "Stan Eminem",
  "In Da Club 50 Cent",
  "Still Dre Dr Dre",
  "California Love Tupac",
  "Juicy Notorious BIG",
  "Empire State of Mind Jay Z",
  "Hotline Bling Drake",
  "One Dance Drake",
  "DNA Kendrick Lamar",
  "Money Trees Kendrick Lamar",
  "No Role Modelz J Cole",
  "Changes Tupac",
  "Hit Em Up Tupac",
  "Gin and Juice Snoop Dogg",
  "Ms Jackson Outkast",

  // Electronic / Dance
  "Strobe Deadmau5",
  "Levels Avicii",
  "Wake Me Up Avicii",
  "Clarity Zedd",
  "Titanium David Guetta",
  "Sandstorm Darude",
  "Around the World Daft Punk",
  "Get Lucky Daft Punk",
  "One More Time Daft Punk",
  "Scary Monsters Skrillex",
  "Bangarang Skrillex",
  "Animals Martin Garrix",
  "Summertime Sadness Lana Del Rey",
  "Faded Alan Walker",
  "Alone Marshmello",
  "Happier Marshmello",
  "Lean On Major Lazer",
  "Where Are U Now Jack U",
  "Feel So Close Calvin Harris",
  "Summer Calvin Harris",

  // Indie / Alternative
  "Creep Radiohead",
  "Karma Police Radiohead",
  "Mr Brightside Killers",
  "Seven Nation Army White Stripes",
  "Take Me Out Franz Ferdinand",
  "Dog Days Are Over Florence",
  "Somebody Told Me Killers",
  "Use Somebody Kings of Leon",
  "Fix You Coldplay",
  "Yellow Coldplay",
  "Viva la Vida Coldplay",
  "Clocks Coldplay",
  "The Scientist Coldplay",
  "Bitter Sweet Symphony Verve",
  "Wonderwall Oasis",
  "Champagne Supernova Oasis",
  "Zombie Cranberries",
  "Linger Cranberries",
  "No Surprises Radiohead",
  "Fake Plastic Trees Radiohead",

  // Latin / World
  "Despacito Luis Fonsi",
  "Gasolina Daddy Yankee",
  "Danza Kuduro Don Omar",
  "La Vida Es Un Carnaval Celia Cruz",
  "Bailando Enrique Iglesias",
  "Vivir Mi Vida Marc Anthony",
  "Obsesion Aventura",
  "Propuesta Indecima Julieta Venegas",
  "El Perdon Nicky Jam",
  "Hasta el Amanecer Nicky Jam",
  "Ay Vamos J Balvin",
  "Mi Gente J Balvin",
  "Taki Taki DJ Snake",
  "I Like It Cardi B",
  "Con Calma Daddy Yankee",
  "Calma Pedro Capo",
  "Bella Ciao Música",
  "Waka Waka Shakira",
  "Hips Dont Lie Shakira",
  "Whenever Wherever Shakira",
];

// ── CDP Client ──

class CDP {
  #id = 0; #pending = new Map(); #ws = null;
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
            if (msg.id && this.#pending.has(msg.id)) { this.#pending.get(msg.id)(msg); this.#pending.delete(msg.id); }
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

function getProxyLogs() {
  try {
    const out = execSync('cat /tmp/muisc-dev.log 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

async function getEngineLogs(cdp) {
  const body = await cdp.eval('document.body.innerText');
  return body?.split('\n').filter(l => l.includes('[engine]')) || [];
}

async function getLastEngineTiming(cdp) {
  const logs = await getEngineLogs(cdp);
  const playingLine = logs.filter(l => l.includes('playing')).slice(-1)[0] || '';
  const match = playingLine.match(/\[\+(\d+)ms\]/);
  return match ? parseInt(match[1]) : null;
}

// ── Main ──

async function main() {
  console.log('═══ MUISC 100-SONG COLD PLAY STRESS TEST ═══\n');
  console.log(`Testing ${SONGS.length} songs...\n`);

  const cdp = new CDP();
  await cdp.connect();
  console.log('✓ Connected to Muisc CDP\n');

  const results = { passes: 0, failures: 0, errors: 0, timings: [] };
  const startTime = Date.now();

  for (let i = 0; i < SONGS.length; i++) {
    const query = SONGS[i];
    const num = i + 1;
    process.stdout.write(`  [${num}/${SONGS.length}] "${query}"... `);

    try {
      // ── Clear search input ──
      await cdp.eval(`(() => {
        const inputs = document.querySelectorAll('input');
        if (inputs.length > 0) {
          const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          s.call(inputs[0], '');
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`);
      await sleep(50);

      // ── Type search query ──
      await cdp.eval(`(() => {
        const inputs = document.querySelectorAll('input');
        if (inputs.length > 0) {
          const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          s.call(inputs[0], ${JSON.stringify(query)});
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`);
      await sleep(100);

      // ── Click Search button ──
      await cdp.eval(`(() => {
        for (const b of document.querySelectorAll('button'))
          if (b.textContent.trim() === 'Search') { b.click(); break; }
      })()`);

      // ── Wait for results to appear (poll for search divs) ──
      let foundResults = false;
      for (let w = 0; w < 30; w++) {
        await sleep(200);
        const hasResults = await cdp.eval(`document.querySelectorAll('div[style*="max-height: 300px"]').length > 0`);
        if (hasResults) { foundResults = true; break; }
      }
      if (!foundResults) {
        console.log(`⏰ no results after 6s`);
        results.errors++;
        continue;
      }

      // ── Click first result ──
      await cdp.eval(`(() => {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
          if (d.style.maxHeight === '300px') {
            if (d.children[0]) { d.children[0].click(); }
            break;
          }
        }
      })()`);

      // ── Poll for engine playing event ──
      let timing = null;
      for (let w = 0; w < 30; w++) {
        await sleep(200);
        timing = await getLastEngineTiming(cdp);
        if (timing !== null && timing > 0) break;
      }

      if (timing === null) {
        console.log(`no timing`);
        results.errors++;
        continue;
      }

      results.timings.push(timing);
      const pass = timing < 1000;
      if (pass) results.passes++;
      else results.failures++;

      const pct = (pass ? '✅' : '❌');
      const elapsed = Date.now() - startTime;
      const avgMs = Math.round(elapsed / (i + 1));
      process.stdout.write(`${pct} +${timing}ms  [avg ${avgMs}ms/song, ${Math.round(elapsed/1000)}s total]\n`);

      // ── Let engine play for a moment before next song ──
      await sleep(800);

    } catch (err) {
      console.log(`💥 ${err.message}`);
      results.errors++;
    }

    // Every 10 songs, show a status summary
    if ((i + 1) % 10 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const passRate = Math.round((results.passes / (results.passes + results.failures)) * 100);
      console.log(`  --- Status: ${results.passes}✅ ${results.failures}❌ ${results.errors}💥 | ${passRate}% pass rate | ${elapsed}s elapsed ---\n`);
    }
  }

  // ── Final Results ──
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const attempted = results.passes + results.failures;
  const passRate = attempted > 0 ? Math.round((results.passes / attempted) * 100) : 0;

  console.log('\n═══════════════════════════════════════');
  console.log('          100-SONG RESULTS');
  console.log('═══════════════════════════════════════');
  console.log(`  Total time:   ${totalTime}s (${Math.round(totalTime / 60)}min ${totalTime % 60}s)`);
  console.log(`  Pass (<1s):   ${results.passes}`);
  console.log(`  Fail (≥1s):   ${results.failures}`);
  console.log(`  Errors:       ${results.errors}`);
  console.log(`  Pass rate:    ${passRate}%`);

  if (results.timings.length > 0) {
    const sorted = [...results.timings].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const median = sorted.length % 2 === 0
      ? Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      : sorted[Math.floor(sorted.length / 2)];
    console.log(`\n  Timing stats (ms):`);
    console.log(`    min:    ${min}ms`);
    console.log(`    median: ${median}ms`);
    console.log(`    avg:    ${avg}ms`);
    console.log(`    max:    ${max}ms`);
    console.log(`    p95:    ${sorted[Math.floor(sorted.length * 0.95)]}ms`);

    const histogram = {};
    for (const t of results.timings) {
      const bucket = Math.floor(t / 200) * 200;
      histogram[bucket] = (histogram[bucket] || 0) + 1;
    }
    console.log(`\n  Histogram:`);
    for (const [bucket, count] of Object.entries(histogram).sort((a, b) => a[0] - b[0])) {
      const bar = '█'.repeat(Math.min(count, 30));
      console.log(`    ${bucket.padStart(5)}-${+bucket + 199}ms: ${bar} ${count}`);
    }
  }

  console.log('\n─── Proxy Logs (last 30) ───');
  const logs = getProxyLogs();
  logs.filter(l => l.includes('[Chunk buffered]') || l.includes('[Chunk START]') || l.includes('[Prewarm HIT]') || l.includes('[Prewarm MISS]') || l.includes('[Proxy] HANDLER') || l.includes('[yt-dlp-daemon] RESOLVE_DETAIL') || l.includes('error') || l.includes('Error'))
    .slice(-60).forEach(l => console.log('  ' + l.trim()));

  cdp.close();

  const allPass = results.failures === 0 && results.errors === 0;
  console.log(`\n═══ ${allPass ? 'ALL 100 SONGS PASSED ✅' : `${results.passes}/${SONGS.length} PASSED`} ═══`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
