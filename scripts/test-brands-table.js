// scripts/test-brands-table.js — Brands → All brands as one table (Leo,
// Oct 2026). Drives public/app.html in Chromium against a fake /api/data:
// buyer counts and the Needs people / Has enough filters, sort, search
// (name or also-known-as), a row opening to edit (saves on change), adding
// a person, and the phone width (no sideways page scroll).
//   NODE_PATH=$(npm root -g) node scripts/test-brands-table.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-brands-table.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();

function row(id, name, buyers, people, extra) {
  return Object.assign({
    id, name, category: 'energy', tier: 'growth', passedAt: null, aka: null, website: null, linkedinUrl: null, notes: null,
    source: 'manual', createdAt: NOW, contacts: [], _count: { contacts: people, targets: 0 },
    buyers: { partnerships: buyers, events: 0, marketing: 0, founder: 0, total: buyers },
    buyerPeople: Array.from({ length: buyers }, (_, i) => ({ id: id + 'p' + i, name: 'Buyer ' + i, title: 'Partnerships Manager', kind: 'partnerships', email: true, linkedin: true })),
    withEmail: buyers, withLinkedin: people, outreach: {},
  }, extra || {});
}

const S = { list: [], saves: [], adds: [] };
function reset() {
  S.list = [
    row('b1', 'Alpha Energy', 0, 4, { aka: 'Alpha Co' }),
    row('b2', 'Bravo Soda', 2, 6, { category: 'beverage' }),
    row('b3', 'Charlie Spirits', 1, 1, { category: 'spirits', outreach: { lastSentAt: NOW, invited: 1 } }),
    row('b4', 'Delta Gone', 0, 0, { passedAt: NOW }),
  ];
}
reset();

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listBrands: () => S.list,
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  findDuplicates: () => ({ groups: [] }),
  updateBrand: (a) => { S.saves.push(a); return { ok: true }; },
  upsertContact: (a) => {
    S.adds.push(a);
    const b = S.list.find((x) => x.id === a.brandId);
    b._count.contacts += 1;
    b.buyers.total += 1; b.buyers.partnerships += 1;
    b.buyerPeople.push({ id: 'n' + S.adds.length, name: a.name, title: a.title, kind: 'partnerships', email: !!a.email, linkedin: !!a.linkedinUrl });
    return { id: 'n' + S.adds.length };
  },
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
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadBrands === 'function');
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');

  const names = () => page.$$eval('#brands-list [data-brow]', (rs) => rs.map((r) => r.getAttribute('data-name')));

  // Sub-tabs: Stock take and Needs contacts folded in, still reachable.
  const tabs = await page.$$eval('#sub-tabs .nav-item', (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(tabs, ['All brands', 'Discover']);
  assert.ok(await page.$('#bq-stock') && await page.$('#bq-needs'), 'lanes and worklist buttons');
  console.log('✓ one Brands page; lanes / worklist are buttons');

  // Leo, Oct 2026 ("too much going on"): tools in one More menu, one
  // category dropdown, Brand / Category / Tier / Fit / Buyers only, and
  // archived hidden by default.
  assert.ok(await page.isHidden('#bq-dups'), 'tools sit in the More menu');
  await page.click('#bq-more > summary');
  assert.ok(await page.isVisible('#bq-dups') && await page.isVisible('#bq-fittools'));
  await page.click('#bq-more > summary');
  assert.ok(await page.isHidden('#brand-cat-chips'), 'no chip row');
  assert.ok(await page.$('#brands-list [data-brcat]'), 'one category dropdown');
  const heads = await page.$$eval('#brands-list thead th', (ts) => ts.map((t) => t.textContent.trim()).filter(Boolean));
  assert.deepEqual(heads, ['Brand', 'Category', 'Tier', 'Fit', 'Buyers']);
  assert.deepEqual(await names(), ['Alpha Energy', 'Charlie Spirits', 'Bravo Soda'], 'archived hidden by default');
  await page.uncheck('[data-brarch]');
  console.log('✓ More menu, category dropdown, five columns, archived hidden by default');

  // Default sort: fewest buyers first, archived last.
  assert.deepEqual(await names(), ['Alpha Energy', 'Charlie Spirits', 'Bravo Soda', 'Delta Gone']);
  assert.match(await page.textContent('#brands-sub'), /2 have a marketing \/ partnerships person on file · 2 still need one/);
  assert.match(await page.textContent('[data-brow="b1"] .br-buy'), /0/);
  assert.ok(await page.$('[data-brow="b1"] .br-buy.low') && await page.$('[data-brow="b2"] .br-buy.ok'));
  console.log('✓ buyer counts, fewest first, archived last');

  await page.click('[data-brshow="need"]');
  assert.deepEqual(await names(), ['Alpha Energy', 'Delta Gone']);
  await page.check('[data-brarch]');
  assert.deepEqual(await names(), ['Alpha Energy']);
  await page.uncheck('[data-brarch]');
  await page.click('[data-brshow="enough"]');
  assert.deepEqual(await names(), ['Charlie Spirits', 'Bravo Soda']);
  await page.click('[data-brshow="all"]');
  await page.selectOption('[data-brsort]', 'most');
  assert.deepEqual(await names(), ['Bravo Soda', 'Charlie Spirits', 'Alpha Energy', 'Delta Gone']);
  await page.selectOption('[data-brsort]', 'fewest');
  console.log('✓ Needs people / Has enough / Hide archived / sort');

  await page.fill('#bq', 'alpha co');
  assert.deepEqual(await names(), ['Alpha Energy'], 'search matches also-known-as');
  await page.fill('#bq', '');
  assert.equal((await names()).length, 4);
  console.log('✓ search by name or also-known-as');

  // A row opens to edit; edits save on change.
  await page.click('[data-brow="b1"] .br-cat');
  await page.waitForSelector('[data-bropen="b1"]');
  await page.selectOption('[data-bropen="b1"] [data-bredit="category"]', 'electrolytes');
  await page.waitForFunction(() => document.querySelector('[data-brow="b1"] .br-cat').textContent === 'Electrolytes & Hydration');
  await page.fill('[data-bropen="b1"] [data-bredit="website"]', 'alpha.com');
  await page.press('[data-bropen="b1"] [data-bredit="website"]', 'Tab');
  await page.fill('[data-bropen="b1"] [data-bredit="notes"]', 'Met at expo');
  await page.click('[data-bropen="b1"] .br-h');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(S.saves, [
    { brandId: 'b1', category: 'electrolytes' },
    { brandId: 'b1', website: 'alpha.com' },
    { brandId: 'b1', notes: 'Met at expo' },
  ]);
  console.log('✓ a row opens to edit; category, website, notes save on change');

  // Add a person: Enter adds, list reloads, the row stays open, count goes up.
  await page.fill('[data-bropen="b1"] [data-bradd="name"]', 'Pat Lee');
  await page.fill('[data-bropen="b1"] [data-bradd="title"]', 'Brand Partnerships Manager');
  await page.fill('[data-bropen="b1"] [data-bradd="email"]', 'not-an-email');
  await page.click('[data-bropen="b1"] [data-bract="add"]');
  assert.equal(S.adds.length, 0, 'a bad email is refused before saving');
  await page.fill('[data-bropen="b1"] [data-bradd="email"]', 'pat@alpha.com');
  await page.press('[data-bropen="b1"] [data-bradd="email"]', 'Enter');
  await page.waitForFunction(() => /Pat Lee/.test((document.querySelector('[data-bropen="b1"]') || {}).textContent || ''));
  assert.deepEqual(S.adds[0], { brandId: 'b1', name: 'Pat Lee', title: 'Brand Partnerships Manager', email: 'pat@alpha.com', linkedinUrl: null });
  assert.match(await page.textContent('[data-brow="b1"] .br-buy'), /1/);
  console.log('✓ add a person from the row; the count updates and the row stays open');

  // The category dropdown switches the list.
  await page.selectOption('#brands-list [data-brcat]', 'energy');
  await page.waitForFunction(() => /Energy/.test(document.getElementById('brands-title').textContent));
  assert.equal(await page.$eval('#brands-list [data-brcat]', (s) => s.value), 'energy');
  await page.selectOption('#brands-list [data-brcat]', 'all');
  await page.waitForFunction(() => document.getElementById('brands-title').textContent === 'All brands');
  console.log('✓ the category dropdown switches the list');

  if (process.env.BRANDS_SHOT) await page.screenshot({ path: process.env.BRANDS_SHOT });

  // The name opens the brand page.
  await page.click('[data-brow="b2"] .br-link');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  console.log('✓ the brand name opens the full brand page');

  // Phone width: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  console.log('✓ phone width fits');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Brands table checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
