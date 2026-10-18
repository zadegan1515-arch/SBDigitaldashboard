// scripts/test-reach-filter.js — the Outreach filter (Leo, Oct 18 2026:
// "anywhere on the site where i sort brands … a filter [for] outreached to,
// meaning that we have sent a request to at least one person there").
// Drives public/app.html in Chromium against a fake /api/data. Every brand
// list with filters has the same dropdown — Any / Reached out (N) / Not
// reached out (N) — and it shows exactly the brands with (or without) a
// LinkedIn invite to someone there:
//   1. Brands → All brands (buttons there; with Hide archived, Show, the
//      Outreach column, headings that sort, Showing N of M and Clear filters)
//   2. Outreach → People (with its chips and the filter box)
//   3. Brands → Stock take (a lane's brand list and its count)
//   4. Brands → Discover (the Added tab; a tab change resets it)
//   5. Outreach → Week plan → browse a category (Add the top N follows it)
//   6. Outreach → Schedule → a category's drill-in (an email alone isn't
//      "reached out")
//   NODE_PATH=$(npm root -g) node scripts/test-reach-filter.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-reach-filter.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();

function brandRow(id, name, buyers, invited, extra) {
  return Object.assign({
    id, name, category: 'energy', tier: 'growth', passedAt: null, aka: null, website: null, linkedinUrl: null, notes: null,
    source: 'manual', createdAt: NOW, contacts: [], _count: { contacts: buyers + 1, targets: invited },
    buyers: { partnerships: buyers, events: 0, marketing: 0, founder: 0, total: buyers }, buyerPeople: [],
    withEmail: 0, withLinkedin: 0, outreach: invited ? { invited, lastSentAt: NOW } : { invited: 0 },
  }, extra || {});
}
const BRANDS = [
  brandRow('b1', 'Alpha Energy', 0, 0),
  brandRow('b2', 'Bravo Soda', 2, 2),
  brandRow('b3', 'Charlie Spirits', 1, 1),
  brandRow('b4', 'Delta Gone', 0, 1, { passedAt: NOW }),
];

const PEOPLE = [
  { id: 'l1', name: 'Lime Co', category: 'energy', tier: 'growth', linkedinUrl: null, archived: false, doNotEmail: false, invited: 0, liNote: null, contacts: [] },
  { id: 'l2', name: 'Mango Co', category: 'energy', tier: 'growth', linkedinUrl: null, archived: false, doNotEmail: false, invited: 2, liNote: null,
    contacts: [{ id: 'c1', name: 'Pat Doe', title: 'Brand Partnerships', linkedinUrl: 'https://www.linkedin.com/in/pat', status: 'sent', shelved: false }] },
  { id: 'l3', name: 'Nectar Co', category: 'energy', tier: 'growth', linkedinUrl: null, archived: false, doNotEmail: false, invited: 0, liNote: null,
    contacts: [{ id: 'c2', name: 'Sam Roe', title: 'CMO', linkedinUrl: 'https://www.linkedin.com/in/sam', status: 'queued', shelved: false }] },
];

const sb = (id, name, state, invited) => ({ id, name, category: 'energy', tier: 'growth', state, people: 3, invited, accepted: 0, emailed: 0, replied: 0, queued: 0, dealStage: null, archived: false, doNotEmail: false, linkedinUrl: null });
const STOCK = {
  goal: 15, refile: 0, lastRefile: null,
  totals: { business: 0, replied: 0, reached: 1, ready: 1, needs: 1, off: 0, total: 3, people: 9, under25: 3, noProfile: 0, touched: 1, small: 0, categories: 1 },
  lanes: [{
    key: 'energy', name: 'Energy', file: 'energy', priority: true, ageGate: null, ideas: [], ideaNotes: {},
    counts: { total: 3, needs: 1, ready: 1, reached: 1, replied: 0, business: 0, off: 0 },
    brands: [sb('s1', 'Sent Energy', 'reached', 2), sb('s2', 'Ready Energy', 'ready', 0), sb('s3', 'Empty Energy', 'needs', 0)],
  }],
  others: [],
};

const fit = (score) => ({ score, grade: 'B', reasons: [] });
const DISC = [
  { id: 'd0', name: 'New Find', category: 'energy', query: 'Claude hunt · Oct 5', source: 'Claude hunt', signals: 'genz', status: 'new', inSystem: false, contactCount: 0, brandId: null, reached: false, reason: 'r', grade: { grade: 'A', score: 70, word: 'w', reasons: [] } },
  { id: 'd1', name: 'Added Reached', category: 'energy', query: 'Claude hunt · Oct 5', source: 'Claude hunt', signals: 'genz', status: 'added', inSystem: true, contactCount: 4, brandId: 'x1', reached: true, reason: 'r', grade: { grade: 'B', score: 55, word: 'w', reasons: [] } },
  { id: 'd2', name: 'Added Waiting', category: 'energy', query: 'Claude hunt · Oct 5', source: 'Claude hunt', signals: 'genz', status: 'added', inSystem: true, contactCount: 2, brandId: 'x2', reached: false, reason: 'r', grade: { grade: 'B', score: 52, word: 'w', reasons: [] } },
];

const label = { kind: 'ready', reachable: 3, need: 3, onFile: 3 };
const WEEK = {
  category: 'energy', date: '2026-10-20', setAside: 0, total: 3, brands: [
    { id: 'w1', name: 'Wave One', category: 'energy', label, action: 'add', text: '3 would go out', going: 3, fit: fit(80), invited: false },
    { id: 'w2', name: 'Wave Two', category: 'energy', label, action: 'addAnyway', status: 'reached', text: 'Invited Oct 1 · already reached', going: 3, fit: fit(75), invited: true },
    { id: 'w3', name: 'Wave Three', category: 'energy', label, action: 'add', text: '3 would go out', going: 3, fit: fit(60), invited: false },
  ],
};

const DRILL = {
  category: 'energy', brands: [
    { id: 'k1', name: 'Kilo Ready', tier: 'growth', label, group: 'notReached', invited: false, outreach: { stage: null, detail: '' }, queued: 0 },
    { id: 'k2', name: 'Kilo Invited', tier: 'growth', label, group: 'reached', invited: true, outreach: { stage: 'invited', detail: 'Oct 1 · 2 people' }, queued: 0 },
    { id: 'k3', name: 'Kilo Emailed', tier: 'growth', label, group: 'reached', invited: false, outreach: { stage: 'emailed', detail: 'Sep 2 · 1 person' }, queued: 0 },
  ],
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listBrands: () => BRANDS,
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  findDuplicates: () => ({ groups: [] }),
  suMatchQueue: () => ({ proposals: [], missing: 0, capturePending: 0 }),
  linkedinPeople: () => ({ brands: PEOPLE, pageReview: [], zachList: [], zachDone: [], runs: [] }),
  liCleanup: () => ({ people: [], brands: [] }),
  fillSchedule: () => ({ days: [], total: 0, perDay: 100, minFit: 50 }),
  brandStock: () => STOCK,
  // Stock take's Brand Fit panel.
  fitArchive: () => ({ brands: [], last: null }),
  researchList: () => ({ scope: 'schedule', total: 0, shown: 0, scheduled: 0, rows: [], text: '' }),
  researchImport: () => ({ rows: [], unmatched: [], errors: [], staged: null, last: null }),
  listDiscoveries: () => ({ rows: DISC, bulkUndo: null }),
  categoryBrands: () => DRILL,
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
  await page.waitForFunction(() => typeof window.loadBrands === 'function' && typeof window.reachSelect === 'function');

  // The dropdown's options as [value, text] pairs.
  const opts = (sel) => page.$$eval(sel + ' option', (os) => os.map((o) => [o.value, o.textContent]));
  const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

  // 1. All brands --------------------------------------------------------
  // Oct 18 2026 ("too hard to look at"): here the filter is a row of
  // buttons in the filter panel, with a "Showing N of M" line and Clear.
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');
  const brNames = () => page.$$eval('#brands-list [data-brow]', (rs) => rs.map((r) => r.getAttribute('data-name')));
  const segs = () => page.$$eval('#brands-list [data-brreach]', (bs) => bs.map((b) => [b.getAttribute('data-brreach'), b.textContent, b.classList.contains('on')]));
  const shown = async () => (await page.textContent('#brands-list .br-count')).replace(/\s+/g, ' ').trim();
  assert.deepEqual(await segs(), [['', 'Any', true], ['yes', 'Reached out2', false], ['no', 'Not reached out1', false]], 'counts what Hide archived leaves');
  assert.match(await page.getAttribute('#brands-list .br-grp[title]', 'title'), /LinkedIn invite went to at least one person/);
  assert.equal(await shown(), 'Showing 3 of 4 brands', 'no Clear while nothing is filtered');
  await page.click('#brands-list [data-brreach="yes"]');
  assert.deepEqual(await brNames(), ['Charlie Spirits', 'Bravo Soda'], 'only brands with an invite out');
  assert.equal(await shown(), 'Showing 2 of 4 brandsClear filters');
  assert.match(await page.textContent('[data-brow="b3"] .br-out'), /Reached out · 1 person/, 'the Outreach column says so');
  await page.click('#brands-list [data-brreach="no"]');
  assert.deepEqual(await brNames(), ['Alpha Energy']);
  assert.match(await page.textContent('[data-brow="b1"] .br-out'), /Not yet/);
  await page.uncheck('[data-brarch]');
  assert.deepEqual((await segs()).map((x) => x[2]), [false, false, true], 'the choice holds through a redraw');
  assert.deepEqual((await segs()).map((x) => x[1]), ['Any', 'Reached out3', 'Not reached out1'], 'archived counted once shown');
  await page.click('#brands-list [data-brreach="yes"]');
  assert.deepEqual(await brNames(), ['Charlie Spirits', 'Bravo Soda', 'Delta Gone']);
  await page.click('#brands-list [data-brshow="enough"]');
  assert.deepEqual(await brNames(), ['Charlie Spirits', 'Bravo Soda'], 'with the Has enough button');
  // A heading sorts: Brand = A–Z, Buyers flips fewest / most.
  await page.click('#brands-list th[data-brsorth="name"]');
  assert.equal(await page.$eval('[data-brsort]', (s) => s.value), 'name', 'the Sort menu follows');
  assert.deepEqual(await brNames(), ['Bravo Soda', 'Charlie Spirits']);
  await page.click('#brands-list th[data-brsorth="buyers"]');
  assert.equal(await page.$eval('[data-brsort]', (s) => s.value), 'fewest');
  await page.click('#brands-list th[data-brsorth="buyers"]');
  assert.equal(await page.$eval('[data-brsort]', (s) => s.value), 'most');
  assert.deepEqual(await brNames(), ['Bravo Soda', 'Charlie Spirits']);
  assert.match(await page.textContent('#brands-list th.sorted'), /Buyers▼/);
  await page.selectOption('[data-brsort]', 'fewest');
  // Clear filters: Show, Outreach and the search box back to all.
  await page.fill('#bq', 'zzz');
  assert.match(await page.textContent('#brands-list .empty'), /No brands match/);
  await page.click('#brands-list .empty [data-brclear]');
  assert.equal(await page.inputValue('#bq'), '');
  assert.deepEqual((await segs()).map((x) => x[2]), [true, false, false]);
  assert.equal((await brNames()).length, 4);
  assert.equal(await shown(), 'Showing 4 of 4 brands');
  console.log('✓ 1 All brands: Reached out / Not reached out buttons, the Outreach column, headings sort, Showing N of M, Clear filters');

  // 2. Outreach → People ---------------------------------------------------
  await page.evaluate(() => gotoView('linkedin'));
  await page.waitForSelector('#li-list .target');
  const liSel = '#li-reach select[data-reachf="people"]';
  const liNames = () => texts('#li-list .target .t-brand');
  assert.deepEqual(await opts(liSel), [['', 'Any'], ['yes', 'Reached out (1)'], ['no', 'Not reached out (2)']]);
  await page.selectOption(liSel, 'yes');
  assert.deepEqual(await liNames(), ['Mango Co']);
  await page.selectOption(liSel, 'no');
  assert.deepEqual((await liNames()).sort(), ['Lime Co', 'Nectar Co']);
  await page.fill('#li-q', 'nec');
  assert.deepEqual(await liNames(), ['Nectar Co'], 'with the filter box');
  assert.deepEqual(await opts(liSel), [['', 'Any'], ['yes', 'Reached out (0)'], ['no', 'Not reached out (1)']], 'counts follow the box');
  await page.fill('#li-q', '');
  await page.click('#linkedin .chip[data-lif="none"]');
  assert.deepEqual(await liNames(), ['Lime Co'], 'with the Nobody yet chip');
  await page.selectOption(liSel, 'yes');
  assert.match(await page.textContent('#li-list'), /No brands here/);
  await page.selectOption(liSel, '');
  await page.click('#linkedin .chip[data-lif="all"]');
  console.log('✓ 2 Outreach → People: the same dropdown, with the chips and the filter box');

  // 3. Stock take ------------------------------------------------------------
  await page.evaluate(() => gotoView('stock'));
  await page.waitForSelector('#st-lanes [data-strow="energy"]');
  const stSel = '#st-reach select[data-reachf="stock"]';
  assert.deepEqual(await opts(stSel), [['', 'Any'], ['yes', 'Reached out (1)'], ['no', 'Not reached out (2)']]);
  await page.selectOption(stSel, 'yes');
  assert.match(await page.textContent('[data-strow="energy"] [data-sttoggle="brands"]'), /Brands \(1 of 3\)/);
  await page.click('[data-strow="energy"] [data-sttoggle="brands"]');
  assert.deepEqual(await texts('[data-strow="energy"] .st-bname'), ['Sent Energy']);
  await page.selectOption(stSel, 'no');
  assert.deepEqual(await texts('[data-strow="energy"] .st-bname'), ['Empty Energy', 'Ready Energy'], 'the lane stays open (grouped by where each stands)');
  await page.selectOption(stSel, '');
  assert.deepEqual((await texts('[data-strow="energy"] .st-bname')).length, 3);
  console.log('✓ 3 Stock take: a lane\'s brands and its count follow the dropdown');

  // 4. Discover ----------------------------------------------------------------
  await page.evaluate(() => gotoView('discover'));
  await page.waitForSelector('#disc-body .dc-row');
  const dcSel = '#dc-bar select[data-reachf="discover"]';
  const dcNames = () => texts('#disc-body .dc-name b');
  assert.deepEqual(await opts(dcSel), [['', 'Any'], ['yes', 'Reached out (0)'], ['no', 'Not reached out (1)']], 'a find not on the roster was never reached');
  await page.click('#dc-bar [data-dctab="added"]');
  assert.deepEqual(await opts(dcSel), [['', 'Any'], ['yes', 'Reached out (1)'], ['no', 'Not reached out (1)']]);
  await page.selectOption(dcSel, 'yes');
  assert.deepEqual(await dcNames(), ['Added Reached']);
  await page.selectOption(dcSel, 'no');
  assert.deepEqual(await dcNames(), ['Added Waiting']);
  await page.click('#dc-bar [data-dctab="review"]');
  assert.equal(await page.$eval(dcSel, (s) => s.value), '', 'a tab change resets it, like the other dropdowns');
  assert.deepEqual(await dcNames(), ['New Find']);
  console.log('✓ 4 Discover: the Added tab splits by outreach; a tab change resets it');

  // 5. Week plan → browse a category -------------------------------------------
  await page.evaluate((d) => { showView('weekplan'); WP.cat = 'energy'; WP.catData = d; WP.catSel = {}; wpRenderResults(); }, WEEK);
  const wpSel = '#wp-results select[data-reachf="weekplan"]';
  const wpNames = () => texts('#wp-results .wp-rows .sd-bname');
  assert.deepEqual(await opts(wpSel), [['', 'Any'], ['yes', 'Reached out (1)'], ['no', 'Not reached out (2)']]);
  await page.selectOption(wpSel, 'yes');
  assert.deepEqual(await wpNames(), ['Wave Two']);
  assert.match(await page.textContent('#wp-results .wp-bar'), /1 of 3 brands/);
  assert.equal(await page.$('#wp-results [data-wpaddtop]'), null, 'no "Add the top" — a reached brand is an Add anyway');
  await page.selectOption(wpSel, 'no');
  assert.deepEqual(await wpNames(), ['Wave One', 'Wave Three']);
  assert.match(await page.textContent('#wp-results [data-wpaddtop]'), /Add the top 2/);
  console.log('✓ 5 Week plan: a category\'s brands and Add the top N follow the dropdown');

  // 6. Schedule → a category's drill-in ------------------------------------------
  await page.evaluate((d) => {
    showView('schedule');
    if (!document.getElementById('sd-drill')) document.getElementById('schedule').insertAdjacentHTML('beforeend', '<div id="sd-drill"></div>');
    SCHED.openCat = 'energy'; SCHED.catQ = ''; SCHED.catCache.energy = Object.assign({ _gen: SCHED.catGen }, d);
    renderSchedDrill();
  }, DRILL);
  const sdSel = '#sd-drill select[data-reachf="sched"]';
  const sdNames = () => texts('#sd-drill-body .sd-bname');
  assert.deepEqual(await opts(sdSel), [['', 'Any'], ['yes', 'Reached out (1)'], ['no', 'Not reached out (2)']], 'an email alone is not reached out');
  await page.selectOption(sdSel, 'yes');
  assert.deepEqual(await sdNames(), ['Kilo Invited']);
  assert.match(await page.textContent('#sd-drill-body'), /Nothing here matches\./);
  await page.selectOption(sdSel, 'no');
  assert.deepEqual(await sdNames(), ['Kilo Ready', 'Kilo Emailed']);
  await page.click('#sd-drill [data-sdselready]');
  assert.deepEqual(await page.evaluate(() => Object.keys(SCHED.catSel)), ['k1'], 'Select all ready ticks only rows on screen');
  console.log('✓ 6 Schedule drill-in: the same dropdown; an email-only brand is not reached out');

  // Phone width: the dropdown never pushes the page sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list [data-brreach]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a phone');
  console.log('✓ fits a phone');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Outreach filter checks passed');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
