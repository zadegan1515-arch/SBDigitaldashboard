// scripts/test-discover.js — Brands → Discover as one clean list (Leo, Oct
// 2026: "make this cleaner … more simple and clean"). Drives public/app.html
// in Chromium against a fake /api/data: To review / Added, the source and
// category dropdowns, a row opening for the pitch and links, Add and ×,
// and the phone width.
//   NODE_PATH=$(npm root -g) node scripts/test-discover.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-discover.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();


const NAMES = ['Aéropostale', 'Blenders Eyewear', 'Lucky Energy', 'Garage Beer', 'Flerish'];
const S = { rows: [], adds: [], dismissed: [] };
function reset() {
  S.rows = NAMES.map((n, i) => ({
    id: 'd' + i, name: n, category: ['apparel', 'apparel', 'energy', 'rtd', 'electrolytes'][i],
    query: i < 4 ? 'Claude hunt · Oct 5' : 'LinkedIn: similar to Levi\'s', source: i < 4 ? 'Claude hunt' : 'LinkedIn',
    signals: i % 2 ? 'sponsors,genz' : 'midsize', status: 'new', inSystem: false, contactCount: 0, brandId: null,
    reason: 'A long reason about why ' + n + ' fits SB Agency, with a fact or two that could run past one line on a narrow screen and should be cut off neatly.',
    activation: 'Sampling at the door for ' + n + '.', website: 'https://example.com/' + i, sourceUrl: 'https://news.example.com/' + i, linkedinUrl: null,
  }));
  S.rows.push({ id: 'dx', name: 'Already Here', category: 'energy', query: 'Claude hunt · Oct 5', source: 'Claude hunt', signals: 'genz',
    status: 'added', inSystem: true, contactCount: 3, brandId: 'b9', reason: 'r', activation: null, website: null, sourceUrl: null, linkedinUrl: null });
}
reset();
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listDiscoveries: () => ({ rows: S.rows.filter((r) => !S.dismissed.includes(r.id)) }),
  addDiscoveredBrand: ({ id }) => { S.adds.push(id); return { ok: true, brandId: 'nb' + id }; },
  dismissDiscovered: ({ id }) => { S.dismissed.push(id); return { ok: true }; },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; } catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadDiscover === 'function');
  await page.evaluate(() => gotoView('discover'));
  await page.waitForSelector('#disc-body .dc-row');
  const names = () => page.$$eval('#disc-body .dc-row b', (bs) => bs.map((b) => b.textContent));

  assert.deepEqual(await names(), NAMES, 'To review lists everything not added');
  assert.match(await page.textContent('[data-dctab="review"]'), /5/);
  assert.match(await page.textContent('[data-dctab="added"]'), /1/);
  assert.equal(await page.$('#disc-q'), null, 'the old search box is gone');
  console.log('✓ one list, To review / Added');

  await page.selectOption('[data-dcsel="source"]', 'LinkedIn');
  assert.deepEqual(await names(), ['Flerish']);
  await page.selectOption('[data-dcsel="source"]', '');
  await page.selectOption('[data-dcsel="cat"]', 'apparel');
  assert.deepEqual(await names(), ['Aéropostale', 'Blenders Eyewear']);
  await page.selectOption('[data-dcsel="cat"]', '');
  console.log('✓ source and category dropdowns');

  await page.screenshot({ path: process.env.SHOT || '/dev/null' });
  await page.click('[data-disc="d0"] .dc-name');
  await page.waitForSelector('[data-disc="d0"] .dc-more');
  assert.match(await page.textContent('[data-disc="d0"] .dc-more'), /Sampling at the door/);
  assert.ok(await page.$('[data-disc="d0"] a[href="https://news.example.com/0"]'));
  console.log('✓ a row opens for the pitch and links');

  await page.click('[data-disc="d2"] [data-dcact="add"]');
  await page.waitForFunction(() => !document.querySelector('[data-disc="d2"]'));
  assert.deepEqual(S.adds, ['d2']);
  await page.click('[data-disc="d3"] [data-dcact="dismiss"]');
  await page.waitForFunction(() => !document.querySelector('[data-disc="d3"]'));
  assert.deepEqual(S.dismissed, ['d3']);
  await page.click('[data-dctab="added"]');
  assert.deepEqual(await names(), ['Lucky Energy', 'Already Here']);
  console.log('✓ Add moves a brand to Added; × dismisses');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('[data-dctab="review"]');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  console.log('✓ phone width fits');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Discover checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
