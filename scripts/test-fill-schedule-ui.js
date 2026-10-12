// scripts/test-fill-schedule-ui.js — Outreach → People → Fill schedule. Drives
// public/app.html in Chromium against a fake /api/data: the card draws the days
// (today first, open), names each brand with its fit and why, the floor is sent
// and remembered, and a brand opens its page.
//   NODE_PATH=$(npm root -g) node scripts/test-fill-schedule-ui.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-fill-schedule-ui.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const row = (i, extra) => Object.assign({ brandId: 'b' + i, name: 'Brand ' + i, category: 'energy', fit: 90 - i, contacts: 2, research: false, why: 'No buyer on file' }, extra || {});
const sched = (minFit) => ({
  today: '2026-10-12', doneToday: 40, perDay: 100, minFit, focus: 'electrolyte', total: 3,
  belowFit: 12, resting: 30, underCap: 80, planned: 1, research: 1, reachedLast: 0, giantsLast: 0,
  days: [
    { day: '2026-10-12', label: 'Mon, Oct 12', rows: [row(1, { why: 'On the Schedule Wed, Oct 14, short on people' }), row(2)] },
    { day: '2026-10-13', label: 'Tue, Oct 13', rows: [row(3, { brandId: null, name: 'Liquid Lab', fit: null, research: true, why: 'Research list · Electrolytes' })] },
  ],
});
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  linkedinPeople: () => ({ brands: [], pageReview: [], zachList: [], zachDone: [], runs: [] }),
  liCleanup: () => ({ people: [], brands: [] }),
  fillSchedule: (a) => sched(a.minFit),
  getBrand: () => { throw new Error('no brand in this test'); },
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadLinkedin === 'function');
  await page.evaluate(() => loadLinkedin());
  await page.waitForSelector('#li-sched [data-fsday]');

  const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);
  assert.equal(last('fillSchedule').args.minFit, 60, 'the script’s default floor');
  const text = await page.textContent('#li-sched');
  assert.ok(/3 brands · about 2 days at 100 a day/.test(text), text);
  assert.ok(/40 read today already/.test(text) && /12 under Fit 60 left out/.test(text), text);
  assert.ok(await page.$eval('[data-fsday="2026-10-12"]', (d) => d.open), 'today open');
  assert.ok(!(await page.$eval('[data-fsday="2026-10-13"]', (d) => d.open)), 'later days folded');
  assert.ok(/Today · Mon, Oct 12/.test(text) && /Tomorrow · Tue, Oct 13/.test(text), text);
  assert.ok(/Brand 1.*Fit 89.*On the Schedule Wed, Oct 14/.test(text), text);
  console.log('✓ days, today open, fit and why on each brand');

  await page.fill('[data-fsfit]', '75');
  await page.dispatchEvent('[data-fsfit]', 'change');
  await page.waitForFunction(() => document.querySelector('[data-fsfit]') && document.querySelector('[data-fsfit]').value === '75');
  assert.equal(last('fillSchedule').args.minFit, 75);
  assert.equal(await page.evaluate(() => localStorage.getItem('sb.fillFit')), '75');
  console.log('✓ the floor is sent and remembered');

  await page.screenshot({ path: process.env.SHOT || path.join(require('os').tmpdir(), 'fill-schedule.png'), fullPage: false, clip: await page.$eval('#li-sched', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, width: r.width, height: Math.min(r.height, 600) }; }) }).catch(() => {});
  await page.click('#li-sched [data-brand="b2"]');
  for (let i = 0; i < 50 && !calls.some((c) => c.fn === 'getBrand'); i++) await page.waitForTimeout(100);
  assert.ok(JSON.stringify(last('getBrand').args).includes('b2'), 'a brand opens its page');
  console.log('✓ a brand opens its page');
  assert.deepEqual(errors.filter((m) => !/no brand in this test/.test(m)), []);

  await browser.close();
  server.close();
  console.log('fill schedule page: all passed');
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
