// scripts/test-week-plan.js
//
// Outreach → Week plan (Leo, Oct 18 2026: a list of ~100 brands, the top
// by Brand Fit plus what he adds by search or category, spread onto the
// week's days as an even mix of rank, then moved between days; "make sure
// that adding and removing brands does not glitch"; then "i want the brands
// to be the entire page … make it easier for brands that i add", "filters
// for brands that i have and have not reached out to", and "recommend for me
// to reach out to brands again if there are decision makers who i did not
// reach out to yet … around 1 to 2 weeks later"). Drives public/app.html in
// Chromium against a fake /api/data:
//
//   1. The tab sits between Results and Schedule. The week is a strip of day
//      tiles that stays in view while the page scrolls; the brands fill the
//      page as a grid of big cards in three parts — Added by you, Reach out
//      again, Top by Brand Fit (40 then Show more); status filters. A tile
//      opens its day over the list (the list doesn't move); Esc closes it.
//   2. The number: changing it asks weekBankSize.
//   3. Adding: search results fill the page — + Add to list, a giant's Add
//      anyway (allowGiants), Enter only for a plain add, "Added ✓" in place,
//      and a button per day that adds it AND puts it on that day; a brand on
//      the list shows its list card, one due again its reach-again card; a
//      category — Add the top N, ticks → Add N ticked; × Back to your list.
//   4. The Outreach filter: Reached out / Not reached out over the list,
//      the reach-again part and search results.
//   5. Reach out again: the card says when, who was never contacted and how
//      late; a day button = reachAgain (on that day at once); its lit button
//      takes it off; dragged onto a day tile it goes too.
//   6. No glitches: a day button shows the brand on that day at once (before
//      the server answers) and the card stays where it is on screen through
//      the refresh; Remove leaves the card in its place with Undo (PutBack);
//      a brand on a day asks first and comes off the day too.
//   7. The spread: a preview (a seed) over the list names each day's new
//      brands, the tiles count them; Shuffle again deals with another seed;
//      Put them on the days sends exactly the previewed days; Undo asks first.
//   8. Moving: → day on an open day's card, the day buttons on a list card
//      (planMoveBrand), the lit day button again or ↩ Back to list
//      (planRemoveBrand), a day button on a waiting brand (planAddBrands);
//      drag a list card onto a tile, a tile's brand onto another tile, an
//      open day's card back onto the list; Only my list / Let Best fit fill.
//   9. The Schedule: a day spread from the list says so (tag, no category
//      menu, ⋯ → Let Best fit fill its open spots), and its Fill box offers
//      the list.
//  10. A phone: the week first, then the brands; no sideways scroll.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-week-plan.js   (~10s)

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
  how: 'auto', addedAt: null, reached: false, where: 'waiting', day: null, why: null, linkedinUrl: null, website: null, externalId: null,
}, over || {});

function bank() {
  const rows = [];
  for (let i = 1; i <= 60; i++) rows.push(row(i));
  rows[0] = row(1, { name: 'Celsius', where: 'day', day: '2026-10-20' });
  rows[1] = row(2, { name: 'Ghost', how: 'hand', reached: true, addedAt: '2026-10-18T14:00:00Z' });
  rows[2] = row(3, { name: 'Resting Co', where: 'cant', why: 'Reached out (Oct 10) — it rests a week, until Fri Oct 17.', going: 0 });
  rows[3] = row(4, { name: 'Big Brew', big: true, going: 10 });
  return rows;
}
const againRow = (id, over) => Object.assign({
  id, name: 'Again ' + id, category: 'energy', tier: 'growth', fit: 72, label: label('ready', 6),
  state: 'due', last: '2026-10-09', daysSince: 9, dueBy: '2026-10-23',
  fresh: [{ id: id + 'c1', name: 'Dana Lee', title: 'Head of Partnerships' }, { id: id + 'c2', name: 'Sam Roe', title: 'Events Lead' }],
  freshTotal: 2, going: 2, invited: 3, emailed: 0, pinnedOn: null, inToday: false, big: false,
  linkedinUrl: null, website: null, externalId: null,
}, over || {});

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
  again: { rows: [], total: 2, due: 1, late: 1, fromDays: 7, dueDays: 14 },
  spreadLast: { at: '2026-10-18T15:00:00Z', days: [{ date: '2026-10-20', added: 1 }] },
  cap: 30,
  linkedin: { limit: 100, sentLast7: 0 },
  priority: { energy: 'top', cpg: 'middle' },
};

const OFF = new Set();
// Where the reach-again brands sit (reachAgain / planMoveBrand / planRemoveBrand keep it).
const AGAIN_ON = {};
// Handlers answered late, to see the page before the server answers.
const SLOW = { fn: '', ms: 0 };
const brief = (r) => ({ id: r.id, rank: r.rank, name: r.name, category: r.category, fit: r.fit, label: r.label, going: r.going, people: r.people, big: r.big, how: r.how });

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  // Taken off stays off until put back (the server's own rule).
  weekBank: () => {
    const again = [
      againRow('ag1', { name: 'Liquid Again', pinnedOn: AGAIN_ON.ag1 || null }),
      againRow('ag2', { name: 'Late Labs', state: 'late', daysSince: 19, last: '2026-09-29', dueBy: '2026-10-13', fit: 60, freshTotal: 5,
        fresh: [1, 2, 3, 4, 5].map((i) => ({ id: 'l' + i, name: 'Lee ' + i, title: 'Marketing Manager' })), going: 3, pinnedOn: AGAIN_ON.ag2 || null }),
    ];
    const days = WEEK.days.map((d) => Object.assign({}, d, {
      pinned: d.pinned.concat(again.filter((a) => a.pinnedOn === d.date).map((a) => ({ id: a.id, name: a.name, category: a.category, state: 'going', going: a.going, waits: null, people: a.fresh.slice(0, a.going), big: false }))),
    }));
    return Object.assign({}, WEEK, { days, again: Object.assign({}, WEEK.again, { rows: again }),
      bank: Object.assign({}, WEEK.bank, { rows: WEEK.bank.rows.filter((r) => !OFF.has(r.id)) }) });
  },
  reachedBrands: () => ({ brands: {
    r2: ['2026-09-20', '2026-09-22', 'a', 2, 1], r3: ['2026-10-01', '2026-10-10', 'i', 3, 0],
    ag1: ['2026-10-01', '2026-10-09', 'i', 3, 0], ag2: ['2026-09-20', '2026-09-29', 'i', 2, 0],
  } }),
  weekBankSize: ({ size }) => ({ ok: true, size }),
  weekBankAdd: ({ brandIds }) => ({ ok: true, added: brandIds.map((id) => ({ id, name: id })), already: 0, refused: [] }),
  weekBankRemove: ({ brandIds }) => { brandIds.forEach((id) => OFF.add(id)); return { ok: true, removed: brandIds.length, offDays: [] }; },
  weekBankPutBack: ({ brandIds }) => { brandIds.forEach((id) => OFF.delete(id)); return { ok: true, back: brandIds.length }; },
  weekBankBrowse: ({ category }) => ({ category, date: '2026-10-20', setAside: 2, total: 14, brands: [
    { id: 'k1', name: 'Kin One', category, action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 70 }, going: 3, reached: false },
    { id: 'k2', name: 'Kin Two', category, action: 'add', text: '4 would go out', label: label('ready', 4), fit: { score: 64 }, going: 4, reached: false },
    { id: 'k3', name: 'Kin Giant', category, action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 5), fit: { score: 50 }, going: 5, reached: false },
    { id: 'r5', name: 'Brand 5', category, action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 95 }, going: 3, reached: false },
  ] }),
  searchPlanBrands: ({ q }) => ({ brands: /prime/i.test(q) ? [
    { id: 'pr', name: 'Prime Hydration', category: 'electrolytes', action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 6), fit: { score: 55 }, going: 6, reached: false },
    { id: 'pm', name: 'Primal Kitchen', category: 'cpg', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 61 }, going: 3, reached: false },
    { id: 'r2', name: 'Ghost', category: 'energy', action: 'add', text: '3 would go out', label: label('ready', 4), fit: { score: 98 }, reached: true },
    { id: 'ag1', name: 'Liquid Again', category: 'energy', action: 'addAnyway', text: 'Invited Oct 9 · already reached', label: label('ready', 6), fit: { score: 72 }, reached: true },
  ] : [] }),
  reachAgain: ({ brandId, date }) => { AGAIN_ON[brandId] = date; return { ok: true, brandId, brandName: brandId === 'ag1' ? 'Liquid Again' : 'Late Labs', date, label: date, people: [{ name: 'Dana Lee' }, { name: 'Sam Roe' }], going: 2, state: 'going' }; },
  weekSpread: (a) => {
    if (a.apply) return { ok: true, days: a.days.map((d) => ({ date: d.date, label: d.date, ok: true, added: d.brandIds.length, people: d.brandIds.length * 3, waits: [], refused: [], elsewhere: [] })) };
    const rows = bank();
    const odd = a.seed % 2;
    return {
      ok: true, seed: a.seed, week: '2026-10-19', which: 'next',
      days: WEEK.days.map((d, i) => Object.assign({}, d, {
        add: [rows[4 + ((i + odd) % 3)], rows[7 + i]].map(brief),
        addPeople: 6, total: d.keptPeople + 6,
      })),
      placed: 6, people: 18, waitNext: 50,
      passedOver: [Object.assign(brief(rows[3]), { why: 'too big for the room left (10 people)' })], cantGo: 1,
    };
  },
  undoWeekSpread: ({ preview }) => ({ ok: true, preview: !!preview, off: [{ name: 'Brand 5', day: 'Tue Oct 20' }], stays: ['Celsius'], unmark: ['Tue Oct 20'] }),
  setListDay: ({ date, on }) => ({ ok: true, date, list: on !== false }),
  planMoveBrand: ({ brandId, from, to }) => { if (AGAIN_ON[brandId]) AGAIN_ON[brandId] = to; return { ok: true, from, to, unqueued: 0, result: { brandId, added: true, state: 'going', going: 3 } }; },
  planRemoveBrand: ({ brandId }) => { delete AGAIN_ON[brandId]; return { ok: true, unqueued: 0 }; },
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
    labels: {}, categories: [], queueRules: { giantsOn: false, giantsHeld: 0, giantsOk: 0, restDays: 7 },
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
      if (SLOW.fn === fn) await new Promise((r) => setTimeout(r, SLOW.ms));
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
  const top = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().top);
  const cardOf = (id) => '#wp-list [data-wpid="' + id + '"]';
  const settle = () => page.waitForFunction(() => WP.writes === 0).then(() => page.waitForTimeout(150));

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadWeekPlan === 'function');

  // 1. The tab --------------------------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  const tabs = await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 4), ['LinkedIn', 'Results', 'Week plan', 'Schedule'], 'Week plan sits between Results and Schedule');
  await page.click('#sub-tabs [data-view="weekplan"]');
  await page.waitForSelector('#wp-strip [data-wptile="2026-10-20"]');
  assert.ok(count('weekBank') >= 1, 'reads weekBank');
  assert.match(await page.textContent('#wp-weekhead'), /The week[\s\S]*Next week · Tue Oct 20 – Thu Oct 22[\s\S]*3\s*of 90 spots planned/);
  assert.equal(await page.$$eval('#wp-strip .wp-tile', (els) => els.length), 3, 'a tile per sending day');
  assert.match(await page.textContent('[data-wptile="2026-10-20"]'), /Tue Oct 20[\s\S]*Your list only[\s\S]*3\s*\/ 30[\s\S]*Celsius[\s\S]*27 open[\s\S]*1 brand/, 'a list day: its tag, how full, its brands');
  assert.match(await page.textContent('[data-wptile="2026-10-21"]'), /★ Best fit[\s\S]*Nothing yet[\s\S]*\+ 7 Best fit/, 'a Best fit day');
  assert.match(await page.textContent('[data-wptile="2026-10-22"]'), /Energy Drinks/, 'a category day shows its category');
  // The brands fill the page: a grid several cards wide, as wide as the page.
  const grid = await page.evaluate(() => {
    var sec = document.getElementById('weekplan').getBoundingClientRect();
    var list = document.getElementById('wp-listpane').getBoundingClientRect();
    var bar = document.getElementById('wp-bar').getBoundingClientRect();
    var cards = [].slice.call(document.querySelectorAll('#wp-list .wp-sec:last-of-type .wp-b')).slice(0, 6).map(function (c) { return Math.round(c.getBoundingClientRect().top); });
    return { wide: list.width >= bar.width - 2 && list.width > sec.width * 0.85, perRow: cards.filter(function (t) { return t === cards[0]; }).length };
  });
  assert.ok(grid.wide, 'the brands take the page’s width');
  assert.ok(grid.perRow >= 3, 'several cards a row (' + grid.perRow + ')');
  const secs = await page.$$eval('#wp-list .wp-sec h3', (els) => els.map((e) => e.textContent));
  assert.deepEqual(secs, ['Added by you', 'Reach out again', 'Top by Brand Fit'], 'three parts');
  assert.equal(await page.$$eval('#wp-list .wp-sec:last-of-type .wp-b', (els) => els.length), 40, 'the first 40 of the top');
  const big = await page.$eval('#wp-list .wp-b .wp-b-name', (el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(big >= 17, 'brand names are big (' + big + 'px)');
  assert.match(await page.textContent(cardOf('r1')), /#1[\s\S]*Celsius[\s\S]*99[\s\S]*Energy Drinks[\s\S]*3 people[\s\S]*Ready · 4 reachable[\s\S]*On Tue Oct 20 ✓[\s\S]*✓ Tue[\s\S]*\+ Wed[\s\S]*\+ Thu[\s\S]*Remove/, 'rank, name, fit, category, people, contacts, where, day buttons, Remove');
  await page.waitForFunction(() => /Reached Sep 22/.test(document.querySelector('#wp-list [data-wpid="r2"]').textContent));
  assert.match(await page.textContent(cardOf('r2')), /Ghost[\s\S]*added by you[\s\S]*Reached Sep 22[\s\S]*Waiting for a day/, 'a hand add says so, with its Reached tag');
  assert.match(await page.textContent(cardOf('r3')), /Resting Co[\s\S]*rests a week/, 'a brand that can’t go says why, and has no day buttons');
  assert.equal(await page.$(cardOf('r3') + ' [data-wpput]'), null);
  assert.match(await page.textContent('#wp-listhead'), /Your list[\s\S]*60[\s\S]*brands[\s\S]*1 added by you · 12 more would come in[\s\S]*2 brands to reach out to again/);
  await page.click('[data-wpmore]');
  assert.equal(await page.$$eval('#wp-list .wp-sec:last-of-type .wp-b', (els) => els.length), 59, 'Show more');
  await page.click('[data-wpfilter="cant"]');
  assert.equal(await page.$$eval('#wp-list .wp-b', (els) => els.length), 1, 'filter: can’t go yet');
  await page.click('[data-wpfilter="all"]');
  // The strip stays in view while the page scrolls, slim once it sticks —
  // and going slim never moves the brands under it.
  const docTop = () => page.$eval(cardOf('r20'), (el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  const y0 = await docTop();
  const full = await page.$eval('#wp-bar', (el) => el.offsetHeight);
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(120);
  const bar = await page.evaluate(() => { var b = document.getElementById('wp-bar'); var r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, slim: b.classList.contains('compact'), h: b.offsetHeight }; });
  assert.ok(bar.top >= 0 && bar.top < 200 && bar.bottom < 420, 'the week stays in view (' + bar.top + '–' + bar.bottom + ')');
  assert.ok(bar.slim && bar.h < full - 40, 'slim once it sticks (' + full + ' → ' + bar.h + ')');
  assert.ok(Math.abs((await docTop()) - y0) < 1, 'going slim never moves the brands');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  assert.equal(await page.$eval('#wp-bar', (el) => el.classList.contains('compact')), false, 'full again at the top');
  assert.ok(Math.abs((await docTop()) - y0) < 1);
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(120);
  // A tile opens its day over the list; the list doesn't move.
  const firstCard = await page.evaluate(() => { var els = document.querySelectorAll('#wp-list .wp-b'); for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.top > 520) return els[i].getAttribute('data-wpid'); } return ''; });
  const t0 = await top(cardOf(firstCard));
  await page.click('[data-wptile="2026-10-20"]');
  await page.waitForSelector('#wp-dayopen:not([hidden]) [data-wpmove="r1"]');
  assert.match(await page.textContent('#wp-dayopen'), /Tue Oct 20[\s\S]*Your list only[\s\S]*#1[\s\S]*Celsius[\s\S]*3 going[\s\S]*→ Wed[\s\S]*→ Thu[\s\S]*Back to list[\s\S]*Let Best fit fill the open spots/, 'the open day: its brands with move buttons');
  assert.equal(await top(cardOf(firstCard)), t0, 'opening a day never moves the list');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#wp-dayopen[hidden]', { state: 'attached' });
  await page.click('[data-wptile="2026-10-21"]');
  assert.match(await page.textContent('#wp-dayopen'), /Wed Oct 21[\s\S]*Nothing on Wed yet[\s\S]*Best fit adds 7 brands \(26 people\) by itself[\s\S]*Only my list/, 'a day not from the list says what Best fit adds');
  await page.click('[data-wpclose]');
  await page.waitForSelector('#wp-dayopen[hidden]', { state: 'attached' });
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('✓ 1 the tab: a strip of days that stays in view, the brands as a full-page grid in three parts, a day opens over the list');

  // 2. The number --------------------------------------------------------
  let n = count('weekBankSize');
  await page.fill('[data-wpsize]', '120');
  await page.dispatchEvent('[data-wpsize]', 'change');
  assert.deepEqual((await waitFor('weekBankSize', n)).args, { size: 120 });
  console.log('✓ 2 the number the list holds');

  // 3. Adding ---------------------------------------------------------------
  await page.fill('#wp-q', 'prime');
  await page.waitForSelector('#wp-list [data-wpadd="pm"]');
  assert.equal(last('searchPlanBrands').args.date, '2026-10-20', 'searched for the week’s first day');
  assert.match(await page.textContent('#wp-filters'), /Results for “prime”[\s\S]*Back to your list/);
  assert.match(await page.textContent(cardOf('pr')), /Prime Hydration[\s\S]*Add anyway[\s\S]*\+ Tue[\s\S]*\+ Wed[\s\S]*\+ Thu/, 'a giant asks; it has day buttons too');
  assert.ok(await page.$(cardOf('r2') + ' [data-wprm]'), 'a brand on the list shows its list card');
  assert.match(await page.textContent(cardOf('ag1')), /Liquid Again[\s\S]*Never contacted[\s\S]*Dana Lee/, 'a brand due again shows its reach-again card');
  n = count('weekBankAdd');
  await page.press('#wp-q', 'Enter');
  await page.waitForTimeout(150);
  assert.equal(count('weekBankAdd'), n, 'Enter never takes an Add anyway');
  await page.press('#wp-q', 'ArrowDown');
  await page.press('#wp-q', 'Enter');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['pm'], allowGiants: [] }, 'Enter adds the plain add');
  await page.waitForFunction(() => /Primal Kitchen[\s\S]*Added ✓/.test(document.getElementById('wp-list').textContent));
  n = count('weekBankAdd');
  await page.click('#wp-list [data-wpadd="pr"]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['pr'], allowGiants: ['pr'] }, 'Add anyway OKs the giant');
  assert.equal(await page.inputValue('#wp-q'), 'prime', 'the search box keeps its text through the refresh');
  // A day button: on the list AND on that day, one click.
  await settle();
  WP_ADDED: {
    H.searchPlanBrands = ((orig) => (a) => { const r = orig(a); r.brands.push({ id: 'pz', name: 'Prime Zest', category: 'cpg', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 58 }, going: 3, reached: false }); return r; })(H.searchPlanBrands);
    await page.fill('#wp-q', 'prime ');
    await page.waitForSelector('#wp-list [data-wpaddday="pz"][data-wpto="2026-10-21"]');
    const na = count('weekBankAdd'), np = count('planAddBrands');
    await page.click('#wp-list [data-wpaddday="pz"][data-wpto="2026-10-21"]');
    assert.ok(await page.$('[data-wptile="2026-10-21"] [data-wpdrag="pz"]'), 'on the Wed tile at once');
    assert.deepEqual((await waitFor('weekBankAdd', na)).args, { brandIds: ['pz'], allowGiants: [] }, 'added to the list');
    assert.deepEqual((await waitFor('planAddBrands', np)).args, { date: '2026-10-21', brandIds: ['pz'], allowGiants: [] }, 'and put on Wed');
  }
  await page.click('[data-wpclear]');
  assert.equal(await page.inputValue('#wp-q'), '', '× Back to your list clears the search');
  await page.waitForSelector('#wp-list .wp-b [data-wprm]');
  // A category.
  await page.selectOption('#wp-cat', 'energy');
  await page.waitForSelector('#wp-filters [data-wpaddtop]');
  assert.equal(last('weekBankBrowse').args.category, 'energy');
  assert.match(await page.textContent('#wp-filters'), /Energy Drinks[\s\S]*Add the top 2[\s\S]*Back to your list[\s\S]*2 set aside/, 'the top ones not on the list yet');
  assert.ok(await page.$(cardOf('r5') + ' [data-wprm]'), 'one on the list shows its list card');
  assert.ok(await page.$(cardOf('k1') + ' [data-wpaddday="k1"]'), 'day buttons on a category’s brands');
  n = count('weekBankAdd');
  await page.click('[data-wpaddtop]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['k1', 'k2'], allowGiants: [] }, 'Add the top N');
  await page.waitForSelector('#wp-list [data-wptick="k3"]');
  assert.equal(await page.$('#wp-list [data-wptick="k1"]'), null, 'an added one has no tick any more');
  await page.check('#wp-list [data-wptick="k3"]');
  await page.waitForSelector('[data-wpaddticked]');
  n = count('weekBankAdd');
  await page.click('[data-wpaddticked]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['k3'], allowGiants: ['k3'] }, 'Add N ticked (a ticked giant is OK’d)');
  await page.click('[data-wpcatx]');
  await page.waitForSelector('#wp-list .wp-b [data-wprm]');
  console.log('✓ 3 adding: search and categories fill the page, + Add to list, Add anyway, Enter, a day button adds and places in one click');

  // 4. The Outreach filter ----------------------------------------------------
  await page.selectOption('#wp-filters select[data-reachf="weekplan"]', 'yes');
  await page.waitForTimeout(80);
  let ids = await page.$$eval('#wp-list .wp-b', (els) => els.map((e) => e.getAttribute('data-wpid')));
  assert.deepEqual(ids, ['r2', 'ag1', 'ag2'], 'Reached out: the reached hand add and the brands to reach again');
  assert.match(await page.textContent('#wp-filters'), /Reached out \(3\)[\s\S]*Not reached out \(59\)/, 'with counts');
  await page.selectOption('#wp-filters select[data-reachf="weekplan"]', 'no');
  await page.waitForTimeout(80);
  ids = await page.$$eval('#wp-list .wp-b', (els) => els.map((e) => e.getAttribute('data-wpid')));
  assert.ok(!ids.includes('r2') && !ids.includes('ag1') && ids.includes('r1'), 'Not reached out: never reached only');
  assert.deepEqual(await page.$$eval('#wp-list .wp-sec h3', (els) => els.map((e) => e.textContent)), ['Top by Brand Fit'], 'no Reach out again part');
  await page.fill('#wp-q', 'prime');
  await page.waitForSelector(cardOf('pm'));
  assert.equal(await page.$(cardOf('ag1')), null, 'the filter runs over search results too');
  await page.click('[data-wpclear]');
  await page.selectOption('#wp-filters select[data-reachf="weekplan"]', '');
  await page.waitForSelector(cardOf('ag1'));
  console.log('✓ 4 the Outreach filter: reached out / not reached out over the list, reach again and search');

  // 5. Reach out again ----------------------------------------------------------
  const ag1 = await page.textContent(cardOf('ag1'));
  assert.match(ag1, /Liquid Again[\s\S]*72[\s\S]*Energy Drinks[\s\S]*due by Fri Oct 23[\s\S]*Last outreach Fri Oct 9 \(9 days ago\) · 3 invites · no answer yet[\s\S]*Never contacted — they decide:[\s\S]*Dana Lee — Head of Partnerships[\s\S]*Sam Roe — Events Lead[\s\S]*2 people go on the day you pick[\s\S]*\+ Tue[\s\S]*\+ Wed[\s\S]*\+ Thu/, 'when, who, how many, a button per day');
  assert.match(await page.textContent(cardOf('ag2')), /Late Labs[\s\S]*late · 19 days[\s\S]*\+2 more on file/, 'a late one says so, and how many more');
  assert.match(await page.textContent('#wp-list .wp-sec:nth-of-type(2)'), /1 to 2 weeks after the last outreach · 1 late/);
  SLOW.fn = 'reachAgain'; SLOW.ms = 600;
  n = count('reachAgain');
  await page.click(cardOf('ag1') + ' [data-wpagain="ag1"][data-wpto="2026-10-21"]');
  await page.waitForTimeout(100);
  assert.match(await page.textContent(cardOf('ag1')), /On Wed Oct 21 ✓/, 'on Wed at once');
  assert.ok(await page.$('[data-wptile="2026-10-21"] [data-wpdrag="ag1"]'), 'on the Wed tile at once');
  assert.deepEqual((await waitFor('reachAgain', n)).args, { brandId: 'ag1', date: '2026-10-21' }, 'reachAgain for that day');
  SLOW.fn = '';
  await settle();
  assert.ok(await page.$(cardOf('ag1') + ' .wp-daybtn.on[data-wpto="2026-10-21"]'), 'still on Wed after the read');
  await page.click('[data-wptile="2026-10-21"]');
  assert.match(await page.textContent('#wp-dayopen'), /Liquid Again[\s\S]*reach again[\s\S]*Off the day/, 'on the open day, tagged');
  await page.click('[data-wpclose]');
  n = count('planRemoveBrand');
  await page.click(cardOf('ag1') + ' [data-wpagain="ag1"][data-wpto="2026-10-21"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-21', brandId: 'ag1' }, 'its lit day again takes it off');
  await settle();
  n = count('reachAgain');
  await page.dragAndDrop(cardOf('ag2'), '[data-wptile="2026-10-22"]');
  assert.deepEqual((await waitFor('reachAgain', n)).args, { brandId: 'ag2', date: '2026-10-22' }, 'dragged onto Thu');
  await settle();
  n = count('planRemoveBrand');
  await page.click(cardOf('ag2') + ' [data-wpagain="ag2"][data-wpto="2026-10-22"]');
  await waitFor('planRemoveBrand', n);
  await settle();
  console.log('✓ 5 reach out again: when, who and how late; a day button or a drag puts them on that day, at once');

  // 6. No glitches ---------------------------------------------------------------
  // A day button: on that day at once, before the server answers; the card
  // stays where it is on screen through the refresh.
  const r9 = cardOf('r9') + ' [data-wpput="r9"][data-wpto="2026-10-21"]';
  await page.$eval(cardOf('r9'), (el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 520));
  await page.waitForTimeout(50);
  const keptY = await page.evaluate(() => window.scrollY);
  assert.ok(keptY > 300, 'scrolled down the page (' + keptY + ')');
  const before = await top(cardOf('r9'));
  SLOW.fn = 'planAddBrands'; SLOW.ms = 700;
  n = count('planAddBrands');
  await page.click(r9);
  await page.waitForTimeout(120);
  const mid = await page.$eval(r9, (el) => ({ on: el.classList.contains('on'), card: el.closest('.wp-b').textContent, top: el.closest('.wp-b').getBoundingClientRect().top }));
  assert.ok(mid.on && /On Wed Oct 21 ✓/.test(mid.card), 'on Wed at once, before the server answers');
  assert.ok(await page.$('[data-wptile="2026-10-21"] [data-wpdrag="r9"]'), 'on the Wed tile at once');
  assert.ok(Math.abs(mid.top - before) < 2, 'the card didn’t move (' + before + ' → ' + mid.top + ')');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-21', brandIds: ['r9'] });
  SLOW.fn = '';
  await settle();
  assert.ok(Math.abs((await top(cardOf('r9'))) - before) < 2, 'still in the same place after the refresh');
  // Remove: the card stays in its place with Undo.
  const r12 = await top(cardOf('r12'));
  n = count('weekBankRemove');
  await page.click(cardOf('r12') + ' [data-wprm="r12"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r12'] }, 'Remove on a waiting brand');
  await settle();
  const ghost = await page.$eval('#wp-list [data-wpundo1="r12"]', (el) => ({ text: el.closest('.wp-b').textContent, top: el.closest('.wp-b').getBoundingClientRect().top }));
  assert.match(ghost.text, /Brand 12[\s\S]*Taken off your list[\s\S]*Undo/, 'it stays in its place with Undo');
  assert.ok(Math.abs(ghost.top - r12) < 2, 'nothing moved up into its place');
  n = count('weekBankPutBack');
  await page.click('#wp-list [data-wpundo1="r12"]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['r12'] }, 'Undo puts it back');
  await page.waitForSelector('#wp-list [data-wprm="r12"]');
  // A brand on a day: asks first, comes off the day too.
  n = count('weekBankRemove');
  const d0 = dialogs.length;
  await page.click('#wp-list [data-wprm="r1"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r1'], offDays: true }, 'Remove on a brand on a day takes it off the day too');
  assert.match(dialogs[d0], /Take Celsius off your list and off Tue Oct 20\?/, 'asked first');
  n = count('weekBankPutBack');
  await page.click('#wp-list [data-wpundo1="r1"]');
  await waitFor('weekBankPutBack', n);
  await page.waitForSelector('#wp-list [data-wprm="r1"]');
  // Taken off earlier: Put back at the bottom.
  n = count('weekBankPutBack');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('#wp-list details.wp-removed summary');
  await page.click('[data-wpputback="gone1"]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['gone1'] });
  await settle();
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('✓ 6 no glitches: shown at once, the card stays put through the refresh, Remove leaves Undo in place');

  // 7. The spread -------------------------------------------------------------------
  n = count('weekSpread');
  await page.click('[data-wpspread]');
  const pv1 = (await waitFor('weekSpread', n)).args;
  assert.equal(pv1.apply, undefined, 'a preview first');
  assert.ok(Number.isFinite(pv1.seed), 'with a seed');
  await page.waitForSelector('#wp-dayopen.pv:not([hidden])');
  const pvText = await page.textContent('#wp-dayopen');
  assert.match(pvText, /Preview[\s\S]*6 brands, 18 people[\s\S]*50 brands wait on the list for next week[\s\S]*only brands from your list/);
  assert.match(pvText, /Tue Oct 20 · \+2 brands, 6 people: #\d+ Brand \d+, #8 Brand 8/, 'each day’s new brands');
  assert.match(pvText, /Passed over: #4 Big Brew \(too big for the room left \(10 people\)\)/);
  assert.match(await page.textContent('[data-wptile="2026-10-21"]'), /\+2 new/, 'the tiles count them');
  assert.match(await page.textContent('#wp-weekhead'), /Preview open below/);
  const seeds = new Set([pv1.seed]);
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
  await page.waitForFunction(() => /Put 6 brands \(18 people\) on 3 days/.test(document.getElementById('wp-weekhead').textContent));
  await page.waitForSelector('#wp-dayopen[hidden]', { state: 'attached' });
  n = count('undoWeekSpread');
  const d1 = dialogs.length;
  await page.click('[data-wpundo]');
  for (let i = 0; i < 100 && count('undoWeekSpread') < n + 2; i++) await page.waitForTimeout(20);
  assert.equal(calls.filter((c) => c.fn === 'undoWeekSpread')[n].args.preview, true, 'Undo previews first');
  assert.equal(last('undoWeekSpread').args.preview, undefined, 'then applies');
  assert.match(dialogs[d1], /Brand 5 \(Tue Oct 20\)[\s\S]*Stays where it is[\s\S]*Celsius[\s\S]*Best fit fills the open spots again on: Tue Oct 20/, 'Undo names what changes');
  await settle();
  console.log('✓ 7 the spread: a preview over the list, the tiles count it, shuffle, apply exactly the preview, Undo asks first');

  // 8. Moving -----------------------------------------------------------------------
  await page.click('[data-wptile="2026-10-20"]');
  await page.waitForSelector('#wp-dayopen [data-wpmove="r1"][data-wpto="2026-10-22"]');
  n = count('planMoveBrand');
  await page.click('#wp-dayopen [data-wpmove="r1"][data-wpto="2026-10-22"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-22' }, '→ Thu on its day card');
  await settle();
  n = count('planMoveBrand');
  await page.click(cardOf('r1') + ' [data-wpput="r1"][data-wpto="2026-10-21"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-21' }, 'another day button on its list card moves it');
  await settle();
  n = count('planRemoveBrand');
  await page.click(cardOf('r1') + ' [data-wpput="r1"][data-wpto="2026-10-20"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, 'its lit day button again takes it off');
  await settle();
  n = count('planRemoveBrand');
  await page.click('#wp-dayopen [data-wpoff="r1"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, '↩ Back to list');
  await settle();
  n = count('planAddBrands');
  await page.click(cardOf('r7') + ' [data-wpput="r7"][data-wpto="2026-10-22"]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-22', brandIds: ['r7'] }, 'a day button on a waiting brand');
  await settle();
  n = count('setListDay');
  await page.click('#wp-dayopen [data-wplist="2026-10-20"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-20', on: false }, 'Let Best fit fill the open spots');
  await settle();
  await page.click('[data-wpclose]');
  await page.waitForSelector('#wp-dayopen[hidden]', { state: 'attached' });
  n = count('planAddBrands');
  await page.dragAndDrop(cardOf('r8'), '[data-wptile="2026-10-22"]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-22', brandIds: ['r8'] }, 'a list card dragged onto a day tile');
  await settle();
  // (The slim bar hides the names: from the top of the page.)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  n = count('planMoveBrand');
  await page.dragAndDrop('[data-wptile="2026-10-20"] [data-wpdrag="r1"]', '[data-wptile="2026-10-21"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-21' }, 'a tile’s brand dragged onto another day');
  await settle();
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(120);
  await page.click('[data-wptile="2026-10-20"]');
  await page.waitForSelector('#wp-dayopen [data-wpdrag="r1"]');
  // A card in view under the open day.
  const under = await page.evaluate(() => {
    var o = document.getElementById('wp-dayopen').getBoundingClientRect().bottom;
    var els = document.querySelectorAll('#wp-list .wp-b');
    for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.top > o + 10 && r.bottom < window.innerHeight) return els[i].getAttribute('data-wpid'); }
    return '';
  });
  assert.ok(under, 'a card in view under the open day');
  n = count('planRemoveBrand');
  await page.dragAndDrop('#wp-dayopen [data-wpdrag="r1"]', cardOf(under));
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, 'an open day’s card dragged back onto the list');
  await settle();
  await page.click('[data-wptile="2026-10-21"]');
  n = count('setListDay');
  await page.click('#wp-dayopen [data-wplist="2026-10-21"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-21', on: true }, 'Only my list');
  await settle();
  await page.keyboard.press('Escape');
  console.log('✓ 8 moving: day buttons, → day, Back to list, drag onto tiles and back; Only my list / Best fit');

  // 9. The Schedule ----------------------------------------------------------------------
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
  console.log('✓ 9 the Schedule: list days marked, the Fill box from the list, back to Week plan');

  // 10. A phone ------------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => loadWeekPlan());
  await page.waitForTimeout(300);
  const phone = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - window.innerWidth,
    weekFirst: document.getElementById('wp-bar').getBoundingClientRect().top < document.getElementById('wp-listpane').getBoundingClientRect().top,
    oneCol: (function () { var c = document.querySelectorAll('#wp-list .wp-b'); return c.length > 1 && Math.round(c[0].getBoundingClientRect().left) === Math.round(c[1].getBoundingClientRect().left); })(),
  }));
  assert.ok(phone.over <= 1, 'no sideways scroll on a phone (' + phone.over + 'px)');
  assert.ok(phone.weekFirst, 'the week first, then the brands');
  assert.ok(phone.oneCol, 'one card a row');
  console.log('✓ 10 a phone: the week first, one card a row, no sideways scroll');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All Week plan checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
