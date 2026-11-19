// scripts/test-li-run.js — Brands → LinkedIn run (Leo, Nov 18 2026: "a list on
// the brands tab that specifically says how many brands need a linkedin run and
// for what reason, not enough people, new brand, etc") in Chromium against a
// fake /api/data: the sub-tab, the one number and what a run takes, a tile per
// reason (a click shows only that reason), each brand's row (goes first, on
// file, no page saved, what went wrong), Show all, the brands not on the run
// and why (Pick their pages opens Outreach → People), the Brand Fit floor, a
// run going now, the link from All brands' card, the deep link and a phone.
//   NODE_PATH=$(npm root -g) node scripts/test-li-run.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-li-run.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();
const S = { calls: [], live: false, empty: false, fail: false };

const brand = (id, name, fit, extra) => Object.assign({
  id, name, category: 'electrolytes', fit, contacts: 0, first: null, page: 'saved', issue: null, noBuyer: false, short: false, belowFloor: false, pick: false,
}, extra || {});
const many = Array.from({ length: 45 }, (_, i) => brand('n' + i, 'New Brand ' + String(i + 1).padStart(2, '0'), 80 - i, { page: 'search' }));
const needs = (a) => {
  if (S.fail) throw new Error('database asleep');
  const floor = a.minFit == null ? 24 : a.minFit;
  const reasons = S.empty ? [] : [
    { key: 'new', label: 'New — never read', hint: 'The run hasn’t read it on LinkedIn yet.', brands: [
      brand('bPlan', 'Planned Hydration', 71, { first: 'On the Schedule Wed, Nov 25', page: 'search' }),
      brand('bMine', 'Jetty', 78, { first: 'You added it', page: 'search', pick: true }),
    ].concat(many) },
    { key: 'people', label: 'Not enough people', hint: 'Read before, and still short on people to go out — or nobody in partnerships, marketing or a founder on file.', brands: [
      brand('bShort', 'Short Hydration', 83, { contacts: 1, short: true }),
      brand('bNoBuyer', 'Nobuyer Threads', 43, { category: 'apparel', contacts: 5, noBuyer: true, belowFloor: true }),
      brand('bParent', 'Label Vodka', 60, { category: 'spirits', page: 'parent' }),
    ] },
    { key: 'wrong', label: 'Last read went wrong', hint: 'The run reads it again.', brands: [
      brand('bWrong', 'Kiehl’s', 47, { category: 'beauty', contacts: 6, issue: 'its page wouldn’t open (try 3)' }),
    ] },
    { key: 'research', label: 'Not on the dashboard yet', hint: 'Names from the research list for the run to find on LinkedIn.', brands: [
      brand(null, 'Ghost Name Energy', null, { category: 'energy', page: 'search' }),
    ] },
  ].map((r) => Object.assign(r, { n: r.brands.length }));
  const off = [
    { key: 'pick', label: 'Waiting on your page pick', hint: 'The run wasn’t sure which LinkedIn page is theirs. It can’t read them until you pick.', brands: [
      { id: 'oPick1', name: 'AVANA', category: 'beverage', fit: 63, contacts: 0, back: null },
      { id: 'oPick2', name: 'ALB Vodka', category: 'spirits', fit: 60, contacts: 0, back: null },
    ] },
    { key: 'stuck', label: 'Went wrong three runs in a row', hint: 'Back on the run a month after the last try.', brands: [
      { id: 'oStuck', name: 'Stuck Seltzer', category: 'rtd', fit: 55, contacts: 2, back: '2026-12-16T12:00:00.000Z' },
    ] },
    { key: 'belowFit', label: 'Under the Brand Fit floor', hint: 'They have their people; the floor keeps them off.', brands: [
      { id: 'oLow', name: 'Low Threads', category: 'apparel', fit: 12, contacts: 5, back: null },
    ] },
    { key: 'done', label: 'Read in full already', hint: 'Nothing went wrong, so the run doesn’t read them again by itself.',
      brands: Array.from({ length: 90 }, (_, i) => ({ id: 'oDone' + i, name: 'Done Brand ' + (i + 1), category: 'cpg', fit: 90 - i, contacts: 8, back: null })) },
  ].map((r) => Object.assign(r, { n: r.brands.length }));
  const total = reasons.reduce((x, r) => x + r.n, 0);
  return {
    today: NOW.slice(0, 10), minFit: floor, appFloor: { minFit: 24, at: NOW }, perDay: 100,
    total: floor === 0 ? 121 : total,
    inPlay: total - (S.empty ? 0 : 1) + off.reduce((x, r) => x + r.n, 0),
    first: S.empty ? { planned: 0, mine: 0 } : { planned: 1, mine: 1 },
    reasons, off,
    run: S.live
      ? { status: 'running', startedAt: NOW, lastAt: NOW, items: 56, read: 41, added: 164, live: true }
      : { status: 'finished', startedAt: '2026-11-18T17:03:57.084Z', lastAt: '2026-11-19T02:40:08.945Z', items: 56, read: 56, added: 208, live: false },
  };
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  reachedBrands: () => ({ brands: { bShort: ['2026-11-01', '2026-11-03', 'r', 1, 0, ''] }, el: {} }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0, recentlyAdded: 0 }),
  findDuplicates: () => ({ groups: [] }), suMatchQueue: () => ({ proposals: [], missing: 0, capturePending: 0 }),
  buyerCoverage: () => ({ perDay: 100, week: { linkedin: 0, sponsorunited: 0, other: 0 }, coveredWeek: 0, run: null }),
  brandSupply: () => ({
    today: NOW.slice(0, 10), minFit: 24, appFloor: { minFit: 24, at: NOW }, perDay: 35, readyPeople: 0,
    switches: { giantsOn: false, smallOn: false }, ids: { ready: [], short: [], none: [], pass: [], giant: [], skip: [], small: [] },
    lets: { giant: 0, skip: 0, small: 0 }, skipCats: [],
    fill: { ids: { new: ['bPlan'], again: [], reread: [] }, total: 52, belowFit: 1, bigSkipped: 0, resting: 90, stuck: 1, shortFirst: 0, reread: 0, perDay: 100, needsUnderFloor: 0 },
    again: { total: 0, due: 0, late: 0, ids: [], rows: [] }, days: [], dead: { count: 0, last: null },
  }),
  fillNeeds: needs,
  linkedinPeople: () => ({ brands: [], runs: [], pagesNow: null, pageReview: [], zachList: [], zachDone: [], zachRestDays: 120 }),
  fillSchedule: () => ({ today: NOW.slice(0, 10), doneToday: 0, perDay: 100, minFit: 50, focus: 'electrolyte', total: 0, days: [] }),
  getBrand: (a) => ({ brand: { id: a.brandId, name: 'Jetty', category: 'electrolytes', contacts: [], targets: [], deals: [], notes: null }, contacts: [], targets: [], deals: [], shows: [], documents: [], notes: [] }),
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: process.env.SHOT ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      S.calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  const calls = (fn) => S.calls.filter((c) => c.fn === fn);
  const text = (sel) => page.textContent(sel);
  const rows = (key) => page.$$eval('#lr-body [data-lrsec="' + key + '"] .lr-row', (rs) => rs.length);

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadLiRun === 'function');

  // ---- the sub-tab ----
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#sub-tabs [data-view="lirun"]');
  assert.deepEqual(await page.$$eval('#sub-tabs .nav-item', (bs) => bs.map((b) => b.textContent)),
    ['All brands', 'Recently added', 'LinkedIn run', 'Discover', 'Clarify']);
  await page.click('#sub-tabs [data-view="lirun"]');
  await page.waitForSelector('#lr-body .lr-top');
  assert.equal(await text('#sub-tabs .nav-item.active'), 'LinkedIn run');
  assert.equal(await page.$eval('.tabs .nav-item.active[data-view="brands"]', (b) => b.textContent.trim()), 'Brands', 'the Brands tab stays lit');
  assert.equal(calls('fillNeeds')[0].args.minFit, undefined, 'the fill app’s own floor (the server knows it)');
  console.log('✓ Brands → LinkedIn run is a sub-tab of its own');

  // ---- the number and what a run takes ----
  assert.equal(await text('#lr-total'), '52');
  let top = await text('#lr-body .lr-top');
  assert.match(top, /brands waiting for a run/);
  assert.match(top, /One run reads up to 100 brands, so all 52 go in one run — about 40 minutes\./);
  assert.match(top, /Start it from your LinkedIn Fill app/);
  assert.match(top, /1 is on the Schedule’s coming days and 1 is one you added yourself — those go first/);
  assert.match(top, /47 have no LinkedIn page saved — the run searches for each, and any it isn’t sure of land on your page-pick list\./);
  assert.match(top, /Last run: finished Nov 18, 9:40 PM — 56 of 56 brands read, 208 people saved\./);
  assert.match(top, /the floor your LinkedIn Fill app’s run uses/);
  assert.equal(await page.inputValue('#lr-body [data-lrfloor]'), '24');
  assert.equal(await page.$('#lr-body a[href*="sb-fill"]'), null, 'no Start here: the run starts from the LinkedIn Fill app');
  console.log('✓ one number, one run, the last run, the floor');

  // ---- a tile per reason ----
  const tiles = await page.$$eval('#lr-body .lr-tile', (ts) => ts.map((t) => [t.querySelector('.v').textContent, t.querySelector('.k').textContent]));
  assert.deepEqual(tiles, [['47', 'New — never read'], ['3', 'Not enough people'], ['1', 'Last read went wrong'], ['1', 'Not on the dashboard yet']]);
  assert.equal(tiles.reduce((a, t) => a + Number(t[0]), 0), 52, 'the reasons add up to the number');
  assert.deepEqual(await page.$$eval('#lr-body [data-lrsec]', (s) => s.map((x) => x.getAttribute('data-lrsec'))), ['new', 'people', 'wrong', 'research']);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // ---- the rows ----
  assert.equal(await rows('new'), 15, '15 rows a reason, then Show all');
  let row = await text('#lr-body [data-lrrow="bPlan"]');
  assert.match(row, /Planned Hydration/);
  assert.match(row, /Goes first · On the Schedule Wed, Nov 25/);
  assert.match(row, /Goes first · On the Schedule Wed, Nov 25Electrolytes.* · Fit 71 · nobody on file · no LinkedIn page saved$/);
  assert.match(await text('#lr-body [data-lrrow="bMine"]'), /Goes first · You added it.*still on your page-pick list/);
  row = await text('#lr-body [data-lrrow="bShort"]');
  assert.match(row, /Outreached Nov 3/, 'the Reached tag');
  assert.match(row, /1 person on file/);
  assert.doesNotMatch(row, /Goes first|no LinkedIn page/);
  assert.match(await text('#lr-body [data-lrrow="bNoBuyer"]'), /5 people on file, none in partnerships, marketing or a founder · under Fit 24 — read because it needs people/);
  assert.match(await text('#lr-body [data-lrrow="bParent"]'), /read under its parent company’s page/);
  assert.match(await text('#lr-body [data-lrrow="bWrong"]'), /6 people on file · last time: its page wouldn’t open \(try 3\)/);
  const res = await text('#lr-body [data-lrsec="research"] .lr-row');
  assert.match(res, /Ghost Name Energy/);
  assert.doesNotMatch(res, /on file|no LinkedIn page/, 'a research name is not a brand yet');
  await page.click('#lr-body [data-lrmore="new"]');
  assert.equal(await rows('new'), 47);
  console.log('✓ each brand’s row: goes first, on file, no page saved, what went wrong; Show all');

  // ---- a tile shows only its reason ----
  await page.click('#lr-body [data-lrpick="people"]');
  assert.deepEqual(await page.$$eval('#lr-body [data-lrsec]', (s) => s.map((x) => x.getAttribute('data-lrsec'))), ['people']);
  await page.click('#lr-body [data-lrpick="new"]');
  assert.equal(await rows('new'), 47, 'a reason on its own lists every brand');
  await page.click('#lr-body [data-lrpick="people"]');
  assert.ok(await page.$('#lr-body .lr-tile.on[data-lrpick="people"]'));
  assert.match(await text('#lr-body'), /Showing one reason · Show all 52/);
  await page.click('#lr-body [data-lrpick="people"]');
  assert.equal((await page.$$('#lr-body [data-lrsec]')).length, 4, 'a second click shows every reason again');
  await page.click('#lr-body [data-lrpick="wrong"]');
  await page.click('#lr-body a[data-lrpick=""]');
  assert.equal((await page.$$('#lr-body [data-lrsec]')).length, 4, 'Show all');
  console.log('✓ a tile shows only that reason; again (or Show all) shows them all');

  // ---- not on the run ----
  const off = await text('#lr-body .lr-off');
  assert.match(off, /Not on the run94 brands/);
  assert.deepEqual(await page.$$eval('#lr-body [data-lrorow]', (rs) => rs.map((r) => [r.getAttribute('data-lrorow'), r.querySelector('.lr-on').textContent])),
    [['pick', '2'], ['stuck', '1'], ['belowFit', '1'], ['done', '90']]);
  assert.match(off, /Under Brand Fit 24/);
  assert.match(off, /145 brands in play in all: 51 on the run, 94 not/);
  assert.equal(await page.$('#lr-body .lr-names'), null, 'names only when asked');
  await page.click('#lr-body [data-lroff="stuck"]');
  assert.match(await text('#lr-body [data-lrorow="stuck"] .lr-names'), /Stuck Seltzer \(back Dec 16\)/);
  await page.click('#lr-body [data-lroff="done"]');
  assert.equal((await page.$$('#lr-body [data-lrorow="done"] .lr-names [data-brand]')).length, 80);
  await page.click('#lr-body [data-lrmore="off:done"]');
  assert.equal((await page.$$('#lr-body [data-lrorow="done"] .lr-names [data-brand]')).length, 90);
  await page.click('#lr-body [data-lroff="stuck"]');
  assert.equal(await page.$('#lr-body [data-lrorow="stuck"] .lr-names'), null, 'Hide');
  console.log('✓ not on the run: a line per reason, adding up to the brands in play; names on request');

  // ---- the floor ----
  await page.fill('#lr-body [data-lrfloor]', '0');
  await page.dispatchEvent('#lr-body [data-lrfloor]', 'change');
  await page.waitForFunction(() => document.getElementById('lr-total') && document.getElementById('lr-total').textContent === '121');
  assert.equal(calls('fillNeeds').slice(-1)[0].args.minFit, 0);
  top = await text('#lr-body .lr-top');
  assert.match(top, /A run reads 100 brands a day, so this is about 2 days/);
  assert.match(top, /your LinkedIn Fill app’s run uses 24/);
  await page.click('#lr-body [data-lrappfloor]');
  await page.waitForFunction(() => document.getElementById('lr-total').textContent === '52');
  assert.equal(calls('fillNeeds').slice(-1)[0].args.minFit, undefined, 'back to the app’s floor');
  console.log('✓ another Brand Fit floor counts again; back to the fill app’s');

  // ---- a run going now; refresh keeps what's open ----
  S.live = true;
  await page.click('#lr-body [data-lroff="pick"]');
  await page.click('#lr-body [data-lrre]');
  await page.waitForFunction(() => /A run is going now/.test(document.getElementById('lr-body').textContent));
  assert.match(await text('#lr-body .lr-live'), /A run is going now — 41 of 56 brands read, 164 people saved so far\. It took its list when it started/);
  assert.ok(await page.$('#lr-body [data-lrorow="pick"] .lr-names'), 'a refresh keeps an open list open');
  S.live = false;
  console.log('✓ a run going now says so, and that brands added since wait for the next one');

  // ---- a brand opens its page; Pick their pages opens Outreach → People ----
  await page.click('#lr-body [data-lrrow="bMine"] [data-brand]');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  assert.equal(calls('getBrand').slice(-1)[0].args.brandId, 'bMine');
  await page.evaluate(() => gotoView('lirun'));
  await page.waitForSelector('#lr-body [data-lrpickpages]');
  await page.click('#lr-body [data-lrpickpages]');
  await page.waitForFunction(() => document.getElementById('linkedin').classList.contains('active'));
  console.log('✓ a name opens its brand page; Pick their pages opens Outreach → People');

  // ---- from All brands' card; the deep link ----
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#supply-card [data-suplirun]');
  assert.match(await text('#supply-card [data-suplirun]'), /See them by reason/);
  await page.click('#supply-card [data-suplirun]');
  await page.waitForFunction(() => document.getElementById('lirun').classList.contains('active'));
  assert.equal(await page.inputValue('#lr-body [data-lrfloor]'), '24', 'a fresh visit starts at the app’s floor');
  await page.goto(base + '/app.html#lirun');
  await page.waitForFunction(() => document.getElementById('lirun') && document.getElementById('lirun').classList.contains('active'));
  await page.waitForSelector('#lr-body .lr-top');
  console.log('✓ All brands’ card links to it; app.html#lirun opens it');

  // ---- nothing waiting; an error ----
  S.empty = true;
  await page.click('#lr-body [data-lrre]');
  await page.waitForFunction(() => document.getElementById('lr-total').textContent === '0');
  assert.match(await text('#lr-body .lr-top'), /Nothing is waiting for a run at this floor/);
  assert.equal(await page.$('#lr-body .lr-tile'), null);
  S.empty = false; S.fail = true;
  await page.evaluate(() => { LR.data = null; return loadLiRun(); });
  await page.waitForFunction(() => /database asleep/.test(document.getElementById('lr-body').textContent));
  S.fail = false;
  await page.click('#lr-body [data-lrre]');
  await page.waitForSelector('#lr-body .lr-top');
  console.log('✓ nothing waiting says so; an error offers Try again');

  // ---- a phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => loadLiRun());
  await page.waitForSelector('#lr-body .lr-top');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  if (process.env.SHOT_PHONE) await page.screenshot({ path: process.env.SHOT_PHONE, fullPage: true });
  console.log('✓ fits a phone');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All LinkedIn run page checks passed');
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
