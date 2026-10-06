// scripts/test-brands-table.js — Brands → All brands as one table (Leo,
// Oct 2026). Drives public/app.html in Chromium against a fake /api/data:
// buyer counts and the Needs people / Has enough filters, sort, search
// (name or also-known-as), a row opening to edit (saves on change), adding
// a person, the "Every brand a marketing / partnerships person" card
// (counts by reason, Show them, Pick their pages, the folded SponsorUnited
// sweep card), and the phone width (no sideways page scroll).
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

  // Default sort: fewest buyers first, archived last.
  assert.deepEqual(await names(), ['Alpha Energy', 'Charlie Spirits', 'Bravo Soda', 'Delta Gone']);
  // Counted over the brands in play: archived Delta Gone needs nobody.
  assert.match(await page.textContent('#brands-sub'), /^3 brands in play \(\+1 archived\) · 2 have a marketing \/ partnerships person on file · 1 still need one$/);
  assert.match(await page.textContent('[data-brow="b1"] .br-buy'), /0/);
  assert.ok(await page.$('[data-brow="b1"] .br-buy.low') && await page.$('[data-brow="b2"] .br-buy.ok'));
  console.log('✓ buyer counts, fewest first, archived last');

  await page.click('[data-brshow="need"]');
  assert.deepEqual(await names(), ['Alpha Energy'], 'an archived brand never needs people');
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

  // The name opens the brand page.
  await page.click('[data-brow="b2"] .br-link');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  console.log('✓ the brand name opens the full brand page');

  // Every brand a marketing / partnerships person (coverage.ts): counts
  // from the rows' `cover`, this week and the last LinkedIn run from
  // buyerCoverage; Show them = Needs people narrowed to that reason.
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  S.list = [
    row('c1', 'Next One', 0, 2, { cover: { state: 'next' } }),
    row('c2', 'Next Two', 0, 0, { cover: { state: 'next' } }),
    row('c3', 'Page Pick', 0, 0, { cover: { state: 'page' } }),
    row('c4', 'Rest Co', 0, 5, { cover: { state: 'resting', note: 'big company (173 people) — nobody new in its partnerships, sponsorship, brand manager, marketing searches', at: '2026-09-30T20:00:00.000Z', back: '2026-10-30T20:00:00.000Z' } }),
    row('c5', 'Covered Co', 2, 4, { cover: { state: 'covered' } }),
    row('c6', 'Gone Co', 0, 0, { passedAt: NOW, cover: { state: 'off' } }),
  ];
  H.buyerCoverage = () => ({
    target: 1, perDay: 100, week: { linkedin: 11, sponsorunited: 3, other: 1 }, coveredWeek: 4, latestScript: '1.28',
    run: { startedAt: ago(3), lastAt: ago(3), status: 'stopped', brands: 6, added: 11, script: '1.25' },
  });
  H.fillProgress = () => ({
    resting: 18, restDays: 14, cap: 25, brands: 486, atCap: 29, under: 457, underNoId: 437, empty: 200, peopleOnFile: 3999,
    roomReachable: 38, addedToday: 3, addedWeek: 3, lastAt: NOW, lastBrand: 'Knox Hydrate', nextUp: [],
  });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForFunction(() => /15 people added this week/.test(document.getElementById('cover-card').textContent));
  const card = await page.textContent('#cover-card');
  assert.match(card, /Every brand a marketing \/ partnerships person\s*1 of 5 brands in play/);
  assert.match(card, /\+4 brands got one this week/);
  assert.match(card, /15 people added this week: 11 from LinkedIn · 3 from SponsorUnited · 1 by hand/);
  assert.deepEqual(
    await page.$$eval('#cover-card [data-cvrow]', (rs) => rs.map((r) => r.getAttribute('data-cvrow') + ':' + r.querySelector('.cv-n').textContent)),
    ['next:2', 'page:1', 'resting:1'], 'one row per reason, empty reasons left out');
  assert.match(card, /About 1 day at 100 a day/);
  assert.match(card, /back on the fill’s list from Oct 30/);
  assert.ok(await page.$('#cover-card [data-cvrow="next"] a[href="https://www.linkedin.com/feed/#sb-fill"]'), 'Start the LinkedIn fill');
  assert.match(card, /Last LinkedIn run \w{3} \d{1,2} · 6 brands · \+11 people · nothing since/);
  assert.match(card, /that run used script 1\.25, 1\.28 is out/);
  assert.ok(await page.$('#cover-card .cv-run.warn'), 'an idle fill and an old script are flagged');
  assert.equal(await page.textContent('#brands-sub'), '5 brands in play (+1 archived) · 1 have a marketing / partnerships person on file · 4 still need one');
  console.log('✓ the coverage card: counts by reason, this week, the last LinkedIn run');

  await page.click('#cover-card [data-cvshow="resting"]');
  assert.deepEqual(await names(), ['Rest Co']);
  const restLine = await page.textContent('[data-brow="c4"] .br-cvl');
  assert.match(restLine, /^LinkedIn Sep 30: big company \(173 people\) — nobody new in its partnerships/);
  assert.match(restLine, /… · back on the fill Oct 30$/, 'a long note is cut short; the whole note is in the tooltip');
  assert.deepEqual(await page.$$eval('#brands-list [data-brwhy]', (cs) => cs.map((c) => c.textContent)),
    ['Any reason4', 'Next in the LinkedIn fill2', 'Pick their LinkedIn page1', 'LinkedIn found nobody1']);
  await page.click('#brands-list [data-brwhy=""]');
  assert.deepEqual((await names()).sort(), ['Next One', 'Next Two', 'Page Pick', 'Rest Co'], 'archived Gone Co needs nobody');
  assert.equal(await page.$('[data-brow="c1"] .br-cvl'), null, 'next in the fill: nothing to say on the row');
  await page.click('#brands-list [data-brwhy="page"]');
  assert.deepEqual(await names(), ['Page Pick']);
  assert.match(await page.textContent('[data-brow="c3"] .br-cvl'), /No clear LinkedIn page — pick it/);
  await page.click('[data-brshow="all"]');
  assert.equal(await page.$('#brands-list [data-brwhy]'), null, 'the reasons show under Needs people only');
  console.log('✓ Show them: Needs people narrowed to that reason; each row says why');

  // The SponsorUnited sweep card: one line, opens as it was.
  const fold = await page.textContent('#fill-progress details:not([open]) summary');
  assert.equal(fold, 'SponsorUnited sweep · 29 of 486 brands at 25 people · +3 people today');
  await page.click('#fill-progress summary');
  await page.waitForFunction(() => /Filling to 25 people per brand/.test(document.querySelector('#fill-progress details[open]').textContent));
  console.log('✓ the SponsorUnited sweep card is folded to one line and opens as it was');

  // "pick it" (and the card's Pick their pages) → Outreach → People's
  // "Which LinkedIn page is theirs?".
  H.linkedinPeople = () => ({
    brands: [], runs: [], latestScript: '1.28', liOwner: null,
    pageReview: [{ brandId: 'c3', name: 'Page Pick', category: 'energy', website: null, at: NOW, why: 'unclear', saved: null, pageIndustry: null, candidates: [] }],
  });
  H.liCleanup = () => ({ people: [], brands: [] });
  await page.click('#brands-list [data-brshow="need"]');
  await page.click('#brands-list [data-brwhy="page"]');
  await page.click('[data-brow="c3"] [data-bract="pickpage"]');
  await page.waitForFunction(() => document.getElementById('linkedin').classList.contains('active'));
  await page.waitForFunction(() => /Which LinkedIn page is theirs\?/.test(document.getElementById('li-review').textContent));
  console.log('✓ "pick it" opens Outreach → People on the page-picking card');

  // Phone width: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');
  await page.waitForSelector('#cover-card .cv-card');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  console.log('✓ phone width fits');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Brands table checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
