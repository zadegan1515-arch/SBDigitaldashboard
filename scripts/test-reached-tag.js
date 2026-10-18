// scripts/test-reached-tag.js
//
// The Reached tag (Leo, Oct 18 2026: "all over the site for any brand that
// has been reached out to i want a tag that shows that"). Drives
// public/app.html in Chromium against a fake /api/data:
//
//   1. reachedBrands is read once at the start; a brand reached gets
//      "Reached <its last day>" (with how in its tooltip), one not reached
//      gets nothing — on Brands → All brands, the global search, the
//      Schedule's cards and the Week plan.
//   2. A list drawn before the map lands is painted when it does.
//   3. Logging an invite (setTargetStatus) reads the map again, and the
//      brand's tag appears without a reload.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-reached-tag.js   (~5s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-reached-tag.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();
const calls = [];
const count = (fn) => calls.filter((c) => c.fn === fn).length;

const brow = (id, name) => ({
  id, name, category: 'energy', tier: 'growth', passedAt: null, aka: null, website: null, linkedinUrl: null, notes: null,
  source: 'manual', createdAt: NOW, contacts: [], _count: { contacts: 3, targets: 0 },
  buyers: { partnerships: 1, events: 0, marketing: 0, founder: 0, total: 1 },
  buyerPeople: [], withEmail: 0, withLinkedin: 3, outreach: {},
});

const S = { reached: { b1: ['2026-09-30', '2026-10-12', 'a', 3, 1] }, slow: 0 };
const label = { kind: 'ready', reachable: 4, need: 3, onFile: 4 };
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  reachedBrands: () => ({ brands: S.reached, count: Object.keys(S.reached).length }),
  listBrands: () => [brow('b1', 'Alpha Energy'), brow('b2', 'Bravo Soda')],
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  search: () => ({ brands: [{ id: 'b1', name: 'Alpha Energy', tier: 'growth', category: 'energy', _count: { contacts: 3, shows: 0 } }, { id: 'b2', name: 'Bravo Soda', tier: null, category: 'beverage', _count: { contacts: 1, shows: 0 } }], contacts: [], sponsorships: [], shows: [] }),
  setTargetStatus: () => { S.reached = Object.assign({}, S.reached, { b2: ['2026-10-17', '2026-10-17', 'i', 1, 0] }); return { ok: true }; },
  getOutreachPlan: () => ({
    stamp: 's', plan: {}, brands: [], today: '2026-10-18', past: [], labels: {}, categories: [], carry: null, extraDays: [], skipDays: [],
    nextOffDay: '', pool: { total: 0, cap: 30 }, priority: {}, planWeekLast: null, themeUndo: null,
    linkedinWeek: { limit: 100, near: 90, sentLast7: 0, sentByDay: {}, days: {} },
    queueRules: { giantsOn: false, giantsHeld: 0, giantsOk: 0, restDays: 14 },
    days: [{ date: '2026-10-20', list: false, offTheme: 0, today: false, extra: false, category: 'bestfit', auto: true, cap: 30, bigs: 0,
      ready: 7, total: 7, over: 0, sent: 0, sentPeople: [], overflow: [],
      pinned: [{ id: 'b1', name: 'Alpha Energy', category: 'energy', state: 'going', going: 3, people: [], waits: null }],
      brands: [{ id: 'b2', name: 'Bravo Soda', going: 4, people: [] }] }],
  }),
  weekBank: () => ({
    today: '2026-10-18', weeks: [{ start: '2026-10-19', which: 'next', days: ['2026-10-20'], labels: ['Tue Oct 20'] }], week: '2026-10-19', which: 'next',
    days: [{ date: '2026-10-20', label: 'Tue Oct 20', list: false, category: 'bestfit', keptPeople: 0, bigs: 0, cap: 30, room: 30, auto: 0, autoPeople: 0, pinned: [] }],
    bank: { size: 100, autoLeft: 0, hand: 0, waiting: 2, onDays: 0, removed: [], rows: ['b1', 'b2'].map((id, i) => ({
      rank: i + 1, id, name: id === 'b1' ? 'Alpha Energy' : 'Bravo Soda', category: 'energy', tier: null, fit: 80 - i, label, going: 3, people: [],
      big: false, how: 'hand', addedAt: NOW, where: 'waiting', day: null, why: null, linkedinUrl: null, website: null, externalId: null })) },
    spreadLast: null, cap: 30, linkedin: { limit: 100, sentLast7: 0 }, priority: {},
  }),
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
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      if (fn === 'reachedBrands' && S.slow) await new Promise((r) => setTimeout(r, S.slow));
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  const tagOf = (sel) => page.evaluate((s) => {
    var el = document.querySelector(s);
    var t = el && el.querySelector('.rb-tag');
    return t ? { text: t.textContent, tip: t.getAttribute('title') } : null;
  }, sel);

  // 1. Everywhere ------------------------------------------------------
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.rbTag === 'function' && RB.map);
  assert.equal(count('reachedBrands'), 1, 'read once at the start');
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands [data-brand="b1"]');
  const row1 = await page.evaluate(() => document.querySelector('#brands [data-brand="b1"]').closest('tr').querySelector('.rb-tag').textContent);
  assert.equal(row1, 'Reached Oct 12', 'Brands table: a reached brand');
  assert.equal(await page.evaluate(() => !!document.querySelector('#brands [data-brand="b2"]').closest('tr').querySelector('.rb-tag')), false, 'not reached: no tag');
  const tip = await page.evaluate(() => document.querySelector('#brands .rb-tag').getAttribute('title'));
  assert.match(tip, /last Oct 12, first Sep 30 · 3 people invited on LinkedIn · 1 emailed · they accepted/, 'the tooltip says how');
  console.log('✓ Brands table');

  await page.fill('#q', 'alpha');
  await page.press('#q', 'Enter');
  await page.waitForSelector('#search-results [data-brand="b1"]');
  const sr = await page.evaluate(() => { var el = document.querySelector('#search-results [data-brand="b1"]'); var t = el && el.querySelector('.rb-tag'); return t && t.textContent; });
  assert.equal(await page.evaluate(() => !!document.querySelector('#search-results [data-brand="b2"] .rb-tag')), false, 'search: not reached, no tag');
  assert.equal(sr, 'Reached Oct 12', 'search results');
  console.log('✓ search');

  await page.evaluate(() => gotoView('schedule'));
  await page.waitForSelector('#sched-days [data-dragb="b1"]');
  assert.equal((await tagOf('#sched-days [data-dragb="b1"]')).text, 'Reached Oct 12', 'Schedule: a pinned card');
  assert.equal(await tagOf('#sched-days [data-dragb="b2"]'), null, 'Schedule: an automatic row not reached');
  console.log('✓ Schedule');

  await page.evaluate(() => gotoView('weekplan'));
  await page.waitForSelector('#wp-list [data-wprm="b1"]');
  assert.equal(await page.evaluate(() => document.querySelector('#wp-list [data-wprm="b1"]').closest('.wp-b').querySelector('.rb-tag').textContent), 'Reached Oct 12', 'Week plan');
  console.log('✓ 1 a reached brand is tagged everywhere, one not reached isn’t');

  // 2. Drawn before the map lands -----------------------------------------
  await page.evaluate(() => { RB.map = null; RB.at = 0; });
  S.slow = 500;
  await page.evaluate(() => { wpRenderAll(); rbLoad(); });
  assert.equal(await page.evaluate(() => document.querySelectorAll('#wp-list .rb-tag').length), 0, 'no map yet: no tag');
  await page.waitForFunction(() => document.querySelectorAll('#wp-list .rb-tag').length === 1, null, { timeout: 3000 });
  S.slow = 0;
  console.log('✓ 2 a list drawn before the map lands is painted when it does');

  // 3. An invite logged: the tag appears ------------------------------------
  const n = count('reachedBrands');
  await page.evaluate(() => api('setTargetStatus', { targetId: 't1', status: 'sent' }));
  await page.waitForFunction((m) => document.querySelectorAll('#wp-list .rb-tag').length === 2, n, { timeout: 3000 });
  assert.ok(count('reachedBrands') > n, 'read again after an invite was logged');
  assert.equal(await page.evaluate(() => document.querySelector('#wp-list [data-wprm="b2"]').closest('.wp-b').querySelector('.rb-tag').textContent), 'Reached Oct 17');
  console.log('✓ 3 logging an invite tags the brand without a reload');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All Reached tag checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
