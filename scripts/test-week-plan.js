// scripts/test-week-plan.js
//
// Outreach → Week plan (Leo, Oct 18 2026: a list of ~100 brands, the top
// by Brand Fit plus what he adds by search or category, spread onto the
// week's days as an even mix of rank, then moved between days; cleaned up
// the same day: "make each brand bigger … make sure that adding and
// removing brands does not glitch"). Drives public/app.html in Chromium
// against a fake /api/data:
//
//   1. The tab sits between Results and Schedule: the list (left) and the
//      week (right), each scrolling on its own; one big card per brand
//      (rank, name, fit, category, people, contacts, where it is, Reached
//      tag), the first 40 then Show more, filters.
//   2. The number: changing it asks weekBankSize.
//   3. Adding: the search box shows results in the list pane — + Add to
//      list, a giant's Add anyway (allowGiants), Enter only for a plain add,
//      "Added ✓" in place; a category — Add the top N, ticks → Add N ticked;
//      × Back to your list.
//   4. No glitches: a day button shows the brand on that day at once (before
//      the server answers) and the card stays put; the list pane keeps its
//      scroll; Remove leaves the card in its place with Undo (PutBack); a
//      brand on a day asks first and comes off the day too.
//   5. The spread: a preview (a seed) shows the new cards on their days and
//      who waits; Shuffle again deals with another seed; Put them on the
//      days sends exactly the previewed days; Undo asks first.
//   6. Moving: → day on a day's card / the day buttons on a list card
//      (planMoveBrand), the lit day button again or ↩ Back to list
//      (planRemoveBrand), a day button on a waiting brand (planAddBrands);
//      drag a list card onto a day, a day card onto another day or back onto
//      the list; Only my list / Let Best fit fill (setListDay).
//   7. The Schedule: a day spread from the list says so (tag, no category
//      menu, ⋯ → Let Best fit fill its open spots), and its Fill box offers
//      the list.
//   8. A phone: the week first, then the list; no sideways scroll.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-week-plan.js   (~8s)

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

const OFF = new Set();
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
  weekBank: () => Object.assign({}, WEEK, { bank: Object.assign({}, WEEK.bank, { rows: WEEK.bank.rows.filter((r) => !OFF.has(r.id)) }) }),
  reachedBrands: () => ({ brands: { r2: ['2026-09-20', '2026-09-22', 'a', 2, 1], r3: ['2026-10-01', '2026-10-10', 'i', 3, 0] } }),
  weekBankSize: ({ size }) => ({ ok: true, size }),
  weekBankAdd: ({ brandIds }) => ({ ok: true, added: brandIds.map((id) => ({ id, name: id })), already: 0, refused: [] }),
  weekBankRemove: ({ brandIds }) => { brandIds.forEach((id) => OFF.add(id)); return { ok: true, removed: brandIds.length, offDays: [] }; },
  weekBankPutBack: ({ brandIds }) => { brandIds.forEach((id) => OFF.delete(id)); return { ok: true, back: brandIds.length }; },
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

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadWeekPlan === 'function');

  // 1. The tab --------------------------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  const tabs = await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 4), ['LinkedIn', 'Results', 'Week plan', 'Schedule'], 'Week plan sits between Results and Schedule');
  await page.click('#sub-tabs [data-view="weekplan"]');
  await page.waitForSelector('#wp-days [data-wpdrop="2026-10-20"]');
  assert.ok(count('weekBank') >= 1, 'reads weekBank');
  assert.match(await page.textContent('#wp-weekhead'), /The week[\s\S]*Next week · Tue Oct 20 – Thu Oct 22[\s\S]*3\s*of 90 spots planned/);
  // Side by side, each pane scrolling on its own.
  const panes = await page.evaluate(() => {
    var l = document.getElementById('wp-listpane').getBoundingClientRect();
    var w = document.querySelector('.wp-weekpane').getBoundingClientRect();
    return { side: Math.abs(l.top - w.top) < 2 && l.right <= w.left, listScroll: getComputedStyle(document.getElementById('wp-list')).overflowY, fits: l.bottom <= window.innerHeight };
  });
  assert.deepEqual(panes, { side: true, listScroll: 'auto', fits: true }, 'the list and the week side by side, filling the screen, each scrolling');
  assert.equal(await page.$$eval('#wp-days .wp-day', (els) => els.length), 3, 'a section per sending day');
  const tue = await page.textContent('#wp-days [data-wpdrop="2026-10-20"]');
  assert.match(tue, /Tue Oct 20[\s\S]*Your list only[\s\S]*#1[\s\S]*Celsius[\s\S]*99[\s\S]*3 going[\s\S]*→ Wed[\s\S]*→ Thu[\s\S]*Back to list/, 'a list day: its tag and the brand’s card with move buttons');
  assert.match(await page.textContent('#wp-days [data-wpdrop="2026-10-21"]'), /Best fit adds 7 brands \(26 people\) by itself[\s\S]*Only my list/, 'a day not from the list says what Best fit adds');
  assert.match(await page.textContent('#wp-days [data-wpdrop="2026-10-22"]'), /Energy Drinks/, 'a category day shows its category');
  assert.equal(await page.$$eval('#wp-list .wp-b', (els) => els.length), 40, 'the first 40 cards');
  const big = await page.$eval('#wp-list .wp-b .wp-b-name', (el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(big >= 17, 'brand names are big (' + big + 'px)');
  const c1 = await page.textContent('#wp-list .wp-b:nth-child(1)');
  assert.match(c1, /#1[\s\S]*Celsius[\s\S]*99[\s\S]*Energy Drinks[\s\S]*3 people[\s\S]*Ready · 4 reachable[\s\S]*On Tue Oct 20 ✓[\s\S]*✓ Tue[\s\S]*\+ Wed[\s\S]*\+ Thu[\s\S]*Remove/, 'rank, name, fit, category, people, contacts, where, day buttons, Remove');
  await page.waitForFunction(() => /Reached Sep 22/.test(document.querySelector('#wp-list .wp-b:nth-child(2)').textContent));
  assert.match(await page.textContent('#wp-list .wp-b:nth-child(2)'), /Ghost[\s\S]*added by you[\s\S]*Reached Sep 22[\s\S]*Waiting for a day/, 'a hand add says so, with its Reached tag');
  assert.match(await page.textContent('#wp-list .wp-b:nth-child(3)'), /Resting Co[\s\S]*rests two weeks/, 'a brand that can’t go says why, and has no day buttons');
  assert.equal(await page.$('#wp-list .wp-b:nth-child(3) [data-wpput]'), null);
  assert.match(await page.textContent('#wp-listhead'), /Your list[\s\S]*60[\s\S]*brands[\s\S]*1 added by you · 12 more would come in/);
  await page.click('[data-wpmore]');
  assert.equal(await page.$$eval('#wp-list .wp-b', (els) => els.length), 60, 'Show more');
  await page.click('[data-wpfilter="cant"]');
  assert.equal(await page.$$eval('#wp-list .wp-b', (els) => els.length), 1, 'filter: can’t go yet');
  await page.click('[data-wpfilter="all"]');
  console.log('✓ 1 the tab: list and week side by side, big cards, Reached tags, Show more, filters');

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
  const res = await page.textContent('#wp-list');
  assert.match(res, /Prime Hydration[\s\S]*Add anyway/, 'a giant asks');
  assert.match(res, /Ghost[\s\S]*On your list · #2/, 'a brand on the list says where');
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
  await page.click('[data-wpclear]');
  assert.equal(await page.inputValue('#wp-q'), '', '× Back to your list clears the search');
  await page.waitForSelector('#wp-list .wp-b [data-wprm]');
  // A category.
  await page.selectOption('#wp-cat', 'energy');
  await page.waitForSelector('#wp-filters [data-wpaddtop]');
  assert.equal(last('weekBankBrowse').args.category, 'energy');
  const catBar = await page.textContent('#wp-filters');
  assert.match(catBar, /Energy Drinks[\s\S]*Add the top 2[\s\S]*Back to your list[\s\S]*2 set aside/, 'the top ones not on the list yet');
  assert.match(await page.textContent('#wp-list'), /Brand 5[\s\S]*On your list · #5/);
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
  console.log('✓ 3 adding: search (+ Add to list, Add anyway, Enter, Added ✓), a category (top N, ticks)');

  // 4. No glitches ---------------------------------------------------------------
  // A day button: on that day at once, before the server answers; the card
  // stays where it was; the list pane keeps its scroll.
  const r9 = '#wp-list [data-wpput="r9"][data-wpto="2026-10-21"]';
  // Scrolled down the list pane, with that card in view.
  await page.$eval(r9, (el) => { var box = document.getElementById('wp-list'); box.scrollTop = el.closest('.wp-b').offsetTop - box.offsetTop - 120; });
  await page.waitForTimeout(50);
  const keptTop = await page.$eval('#wp-list', (el) => el.scrollTop);
  assert.ok(keptTop > 300, 'scrolled down the list (' + keptTop + ')');
  const before = await page.$eval(r9, (el) => el.closest('.wp-b').getBoundingClientRect().top);
  SLOW.fn = 'planAddBrands'; SLOW.ms = 700;
  n = count('planAddBrands');
  await page.click(r9);
  await page.waitForTimeout(120);
  const mid = await page.$eval('#wp-list [data-wpput="r9"][data-wpto="2026-10-21"]', (el) => ({
    on: el.classList.contains('on'), card: el.closest('.wp-b').textContent, top: el.closest('.wp-b').getBoundingClientRect().top,
  }));
  assert.ok(mid.on && /On Wed Oct 21 ✓/.test(mid.card), 'on Wed at once, before the server answers');
  assert.ok(await page.$('#wp-days [data-wpdrop="2026-10-21"] [data-wpdrag="r9"]'), 'its card is on Wed at once');
  assert.ok(Math.abs(mid.top - before) < 2, 'the card didn’t move (' + before + ' → ' + mid.top + ')');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-21', brandIds: ['r9'] });
  SLOW.fn = '';
  await page.waitForTimeout(250);
  assert.equal(await page.$eval('#wp-list', (el) => el.scrollTop), keptTop, 'the list pane kept its scroll through the refresh');
  // Remove: the card stays in its place with Undo.
  await page.$eval('#wp-list [data-wprm="r12"]', (el) => { var box = document.getElementById('wp-list'); box.scrollTop = el.closest('.wp-b').offsetTop - box.offsetTop - 120; });
  await page.waitForTimeout(50);
  const r12 = await page.$eval('#wp-list [data-wprm="r12"]', (el) => el.closest('.wp-b').getBoundingClientRect().top);
  n = count('weekBankRemove');
  await page.click('#wp-list [data-wprm="r12"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r12'] }, 'Remove on a waiting brand');
  await page.waitForTimeout(200);
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
  await page.evaluate(() => { document.getElementById('wp-list').scrollTop = 0; });
  await page.click('#wp-list [data-wprm="r1"]');
  assert.deepEqual((await waitFor('weekBankRemove', n)).args, { brandIds: ['r1'], offDays: true }, 'Remove on a brand on a day takes it off the day too');
  assert.match(dialogs[d0], /Take Celsius off your list and off Tue Oct 20\?/, 'asked first');
  n = count('weekBankPutBack');
  await page.click('#wp-list [data-wpundo1="r1"]');
  await waitFor('weekBankPutBack', n);
  await page.waitForSelector('#wp-list [data-wprm="r1"]');
  // Taken off earlier: Put back at the bottom.
  n = count('weekBankPutBack');
  await page.evaluate(() => { var el = document.getElementById('wp-list'); el.scrollTop = el.scrollHeight; });
  await page.click('#wp-list details.wp-removed summary');
  await page.click('[data-wpputback="gone1"]');
  assert.deepEqual((await waitFor('weekBankPutBack', n)).args, { brandIds: ['gone1'] });
  console.log('✓ 4 no glitches: shown at once, the card stays put, the scroll stays, Remove leaves Undo in place');

  // 5. The spread -------------------------------------------------------------------
  n = count('weekSpread');
  await page.click('[data-wpspread]');
  const pv1 = (await waitFor('weekSpread', n)).args;
  assert.equal(pv1.apply, undefined, 'a preview first');
  assert.ok(Number.isFinite(pv1.seed), 'with a seed');
  await page.waitForSelector('#wp-weekhead .wp-pv');
  const pvText = await page.textContent('#wp-weekhead .wp-pv');
  assert.match(pvText, /6 brands, 18 people[\s\S]*50 brands wait on the list for next week[\s\S]*only brands from your list/);
  assert.match(pvText, /Passed over: #4 Big Brew \(too big for the room left \(10 people\)\)/);
  assert.equal(await page.$$eval('#wp-days .wp-dc.new', (els) => els.length), 6, 'the new cards on their days');
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
  assert.equal(await page.$('#wp-weekhead .wp-pv'), null, 'the preview is gone');
  n = count('undoWeekSpread');
  const d1 = dialogs.length;
  await page.click('[data-wpundo]');
  for (let i = 0; i < 100 && count('undoWeekSpread') < n + 2; i++) await page.waitForTimeout(20);
  assert.equal(calls.filter((c) => c.fn === 'undoWeekSpread')[n].args.preview, true, 'Undo previews first');
  assert.equal(last('undoWeekSpread').args.preview, undefined, 'then applies');
  assert.match(dialogs[d1], /Brand 5 \(Tue Oct 20\)[\s\S]*Stays where it is[\s\S]*Celsius[\s\S]*Best fit fills the open spots again on: Tue Oct 20/, 'Undo names what changes');
  console.log('✓ 5 the spread: preview, shuffle, apply exactly the preview, Undo asks first');

  // 6. Moving -----------------------------------------------------------------------
  await page.waitForSelector('#wp-days [data-wpmove="r1"][data-wpto="2026-10-22"]');
  n = count('planMoveBrand');
  await page.click('#wp-days [data-wpmove="r1"][data-wpto="2026-10-22"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-22' }, '→ Thu on its day card');
  n = count('planMoveBrand');
  await page.click('#wp-list [data-wpput="r1"][data-wpto="2026-10-21"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-21' }, 'another day button on its list card moves it');
  n = count('planRemoveBrand');
  await page.click('#wp-list [data-wpput="r1"][data-wpto="2026-10-20"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, 'its lit day button again takes it off');
  n = count('planRemoveBrand');
  await page.click('#wp-days [data-wpoff="r1"]');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, '↩ Back to list');
  n = count('planAddBrands');
  await page.click('#wp-list [data-wpput="r7"][data-wpto="2026-10-22"]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-22', brandIds: ['r7'] }, 'a day button on a waiting brand');
  n = count('planAddBrands');
  await page.dragAndDrop('#wp-list [data-wpdrag="r8"]', '#wp-days [data-wpdrop="2026-10-22"]');
  assert.deepEqual((await waitFor('planAddBrands', n)).args, { date: '2026-10-22', brandIds: ['r8'] }, 'a list card dragged onto a day');
  n = count('planMoveBrand');
  await page.dragAndDrop('#wp-days [data-wpdrag="r1"]', '#wp-days [data-wpdrop="2026-10-21"]');
  assert.deepEqual((await waitFor('planMoveBrand', n)).args, { brandId: 'r1', from: '2026-10-20', to: '2026-10-21' }, 'a day card dragged onto another day');
  n = count('planRemoveBrand');
  await page.dragAndDrop('#wp-days [data-wpdrag="r1"]', '#wp-list');
  assert.deepEqual((await waitFor('planRemoveBrand', n)).args, { date: '2026-10-20', brandId: 'r1' }, 'a day card dragged back onto the list');
  n = count('setListDay');
  await page.click('#wp-days [data-wplist="2026-10-21"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-21', on: true }, 'Only my list');
  n = count('setListDay');
  await page.click('#wp-days [data-wplist="2026-10-20"]');
  assert.deepEqual((await waitFor('setListDay', n)).args, { date: '2026-10-20', on: false }, 'Let Best fit fill the open spots');
  console.log('✓ 6 moving: day buttons, → day, Back to list, drag both ways; Only my list / Best fit');

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
  const phone = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - window.innerWidth,
    weekFirst: document.querySelector('.wp-weekpane').getBoundingClientRect().top < document.getElementById('wp-listpane').getBoundingClientRect().top,
  }));
  assert.ok(phone.over <= 1, 'no sideways scroll on a phone (' + phone.over + 'px)');
  assert.ok(phone.weekFirst, 'the week first, then the list');
  console.log('✓ 8 a phone: the week first, no sideways scroll');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All Week plan checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
