// scripts/test-week-plan.js
//
// Outreach → Week plan, redone Nov 19 2026 (Leo: "it's really crowded, and
// it brings up the same brands over and over again. I want a list, and I
// want it to be easy to add, for each day, the next 100 ranked brands, their
// score, and their category … separate by category or just separate by 1
// through 100. I can press pass … the head banner at the top of it comes
// down and covers some of the page"; his picks: pick the day once and every
// row has one + Add; Reach out again in a view of its own). Drives
// public/app.html in Chromium against a fake /api/data that keeps the
// server's own rule — a brand on a day, passed or removed has left the list
// and the next-ranked one has its place:
//
//   1. The tab sits between Results and Schedule. A row of days (this week's
//      and next week's), the first with room picked; one table — # · Brand ·
//      Score · Category · Would go · + day · Pass — of the brands still
//      waiting; the picked day beside it. Scrolled down, only the table's
//      heading line and the day beside the list stay: nothing over the rows.
//   2. + day: on that day at once (before the server answers), the row keeps
//      its place as "On Tue Oct 20 ✓ · Undo" so the next brand never slides
//      under the mouse, the next-ranked brand comes in at the end, and the
//      kept row leaves once the mouse is off the table. Undo takes it off the
//      day; a refusal puts the row back and says why.
//   3. Picking a day: the + buttons, the rail and ‹ › follow.
//   4. Pass: one click, a month (passBrandToday), the row kept with Undo; the
//      Passed fold brings one back; from the rail it asks first.
//   5. Remove for good: ▾ → asks in the row → weekBankRemove, Undo, Put back.
//   6. The rail: × off the day (back on the list), Move…, only what I put
//      here / Let Best fit fill; Added by you, not waiting.
//   7. By category: a heading per category in priority order, the # its place
//      overall; one category's whole ranking — + day (list AND day), Save to
//      list, a giant's Anyway.
//   8. Reach out again: its own table; + day = reachAgain, Take off, Pass,
//      Show more.
//   9. Search: results in the table; Enter only for a plain add; a list brand
//      shows its list row; a brand due again reaches out again.
//  10. Fill the week: a preview in the page (not over it), Shuffle again, Put
//      them on the days, Undo asks first.
//  11. How many the list shows: weekBankSize.
//  12. The Schedule: a list day says so and links back; a long day beside
//      the list fits the screen and scrolls to its last brand; a page short
//      of room puts the day over the list.
//  13. A phone: the day first, then the brands; no sideways scroll.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-week-plan.js   (~15s)
//      SHOT=/some/dir … also saves screenshots there.

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
const SHOT = process.env.SHOT || '';
const calls = [];
const last = (fn) => calls.filter((c) => c.fn === fn).slice(-1)[0];
const count = (fn) => calls.filter((c) => c.fn === fn).length;

const TUE = '2026-10-20', WED = '2026-10-21', THU = '2026-10-22', THIS_THU = '2026-10-15';
const label = (k, n) => ({ kind: k, reachable: n, need: 3, onFile: n });
const CATS = ['apparel', 'energy', 'cpg'];
const row = (i, over) => Object.assign({
  id: 'r' + i, name: 'Brand ' + i, category: CATS[i % 3], tier: null, fit: 100 - i,
  label: label('ready', 4), going: 3, people: [{ name: 'P' + i, title: 'Marketing' }], big: false,
  addedAt: null, reached: false, linkedinUrl: null, website: null, externalId: null,
}, over || {});

// Every brand the system would pick, best first (66: the list shows 60).
const BASE = [];
for (let i = 1; i <= 66; i++) BASE.push(row(i));
Object.assign(BASE[1], { name: 'Ghost', reached: true, addedAt: '2026-10-12T14:00:00Z' });
Object.assign(BASE[2], { name: 'Thin Co', label: label('thin', 1), going: 1 });
Object.assign(BASE[3], { name: 'Big Brew', big: true, going: 10 });
BASE[9].category = null;
// Brands Leo added that aren't waiting: one on a day, one that can't go.
const PLACED = [
  row(0, { id: 'h1', name: 'Hand On Day', fit: 81, category: 'energy' }),
  row(0, { id: 'h2', name: 'Resting Co', fit: 74, category: 'cpg', going: 0, cant: 'Reached out (Oct 10) — it rests a week, until Fri Oct 17.' }),
];
const OTHER = { c1: row(0, { id: 'c1', name: 'Celsius', fit: 99, category: 'energy' }) };
const HAND = new Set(['r2', 'h1', 'h2']);
const ON = { c1: TUE, h1: WED };       // brandId -> the coming day it sits on
const PASSED = new Set();
const OFF = new Set();
const REFUSE = new Set();              // planAddBrands says no
const AGAIN_ON = {};
let SIZE = 60;
// Handlers answered late, to see the page before the server answers.
const SLOW = { fn: '', ms: 0 };

const againRow = (id, over) => Object.assign({
  id, name: 'Again ' + id, category: 'energy', tier: 'growth', fit: 72, label: label('ready', 6),
  state: 'due', last: '2026-10-05', daysSince: 9, dueBy: '2026-10-19',
  fresh: [{ id: id + 'c1', name: 'Dana Lee', title: 'Head of Partnerships' }, { id: id + 'c2', name: 'Sam Roe', title: 'Events Lead' }],
  freshTotal: 2, going: 2, invited: 3, emailed: 0, pinnedOn: null, inToday: false, big: false,
  linkedinUrl: null, website: null, externalId: null,
}, over || {});
const AGAIN = [
  againRow('ag1', { name: 'Liquid Again' }),
  againRow('ag2', { name: 'Late Labs', state: 'late', daysSince: 19, last: '2026-09-25', dueBy: '2026-10-09', fit: 60, freshTotal: 5, accepted: 1,
    fresh: [1, 2, 3, 4, 5].map((i) => ({ id: 'l' + i, name: 'Lee ' + i, title: 'Marketing Manager' })), going: 3 }),
];
for (let i = 3; i <= 30; i++) AGAIN.push(againRow('ag' + i));

const brandOf = (id) => BASE.concat(PLACED).find((r) => r.id === id) || OTHER[id] || AGAIN.find((a) => a.id === id) || { id, name: id, category: null, fit: null, going: 3, people: [] };
const pin = (id) => { const b = brandOf(id); return { id, name: b.name, category: b.category, state: 'going', going: b.going || 3, waits: null, reasonText: null, people: (b.people || b.fresh || []).slice(0, 4), linkedinUrl: null, website: null, carriedFrom: null, big: !!b.big, fit: b.fit }; };
const FULL = Array.from({ length: 7 }, (_, i) => ({ id: 'f' + i, name: 'Full ' + i, category: 'energy', state: 'going', going: 5, waits: null, reasonText: null, people: [], big: false, fit: 70 }));
const DAYS = [
  { date: THIS_THU, label: 'Thu Oct 15', week: '2026-10-12', which: 'this', list: false, category: 'bestfit', bigs: 0, cap: 35, auto: 0, autoPeople: 0 },
  { date: TUE, label: 'Tue Oct 20', week: '2026-10-19', which: 'next', list: true, category: 'bestfit', bigs: 0, cap: 35, auto: 0, autoPeople: 0 },
  { date: WED, label: 'Wed Oct 21', week: '2026-10-19', which: 'next', list: false, category: 'bestfit', bigs: 0, cap: 35, auto: 7, autoPeople: 26 },
  { date: THU, label: 'Thu Oct 22', week: '2026-10-19', which: 'next', list: false, category: 'energy', bigs: 0, cap: 30, auto: 0, autoPeople: 0 },
];
const LIST_DAY = { [TUE]: true };

// The list as the server builds it: the next SIZE brands still waiting
// (hand adds count), then the hand adds that aren't waiting (rank 0).
function bankRows() {
  const waiting = BASE.filter((r) => !OFF.has(r.id) && !PASSED.has(r.id) && !ON[r.id] && !AGAIN_ON[r.id]);
  const hands = waiting.filter((r) => HAND.has(r.id));
  const autos = waiting.filter((r) => !HAND.has(r.id));
  const room = Math.max(0, SIZE - hands.length);
  let n = 0;
  const list = hands.concat(autos.slice(0, room)).sort((a, b) => b.fit - a.fit)
    .map((r) => Object.assign({}, r, { rank: ++n, how: HAND.has(r.id) ? 'hand' : 'auto', where: 'waiting', day: null, why: null }));
  const placed = BASE.filter((r) => HAND.has(r.id) && ON[r.id]).concat(PLACED)
    .filter((r) => !OFF.has(r.id) && !PASSED.has(r.id))
    .map((r) => Object.assign({}, r, { rank: 0, how: 'hand', where: ON[r.id] ? 'day' : r.cant ? 'cant' : 'waiting', day: ON[r.id] || null, why: r.cant || null }));
  return { rows: list.concat(placed), autoLeft: Math.max(0, autos.length - room) };
}
function weekBank() {
  const again = AGAIN.filter((a) => !PASSED.has(a.id)).map((a) => Object.assign({}, a, { pinnedOn: AGAIN_ON[a.id] || null }));
  const days = DAYS.map((d) => {
    const pinned = (d.date === THIS_THU ? FULL : [])
      .concat(Object.keys(ON).filter((id) => ON[id] === d.date).map(pin))
      .concat(Object.keys(AGAIN_ON).filter((id) => AGAIN_ON[id] === d.date).map(pin));
    return Object.assign({}, d, { list: !!LIST_DAY[d.date], pinned, keptPeople: pinned.reduce((n, p) => n + p.going, 0), room: 0 });
  });
  const b = bankRows();
  return {
    today: '2026-10-14',
    weeks: [{ start: '2026-10-12', which: 'this', days: [THIS_THU], labels: ['Thu Oct 15'] }, { start: '2026-10-19', which: 'next', days: [TUE, WED, THU], labels: ['Tue Oct 20', 'Wed Oct 21', 'Thu Oct 22'] }],
    week: '2026-10-12', which: 'this',
    days,
    bank: { size: SIZE, rows: b.rows, autoLeft: b.autoLeft, hand: b.rows.filter((r) => r.how === 'hand').length,
      waiting: b.rows.filter((r) => r.where === 'waiting').length, onDays: 0,
      removed: [{ id: 'gone1', name: 'Taken Off Co', category: 'cpg', at: '2026-10-13T13:00:00Z' }].concat([...OFF].map((id) => ({ id, name: brandOf(id).name, category: brandOf(id).category, at: '2026-10-14T13:00:00Z' }))),
      passed: [{ id: 'pz', name: 'Old Pass Co', category: 'cpg', until: '2026-11-02T17:00:00Z', reached: false }].concat([...PASSED].map((id) => ({ id, name: brandOf(id).name, category: brandOf(id).category, until: '2026-11-13T17:00:00Z', reached: false }))) },
    again: { rows: again, total: again.length, due: again.filter((a) => a.state === 'due').length, late: again.filter((a) => a.state === 'late').length, fromDays: 7, dueDays: 14 },
    spreadLast: { at: '2026-10-13T15:00:00Z', days: [{ date: TUE, added: 1 }] },
    cap: 35, passDays: 30,
    linkedin: { limit: 100, sentLast7: 0 },
    priority: { energy: 'top', cpg: 'middle', apparel: 'low' },
  };
}
const brief = (r) => ({ id: r.id, rank: r.rank, name: r.name, category: r.category, fit: r.fit, label: r.label, going: r.going, people: r.people, big: r.big, how: r.how });

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  weekBank,
  reachedBrands: () => ({ brands: {
    r2: ['2026-09-20', '2026-09-22', 'a', 2, 1],
    ag1: ['2026-10-01', '2026-10-05', 'i', 3, 0], ag2: ['2026-09-20', '2026-09-25', 'i', 2, 0],
  } }),
  passBrandToday: ({ brandId, on }) => {
    if (on === false) PASSED.delete(brandId); else { PASSED.add(brandId); delete ON[brandId]; delete AGAIN_ON[brandId]; }
    return { id: brandId, name: brandId, passedToday: on !== false, passedUntil: on === false ? null : '2026-11-13T17:00:00Z', passDays: 30, unqueued: 0 };
  },
  weekBankSize: ({ size }) => { SIZE = size; return { ok: true, size }; },
  weekBankAdd: ({ brandIds }) => {
    brandIds.forEach((id) => {
      HAND.add(id);
      if (!BASE.concat(PLACED).some((r) => r.id === id)) {
        const k = KIN.concat(FOUND).find((x) => x.id === id);
        BASE.push(row(0, { id, name: k.name, category: k.category, fit: k.fit.score, going: k.going }));
        BASE.sort((a, b) => b.fit - a.fit);
      }
    });
    return { ok: true, added: brandIds.map((id) => ({ id, name: brandOf(id).name })), already: 0, refused: [], unpassed: [] };
  },
  weekBankRemove: ({ brandIds, offDays }) => { brandIds.forEach((id) => { OFF.add(id); if (offDays) delete ON[id]; }); return { ok: true, removed: brandIds.length, offDays: [] }; },
  weekBankPutBack: ({ brandIds }) => { brandIds.forEach((id) => OFF.delete(id)); return { ok: true, back: brandIds.length }; },
  weekBankBrowse: ({ category, day }) => ({ category, date: day, setAside: 2, total: 14, brands: KIN.map((k) => Object.assign({}, k, { category })) }),
  searchPlanBrands: ({ q }) => ({ brands: /prime/i.test(q) ? FOUND : [] }),
  reachAgain: ({ brandId, date }) => { AGAIN_ON[brandId] = date; return { ok: true, brandId, brandName: brandOf(brandId).name, date, label: date, people: [{ name: 'Dana Lee' }, { name: 'Sam Roe' }], going: 2, state: 'going' }; },
  weekSpread: (a) => {
    if (a.apply) return { ok: true, days: a.days.map((d) => ({ date: d.date, label: d.date, ok: true, added: d.brandIds.length, people: d.brandIds.length * 3, waits: [], refused: [], elsewhere: [] })) };
    const rows = bankRows().rows;
    const odd = a.seed % 2;
    const days = weekBank().days.filter((d) => d.week === a.week);
    return {
      ok: true, seed: a.seed, week: a.week, which: 'next',
      days: days.map((d, i) => Object.assign({}, d, { add: [rows[14 + ((i + odd) % 3)], rows[20 + i]].map(brief), addPeople: 6, total: d.keptPeople + 6 })),
      placed: 6, people: 18, waitNext: 50,
      passedOver: [Object.assign(brief(rows[2]), { why: 'too big for the room left (10 people)' })], cantGo: 1,
    };
  },
  undoWeekSpread: ({ preview }) => ({ ok: true, preview: !!preview, off: [{ name: 'Brand 5', day: 'Tue Oct 20' }], stays: ['Celsius'], unmark: ['Tue Oct 20'] }),
  setListDay: ({ date, on }) => { if (on === false) delete LIST_DAY[date]; else LIST_DAY[date] = true; return { ok: true, date, list: on !== false }; },
  planMoveBrand: ({ brandId, from, to }) => { if (AGAIN_ON[brandId]) AGAIN_ON[brandId] = to; else ON[brandId] = to; return { ok: true, from, to, unqueued: 0, result: { brandId, added: true, state: 'going', going: 3 } }; },
  planRemoveBrand: ({ brandId }) => { delete AGAIN_ON[brandId]; delete ON[brandId]; return { ok: true, unqueued: 0 }; },
  planAddBrands: ({ date, brandIds }) => ({ date, results: brandIds.map((id) => {
    if (REFUSE.has(id)) return { brandId: id, brandName: brandOf(id).name, added: false, reasonText: 'It rests a week, until Fri Oct 23.' };
    ON[id] = date;
    return { brandId: id, brandName: brandOf(id).name, added: true, state: 'going', going: 3 };
  }) }),
  // The Schedule, one list day and one Best fit day.
  getOutreachPlan: () => ({
    stamp: 's1', plan: { [TUE]: { category: null, brandIds: ['c1'] } }, brands: [{ id: 'c1', name: 'Celsius' }], today: '2026-10-14',
    days: [
      { date: TUE, list: true, offTheme: 0, today: false, extra: false, category: 'bestfit', auto: true, cap: 30, bigs: 0, ready: 3, total: 3, over: 0, sent: 0, sentPeople: [],
        pinned: [{ id: 'c1', name: 'Celsius', category: 'energy', state: 'going', going: 3, people: [], waits: null }], brands: [], overflow: [],
        suggest: { category: '', data: { date: TUE, category: '', list: true, hideSmall: true, others: [], needPeople: [], needPeopleTotal: 0, hiddenSmall: 0, ruledOut: 0,
          brands: [{ id: 'r5', name: 'Brand 5', category: 'energy', label: label('ready', 3), fit: { score: 95 }, going: 3, people: [], text: '#5 on your list · 3 would go out', big: false }] } } },
      { date: WED, list: false, offTheme: 0, today: false, extra: false, category: 'bestfit', auto: true, cap: 30, bigs: 0, ready: 30, total: 30, over: 0, sent: 0, sentPeople: [],
        pinned: [], brands: [{ id: 'a1', name: 'Auto One', going: 4, people: [] }], overflow: [] },
    ],
    past: [], linkedinWeek: { limit: 100, near: 90, sentLast7: 0, sentByDay: {}, days: {} }, planWeekLast: null, themeUndo: null,
    priority: { energy: 'top' }, carry: null, extraDays: [], skipDays: [], nextOffDay: '2026-10-19', pool: { total: 0, cap: 30 },
    labels: {}, categories: [], queueRules: { giantsOn: false, giantsHeld: 0, giantsOk: 0, restDays: 7 },
  }),
};
// One category's ranking: two plain adds, a giant, and a brand on the list.
const KIN = [
  { id: 'k1', name: 'Kin One', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 70 }, going: 3, reached: false },
  { id: 'k2', name: 'Kin Two', action: 'add', text: '4 would go out', label: label('ready', 4), fit: { score: 64 }, going: 4, reached: false },
  { id: 'k3', name: 'Kin Giant', action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 5), fit: { score: 50 }, going: 5, reached: false },
  { id: 'r13', name: 'Brand 13', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 87 }, going: 3, reached: false },
];
const FOUND = [
  { id: 'pr', name: 'Prime Hydration', category: 'electrolytes', action: 'addAnyway', giant: true, text: 'A giant (household name) · held back for now', label: label('ready', 6), fit: { score: 55 }, going: 6, reached: false },
  { id: 'pm', name: 'Primal Kitchen', category: 'cpg', action: 'add', text: '3 would go out', label: label('ready', 3), fit: { score: 61 }, going: 3, reached: false },
  { id: 'r2', name: 'Ghost', category: 'energy', action: 'add', text: '3 would go out', label: label('ready', 4), fit: { score: 98 }, reached: true },
  { id: 'ag1', name: 'Liquid Again', category: 'energy', action: 'addAnyway', text: 'Invited Oct 5 · already reached', label: label('ready', 6), fit: { score: 72 }, reached: true },
];

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOT ? 2 : 1 });
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
      if (SLOW.fn === fn) await new Promise((r) => setTimeout(r, SLOW.ms));
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
  const top = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().top);
  const rowOf = (id) => '#wp-list [data-wpid="' + id + '"]';
  const rail = (id) => '#wp-rail [data-wprid="' + id + '"]';
  const text = (sel) => page.textContent(sel);
  const liveRows = () => page.$$eval('#wp-list .wp-row:not(.wp-head):not(.ghost)', (els) => els.length);
  const settle = () => page.waitForFunction(() => WP.writes === 0).then(() => page.waitForTimeout(150));
  // Off the table, and long enough for a kept row to leave (WP_GONE_MS is 400 here).
  const mouseOff = async () => { await page.mouse.move(700, 8); await page.waitForTimeout(650); };
  // Never assert.equal on a handle: a failure would try to print the whole browser object.
  const has = async (sel) => !!(await page.$(sel));
  const shot = async (name) => { if (SHOT) await page.screenshot({ path: path.join(SHOT, name + '.png') }); };
  let n;

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadWeekPlan === 'function');

  // 1. The tab --------------------------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  const tabs = await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 4), ['LinkedIn', 'Results', 'Week plan', 'Schedule'], 'Week plan sits between Results and Schedule');
  await page.click('#sub-tabs [data-view="weekplan"]');
  await page.waitForSelector(rowOf('r1'));
  assert.deepEqual(last('weekBank').args, {}, 'reads weekBank — every coming day, no week picked');
  const names = await page.evaluate(() => ({ energy: CAT_NAMES.energy, cpg: CAT_NAMES.cpg, apparel: CAT_NAMES.apparel }));
  // The days: this week's and next week's, the first with room picked.
  assert.equal(await page.$$eval('#wp-days .wp-day', (els) => els.length), 4, 'a button per coming sending day');
  assert.match(await text('#wp-days'), /Adding to[\s\S]*This week[\s\S]*Thu Oct 15[\s\S]*35\s*\/ 35[\s\S]*Full ✓[\s\S]*Next week[\s\S]*Tue Oct 20[\s\S]*3\s*\/ 35[\s\S]*32 open[\s\S]*1 brand[\s\S]*Thu Oct 22[\s\S]*0\s*\/ 30/);
  assert.equal(await page.getAttribute('[data-wppick="' + TUE + '"]', 'aria-pressed'), 'true', 'the first day with room is picked (Thursday is full)');
  // One table of the brands still waiting.
  assert.ok(!(await has('#wp-bar')), 'the old week bar is gone');
  assert.equal(await page.$$eval('#wp-list .wp-b', (els) => els.length), 0, 'no cards');
  assert.match(await text('#wp-list .wp-head'), /#\s*Brand\s*Score\s*Category\s*Would go/);
  assert.equal(await liveRows(), 60, 'the next 60');
  assert.match(await text('#wp-views'), /1–60\s*By category\s*Reach out again\s*30/);
  assert.match(await text('#wp-filters'), /The next 60 brands by Brand Fit, never reached out to · 1 added by you · 6 more behind them[\s\S]*Show the next/);
  assert.match(await text(rowOf('r1')), new RegExp('^1\\s*Brand 1\\s*99\\s*' + names.energy + '\\s*3 people\\s*\\+ Tue 20\\s*Pass'), 'place, name, score, category, who would go, + the day, Pass');
  await page.waitForFunction(() => /Outreached Sep 22/.test(document.querySelector('#wp-list [data-wpid="r2"]').textContent));
  assert.match(await text(rowOf('r2')), /^2\s*Ghost\s*yours\s*Outreached Sep 22/, 'a brand he added says so, with its Reached tag');
  assert.match(await text(rowOf('r3')), /Thin Co\s*Thin · 1 reachable[\s\S]*1 person/, 'a brand short on people says so');
  assert.doesNotMatch(await text(rowOf('r1')), /Ready ·/, 'a ready brand carries no label');
  assert.match(await text(rowOf('r4')), /Big Brew\s*big[\s\S]*10 people/);
  assert.ok(!(await has(rowOf('c1'))), 'a brand on a day already is not on the list');
  assert.ok(!(await has(rowOf('h1'))), 'nor one he added that sits on a day');
  // The picked day, beside the list.
  assert.match(await text('#wp-rail'), /Tue Oct 20[\s\S]*3\s*\/ 35 people[\s\S]*1 brand[\s\S]*32 open[\s\S]*Celsius\s*99[\s\S]*3 going[\s\S]*Only brands you put here go this day/);
  const lay = await page.evaluate(() => {
    var r = (id) => document.getElementById(id).getBoundingClientRect();
    return { list: r('wp-listpane'), rail: r('wp-rail'), sec: r('weekplan'), name: parseFloat(getComputedStyle(document.querySelector('#wp-list .wp-name')).fontSize) };
  });
  assert.ok(lay.rail.left >= lay.list.right, 'the day sits beside the list, not over it');
  assert.ok(lay.list.width > lay.sec.width * 0.55, 'the list takes most of the page');
  assert.ok(lay.name >= 15, 'brand names are easy to read (' + lay.name + 'px)');
  const cols = await page.evaluate(() => {
    var xs = (sel) => [].slice.call(document.querySelector(sel).children).map((c) => Math.round(c.getBoundingClientRect().left));
    return { head: xs('#wp-list .wp-head'), row: xs('#wp-list [data-wpid="r1"]') };
  });
  assert.deepEqual(cols.head, cols.row, 'each heading sits over its column');
  await shot('1-top');
  // Scrolled down: only the heading line and the day beside the list stay.
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(150);
  const stuck = await page.evaluate(() => {
    var head = document.querySelector('.header-stick').getBoundingClientRect();
    var h = document.querySelector('#wp-list .wp-head').getBoundingClientRect();
    var rail = document.getElementById('wp-rail').getBoundingClientRect();
    var list = document.getElementById('wp-listpane').getBoundingClientRect();
    var days = document.getElementById('wp-days').getBoundingClientRect();
    var x = list.left + list.width / 2;
    var hits = [h.bottom + 6, h.bottom + 120, innerHeight - 30].map(function (y) { var el = document.elementFromPoint(x, y); return !!(el && el.closest('#wp-list .wp-row')); });
    return { headBottom: head.bottom, top: h.top, height: h.height, railTop: rail.top, railLeft: rail.left, listRight: list.right, daysBottom: days.bottom, hits: hits };
  });
  assert.ok(Math.abs(stuck.top - stuck.headBottom) <= 2 && stuck.height <= 44, 'the heading line stays under the top bar, one thin line (' + stuck.height + 'px)');
  assert.ok(stuck.daysBottom < stuck.headBottom, 'the row of days scrolls away');
  assert.ok(stuck.railTop >= stuck.headBottom && stuck.railLeft >= stuck.listRight, 'the day stays beside the list');
  assert.deepEqual(stuck.hits, [true, true, true], 'nothing covers the rows');
  await shot('1-scrolled');
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('✓ 1 the tab: days on top, one table of the next brands, the day beside it, nothing over the list');

  // 2. + day ------------------------------------------------------------
  await page.evaluate(() => { WP_GONE_MS = 400; });
  const y6 = await top(rowOf('r6'));
  SLOW.fn = 'planAddBrands'; SLOW.ms = 500;
  n = count('planAddBrands');
  await page.click(rowOf('r5') + ' [data-wpput]');
  await page.waitForTimeout(60);
  assert.equal(count('weekBank'), 1, 'the page did not wait for the server');
  assert.match(await text(rowOf('r5')), /^✓\s*Brand 5\s*On Tue Oct 20 ✓\s*Undo/, 'the row keeps its place and says where it went');
  assert.match(await text('#wp-rail'), /Brand 5/, 'on the day at once');
  assert.match(await text('[data-wppick="' + TUE + '"]'), /6\s*\/ 35[\s\S]*2 brands/, 'the day counts it at once');
  assert.ok(Math.abs((await top(rowOf('r6'))) - y6) < 1, 'the next brand did not slide under the mouse');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: TUE, brandIds: ['r5'] });
  SLOW.fn = '';
  await settle();
  assert.ok(Math.abs((await top(rowOf('r6'))) - y6) < 1, 'nor after the refresh');
  assert.match(await text(rowOf('r6')), /^5\s*Brand 6/, 'the places close up');
  assert.ok(await has(rowOf('r61')), 'the next-ranked brand came in at the end');
  assert.equal(await liveRows(), 60, 'still the next 60');
  await page.waitForTimeout(600);
  assert.ok(await has(rowOf('r5') + '.ghost'), 'the kept row stays while the mouse is on the table');
  await mouseOff();
  assert.ok(!(await has(rowOf('r5'))), 'and leaves once the mouse is off it');
  // Undo on the kept row: off the day, back in its place.
  await page.click(rowOf('r6') + ' [data-wpput]');
  await page.waitForSelector(rowOf('r6') + '.ghost');
  n = count('planRemoveBrand');
  await page.click(rowOf('r6') + ' [data-wpundo1]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: TUE, brandId: 'r6' });
  await settle();
  assert.match(await text(rowOf('r6')), /^5\s*Brand 6[\s\S]*\+ Tue 20/, 'Undo: a plain row again');
  assert.doesNotMatch(await text('#wp-rail'), /Brand 6/, 'and off the day');
  // A refusal: the row comes back and the page says why.
  REFUSE.add('r7');
  await page.click(rowOf('r7') + ' [data-wpput]');
  await settle();
  assert.match(await text('#toast'), /Brand 7 can’t go on Tue Oct 20: It rests a week/);
  assert.match(await text(rowOf('r7')), /^6\s*Brand 7[\s\S]*\+ Tue 20/, 'refused: still waiting on the list');
  assert.doesNotMatch(await text('#wp-rail'), /Brand 7/);
  REFUSE.clear();
  console.log('✓ 2 + day: on the day at once, the row keeps its place with Undo, the next brand comes in, a refusal says why');

  // 3. Picking a day ------------------------------------------------------
  await page.click('[data-wppick="' + WED + '"]');
  assert.match(await text(rowOf('r1')), /\+ Wed 21/, 'every + now goes to Wednesday');
  assert.match(await text('#wp-rail'), /Wed Oct 21[\s\S]*3\s*\/ 35 people[\s\S]*Hand On Day\s*81[\s\S]*Best fit adds 7 brands \(26 people\) to the open spots by itself[\s\S]*Only what I put here/);
  await page.click('#wp-rail [data-wpstep="1"]');
  assert.match(await text('#wp-rail .wp-rail-t'), /Thu Oct 22/, '› the next day');
  assert.equal(await page.$eval('#wp-rail [data-wpstep="1"]', (el) => el.disabled), true, 'the last day: no next');
  assert.match(await text(rowOf('r1')), /\+ Thu 22/);
  await page.click('#wp-rail [data-wpstep="-1"]');
  await page.click('#wp-rail [data-wpstep="-1"]');
  assert.equal(await page.getAttribute('[data-wppick="' + TUE + '"]', 'aria-pressed'), 'true', '‹ back to Tuesday');
  console.log('✓ 3 picking a day: the + buttons and the day beside the list follow');

  // 4. Pass ------------------------------------------------------------------
  n = count('passBrandToday');
  const d0 = dialogs.length;
  await page.click(rowOf('r8') + ' [data-wppass]');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'r8' }, 'one click');
  assert.equal(dialogs.length, d0, 'a waiting brand: no question');
  await settle();
  assert.match(await text(rowOf('r8')), /Brand 8\s*Passed for a month — back Nov 13\s*Undo/);
  n = count('passBrandToday');
  await page.click(rowOf('r8') + ' [data-wpundo1]');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'r8', on: false }, 'Undo lifts the Pass');
  await settle();
  assert.match(await text(rowOf('r8')), /Brand 8[\s\S]*\+ Tue 20\s*Pass/);
  // Passed and left: it waits in the Passed fold, and can come back sooner.
  await page.click(rowOf('r8') + ' [data-wppass]');
  await settle();
  await mouseOff();
  assert.ok(!(await has(rowOf('r8'))));
  assert.equal(await liveRows(), 60, 'the next brand took its place');
  assert.match(await text('[data-wpfold="passed"] summary'), /Passed — back by themselves \(2\)/);
  await page.click('[data-wpfold="passed"] summary');
  assert.match(await text('[data-wpfold="passed"]'), /Old Pass Co[\s\S]*back Nov 2[\s\S]*Brand 8[\s\S]*back Nov 13[\s\S]*Bring back now/);
  n = count('passBrandToday');
  await page.click('[data-wpunpass="r8"]');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'r8', on: false });
  await settle();
  assert.ok(await has(rowOf('r8')), 'brought back: on the list again');
  assert.equal(await page.$eval('[data-wpfold="passed"]', (el) => el.open), true, 'the fold stays open through the refresh');
  // From the day: it asks first, and comes off the day.
  n = count('passBrandToday');
  await page.selectOption(rail('c1') + ' [data-wpmv]', 'pass');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'c1' });
  assert.match(dialogs[dialogs.length - 1], /Pass Celsius for a month\?[\s\S]*comes off Tue Oct 20/);
  await settle();
  assert.ok(!(await has(rail('c1'))), 'off the day');
  console.log('✓ 4 Pass: one click, a month, Undo on the row; the Passed fold brings one back; on a day it asks first');

  // 5. Remove for good ----------------------------------------------------------
  await page.click(rowOf('r9') + ' [data-wpmenu]');
  assert.match(await text(rowOf('r9')), /Never show it here again\?\s*Remove for good\s*Cancel/);
  await page.click(rowOf('r9') + ' [data-wpmenu=""]');
  assert.match(await text(rowOf('r9')), /\+ Tue 20\s*Pass/, 'Cancel');
  await page.click(rowOf('r9') + ' [data-wpmenu]');
  await page.keyboard.press('Escape');
  assert.match(await text(rowOf('r9')), /\+ Tue 20\s*Pass/, 'Esc');
  await page.click(rowOf('r9') + ' [data-wpmenu]');
  n = count('weekBankRemove');
  await page.click(rowOf('r9') + ' [data-wprm]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r9'] });
  await settle();
  assert.match(await text(rowOf('r9')), /Brand 9\s*Taken off this list\s*Undo/);
  n = count('weekBankPutBack');
  await page.click(rowOf('r9') + ' [data-wpundo1]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['r9'] });
  await settle();
  assert.match(await text(rowOf('r9')), /Brand 9[\s\S]*\+ Tue 20/);
  await page.click(rowOf('r9') + ' [data-wpmenu]');
  await page.click(rowOf('r9') + ' [data-wprm]');
  await settle();
  await mouseOff();
  assert.match(await text('[data-wpfold="removed"] summary'), /Removed for good \(2\)/);
  await page.click('[data-wpfold="removed"] summary');
  n = count('weekBankPutBack');
  await page.click('[data-wpputback="r9"]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['r9'] });
  await settle();
  assert.ok(await has(rowOf('r9')), 'put back');
  console.log('✓ 5 Remove for good: asks in the row, Undo, Put back');

  // 6. The day beside the list -----------------------------------------------------
  // × takes a brand off the day: back on the list.
  assert.ok(await has(rail('r5')), 'Brand 5 is on Tuesday');
  n = count('planRemoveBrand');
  await page.click(rail('r5') + ' [data-wpoff]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: TUE, brandId: 'r5' });
  await settle();
  assert.ok(!(await has(rail('r5'))));
  assert.match(await text(rowOf('r5')), /Brand 5[\s\S]*\+ Tue 20/, 'back on the list');
  // Move…
  await page.click(rowOf('r5') + ' [data-wpput]');
  await settle();
  n = count('planMoveBrand');
  await page.selectOption(rail('r5') + ' [data-wpmv]', WED);
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r5', from: TUE, to: WED });
  await settle();
  assert.ok(!(await has(rail('r5'))), 'off Tuesday');
  assert.match(await text('[data-wppick="' + WED + '"]'), /6\s*\/ 35[\s\S]*2 brands/, 'on Wednesday');
  // Only what I put here / Let Best fit fill.
  n = count('setListDay');
  await page.click('#wp-rail [data-wplist]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: TUE, on: false }, 'a list day: Let Best fit fill the open spots');
  await settle();
  n = count('setListDay');
  await page.click('#wp-rail [data-wplist]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: TUE, on: true }, 'Only what I put here');
  await settle();
  // Brands he added that aren't waiting.
  await mouseOff();
  assert.match(await text('[data-wpfold="mine"] summary'), /Added by you, not waiting \(2\)/);
  await page.click('[data-wpfold="mine"] summary');
  assert.match(await text('[data-wpfold="mine"]'), /Hand On Day\s*On Wed Oct 21[\s\S]*Resting Co\s*Reached out \(Oct 10\) — it rests a week/);
  n = count('weekBankRemove');
  await page.click('[data-wpfold="mine"] [data-wprm="h1"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['h1'], offDays: true });
  assert.match(dialogs[dialogs.length - 1], /Take Hand On Day off your list and off Wed Oct 21\?/);
  await settle();
  console.log('✓ 6 the day beside the list: × back to the list, Move…, only what I put here, brands he added that aren’t waiting');

  // 7. By category ----------------------------------------------------------------------
  assert.equal(await page.$eval('#wp-cat', (el) => el.hidden), true, 'the category menu shows only with By category');
  await page.click('[data-wpview="cat"]');
  assert.equal(await page.$eval('#wp-cat', (el) => el.hidden), false);
  const heads = await page.$$eval('#wp-list .wp-grp b', (els) => els.map((e) => e.textContent));
  assert.deepEqual(heads, [names.energy, names.cpg, names.apparel, 'Uncategorised'], 'a heading per category, Top priority first');
  assert.match(await text('#wp-list .wp-grp'), new RegExp(names.energy + '\\s*\\d+\\s*Top[\\s\\S]*See all of ' + names.energy));
  assert.equal(await liveRows(), 60, 'the same brands');
  assert.match(await text(rowOf('r4')), /^4\s*Big Brew/, 'the # is its place overall');
  assert.equal(await page.$eval('#wp-list .wp-grp + .wp-row', (el) => el.getAttribute('data-wpid')), 'r1', 'best first inside a category');
  await shot('7-by-category');
  // One category's whole ranking.
  n = count('weekBankBrowse');
  await page.click('[data-wpcatgo="energy"]');
  assert.deepEqual((await waitFor('weekBankBrowse', n)).args, { category: 'energy', day: TUE });
  assert.equal(await page.$eval('#wp-cat', (el) => el.value), 'energy', 'the menu follows');
  assert.match(await text('#wp-filters'), new RegExp(names.energy + '[\\s\\S]*4 brands that can go out, best Brand Fit first · 2 set aside[\\s\\S]*Outreach[\\s\\S]*× Every category'));
  assert.match(await text(rowOf('k1')), /^1\s*Kin One\s*70[\s\S]*3 people\s*\+ Tue 20\s*Save to list/);
  assert.match(await text(rowOf('k3')), /Kin Giant[\s\S]*A giant \(household name\)[\s\S]*Anyway → Tue 20\s*Save anyway/);
  assert.match(await text(rowOf('r13')), /Brand 13[\s\S]*\+ Tue 20\s*Pass/, 'a brand on the list shows its list row');
  n = count('planAddBrands');
  const a0 = count('weekBankAdd');
  await page.click(rowOf('k1') + ' [data-wpaddday]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: TUE, brandIds: ['k1'], allowGiants: [] });
  assert.deepEqual(calls.filter((c) => c.fn === 'weekBankAdd')[a0].args, { brandIds: ['k1'], allowGiants: [] }, 'on his list first, then on the day');
  await settle();
  assert.match(await text(rowOf('k1')), /Kin One[\s\S]*On Tue Oct 20 ✓\s*Take off/);
  assert.ok(await has(rail('k1')), 'on the day');
  n = count('weekBankAdd');
  await page.click(rowOf('k2') + ' [data-wpadd]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['k2'], allowGiants: [] }, 'Save to list: no day');
  await settle();
  assert.match(await text(rowOf('k2')), /Kin Two[\s\S]*On your list ✓/);
  n = count('weekBankAdd');
  await page.click(rowOf('k3') + ' [data-wpaddday]');
  assert.deepEqual((await waitFor('weekBankAdd', n)).args, { brandIds: ['k3'], allowGiants: ['k3'] }, 'a giant: Anyway OKs it');
  await settle();
  await page.click('[data-wpcatx]');
  assert.equal(await page.$$eval('#wp-list .wp-grp', (els) => els.length), 4, '× Every category: the headings again');
  n = count('weekBankBrowse');
  await page.selectOption('#wp-cat', 'cpg');
  assert.deepEqual((await waitFor('weekBankBrowse', n)).args, { category: 'cpg', day: TUE }, 'the menu opens a category too');
  await page.click('[data-wpview="rank"]');
  assert.equal(await page.$eval('#wp-cat', (el) => el.hidden), true);
  assert.match(await text(rowOf('k2')), /Kin Two\s*yours/, 'the brand he saved is on the list, his');
  console.log('✓ 7 by category: headings in priority order, one category’s whole ranking, + day, Save to list, a giant’s Anyway');

  // 8. Reach out again ------------------------------------------------------------------------
  await page.click('[data-wpview="again"]');
  assert.match(await text('#wp-list .wp-head'), /Brand\s*Score\s*Last outreach\s*Never contacted/);
  assert.match(await text('#wp-filters'), /Reached before, nobody replied[\s\S]*29 due[\s\S]*1 late/);
  assert.equal(await liveRows(), 25, '25 at a time');
  assert.match(await text('[data-wpagmore]'), /Show 5 more \(5 left\)/);
  await page.waitForFunction(() => /Outreached Oct 5/.test(document.querySelector('#wp-list [data-wpid="ag1"]').textContent));
  assert.match(await text(rowOf('ag1')), new RegExp('Liquid Again\\s*Outreached Oct 5\\s*' + names.energy + '\\s*72\\s*Mon Oct 5 · 9 days ago\\s*due by Mon Oct 19\\s*3 invites · no answer yet\\s*Dana Lee — Head of Partnerships\\s*Sam Roe — Events Lead\\s*\\+ Tue 20\\s*Pass'));
  const agCols = await page.evaluate(() => {
    var xs = (sel) => [].slice.call(document.querySelector(sel).children).map((c) => Math.round(c.getBoundingClientRect().left));
    return { head: xs('#wp-list .wp-head'), row: xs('#wp-list [data-wpid="ag1"]') };
  });
  assert.deepEqual(agCols.head, agCols.row, 'each heading sits over its column');
  assert.match(await text(rowOf('ag2')), /Late Labs[\s\S]*19 days ago\s*late\s*3 invites · 1 accepted, no reply yet[\s\S]*Lee 2 — Marketing Manager\s*\+3 more/);
  await shot('8-reach-again');
  n = count('reachAgain');
  await page.click(rowOf('ag1') + ' [data-wpagain]');
  assert.deepEqual((await waitFor('reachAgain', n)).args, { brandId: 'ag1', date: TUE });
  await settle();
  assert.match(await text(rowOf('ag1')), /Liquid Again[\s\S]*On Tue Oct 20 ✓\s*Take off/, 'it stays in its row, on the day');
  assert.match(await text(rail('ag1')), /Liquid Again\s*72[\s\S]*2 going[\s\S]*again/, 'and on the day beside the list');
  n = count('planRemoveBrand');
  await page.click(rowOf('ag1') + ' [data-wpoff]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: TUE, brandId: 'ag1' });
  await settle();
  assert.match(await text(rowOf('ag1')), /\+ Tue 20\s*Pass/, 'Take off: waiting again');
  n = count('passBrandToday');
  await page.click(rowOf('ag3') + ' [data-wppass]');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'ag3' });
  await settle();
  assert.match(await text(rowOf('ag3')), /Again ag3\s*Passed for a month — back Nov 13\s*Undo/);
  n = count('passBrandToday');
  await page.click(rowOf('ag3') + ' [data-wpundo1]');
  assert.deepEqual((await waitFor('passBrandToday', n)).args, { brandId: 'ag3', on: false });
  await settle();
  assert.match(await text(rowOf('ag3')), /\+ Tue 20\s*Pass/);
  await page.click('[data-wpagmore]');
  assert.equal(await liveRows(), 30, 'Show more');
  console.log('✓ 8 reach out again: its own table, + day = reachAgain, Take off, Pass with Undo, Show more');

  // 9. Search ---------------------------------------------------------------------------------
  await page.click('[data-wpview="rank"]');
  n = count('searchPlanBrands');
  await page.fill('#wp-q', 'prime');
  assert.deepEqual((await waitFor('searchPlanBrands', n)).args, { q: 'prime', date: TUE });
  assert.match(await text('#wp-filters'), /Results for “prime”[\s\S]*× Back to the list/);
  assert.match(await text(rowOf('pr')), /Prime Hydration[\s\S]*A giant \(household name\)[\s\S]*Anyway → Tue 20\s*Save anyway/);
  assert.match(await text(rowOf('pm')), /Primal Kitchen\s*61[\s\S]*3 people\s*\+ Tue 20\s*Save to list/);
  assert.match(await text(rowOf('r2')), /^2\s*Ghost\s*yours[\s\S]*\+ Tue 20\s*Pass/, 'a brand on the list shows its list row, with its place');
  assert.match(await text(rowOf('ag1')), /Liquid Again[\s\S]*Reached before — 2 people never contacted would go[\s\S]*2 people\s*\+ Tue 20/);
  const before = { add: count('weekBankAdd'), plan: count('planAddBrands') };
  await page.press('#wp-q', 'Enter');
  await page.waitForTimeout(150);
  assert.equal(count('weekBankAdd'), before.add, 'Enter never adds a giant');
  await page.press('#wp-q', 'ArrowDown');
  assert.ok(await has(rowOf('pm') + '.hl'), '↓ moves the highlight');
  n = count('planAddBrands');
  await page.press('#wp-q', 'Enter');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: TUE, brandIds: ['pm'], allowGiants: [] }, 'Enter puts a plain add on the picked day');
  await settle();
  assert.match(await text(rowOf('pm')), /Primal Kitchen[\s\S]*On Tue Oct 20 ✓\s*Take off/);
  assert.equal(await page.$eval('#wp-q', (el) => el.value), 'prime', 'the search box is never redrawn');
  n = count('reachAgain');
  await page.click(rowOf('ag1') + ' [data-wpagain]');
  assert.deepEqual((await waitFor('reachAgain', n)).args, { brandId: 'ag1', date: TUE }, 'a brand due again reaches out again');
  await settle();
  // Another day: what a result says about adding follows it.
  n = count('searchPlanBrands');
  await page.click('[data-wppick="' + WED + '"]');
  assert.deepEqual((await waitFor('searchPlanBrands', n)).args, { q: 'prime', date: WED });
  await page.click('[data-wppick="' + TUE + '"]');
  await page.click('[data-wpclear]');
  assert.equal(await page.$eval('#wp-q', (el) => el.value), '');
  assert.ok(await has(rowOf('r1')), '× Back to the list');
  await page.fill('#wp-q', 'prime');
  await page.press('#wp-q', 'Escape');
  assert.ok(await has(rowOf('r1')), 'Esc clears the search');
  console.log('✓ 9 search: results in the table, Enter only for a plain add, list rows as themselves, a brand due again');

  // 10. Fill the week ---------------------------------------------------------------------------
  assert.match(await text('#wp-fill'), /Last fill[\s\S]*Undo it[\s\S]*✦ Fill next week for me/);
  n = count('weekSpread');
  await page.click('[data-wpspread]');
  const pv1 = (await waitFor('weekSpread', n)).args;
  assert.equal(pv1.week, '2026-10-19', 'the picked day’s week');
  assert.ok(Number.isInteger(pv1.seed) && !pv1.apply, 'a preview, with its seed');
  assert.equal(await page.$eval('#wp-pv', (el) => el.hidden), false);
  assert.match(await text('#wp-pv'), /Preview[\s\S]*nothing is written until you say so[\s\S]*6 brands, 18 people[\s\S]*Tue Oct 20[\s\S]*\+2 brands, 6 people[\s\S]*Passed over:[\s\S]*too big for the room left[\s\S]*Put them on the days[\s\S]*Shuffle again[\s\S]*Cancel/);
  const pvLay = await page.evaluate(() => {
    var pv = document.getElementById('wp-pv'), cols = document.querySelector('.wp-cols');
    return { pos: getComputedStyle(pv).position, above: pv.getBoundingClientRect().bottom <= cols.getBoundingClientRect().top + 1 };
  });
  assert.ok(pvLay.pos === 'static' && pvLay.above, 'the preview is part of the page, above the list — not over it');
  assert.match(await text('[data-wppick="' + TUE + '"]'), /\+2 new/, 'the days count the preview');
  assert.ok(!(await has('[data-wpspread]')), 'no second Fill while one is open');
  await shot('10-fill-preview');
  n = count('weekSpread');
  await page.click('[data-wpshuffle]');
  const pv2 = (await waitFor('weekSpread', n)).args;
  assert.ok(pv2.week === '2026-10-19' && pv2.seed !== pv1.seed, 'Shuffle again: the same week, another seed');
  n = count('weekSpread');
  await page.click('[data-wpapply]');
  const ap = (await waitFor('weekSpread', n)).args;
  assert.equal(ap.apply, true);
  assert.deepEqual(ap.days.map((d) => d.date), [TUE, WED, THU], 'exactly the previewed days');
  assert.ok(ap.days.every((d) => d.brandIds.length === 2));
  await settle();
  assert.equal(await page.$eval('#wp-pv', (el) => el.hidden), true);
  assert.match(await text('#wp-fill'), /Put 6 brands \(18 people\) on 3 days · Undo it/);
  n = count('undoWeekSpread');
  await page.click('[data-wpundo]');
  await waitFor('undoWeekSpread', n + 1);
  assert.match(dialogs[dialogs.length - 1], /Take the last fill back off\?[\s\S]*Comes off its day: Brand 5 \(Tue Oct 20\)[\s\S]*Stays where it is[\s\S]*Celsius/);
  assert.deepEqual(calls.filter((c) => c.fn === 'undoWeekSpread').slice(-2).map((c) => c.args), [{ preview: true }, {}], 'it asks first');
  await settle();
  // A full week has nothing to fill.
  await page.click('[data-wppick="' + THIS_THU + '"]');
  assert.ok(!(await has('[data-wpspread]')), 'this week is full: no Fill button');
  assert.match(await text('#wp-rail'), /Thu Oct 15[\s\S]*35\s*\/ 35 people[\s\S]*Full ✓/);
  await page.click('[data-wppick="' + TUE + '"]');
  // Esc cancels a preview.
  await page.click('[data-wpspread]');
  await page.waitForFunction(() => !document.getElementById('wp-pv').hidden);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#wp-pv', (el) => el.hidden), true, 'Esc cancels the preview');
  console.log('✓ 10 fill the week: a preview in the page, Shuffle again, Put them on the days, Undo asks first');

  // 11. How many the list shows -------------------------------------------------------------------
  n = count('weekBankSize');
  await page.selectOption('[data-wpsize]', '100');
  assert.deepEqual((await waitFor('weekBankSize', n)).args, { size: 100 });
  await settle();
  assert.match(await text('#wp-filters'), /The next \d+ brands by Brand Fit/);
  assert.equal(await page.$eval('[data-wpsize]', (el) => el.value), '100');
  console.log('✓ 11 the number: weekBankSize');

  // 12. The Schedule ----------------------------------------------------------------------
  await page.evaluate(() => gotoView('schedule'));
  await page.waitForSelector('#sched-days [data-drop="' + TUE + '"]');
  const sTue = await text('#sched-days [data-drop="' + TUE + '"]');
  assert.match(sTue, /Week list[\s\S]*Takes only your week list/, 'a list day says so');
  assert.ok(!(await has('#sched-days [data-sdcatsel="' + TUE + '"]')), 'no category menu on a list day');
  assert.ok(await has('#sched-days [data-sdcatsel="' + WED + '"]'), 'a Best fit day keeps its menu');
  await page.click('#sched-days [data-drop="' + TUE + '"] [data-sdweekplan]');
  await page.waitForFunction(() => document.getElementById('weekplan').classList.contains('active'));
  console.log('✓ 12 the Schedule: list days marked, back to Week plan');

  // 12b. A long day, and a page short of room ------------------------------------------
  // (Leo, Oct 20 2026: "when u click on a day u cant scroll down a lot".) The day
  // beside the list takes the screen's height, no more, and scrolls to its last brand.
  const keep = FULL.slice();
  for (let i = FULL.length; i < 40; i++) FULL.push({ id: 'f' + i, name: 'Full ' + i, category: 'energy', state: 'going', going: 1, waits: null, reasonText: null, people: [], big: false, fit: 70 });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.evaluate(() => loadWeekPlan());
  await page.waitForFunction(() => WP.data && WP.data.days[0].pinned.length === 40);
  await page.click('[data-wppick="' + THIS_THU + '"]');
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(150);
  const long = await page.evaluate(() => {
    var rail = document.getElementById('wp-rail').getBoundingClientRect(), box = document.getElementById('wp-rail-list');
    box.scrollTop = box.scrollHeight;
    var lastItem = box.lastElementChild.getBoundingClientRect(), foot = document.querySelector('#wp-rail .wp-foot').getBoundingClientRect();
    return { bottom: rail.bottom, top: rail.top, vh: innerHeight, head: document.querySelector('.header-stick').getBoundingClientRect().bottom,
      scrolls: box.scrollHeight > box.clientHeight, last: lastItem.bottom, foot: foot.bottom, name: box.lastElementChild.textContent };
  });
  assert.ok(long.top >= long.head && long.bottom <= long.vh, 'a long day ends on screen (' + Math.round(long.top) + '–' + Math.round(long.bottom) + ' of ' + long.vh + ')');
  assert.ok(long.scrolls && long.last <= long.bottom && long.foot <= long.vh && /Full 39/.test(long.name), 'it scrolls inside to its last brand');
  FULL.length = 0; keep.forEach((x) => FULL.push(x));
  // Short of room (the sidebar open, a smaller window): the day sits over the list, nothing sticks.
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.evaluate(() => { window.scrollTo(0, 0); return loadWeekPlan(); });
  await page.click('[data-wppick="' + TUE + '"]');
  await page.waitForTimeout(150);
  const mid = await page.evaluate(() => {
    var xs = (sel) => [].slice.call(document.querySelector(sel).children).map((c) => Math.round(c.getBoundingClientRect().left));
    var rail = document.getElementById('wp-rail'), list = document.getElementById('wp-listpane').getBoundingClientRect();
    var name = document.querySelector('#wp-list [data-wpid="r1"] .wp-c-b').getBoundingClientRect();
    return { over: document.documentElement.scrollWidth - innerWidth, pos: getComputedStyle(rail).position, above: rail.getBoundingClientRect().bottom <= list.top + 1,
      head: xs('#wp-list .wp-head'), row: xs('#wp-list [data-wpid="r1"]'), name: name.width };
  });
  assert.ok(mid.pos === 'static' && mid.above, 'short of room: the day sits over the list and nothing sticks');
  assert.deepEqual(mid.head, mid.row, 'the headings still sit over their columns');
  assert.ok(mid.name >= 200 && mid.over <= 1, 'the brand’s name keeps its room (' + Math.round(mid.name) + 'px), no sideways scroll');
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('✓ 12b a long day fits the screen and scrolls to its last brand; short of room, the day sits over the list');

  // 13. A phone ------------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => loadWeekPlan());
  await page.waitForTimeout(300);
  const phone = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - window.innerWidth,
    dayFirst: document.getElementById('wp-rail').getBoundingClientRect().top < document.getElementById('wp-listpane').getBoundingClientRect().top,
    sticky: getComputedStyle(document.getElementById('wp-rail')).position,
    head: getComputedStyle(document.querySelector('#wp-list .wp-head')).display,
    btn: !!document.querySelector('#wp-list [data-wpid="r1"] [data-wpput]') && document.querySelector('#wp-list [data-wpid="r1"] [data-wpput]').getBoundingClientRect().right <= window.innerWidth,
  }));
  assert.ok(phone.over <= 1, 'no sideways scroll on a phone (' + phone.over + 'px)');
  assert.ok(phone.dayFirst && phone.sticky === 'static', 'the day first, then the brands; nothing sticks');
  assert.equal(phone.head, 'none', 'no column headings on a phone');
  assert.ok(phone.btn, 'the + button is on screen');
  await shot('13-phone');
  console.log('✓ 13 a phone: the day first, then the brands, no sideways scroll');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All Week plan checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
