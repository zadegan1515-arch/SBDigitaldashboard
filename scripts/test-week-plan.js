// scripts/test-week-plan.js
//
// Outreach → Week plan (Leo, Oct 18 2026: a list of ~100 brands, the top
// by Brand Fit plus what he adds by search or category, spread onto the
// week's days as an even mix of rank, then moved between days). Drives
// public/app.html in Chromium against a fake /api/data:
//
//   1. The tab sits between Results and Schedule and reads weekBank: the
//      week chips, one column per sending day with its cards, the list
//      ranked (#, Fit, contacts dot, where it sits), the first 40 then
//      Show all, filters.
//   2. The number: changing it asks weekBankSize.
//   3. Adding: the search box (the Schedule's search, for the week's first
//      day) — + Add, a giant's Add anyway (allowGiants), Enter only for a
//      plain add; a category — Add the top N, ticks → Add N ticked.
//   4. Taking off: × on a waiting row takes it off; on a row already on a
//      day it asks first and takes it off the day too; Put back.
//   5. The spread: a preview (a seed) shows the new cards on their days and
//      who waits; Shuffle again deals with another seed; Put them on the
//      days sends exactly the previewed days; Undo asks first, naming what
//      comes off.
//   6. Moving: Move to… / drag between days (planMoveBrand), × and "Off the
//      days" (planRemoveBrand), Put on… and dragging a list row onto a day
//      (planAddBrands); Keep it to my list / Let Best fit fill (setListDay).
//   7. The Schedule: a day spread from the list says so (tag, no category
//      menu, ⋯ → Let Best fit fill its open spots), and its Fill box offers
//      the list.
//   8. A phone: no sideways scroll.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-week-plan.js   (~6s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-week-plan.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const last = (fn) => calls.filter((c) => c.fn === fn).slice(-1)[0];
const count = (fn) => calls.filter((c) => c.fn === fn).length;

const label = (k, n) => ({ kind: k, reachable: n, need: 3, onFile: n });
const row = (i, over) => Object.assign({
  rank: i, id: 'r' + i, name: 'Brand ' + i, category: 'energy', tier: null, fit: 100 - i,
  label: label('ready', 4), going: 3, people: [{ name: 'P' + i, title: 'Marketing' }], big: false,
  how: 'auto', addedAt: null, where: 'waiting', day: null, why: null, linkedinUrl: null, website: null, externalId: null,
}, over || {});

function bank() {
  const rows = [];
  for (let i = 1; i <= 60; i++) rows.push(row(i));
  rows[0] = row(1, { name: 'Celsius', where: 'day', day: '2026-10-20' });
  rows[1] = row(2, { name: 'Ghost', how: 'hand', addedAt: '2026-10-18T14:00:00Z' });
  rows[2] = row(3, { name: 'Resting Co', where: 'cant', why: 'Reached out (Oct 10) — it rests two weeks, until Fri Oct 24.', going: 0 });
  rows[3] = row(4, { name: 'Big Brew', big: true, going: 10 });
  return rows;
}

const WEEK = {
  today: '2026-10-18',
  weeks: [{ start: '2026-10-19', which: 'next', days: ['2026-10-20', '2026-10-21', '2026-10-22'], labels: ['Tue Oct 20', 'Wed Oct 21', 'Thu Oct 22'] }],
  week: '2026-10-19', which: 'next',
  days: [
    { date: '2026-10-20', label: 'Tue Oct 20', list: true, category: 'bestfit', keptPeople: 3, bigs: 0, cap: 30, room: 27, auto: 0, autoPeople: 0,
      pinned: [{ id: 'r1', name: 'Celsius', category: 'energy', state: 'going', going: 3, waits: null, reasonText: null, people: [{ name: 'Ann', title: 'Brand Manager' }], linkedinUrl: null, website: null, carriedFrom: null, big: false }] },
    { date: '2026-10-21', label: 'Wed Oct 21', list: false, category: 'bestfit', keptPeople: 0, bigs: 0, cap: 30, room: 30, auto: 7, autoPeople: 26, pinned: [] },
    { date: '2026-10-22', label: 'Thu Oct 22', list: false, category: 'energy', keptPeople: 0, bigs: 0, cap: 30, room: 30, auto: 0, autoPeople: 0, pinned: [] },
  ],
  bank: { size: 100, rows: bank(), autoLeft: 12, hand: 1, waiting: 57, onDays: 1,
    removed: [{ id: 'gone1', name: 'Taken Off Co', category: 'cpg', at: '2026-10-18T13:00:00Z' }] },
  spreadLast: { at: '2026-10-18T15:00:00Z', days: [{ date: '2026-10-20', added: 1 }] },
  cap: 30,
  linkedin: { limit: 100, sentLast7: 0 },
  priority: { energy: 'top', cpg: 'middle' },
};

const brief = (r) => ({ id: r.id, rank: r.rank, name: r.name, category: r.category, fit: r.fit, label: r.label, going: r.going, people: r.people, big: r.big, how: r.how });

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  weekBank: () => WEEK,
  weekBankSize: ({ size }) => ({ ok: true, size }),
  weekBankAdd: ({ brandIds }) => ({ ok: true, added: brandIds.map((id) => ({ id, name: id })), already: 0, refused: [] }),
  weekBankRemove: ({ brandIds }) => ({ ok: true, removed: brandIds.length, offDays: [] }),
  weekBankPutBack: ({ brandIds }) => ({ ok: true, back: brandIds.length }),
  weekBankBrowse: ({ category }) => ({ category, date: '2026-10-20', setAside: 2, total: 14, brands: [
    { id: 'k1', name: 'Kin One', category, action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 70 }, going: 3 },
    { id: 'k2', name: 'Kin Two', category, action: 'add', text: '4 would go out', label: label('ready', 4), fit: { score: 64 }, going: 4 },
    { id: 'k3', name: 'Kin Giant', category, action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 5), fit: { score: 50 }, going: 5 },
    { id: 'r5', name: 'Brand 5', category, action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 95 }, going: 3 },
  ] }),
  searchPlanBrands: ({ q }) => ({ brands: /prime/i.test(q) ? [
    { id: 'pr', name: 'Prime Hydration', category: 'electrolytes', action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 6), fit: { score: 55 } },
    { id: 'pm', name: 'Primal Kitchen', category: 'cpg', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 61 } },
    { id: 'r2', name: 'Ghost', category: 'energy', action: 'add', text: '3 would go out', label: label('ready', 4), fit: { score: 98 } },
  ] : [] }),
  weekSpread: (a) => {
    if (a.apply) return { ok: true, days: a.days.map((d) => ({ date: d.date, label: d.date, ok: true, added: d.brandIds.length, people: d.brandIds.length * 3, waits: [], refused: [], elsewhere: [] })) };
    const rows = bank();
    const odd = a.seed % 2;
    return {
      ok: true, seed: a.seed, week: '2026-10-19', which: 'next',
      days: WEEK.days.map((d, i) => Object.assign({}, d, {
        add: [rows[4 + ((i + odd) % 3)], rows[7 + i]].map(brief),
        addPeople: 6,
      })),
      placed: 6, people: 18, waitNext: 50,
      passedOver: [Object.assign(brief(rows[3]), { why: 'too big for the room left (10 people)' })], cantGo: 1,
    };
  },
  undoWeekSpread: ({ preview }) => ({ ok: true, preview: !!preview, off: [{ name: 'Brand 5', day: 'Tue Oct 20' }], stays: ['Celsius'], unmark: ['Tue Oct 20'] }),
  setListDay: ({ date, on }) => ({ ok: true, date, list: on !== false }),
  planMoveBrand: ({ brandId, from, to }) => ({ ok: true, from, to, unqueued: 0, result: { brandId, added: true, state: 'going', going: 3 } }),
  planRemoveBrand: () => ({ ok: true, unqueued: 0 }),
  planAddBrands: ({ date, brandIds }) => ({ date, results: brandIds.map((id) => ({ brandId: id, brandName: id, added: true, state: 'going', going: 3 })) }),
  // The Schedule, one list day and one Best fit day.
  getOutreachPlan: () => ({
    stamp: 's1', plan: { '2026-10-20': { category: null, brandIds: ['r1'] } }, brands: [{ id: 'r1', name: 'Celsius' }], today: '2026-10-18',
    days: [
      { date: '2026-10-20', list: true, offTheme: 0, today: false, extra: false, category: 'bestfit', auto: true, cap: 30, bigs: 0, ready: 3, total: 3, over: 0, sent: 0, sentPeople: [],
        pinned: [{ id: 'r1', name: 'Celsius', category: 'energy', state: 'going', going: 3, people: [], waits: null }], brands: [], overflow: [],
        suggest: { category: '', data: { date: '2026-10-20', category: '', list: true, hideSmall: true, others: [], needPeople: [], needPeopleTotal: 0, hiddenSmall: 0, ruledOut: 0,
          brands: [{ id: 'r5', name: 'Brand 5', category: 'energy', label: label('ready', 3), fit: { score: 95 }, going: 3, people: [], text: '#5 on your list · 3 would go out', big: false }] } } },
      { date: '2026-10-21', list: false, offTheme: 0, today: false, extra: false, category: 'bestfit', auto: true, cap: 30, bigs: 0, ready: 30, total: 30, over: 0, sent: 0, sentPeople: [],
        pinned: [], brands: [{ id: 'a1', name: 'Auto One', going: 4, people: [] }], overflow: [] },
    ],
    past: [], linkedinWeek: { limit: 100, near: 90, sentLast7: 0, sentByDay: {}, days: {} }, planWeekLast: null, themeUndo: null,
    priority: { energy: 'top' }, carry: null, extraDays: [], skipDays: [], nextOffDay: '2026-10-19', pool: { total: 0, cap: 30 },
    labels: {}, categories: [], queueRules: { giantsOn: false, giantsHeld: 0, giantsOk: 0, restDays: 14 },
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
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
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
  const waitFor = async (fn, n) => {
    for (let i = 0; i < 150 && count(fn) <= n; i++) await page.waitForTimeout(20);
    assert.ok(count(fn) > n, fn + ' was called');
    await page.waitForTimeout(80);
    return last(fn);
  };

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadWeekPlan === 'function');

  // 1. The tab --------------------------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  const tabs = await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 4), ['LinkedIn', 'Results', 'Week plan', 'Schedule'], 'Week plan sits between Results and Schedule');
  await page.click('#sub-tabs [data-view="weekplan"]');
  await page.waitForSelector('#wp-days [data-wpdrop="2026-10-20"]');
  assert.ok(count('weekBank') >= 1, 'reads weekBank');
  assert.match(await page.textContent('#wp-head'), /Next week · Tue Oct 20 – Thu Oct 22/);
  assert.equal(await page.$$eval('#wp-days .sd-day', (els) => els.length), 3, 'one column per sending day');
  const tue = await page.textContent('#wp-days [data-wpdrop="2026-10-20"]');
  assert.match(tue, /Week list[\s\S]*#1[\s\S]*Celsius[\s\S]*3 going/, 'a list day: its tag and its card with the list rank');
  const wed = await page.textContent('#wp-days [data-wpdrop="2026-10-21"]');
  assert.match(wed, /Best fit adds 7 brands \(26 people\) by itself[\s\S]*Keep it to my list/, 'a day not from the list says what Best fit adds');
  assert.match(await page.textContent('#wp-days [data-wpdrop="2026-10-22"]'), /Energy Drinks/, 'a category day shows its category');
  assert.equal(await page.$$eval('#wp-list .wp-row', (els) => els.length), 40 + 1, 'the first 40 rows (+ the taken-off one in its fold)');
  const list = await page.textContent('#wp-list');
  assert.match(list, /#1[\s\S]*Celsius[\s\S]*Fit 99[\s\S]*On Tue Oct 20/, 'rank, fit, where it sits');
  assert.match(list, /#2[\s\S]*Ghost[\s\S]*added by you/, 'a hand add says so');
  assert.match(list, /Resting Co[\s\S]*rests two weeks/, 'a brand that can’t go says why');
  assert.match(await page.textContent('#wp-listhead'), /Your list[\s\S]*1 added by you · 12 more past the number/);
  await page.click('[data-wpall]');
  assert.equal(await page.$$eval('#wp-list > .wp-rows > .wp-row', (els) => els.length), 60, 'Show all');
  await page.click('[data-wpfilter="cant"]');
  assert.equal(await page.$$eval('#wp-list > .wp-rows > .wp-row', (els) => els.length), 1, 'filter: can’t go yet');
  await page.click('[data-wpfilter="all"]');
  console.log('✓ 1 the tab: week, days, the ranked list, Show all, filters');

  // 2. The number --------------------------------------------------------
  let n = count('weekBankSize');
  await page.fill('[data-wpsize]', '120');
  await page.dispatchEvent('[data-wpsize]', 'change');
  assert.deepEqual((await waitFor('weekBankSize', n)).args, { size: 120 });
  console.log('✓ 2 the number the list holds');

  // 3. Adding ---------------------------------------------------------------
  await page.fill('#wp-q', 'prime');
  await page.waitForSelector('#wp-results [data-wpadd="pm"]');
  assert.equal(last('searchPlanBrands').args.date, '2026-10-20', 'searched for the week’s first day');
  const res = await page.textContent('#wp-results');
  assert.match(res, /Prime Hydration[\s\S]*Add anyway/, 'a giant asks');
  assert.match(res, /Ghost[\s\S]*On your list · #2/, 'a brand on the list says where');
  // Enter: the first row is an Add anyway — nothing; ↓ to the plain add.
  n = count('weekBankAdd');
  await page.press('#wp-q', 'Enter');
  await page.waitForTimeout(150);
  assert.equal(count('weekBankAdd'), n, 'Enter never takes an Add anyway');
  await page.press('#wp-q', 'ArrowDown');
  await page.press('#wp-q', 'Enter');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['pm'], allowGiants: [] }, 'Enter adds the plain add');
  n = count('weekBankAdd');
  await page.click('#wp-results [data-wpadd="pr"]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['pr'], allowGiants: ['pr'] }, 'Add anyway OKs the giant');
  assert.equal(await page.inputValue('#wp-q'), 'prime', 'the search box keeps its text through the refresh');
  await page.fill('#wp-q', '');
  // A category.
  await page.selectOption('#wp-cat', 'energy');
  await page.waitForSelector('#wp-results [data-wpaddtop]');
  assert.equal(last('weekBankBrowse').args.category, 'energy');
  const cat = await page.textContent('#wp-results');
  assert.match(cat, /Energy Drinks[\s\S]*2 set aside[\s\S]*Add the top 2/, 'the top ones not on the list yet');
  assert.match(cat, /Brand 5[\s\S]*On your list · #5/);
  n = count('weekBankAdd');
  await page.click('[data-wpaddtop]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['k1', 'k2'], allowGiants: [] }, 'Add the top N');
  await page.waitForSelector('#wp-results [data-wptick="k3"]');
  await page.check('#wp-results [data-wptick="k3"]');
  await page.check('#wp-results [data-wptick="k1"]');
  await page.waitForSelector('[data-wpaddticked]');
  n = count('weekBankAdd');
  await page.click('[data-wpaddticked]');
  const ticked = (await waitFor('weekBankAdd', n)).args;
  assert.deepEqual([ticked.brandIds.sort(), ticked.allowGiants], [['k1', 'k3'], ['k3']], 'Add N ticked (a ticked giant is OK’d)');
  await page.click('[data-wpcatx]');
  console.log('✓ 3 adding: search (+ Add, Add anyway, Enter), a category (top N, ticks)');

  // 4. Taking off ---------------------------------------------------------------
  n = count('weekBankRemove');
  await page.click('#wp-list [data-wprm="r6"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r6'] }, '× on a waiting row');
  n = count('weekBankRemove');
  const d0 = dialogs.length;
  await page.click('#wp-list [data-wprm="r1"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r1'], offDays: true }, '× on a row on a day takes it off the day too');
  assert.match(dialogs[d0], /Take Celsius off your list and off Tue Oct 20\?/, 'asked first');
  n = count('weekBankPutBack');
  await page.click('#wp-list details summary');
  await page.click('[data-wpputback="gone1"]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['gone1'] });
  console.log('✓ 4 taking off, and Put back');

  // 5. The spread -------------------------------------------------------------------
  n = count('weekSpread');
  await page.click('[data-wpspread]');
  const pv1 = (await waitFor('weekSpread', n)).args;
  assert.equal(pv1.apply, undefined, 'a preview first');
  assert.ok(Number.isFinite(pv1.seed), 'with a seed');
  await page.waitForSelector('#wp-head .wp-pv');
  const pvText = await page.textContent('#wp-head .wp-pv');
  assert.match(pvText, /6 brands, 18 people[\s\S]*50 brands wait on the list for next week[\s\S]*only brands from your list/);
  assert.match(pvText, /Passed over: #4 Big Brew \(too big for the room left \(10 people\)\)/);
  assert.equal(await page.$$eval('#wp-days .wp-new', (els) => els.length), 6, 'the new cards on their days');
  let seeds = new Set([pv1.seed]);
  for (let i = 0; i < 3; i++) {
    n = count('weekSpread');
    await page.click('[data-wpshuffle]');
    seeds.add((await waitFor('weekSpread', n)).args.seed);
  }
  assert.ok(seeds.size > 1, 'Shuffle again deals with another seed');
  const shown = await page.evaluate(() => WP.pv.days.map((d) => ({ date: d.date, brandIds: d.add.map((a) => a.id) })));
  n = count('weekSpread');
  await page.click('[data-wpapply]');
  const ap = (await waitFor('weekSpread', n)).args;
  assert.deepEqual({ apply: ap.apply, days: ap.days }, { apply: true, days: shown }, 'Put them on the days sends exactly the preview');
  await page.waitForFunction(() => /Put 6 brands \(18 people\) on 3 days/.test(document.getElementById('wp-head').textContent));
  assert.equal(await page.$('#wp-head .wp-pv'), null, 'the preview is gone');
  n = count('undoWeekSpread');
  const d1 = dialogs.length;
  await page.click('[data-wpundo]');
  for (let i = 0; i < 100 && count('undoWeekSpread') < n + 2; i++) await page.waitForTimeout(20);
  assert.equal(last('undoWeekSpread').args.preview, undefined, 'Undo applies after the preview');
  assert.equal(calls.filter((c) => c.fn === 'undoWeekSpread')[n].args.preview, true, 'Undo previews first');
  assert.match(dialogs[d1], /Brand 5 \(Tue Oct 20\)[\s\S]*Stays where it is[\s\S]*Celsius[\s\S]*Best fit fills the open spots again on: Tue Oct 20/, 'Undo names what changes');
  console.log('✓ 5 the spread: preview, shuffle, apply exactly the preview, Undo asks first');

  // 6. Moving -----------------------------------------------------------------------
  n = count('planMoveBrand');
  await page.selectOption('#wp-days [data-wpmove="r1"]', '2026-10-22');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-22' }, 'Move to…');
  n = count('planRemoveBrand');
  await page.selectOption('#wp-days [data-wpmove="r1"]', '__off');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, 'Off the days');
  n = count('planRemoveBrand');
  await page.click('#wp-days [data-wpoff="r1"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, '× on a card');
  n = count('planMoveBrand');
  await page.dragAndDrop('#wp-days [data-wpdrag="r1"]', '#wp-days [data-wpdrop="2026-10-21"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-21' }, 'drag between days');
  n = count('planAddBrands');
  await page.selectOption('#wp-list [data-wpput="r7"]', '2026-10-21');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-21', brandIds: ['r7'] }, 'Put on…');
  n = count('planAddBrands');
  // Both on screen at once (a real drag scrolls the page as it goes).
  await page.setViewportSize({ width: 1400, height: 2600 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.dragAndDrop('#wp-list [data-wpdrag="r8"]', '#wp-days [data-wpdrop="2026-10-22"]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-22', brandIds: ['r8'] }, 'a list row dragged onto a day');
  await page.setViewportSize({ width: 1400, height: 900 });
  n = count('setListDay');
  await page.click('#wp-days [data-wplist="2026-10-21"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-21', on: true }, 'Keep it to my list');
  n = count('setListDay');
  await page.click('#wp-days [data-wplist="2026-10-20"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-20', on: false }, 'Let Best fit fill open spots');
  console.log('✓ 6 moving between days, off, onto a day; a day kept to the list or not');

  // 7. The Schedule ----------------------------------------------------------------------
  await page.evaluate(() => gotoView('schedule'));
  await page.waitForSelector('#sched-days [data-drop="2026-10-20"]');
  const sTue = await page.textContent('#sched-days [data-drop="2026-10-20"]');
  assert.match(sTue, /Week list[\s\S]*Takes only your week list/, 'a list day says so');
  assert.equal(await page.$('#sched-days [data-sdcatsel="2026-10-20"]'), null, 'no category menu on a list day');
  assert.ok(await page.$('#sched-days [data-sdcatsel="2026-10-21"]'), 'a Best fit day keeps its menu');
  assert.match(await page.textContent('#sched-days [data-sdfillbox="2026-10-20"]'), /From your week list \(1\)/, 'its Fill box offers the list');
  n = count('setListDay');
  await page.click('#sched-days [data-drop="2026-10-20"] .sd-day-h summary');
  await page.click('#sched-days [data-sdlistoff="2026-10-20"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-20', on: false }, '⋯ → Let Best fit fill its open spots');
  await page.click('#sched-days [data-drop="2026-10-20"] [data-sdweekplan]');
  await page.waitForFunction(() => document.getElementById('weekplan').classList.contains('active'));
  console.log('✓ 7 the Schedule: list days marked, the Fill box from the list, back to Week plan');

  // 8. A phone ------------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => loadWeekPlan());
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, 'no sideways scroll on a phone (' + over + 'px)');
  console.log('✓ 8 a phone: no sideways scroll');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All Week plan checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
