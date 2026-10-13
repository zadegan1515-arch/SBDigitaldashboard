// scripts/test-schedule.js
//
// Outreach → Schedule, simplified (Leo, Oct 7 2026: "it's just a little
// clunky … the drop down menu sometimes doesn't replace the entire list …
// if I want to add a brand I should be able to search it up easily").
// Drives public/app.html in Chromium against a fake /api/data:
//
//   1. Layout: Plan for Zach / What went out / More ▾ (Plan my week,
//      Category priority, Add a sending day, Hide too small); no LinkedIn
//      line unless it warns; one find box with day chips; no per-day add
//      boxes; Categories & coverage folded.
//   2. The day menu: ★ Best fit first and selected on a day with no
//      category, then the categories in priority order (Top → Low).
//   3. A category change with something to take off shows exactly what
//      comes off, writes nothing until Replace, and Replace sends the
//      previewed signature; one with nothing to take off applies at once;
//      Cancel writes nothing; "Make the day match" asks with the day's own
//      category; Undo previews, then puts it back.
//   4. Find box: asks for the chosen day, spelling-slip rows say so, ↓ +
//      Enter adds the highlighted row to that day, Enter never adds an
//      "Add anyway" row, a chip asks again for the new day, the cursor
//      stays in the box after an add, a spelling guess needs Shift+Enter or a
//      click, a pasted list opens Paste a list for
//      the chosen day.
//   5. Category priority window saves one category at a time.
//   6. The queue rules (Leo, Oct 12 2026): the "New brands only · Giants"
//      line and its switch, Add anyway on a giant's card, an add that
//      comes back "a giant" asks and re-adds with allowGiants, and a giant
//      row in the find box sends allowGiants straight away.
//   7. A later day's automatic row has the × too ("Not now" = a Pass, two
//      weeks), and today's "planned brands wait" note says to move a brand
//      or Send today anyway — reordering today frees nothing.
//   8. The Fill box (fillbox-misclick): two + Add clicks 100 ms apart and a
//      third the moment the refresh lands add exactly the brands under the
//      mouse — the rows never move; the clicked row reads "Adding…"; ticked
//      rows go in one call ("Add 2 ticked").
//  11. Less planning work (Oct 12 2026): a later day's automatic rows are
//      tagged "may change" (Best fit · may change on a Best fit day), today's
//      aren't; ⋯ → Lock this day names the brands, then pins exactly them
//      (planWeek apply, lock); ⋯ → Move this day to… (later days only)
//      previews, a stale answer shows again, Move the day sends the
//      preview's expect; "No day — take it off" sends no target; the "Thu
//      off" chip's Undo previews, then undoes; a day taken off reads "(send
//      on it after all)" in the add-a-day menus. Third review: a part-sent
//      brand on the day off says its rest moves on (once); Remove this
//      sending day asks the server first and names it.
//  13. Review fixes (Oct 13 2026): Fill to 30 on a Best fit day holding a
//      big company adds no second one; a tick on a brand that left the list
//      is dropped (never added unseen); a failed add reads "+ Add" again,
//      not "Added ✓"; Plan my week's "Over by" is against the flat 30, not
//      the week's room; the off chip's Undo names who leaves today's list.
//   9. The numbers (week-limit, carry-front): a day whose LinkedIn week
//      leaves 10 says "/ 10 · week limit" and Fill to 10, an over day says
//      what it can take; a carried card reads "From Tue · carried 2×" and
//      ⋯ → Move to top sends it first.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-schedule.js   (~6s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-schedule.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const last = (fn) => calls.filter((c) => c.fn === fn).slice(-1)[0];
const count = (fn) => calls.filter((c) => c.fn === fn).length;

const PRIORITY = { spirits: 'top', betting: 'top', beauty: 'middle', apparel: 'low', tech: 'low' };
let themeUndo = null;
let giantsOn = false;
let giantCard = false;
let waitCard = false;
// The Fill box test: brands added to Tue Oct 13 show as its pins, the
// add answers slowly (a plan call in flight), the day can be capped.
let pinned13 = [];
let slowAdd = 0;
let cap13 = null;
let carryCard = false;
// Section 11: an automatic row on the Best fit Tuesday, days taken off.
let auto13 = false;
let skipDays = [];
// Section 12: the answer's stamp (an unchanged one answers { unchanged })
// and the Fill box's suggestions carried by the Schedule itself.
let stampVal = '';
let embedSug = false;
// Section 13: big companies on the Best fit Tuesday, an add that fails,
// an Undo whose target day is today.
let bigs13 = 0;
let failAdd = '';
let undoToday = false;
// Section 14 (second review, Oct 13 2026): a waiting card on the one day for
// a part-sent brand's rest; Plan my week's Undo onto today.
let endsCard = false;
const SUG = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) => ({ id, name: 'Sug ' + (i + 1), category: 'energy', going: 3, label: { kind: 'ready', reachable: 3, need: 3, onFile: 3 }, fit: { score: 80 - i }, people: [] }));
const GIANT_CARD = { id: 'g1', name: 'Red Bull', category: 'energy', state: 'blocked', going: 0, people: [], giant: true, reason: 'giant', reasonText: 'A giant (a household name) — held back for now. Add anyway to send it.' };
const PLAN = () => ({
  queueRules: { giantsOn, giantsHeld: 7, giantsOk: 0, restDays: 14 },
  today: '2026-10-07',
  pool: { total: 40, cap: 30 },
  priority: PRIORITY,
  themeUndo,
  linkedinWeek: { sentLast7: 40, limit: 100, near: 90, days: carryCard ? { '2026-10-13': { count: 106, over: 6, near: true } } : {} },
  plan: { '2026-10-07': { category: null, brandIds: ['p1'] }, '2026-10-08': { category: 'spirits', brandIds: [] } },
  labels: {},
  days: [
    {
      date: '2026-10-07', today: true, category: 'bestfit', auto: true, total: 7, sent: 0, offTheme: 1,
      pinned: [{ id: 'p1', name: 'BodyArmor', category: 'electrolytes', state: 'going', going: 2, people: [{ name: 'Ann' }] }]
        .concat(waitCard ? [{ id: 'p9', name: 'Waiting Co', category: 'energy', state: 'going', going: 4, people: [], waits: '2026-10-08' }] : [])
        .concat(endsCard ? [{ id: 'p8', name: 'Lastday Co', category: 'energy', state: 'going', going: 2, people: [], waits: '2026-10-08', sittingEnds: true, restsUntil: 'Tue Oct 20' }] : []),
      brands: [{ id: 'a1', name: 'Celsius', going: 4, people: [{ name: 'Bo' }], category: 'energy' }],
      sentPeople: [], overflow: [],
    },
    {
      date: '2026-10-08', category: 'spirits', auto: false, total: 4, sent: 0, offTheme: 0,
      pinned: [], brands: [{ id: 'a2', name: 'Patrón', going: 4, people: [], category: 'spirits' }],
      sentPeople: [], overflow: [],
    },
    {
      date: '2026-10-13', category: 'bestfit', auto: true, total: pinned13.length * 3 + (carryCard ? 6 : 0), sent: 0, offTheme: 0, bigs: bigs13,
      ...(cap13 != null ? { cap: cap13 } : {}),
      pinned: (giantCard ? [GIANT_CARD] : []).concat(pinned13.map((id) => ({ id, name: 'Sug ' + id.slice(1), category: 'energy', state: 'going', going: 3, people: [] })))
        .concat(carryCard ? [
          { id: 'k1', name: 'Own Co', category: 'energy', state: 'going', going: 3, people: [] },
          { id: 'k2', name: 'Carried Co', category: 'energy', state: 'going', going: 3, people: [], carriedFrom: '2026-10-08', carriedTimes: 2, carriedSince: '2026-10-07' },
        ] : []),
      brands: auto13 ? [{ id: 'a3', name: 'Olipop', going: 3, people: [], category: 'beverage' }] : [], sentPeople: [], overflow: [],
    },
  ],
  categories: [], past: [], extraDays: [], skipDays, nextOffDay: '2026-10-09',
});

const ROWS = [
  { id: 'c1', name: 'Celsius', category: 'energy', action: 'add', text: '4 would go out', going: 4, label: { kind: 'ready', reachable: 4, need: 3, onFile: 5 }, pinnedOn: null, fit: { score: 72 }, matched: 'fuzzy', exact: false },
  { id: 'c2', name: 'Celsius Heat', category: 'energy', action: 'addAnyway', text: 'Invited Sep 16 · already reached', going: 1, label: { kind: 'thin', reachable: 1, need: 3, onFile: 1 }, pinnedOn: null, fit: { score: 40 }, matched: 'name', exact: false },
];

const GIANT_ROW = { id: 'g3', name: 'Red Bull', category: 'energy', action: 'addAnyway', giant: true, status: 'giant', text: 'A giant (a household name) · held back for now', going: 3, label: { kind: 'ready', reachable: 5, need: 10, onFile: 8 }, pinnedOn: null, fit: { score: 60 }, matched: 'name', exact: true };

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], listTargets: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  getOutreachPlan: (args) => {
    if (stampVal && args.since === stampVal) return { unchanged: true, stamp: stampVal };
    const p = PLAN();
    p.stamp = stampVal;
    if (embedSug) p.categories = [{ category: 'energy', total: 5, reached: 1, setAside: 0, stages: { replied: 0, accepted: 0, contacted: 1 }, notReached: { ready: 3, thin: 1, none: 0 }, days: [] }];
    // Every day with open spots carries its list, as the server does.
    if (embedSug && args.suggest) {
      for (const d of p.days) {
        if ((d.cap != null ? d.cap : 30) - d.total <= 0) continue;
        const category = d.category === 'bestfit' ? '' : d.category;
        d.suggest = { category, data: { date: d.date, category, brands: d.date === '2026-10-13' ? SUG.filter((b) => !pinned13.includes(b.id)) : [], others: [], needPeople: [], needPeopleTotal: 0, hiddenSmall: 0, ruledOut: 0, hideSmall: !!args.hideSmall } };
      }
    }
    return p;
  },
  setBrandPassed: ({ brandId, passed, unpin }) => ({ id: brandId, name: brandId, passed: !!passed, unpinned: unpin ? ['2026-10-07'] : [] }),
  categoryCoverage: () => ({ weeks: [], rows: [] }),
  categoryBrands: ({ category }) => ({ category, brands: [] }),
  suggestForDay: ({ date }) => ({ brands: date === '2026-10-13' ? SUG.filter((b) => !pinned13.includes(b.id)) : [], others: [], needPeople: [], hiddenSmall: 0 }),
  planReorderDay: ({ date, brandIds }) => ({ ok: true, date, brandIds, changed: true, waiting: [] }),
  searchPlanBrands: ({ q }) => ({ brands: /^cel/i.test(q) ? ROWS : /^red/i.test(q) ? [GIANT_ROW] : [] }),
  // g* brands are giants: refused unless the add says allowGiants.
  planAddBrands: ({ date, brandIds, allowGiants }) => (failAdd && brandIds.includes(failAdd) ? (() => { throw new Error('Server error'); })() : { ok: true, results: brandIds.map((id) => (/^s\d/.test(id) && date === '2026-10-13' && pinned13.push(id), /^g/.test(id) && !(allowGiants || []).includes(id)
    ? { brandId: id, brandName: 'Giant ' + id, added: false, state: 'refused', going: 0, reason: 'giant', reasonText: 'A giant (a household name) — held back for now. Add anyway to send it.' }
    : { brandId: id, brandName: id, added: true, state: 'going', going: 4, people: [] })) }),
  setGiantsOn: ({ on }) => { giantsOn = !!on; return { giantsOn }; },
  passBrandToday: ({ brandId }) => ({ id: brandId, name: brandId, passedToday: true, unqueued: 0 }),
  // The × on today's card of a brand part-sent today: its rest is pinned
  // first on its next sending day (pinRestOfSitting).
  planRemoveBrand: ({ date }) => ({ ok: true, unqueued: 1, passedToday: date === '2026-10-07', restOn: '2026-10-08', restOnLabel: 'Thu Oct 8' }),
  undoPlanWeek: ({ preview }) => (preview
    ? { ok: true, preview: true, lock: true, brands: [{ date: '2026-10-07', id: 'p1', name: 'BodyArmor' }], categories: [], movedBack: [],
        stay: [{ id: 'p2', name: 'Halfsent Co' }], unqueue: [{ brand: 'BodyArmor', people: 2 }] }
    : { ok: true, brands: [{ date: '2026-10-07', id: 'p1', name: 'BodyArmor' }], unqueued: 2 }),
  allowGiant: ({ brandId }) => ({ ok: true, brandId, name: 'Red Bull' }),
  matchBrandList: ({ text }) => ({ lines: text.split('\n').map((t) => ({ input: t, brand: null, suggestions: [] })) }),
  planApplyCategory: ({ date, category, preview, keepPins, expect, applyIfNone }) => {
    // Nothing to take off: the server applies it in the same call when the
    // page asks it to (applyIfNone), else answers the empty preview.
    if (category === 'beauty' && preview !== false) {
      if (!applyIfNone) return { date, category, changes: 0, unpin: [], unqueue: [], reopen: null, expect: 'sig0' };
      themeUndo = { date, at: 'now', categoryBefore: null };
      return { applied: true, date, category, unpinned: 0, unqueued: 0, undo: true };
    }
    if (preview !== false) {
      return {
        date, category, changes: 2, expect: 'sig1', reopen: null,
        unpin: [{ id: 'p1', name: 'BodyArmor', category: 'electrolytes' }],
        unqueue: [{ brandId: 'q1', brand: 'Liquid Death', category: 'beverage', people: ['Cy'], targetIds: ['t1'] }],
      };
    }
    themeUndo = { date, at: 'now', categoryBefore: null };
    return { applied: true, date, category, unpinned: keepPins ? 0 : 1, unqueued: keepPins ? 0 : 1, undo: true };
  },
  undoDayTheme: ({ preview }) => {
    if (preview) return { ok: true, date: '2026-10-08', label: 'Thu Oct 8', category: null, brands: ['BodyArmor'], people: 0 };
    themeUndo = null;
    return { ok: true, undone: true };
  },
  getCategoryPriority: () => ({
    categories: [
      { key: 'spirits', priority: 'top', custom: false, default: 'top' },
      { key: 'beauty', priority: 'middle', custom: false, default: 'middle' },
      { key: 'apparel', priority: 'low', custom: false, default: 'low' },
    ],
    points: { top: 30, middle: 15, low: 0, skip: 0 },
  }),
  setCategoryPriority: ({ category, priority }) => ({ ok: true, category, priority }),
  // What gets answered (read-only) and Ready for a second try (hand-only).
  outcomeTable: () => ({
    days: 180, acceptAfterDays: 7, replyAfterDays: 19, few: 30,
    overall: { n: 120, accepted: 36, acceptRate: 0.3, replyN: 90, replied: 9, replyRate: 0.1 },
    byCategory: [{ key: 'electrolytes', n: 40, accepted: 24, acceptRate: 0.58, replyN: 30, replied: 4, replyRate: 0.13, few: false },
      { key: 'beauty', n: 6, accepted: 1, acceptRate: 0.27, replyN: 4, replied: 0, replyRate: 0.08, few: true }],
    bySize: [{ key: 'target', n: 80, accepted: 26, acceptRate: 0.32, replyN: 60, replied: 6, replyRate: 0.1, few: false }],
    byBuyer: [{ key: 'partnerships', n: 50, accepted: 20, acceptRate: 0.39, replyN: 40, replied: 5, replyRate: 0.12, few: false }],
    byThreads: [{ key: '3', n: 31, accepted: 14, acceptRate: 0.44, replyN: 25, replied: 3, replyRate: 0.12, few: false }],
    suggestions: [{ category: 'electrolytes', from: 'middle', to: 'top', ratio: 1.9, text: 'accepts 1.9× the average (24 of 40) — make it Top?' }],
  }),
  secondTryBrands: () => ({
    total: 2, day: '2026-10-08', staleDays: 21,
    brands: [
      { id: 'r1', name: 'Quiet Open Co', category: 'energy', fit: 70, label: { kind: 'ready', reachable: 6, need: 3, onFile: 6 }, invited: 3, firstAt: '2026-09-15T15:00:00Z',
        open: [{ targetId: 'to1', name: 'Old Invite', sentAt: '2026-09-15T15:00:00Z' }], going: 2, people: [{ name: 'New Nia', title: 'Head of Partnerships' }] },
      { id: 'r2', name: 'Quiet Done Co', category: 'beauty', fit: 60, label: { kind: 'ready', reachable: 5, need: 3, onFile: 5 }, invited: 3, firstAt: '2026-09-10T15:00:00Z',
        open: [], going: 2, people: [{ name: 'Next Ned', title: 'Brand Manager' }] },
    ],
  }),
  markInvitesWithdrawn: ({ targetIds, preview }) => (preview
    ? { preview: true, will: targetIds.map((id) => ({ id, name: 'Old Invite', brand: 'Quiet Open Co' })), skipped: [] }
    : { ok: true, withdrawn: targetIds.length, skipped: [], brands: [] }),
  planDayChoices: () => ({ today: '2026-10-07', days: [{ key: '2026-10-08', label: 'Thu Oct 8' }, { key: '2026-10-13', label: 'Tue Oct 13' }], offDay: null }),
  // Section 11: Lock, Move this day to…, its Undo.
  planWeek: ({ days }) => ({ ok: true, lock: true, undo: true, days: days.map((d) => ({ date: d.date, ok: true, added: d.brandIds.length, people: 4, refused: [] })) }),
  moveDay: ({ from, to, confirm, expect }) => {
    const pv = {
      preview: true, from, to: to || null, opening: false, whole: false, category: 'spirits', categoryLost: to ? 'spirits' : null, toCategory: to ? 'bestfit' : null, offTheme: [],
      results: to ? [{ brandId: 'x1', brandName: 'Moved Co', added: true, state: 'going', going: 3 }, { brandId: 'x2', brandName: 'Refused Co', added: false, state: 'refused', reasonText: 'Resting until Oct 20' }]
        : [{ brandId: 'x1', brandName: 'Moved Co', added: false, state: 'back' },
          { brandId: 'x3', brandName: 'Halfsent Co', added: false, state: 'back', restOn: '2026-10-13', restLabel: 'Tue Oct 13' }],
      resat: to ? [] : [{ id: 'x3', name: 'Halfsent Co', from, to: '2026-10-13', label: 'Tue Oct 13' }],
      cap: 30, expect: 'mv1',
    };
    if (!confirm) return pv;
    if (expect === 'mv1') return { ...pv, expect: 'mv2', stale: true };
    skipDays = [{ date: from, to: to || null }];
    return { ok: true, from, to: to || null, moved: 1, back: ['Refused Co'], message: 'Thu Oct 8 is off · its plan moved to Tue Oct 13' };
  },
  setExtraSendingDay: ({ date, on, preview }) => (on
    ? { ok: true, extraDays: [date], removedBrands: [], message: date + ' added as a sending day.' }
    : preview
      ? { preview: true, date, removedBrands: ['Plain Co'], restOn: [{ name: 'Halfsent Co', on: '2026-10-13', label: 'Tue Oct 13' }] }
      : { ok: true, extraDays: [], removedBrands: ['Plain Co'], restOn: [{ name: 'Halfsent Co', on: '2026-10-13', label: 'Tue Oct 13' }], message: 'Fri Oct 9 is no longer a sending day.' }),
  undoMoveDay: ({ date, preview }) => {
    if (preview) return { ok: true, preview: true, date, to: '2026-10-13', back: ['Moved Co', 'Refused Co'], stay: [], categoryBack: false, closeTo: false,
      unqueue: undoToday ? [{ brand: 'Moved Co', people: 2 }] : [] };
    skipDays = [];
    return { ok: true, date };
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
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      if (fn === 'planAddBrands' && slowAdd) await new Promise((r) => setTimeout(r, slowAdd));
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.gotoView === 'function');
  await page.evaluate(() => { try { localStorage.removeItem('sb.schedFindDay'); } catch (e) {} gotoView('schedule'); });
  await page.waitForSelector('#sched-days .sd-day');
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 150; i++) { if (pred()) return; await page.waitForTimeout(20); }
    throw new Error('timed out waiting for ' + what);
  };

  // 1. Layout -----------------------------------------------------------
  assert.ok(await page.$('#sched-extra [data-olopen="plan"]'), 'Plan for Zach on screen');
  assert.ok(await page.$('#sd-more [data-sdpw]'), 'Plan my week in More');
  assert.ok(await page.$('#sd-more [data-cpopen]'), 'Category priority in More');
  assert.ok(await page.$('#sd-more [data-hidesmall="sched"]'), 'Hide too small in More');
  assert.equal(await page.isVisible('#sd-more [data-sdpw]'), false, 'More starts closed');
  assert.doesNotMatch(await page.textContent('#sched-extra'), /LinkedIn:/, 'no LinkedIn line while it does not warn');
  assert.ok(await page.$('#sf-q'), 'one find box');
  assert.equal((await page.$$('[data-sdq]')).length, 0, 'no per-day add boxes');
  assert.equal(await page.evaluate(() => document.getElementById('sched-catfold').open), false, 'categories folded');
  assert.deepEqual(await page.$$eval('#sf-days .sd-chip', (els) => els.map((e) => e.textContent)), ['Today23 open', 'Thu Oct 826 open', 'Tue Oct 1330 open']);
  // + Add a sending day keeps More open with its date field showing.
  await page.click('#sd-more > summary');
  await page.click('#sd-more [data-sdxtoggle]');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.getElementById('sd-more').open), true, 'More stays open');
  assert.equal(await page.isVisible('#sd-more [data-sdxdate]'), true, 'the date field shows');
  await page.click('#sd-more a[data-sdxtoggle]');
  await page.click('#schedule h1');
  // A day's ⋯ → See every <category> brand opens the folded drill-in.
  await page.click('[data-drop="2026-10-08"] .sd-day-h .sd-cm > summary');
  await page.click('[data-drop="2026-10-08"] [data-sdseecat="spirits"]');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.getElementById('sched-catfold').open), true, 'See every opens Categories & coverage');
  await page.evaluate(() => { document.getElementById('sched-catfold').open = false; });
  console.log('✓ 1 layout: toolbar + More, one find box with day chips, folds');

  // 2. The day menu -------------------------------------------------------
  const opts = await page.$$eval('[data-sdcatsel="2026-10-07"] option', (els) => els.map((e) => [e.value, e.selected, e.parentElement.tagName === 'OPTGROUP' ? e.parentElement.label : '']));
  assert.deepEqual(opts[0], ['', true, ''], 'Best fit first and selected');
  assert.match(await page.textContent('[data-sdcatsel="2026-10-07"] option'), /Best fit/);
  const groups = await page.$$eval('[data-sdcatsel="2026-10-07"] optgroup', (els) => els.map((e) => e.label));
  assert.deepEqual(groups.slice(0, 3), ['Top priority', 'Middle priority', 'Low priority']);
  assert.equal(opts.find((o) => o[0] === 'spirits')[2], 'Top priority');
  assert.equal(opts.find((o) => o[0] === 'apparel')[2], 'Low priority');
  assert.equal(await page.$eval('[data-sdcatsel="2026-10-08"]', (el) => el.value), 'spirits', 'a category day shows its category');
  console.log('✓ 2 day menu: ★ Best fit first, then categories Top → Low');

  // 3. Category change replaces the list ------------------------------------
  let applies = () => calls.filter((c) => c.fn === 'planApplyCategory' && c.args.preview === false).length;
  await page.selectOption('[data-sdcatsel="2026-10-08"]', 'betting');
  await page.waitForSelector('.sd-theme');
  const card = await page.textContent('.sd-theme');
  assert.match(card, /BodyArmor/); assert.match(card, /Liquid Death/); assert.match(card, /1 person out of today/);
  assert.equal(applies(), 0, 'nothing written before Replace');
  await page.click('[data-sdthemex]');
  await waitFor(() => true, '');
  assert.equal(await page.$('.sd-theme'), null, 'Cancel closes the card');
  assert.equal(applies(), 0, 'Cancel writes nothing');
  await page.selectOption('[data-sdcatsel="2026-10-08"]', 'betting');
  await page.waitForSelector('[data-sdthemego]');
  await page.click('[data-sdthemego]');
  await page.waitForFunction(() => !document.querySelector('.sd-theme'));
  const go = calls.filter((c) => c.fn === 'planApplyCategory' && c.args.preview === false).slice(-1)[0];
  assert.deepEqual([go.args.date, go.args.category, go.args.expect, go.args.keepPins], ['2026-10-08', 'betting', 'sig1', false]);
  // Nothing to take off: applied at once, in the one call (applyIfNone —
  // one-request-per-click: no preview, then apply).
  const before = applies(), asked = count('planApplyCategory'), from = calls.length;
  await page.selectOption('[data-sdcatsel="2026-10-13"]', 'beauty');
  // A refresh anywhere after the apply (other reads may follow it, so not
  // "among the last few calls" — that raced on a slower CI runner).
  const refreshedAfterApply = () => {
    const i = calls.findIndex((c, j) => j >= from && c.fn === 'planApplyCategory');
    return i >= 0 && calls.slice(i + 1).some((c) => c.fn === 'getOutreachPlan');
  };
  await waitFor(refreshedAfterApply, 'the direct apply and its refresh');
  assert.equal(count('planApplyCategory'), asked + 1, 'one call');
  assert.equal(last('planApplyCategory').args.applyIfNone, true);
  assert.equal(applies(), before, 'no second, apply-only call');
  // Make the day match: asks with the day's own category (Best fit = null).
  await page.waitForSelector('[data-sdmatch="2026-10-07"]');
  await page.click('[data-sdmatch="2026-10-07"]');
  await page.waitForSelector('.sd-theme');
  const ask = calls.filter((c) => c.fn === 'planApplyCategory').slice(-1)[0];
  assert.deepEqual([ask.args.date, ask.args.category, ask.args.preview], ['2026-10-07', null, undefined]);
  await page.click('[data-sdthemekeep]');
  await page.waitForFunction(() => !document.querySelector('.sd-theme'));
  assert.equal(last('planApplyCategory').args.keepPins, true);
  // Undo.
  await page.waitForSelector('[data-sdthemeundo]');
  await page.click('[data-sdthemeundo]');
  await waitFor(() => calls.some((c) => c.fn === 'undoDayTheme' && !c.args.preview), 'undo');
  assert.ok(calls.some((c) => c.fn === 'undoDayTheme' && c.args.preview), 'undo previews first');
  console.log('✓ 3 category change: shows what comes off, Replace sends the preview, Cancel writes nothing, Make the day match, Undo');

  // 4. Find box ----------------------------------------------------------
  await page.click('#sf-q');
  await page.type('#sf-q', 'celcius');
  await page.waitForSelector('#sf-res .sd-fr[data-sfrow]');
  assert.equal(last('searchPlanBrands').args.date, '2026-10-07', 'asks for the chosen day');
  assert.match(await page.textContent('#sf-res'), /did you mean this\?/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(count('planAddBrands'), 0, 'Enter on an Add anyway row adds nothing');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(count('planAddBrands'), 0, 'Enter alone never adds a spelling guess');
  await page.keyboard.press('Shift+Enter');
  await waitFor(() => count('planAddBrands') === 1, 'the add');
  assert.deepEqual([last('planAddBrands').args.date, last('planAddBrands').args.brandIds], ['2026-10-07', ['c1']]);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'sf-q', 'cursor stays in the box');
  assert.equal(await page.inputValue('#sf-q'), '', 'box cleared for the next one');
  // Another day.
  await page.click('[data-sfday="2026-10-08"]');
  await page.type('#sf-q', 'cel');
  await page.waitForSelector('#sf-res [data-sfadd="c1"]');
  assert.equal(last('searchPlanBrands').args.date, '2026-10-08');
  assert.match(await page.textContent('#sf-res [data-sfadd="c1"]'), /Add to Thu Oct 8/);
  await page.fill('#sf-q', '');
  // A pasted list.
  await page.evaluate(() => {
    const inp = document.getElementById('sf-q');
    const dt = new DataTransfer();
    dt.setData('text', 'Celsius\nGhost\nAlani Nu');
    inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await waitFor(() => count('matchBrandList') === 1, 'paste check');
  assert.equal(last('matchBrandList').args.date, '2026-10-08');
  assert.match(await page.textContent('#sf-paste'), /Paste a list for Thu Oct 8/);
  console.log('✓ 4 find box: the chosen day, did-you-mean rows, ↓ Enter adds, Add anyway needs a click, focus kept, paste');

  // 5. Category priority ------------------------------------------------
  await page.click('#sd-more > summary');
  await page.click('#sd-more [data-cpopen]');
  await page.waitForSelector('#cp-scrim.open [data-cpcat="apparel"]');
  await page.selectOption('[data-cpcat="apparel"]', 'skip');
  await waitFor(() => count('setCategoryPriority') === 1, 'priority save');
  assert.deepEqual(last('setCategoryPriority').args, { category: 'apparel', priority: 'skip' });
  await page.click('#cp-close');
  console.log('✓ 5 category priority: one category at a time');

  // 6. The queue rules ------------------------------------------------
  const rules = await page.textContent('#sched-extra .sd-rules');
  assert.match(rules, /New brands only/);
  assert.match(rules, /Giants: held back \(7\)/);
  await page.click('#sched-extra [data-sdgiants="1"]');
  await waitFor(() => count('setGiantsOn') === 1, 'the giants switch');
  assert.deepEqual(last('setGiantsOn').args, { on: true });
  await page.waitForFunction(() => /Giants: on/.test(document.querySelector('#sched-extra .sd-rules').textContent));
  await page.click('#sched-extra [data-sdgiants="0"]');
  await waitFor(() => count('setGiantsOn') === 2, 'holding them back again');
  assert.deepEqual(last('setGiantsOn').args, { on: false });
  // A giant pinned before the rules: its card says why and offers Add anyway.
  giantCard = true;
  await page.evaluate(() => sdRefresh());
  await page.waitForSelector('[data-sdgiantok="g1"]');
  assert.match(await page.textContent('[data-drop="2026-10-13"]'), /A giant \(a household name\)/);
  await page.click('[data-sdgiantok="g1"]');
  await waitFor(() => count('allowGiant') === 1, 'Add anyway on the card');
  assert.deepEqual(last('allowGiant').args, { brandId: 'g1' });
  giantCard = false;
  // An add that comes back "a giant" asks (the dialog says yes) and adds
  // just the giants again with allowGiants.
  const adds0 = count('planAddBrands');
  await page.evaluate(() => sdAdd('2026-10-13', ['x1', 'g2']));
  await waitFor(() => count('planAddBrands') === adds0 + 2, 'the second add');
  const [askAdd, giantAdd] = calls.filter((c) => c.fn === 'planAddBrands').slice(-2);
  assert.deepEqual([askAdd.args.brandIds, askAdd.args.allowGiants], [['x1', 'g2'], undefined]);
  assert.deepEqual([giantAdd.args.brandIds, giantAdd.args.allowGiants], [['g2'], ['g2']]);
  // The find box: Add anyway on a giant row is the yes.
  await page.click('[data-sfday="2026-10-13"]');
  await page.fill('#sf-q', '');
  await page.type('#sf-q', 'red');
  await page.waitForSelector('#sf-res [data-sfadd="g3"]');
  assert.match(await page.textContent('#sf-res'), /held back for now/);
  await page.click('#sf-res [data-sfadd="g3"]');
  await waitFor(() => last('planAddBrands').args.brandIds[0] === 'g3', 'the giant row add');
  assert.deepEqual(last('planAddBrands').args.allowGiants, ['g3']);
  console.log('✓ 6 queue rules: the Giants line + switch, Add anyway on a card, an add asks for giants, a giant row');

  // 7. Not now on any day; today's waiting note ------------------------
  const x2 = '[data-drop="2026-10-08"] [data-stoday="a2"]';
  await page.waitForSelector(x2);
  assert.match(await page.getAttribute(x2, 'title'), /Not now — off outreach for 2 weeks/);
  await page.click(x2);
  await waitFor(() => count('passBrandToday') === 1, 'Not now on a later day');
  assert.deepEqual(last('passBrandToday').args, { brandId: 'a2' });
  assert.ok(await page.$('[data-drop="2026-10-07"] [data-stoday="a1"]'), 'today\'s automatic row keeps its ×');
  waitCard = true;
  await page.evaluate(() => sdRefresh());
  await page.waitForFunction(() => /planned brand waits/.test(document.querySelector('[data-drop="2026-10-07"]').textContent));
  const todayCol = await page.textContent('[data-drop="2026-10-07"]');
  assert.match(todayCol, /Move a brand to another day .*Send today anyway/);
  assert.doesNotMatch(todayCol, /Drag to change who goes first/);
  waitCard = false;
  console.log('✓ 7 Not now (a Pass) on any day\'s automatic row; today\'s waiting note says move or send anyway');

  // 8. The Fill box: rows stay under the mouse ------------------------
  const sugFold = '[data-sdfillbox="2026-10-13"] details[data-sdsugfold]';
  await page.waitForSelector('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s1"]', { state: 'attached' });
  await page.click(sugFold + ' > summary');
  await page.waitForSelector('[data-sdmissadd="s1"]');
  const at = async (id) => {
    const b = await page.$('[data-sdfillbox="2026-10-13"] [data-sdmissadd="' + id + '"]');
    const r = await b.boundingBox();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const p1 = await at('s1'), p2 = await at('s2'), p3 = await at('s3');
  const adds8 = count('planAddBrands');
  const plans8 = count('getOutreachPlan');
  slowAdd = 250;
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(100);
  assert.match(await page.textContent('[data-sdfillbox="2026-10-13"]'), /Adding…/, 'the clicked row reads Adding…');
  assert.match(await page.textContent('[data-sdfillbox="2026-10-13"] [data-sdaddsline]'), /Adds/, 'the Adds line stays while a call is out');
  await page.mouse.click(p2.x, p2.y);
  // The moment the first add's refresh lands, click the third row's spot.
  await waitFor(() => count('getOutreachPlan') > plans8, 'the refresh after the first add');
  await page.mouse.click(p3.x, p3.y);
  await waitFor(() => count('planAddBrands') === adds8 + 3, 'three adds');
  slowAdd = 0;
  assert.deepEqual(calls.filter((c) => c.fn === 'planAddBrands').slice(-3).map((c) => [c.args.date, c.args.brandIds]),
    [['2026-10-13', ['s1']], ['2026-10-13', ['s2']], ['2026-10-13', ['s3']]], 'exactly the rows clicked');
  // Ticked rows: one call.
  await page.waitForSelector('[data-sdfck="s4"]');
  await page.check('[data-sdfck="s4"]');
  await page.check('[data-sdfck="s5"]');
  assert.equal(await page.textContent('[data-sdfilltick="2026-10-13"]'), 'Add 2 ticked');
  const adds8b = count('planAddBrands');
  await page.click('[data-sdfilltick="2026-10-13"]');
  await waitFor(() => count('planAddBrands') === adds8b + 1, 'the ticked add');
  assert.deepEqual(last('planAddBrands').args.brandIds, ['s4', 's5'], 'both ticked, one call');
  console.log('✓ 8 Fill box: quick clicks add the rows under the mouse, Adding… in place, Add N ticked in one call');

  // 9. LinkedIn's week caps a day's own picks; carried cards go first ----
  pinned13 = [];
  cap13 = 10;
  carryCard = true;
  await page.evaluate(() => sdRefresh());
  await page.waitForFunction(() => /week limit/.test(document.querySelector('[data-drop="2026-10-13"] .sd-day-n').textContent));
  assert.match(await page.textContent('[data-drop="2026-10-13"] .sd-day-n'), /6 \/ 10/);
  assert.match(await page.textContent('[data-sdfill20="2026-10-13"]'), /Fill to 10/);
  assert.match(await page.textContent('[data-drop="2026-10-13"]'), /From Thu Oct 8 · carried 2×/);
  // Over the week: the real choice, not "move people to a later day".
  assert.match(await page.textContent('[data-drop="2026-10-13"] .sd-liwarn'), /This week goes over by 6; Tue Oct 13 can take 10\. Take a brand off it/);
  await page.click('[data-drop="2026-10-13"] [data-dragb="k2"] .sd-cm > summary');
  await page.click('[data-sdtop="k2"]');
  await waitFor(() => count('planReorderDay') === 1, 'Move to top');
  assert.deepEqual(last('planReorderDay').args, { date: '2026-10-13', brandIds: ['k2', 'k1'] });
  carryCard = false;
  cap13 = null;
  console.log('✓ 9 a day LinkedIn\'s week caps says so and fills to it; a carried card says how long, Move to top sends it first');

  // 10. Day header counts brands; What gets answered is read-only and only
  //     suggests; Ready for a second try is by hand only ----------------
  assert.match(await page.textContent('[data-drop="2026-10-07"] .sd-day-n'), /2 brands/, 'BodyArmor + Celsius');
  const prio10 = count('setCategoryPriority');
  await page.evaluate(() => { document.getElementById('sched-catfold').open = true; });
  await page.waitForSelector('#sched-out .sd-out');
  const out = await page.textContent('#sched-out');
  assert.match(out, /What gets answered/);
  assert.match(out, /accepts counted 7\+ days/);
  assert.match(out, /too few to tell/, 'a small cell says so');
  assert.match(out, /Brands with/);
  assert.equal(count('setCategoryPriority'), prio10, 'nothing changes by itself');
  await page.click('[data-sdoutprio="electrolytes"]');
  await waitFor(() => count('setCategoryPriority') === prio10 + 1, 'the confirmed suggestion');
  assert.deepEqual(last('setCategoryPriority').args, { category: 'electrolytes', priority: 'top' });
  assert.match(await page.textContent('#sched-retryfold > summary'), /Ready for a second try \(2\)/, 'the count shows folded');
  await page.click('#sched-retryfold > summary');
  await page.waitForSelector('[data-sdretrywd="r1"]');
  assert.equal(await page.$('[data-sdretryday="r1"]'), null, 'invites still out: withdraw first, no day picker yet');
  await page.click('[data-sdretrywd="r1"]');
  await waitFor(() => calls.filter((c) => c.fn === 'markInvitesWithdrawn').length === 2, 'preview then log');
  const wd = calls.filter((c) => c.fn === 'markInvitesWithdrawn');
  assert.deepEqual([wd[0].args.preview, wd[1].args.preview, wd[1].args.targetIds], [true, undefined, ['to1']], 'previewed, then exactly what it showed');
  await page.waitForSelector('[data-sdretryday="r2"] [data-pdday]');
  const adds10 = count('planAddBrands');
  await page.selectOption('[data-sdretryday="r2"] [data-pdday]', '2026-10-08');
  await waitFor(() => count('planAddBrands') === adds10 + 1, 'the day preview');
  assert.equal(last('planAddBrands').args.preview, true, 'Put on a day previews first');
  await page.click('[data-sdretryday="r2"] [data-pdapply]');
  await waitFor(() => count('planAddBrands') === adds10 + 2, 'the add');
  assert.deepEqual([last('planAddBrands').args.date, last('planAddBrands').args.brandIds], ['2026-10-08', ['r2']]);
  console.log('✓ 10 day header counts brands; What gets answered only suggests; a second try goes on a day by hand, invites withdrawn first');

  // 11. Less planning work: may-change tags, Lock this day, Move this day to…
  auto13 = true;
  await page.evaluate(() => sdRefresh());
  await page.waitForSelector('[data-drop="2026-10-13"] [data-dragb="a3"]');
  assert.match(await page.textContent('[data-drop="2026-10-13"] [data-dragb="a3"] .sd-card-h'), /Best fit · may change/, 'a Best fit day\'s automatic row');
  const tag08 = await page.textContent('[data-drop="2026-10-08"] [data-dragb="a2"] .sd-card-h');
  assert.match(tag08, /may change/);
  assert.doesNotMatch(tag08, /Best fit/, 'a category day\'s row is just "may change"');
  assert.doesNotMatch(await page.textContent('[data-drop="2026-10-07"] [data-dragb="a1"] .sd-card-h'), /may change/, 'today\'s rows go into the list as they are');
  assert.equal(await page.$('[data-drop="2026-10-07"] [data-sdlock]'), null, 'today is never locked');
  assert.equal(await page.$('[data-drop="2026-10-07"] [data-sdmoveday]'), null, 'today has Move what\'s left, not Move this day');
  await page.click('[data-drop="2026-10-08"] .sd-day-h .sd-cm > summary');
  dialogs.length = 0;
  await page.click('[data-sdlock="2026-10-08"]');
  await waitFor(() => count('planWeek') === 1, 'the lock');
  assert.match(dialogs[0], /Lock Thu Oct 8\?[\s\S]*1\. Patrón \(4\)/, 'Lock names the brands first');
  assert.deepEqual(last('planWeek').args, { apply: true, lock: true, days: [{ date: '2026-10-08', brandIds: ['a2'] }] }, 'exactly the automatic rows, in order');
  await page.waitForSelector('[data-drop="2026-10-08"] [data-sdmoveday]', { state: 'attached' });
  const openDayMenu = async (k) => {
    if (!await page.isVisible('[data-sdmoveday="' + k + '"]')) await page.click('[data-drop="' + k + '"] .sd-day-h .sd-cm > summary');
  };
  await openDayMenu('2026-10-08');
  // Only later days are targets: today never is.
  const targets = await page.$$eval('[data-sdmoveday="2026-10-08"] option', (os) => os.map((o) => o.value));
  assert.deepEqual(targets, ['', '2026-10-09', '2026-10-13', '__none'], 'later days, the next off day, or no day: ' + targets);
  await page.selectOption('[data-sdmoveday="2026-10-08"]', '2026-10-13');
  await waitFor(() => count('moveDay') === 1, 'the preview');
  assert.deepEqual(last('moveDay').args, { from: '2026-10-08', to: '2026-10-13', addDay: false, preview: true });
  await page.waitForSelector('[data-sdmdaygo="2026-10-08"]');
  const mcard = await page.textContent('[data-drop="2026-10-08"] .sd-theme');
  assert.match(mcard, /Thu Oct 8 off → Tue Oct 13\./);
  assert.match(mcard, /Moved Co 3 people on Tue Oct 13/);
  assert.match(mcard, /Refused Co can’t go on Tue Oct 13 \(Resting until Oct 20\) · back to waiting/);
  assert.match(mcard, /Thu Oct 8’s category \(Spirits[^)]*\) stays behind/);
  await page.click('[data-sdmdaygo="2026-10-08"]');
  await waitFor(() => count('moveDay') === 2, 'the first apply');
  assert.deepEqual(last('moveDay').args, { from: '2026-10-08', to: '2026-10-13', addDay: false, confirm: true, expect: 'mv1' });
  await page.waitForFunction(() => /The day changed since/.test(document.querySelector('[data-drop="2026-10-08"] .sd-theme').textContent));
  await page.click('[data-sdmdaygo="2026-10-08"]');
  await waitFor(() => count('moveDay') === 3, 'the apply after stale');
  assert.equal(last('moveDay').args.expect, 'mv2', 'the new preview\'s signature');
  await page.waitForSelector('#sched-extra [data-sdskipundo="2026-10-08"]');
  assert.match(await page.textContent('#sched-extra'), /Thu Oct 8 off/);
  dialogs.length = 0;
  await page.click('#sched-extra [data-sdskipundo="2026-10-08"]');
  await waitFor(() => count('undoMoveDay') === 2, 'Undo preview then apply');
  assert.deepEqual(calls.filter((c) => c.fn === 'undoMoveDay').map((c) => c.args), [{ date: '2026-10-08', preview: true }, { date: '2026-10-08' }]);
  assert.match(dialogs[0], /Send on Thu Oct 8 after all\?[\s\S]*Back on Thu Oct 8: Moved Co, Refused Co/);
  await page.waitForFunction(() => !document.querySelector('#sched-extra [data-sdskipundo]'));
  // No day: the brands go back to waiting.
  await openDayMenu('2026-10-08');
  await page.selectOption('[data-sdmoveday="2026-10-08"]', '__none');
  await waitFor(() => count('moveDay') === 4, 'the take-it-off preview');
  assert.deepEqual(last('moveDay').args, { from: '2026-10-08', to: null, addDay: false, preview: true });
  await page.waitForSelector('[data-sdmdaygo="2026-10-08"]');
  // A part-sent brand there for its rest: that rest moves to its new day
  // (third review), said on its row once — not "back to waiting".
  const offCard = await page.textContent('[data-drop="2026-10-08"] .sd-theme');
  assert.match(offCard, /Its planned brands: ?Moved Co back to waiting/, offCard);
  assert.match(offCard, /Halfsent Co the rest of its first outreach goes Tue Oct 13, first/, offCard);
  assert.doesNotMatch(offCard, /Moves to its new day/, 'not named twice: ' + offCard);
  assert.match(await page.textContent('[data-sdmdaygo="2026-10-08"]'), /Take the day off/);
  await page.click('[data-sdmdayx="2026-10-08"]');
  await page.waitForFunction(() => !document.querySelector('[data-sdmdaygo="2026-10-08"]'));
  assert.equal(count('moveDay'), 4, 'Cancel writes nothing');
  // Remove this sending day (an extra day): asks the server first, and the
  // question names a part-sent brand's rest moving on (third review).
  dialogs.length = 0;
  const xBefore = count('setExtraSendingDay');
  await page.evaluate(() => sdRemoveExtraDay('2026-10-09'));
  await waitFor(() => count('setExtraSendingDay') === xBefore + 2, 'preview then apply');
  assert.deepEqual(calls.filter((c) => c.fn === 'setExtraSendingDay').slice(-2).map((c) => c.args),
    [{ date: '2026-10-09', on: false, preview: true }, { date: '2026-10-09', on: false }]);
  assert.match(dialogs[0], /Remove Fri Oct 9 as a sending day\?[\s\S]*back to unscheduled: Plain Co\.[\s\S]*goes first on another day: Halfsent Co → Tue Oct 13/, dialogs[0]);
  // A day taken off is offered back as "send on it after all".
  assert.equal(await page.evaluate(() => { SCHED.skipDays = [{ date: '2026-10-09' }]; return sdOffWord({ key: '2026-10-09' }); }), ' (send on it after all)');
  assert.equal(await page.evaluate(() => { SCHED.skipDays = []; return sdOffWord({ key: '2026-10-09' }); }), ' (adds it as a sending day)');
  // The brand page says where an automatic row is (lock-days d).
  const bpLine = await page.evaluate(() => {
    var slot = document.createElement('div'); slot.id = 'b-plan'; document.body.appendChild(slot);
    BP.id = 'z9'; BP.note = null;
    BP.data = { today: '2026-10-07', days: [{ key: '2026-10-08', label: 'Thu Oct 8' }], offDay: null, brand: { id: 'z9', name: 'Zed', shownOn: '2026-10-08', going: 0 } };
    bpRender();
    var t1 = slot.textContent;
    BP.data.brand.shownOn = '2026-10-07';
    bpRender();
    var t2 = slot.textContent;
    slot.remove();
    return [t1, t2];
  });
  assert.match(bpLine[0], /Shown on Thu Oct 8 \(not locked\)/, 'not "Not on a day": ' + bpLine[0]);
  assert.match(bpLine[1], /On today’s list \(picked automatically/);
  auto13 = false;
  console.log('✓ 11 may-change tags on later days, Lock this day, Move this day to… (preview, stale, apply, take off, Cancel), the off chip\'s Undo');

  // 12. Faster page (Oct 2026): the Fill box lists come with the Schedule,
  //     quick clicks share one refresh, a tab return with nothing changed
  //     reads nothing else and redraws nothing, the folded section waits
  //     until it opens, Off today and Archive are one call each ----------
  pinned13 = [];
  embedSug = true;
  const sug12 = count('suggestForDay');
  // (Section 8's added rows have let go by now in real time.)
  await page.evaluate(() => { SCHED.adding = {}; document.getElementById('sched-catfold').open = false; return sdRefresh(); });
  await page.waitForSelector('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s1"]', { state: 'attached' });
  assert.deepEqual([last('getOutreachPlan').args.suggest, last('getOutreachPlan').args.hideSmall], [true, true], 'the refresh asks for the lists');
  assert.equal(count('suggestForDay'), sug12, 'no suggestForDay: the Schedule brought the list');
  assert.equal(await page.$eval('[data-sdfill20="2026-10-13"]', (b) => b.disabled), false, 'Fill to 30 ready at once');
  // Two quick adds while the first is still out: one refresh for both.
  slowAdd = 300;
  const plans12 = count('getOutreachPlan'), adds12 = count('planAddBrands');
  await page.evaluate(() => { sdAdd('2026-10-13', ['s1'], { quiet: true }); sdAdd('2026-10-13', ['s2'], { quiet: true }); });
  await waitFor(() => count('planAddBrands') === adds12 + 2 && count('getOutreachPlan') > plans12, 'both adds and a refresh');
  await page.waitForTimeout(400);
  slowAdd = 0;
  assert.equal(count('getOutreachPlan'), plans12 + 1, 'one refresh after the two adds, not two');
  assert.equal(count('suggestForDay'), sug12, 'and still no suggestForDay');
  // Back on the tab with nothing changed: one small check, nothing redrawn.
  stampVal = 'st1';
  await page.evaluate(() => sdRefresh());
  await waitFor(() => true, '');
  await page.waitForFunction(() => SCHED.stamp === 'st1');
  const before12 = { cov: count('categoryCoverage'), brands: count('categoryBrands'), retry: count('secondTryBrands'), sug: count('suggestForDay'), plans: count('getOutreachPlan') };
  await page.evaluate(() => { document.querySelector('#sched-days .sd-day').setAttribute('data-mark', '1'); SCHED.loadedAt = 0; window.dispatchEvent(new Event('focus')); });
  await waitFor(() => count('getOutreachPlan') === before12.plans + 1, 'the quiet check');
  await page.waitForTimeout(150);
  assert.equal(last('getOutreachPlan').args.since, 'st1', 'the check sends the stamp');
  assert.deepEqual([count('categoryCoverage'), count('categoryBrands'), count('secondTryBrands'), count('suggestForDay')], [before12.cov, before12.brands, before12.retry, before12.sug], 'nothing else read');
  assert.equal(await page.$eval('#sched-days .sd-day', (el) => el.getAttribute('data-mark')), '1', 'nothing redrawn');
  // Something changed: the answer is drawn, and the rest read again.
  stampVal = 'st2';
  await page.evaluate(() => { SCHED.loadedAt = 0; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => !document.querySelector('#sched-days .sd-day[data-mark]'));
  await waitFor(() => count('secondTryBrands') > before12.retry, 'Ready for a second try read again');
  assert.equal(count('categoryCoverage'), before12.cov, 'coverage waits while its fold is shut');
  // Folded with a category open: a change reads nothing for it; opening
  // the fold reads it once, and coverage with it.
  await page.evaluate(() => { document.getElementById('sched-catfold').open = true; sdOpenCat('energy'); });
  await waitFor(() => count('categoryBrands') > before12.brands, 'the open category');
  await waitFor(() => count('categoryCoverage') === before12.cov + 1, 'coverage, stale since the tab return, read on opening');
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.getElementById('sched-catfold').open = false; });
  await page.waitForTimeout(50);
  const cb12 = count('categoryBrands'), cov12 = count('categoryCoverage');
  await page.evaluate(() => sdAdd('2026-10-13', ['s3'], { quiet: true }));
  await page.waitForTimeout(300);
  assert.equal(count('categoryBrands'), cb12, 'folded: the change reads nothing for the category');
  await page.evaluate(() => { document.getElementById('sched-catfold').open = true; });
  await waitFor(() => count('categoryBrands') === cb12 + 1, 'opening reads it once');
  await page.waitForTimeout(200);
  assert.equal(count('categoryBrands'), cb12 + 1, 'exactly once');
  assert.equal(count('categoryCoverage'), cov12, 'coverage only reads again after a tab return (an add changes no invite)');
  await page.evaluate(() => { document.getElementById('sched-catfold').open = false; SCHED.openCat = null; });
  // Off today: the Pass alone. Archive on a pinned card: one call.
  const moves12 = count('planMoveBrand'), passes12 = count('passBrandToday'), removes12 = count('planRemoveBrand');
  await page.evaluate(() => sdMove('a1', 'Celsius', '', ''));
  await waitFor(() => count('passBrandToday') === passes12 + 1, 'the Pass');
  assert.equal(count('planMoveBrand'), moves12, 'no planMoveBrand first');
  await page.click('[data-drop="2026-10-07"] [data-dragb="p1"] .sd-cm > summary');
  await page.click('[data-drop="2026-10-07"] [data-spass="p1"]');
  await waitFor(() => count('setBrandPassed') === 1, 'Archive');
  assert.deepEqual(last('setBrandPassed').args, { brandId: 'p1', passed: true, unpin: true });
  await page.waitForTimeout(150);
  assert.equal(count('planRemoveBrand'), removes12, 'no second call to take it off its day');
  embedSug = false;
  stampVal = '';
  console.log('✓ 12 faster page: Fill box lists come with the Schedule, two quick adds = one refresh, an unchanged tab return reads and redraws nothing, the shut fold waits, Off today / Archive one call each');

  // 13. Review fixes ------------------------------------------------------
  pinned13 = [];
  await page.evaluate(() => { SCHED.adding = {}; SCHED.fillSel = {}; return sdRefresh(); });
  await page.waitForSelector('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s1"]', { state: 'attached' });
  if (!await page.isVisible('[data-sdmissadd="s1"]')) await page.click(sugFold + ' > summary');
  // a. A Best fit day holding a big company: Fill to 30 adds no second one.
  SUG[0].big = true; SUG[1].big = true;
  bigs13 = 1;
  await page.evaluate(() => sdRefresh());
  await page.waitForFunction(() => (SCHED.days['2026-10-13'] || {}).bigs === 1);
  await page.waitForFunction(() => sdFillReady('2026-10-13'));
  assert.deepEqual(await page.evaluate(() => sdFillTip('2026-10-13').fit.ids), ['s3', 's4', 's5', 's6'], 'no big one while the day holds one');
  bigs13 = 0;
  await page.evaluate(() => sdRefresh());
  await page.waitForFunction(() => (SCHED.days['2026-10-13'] || {}).bigs === 0 && sdFillReady('2026-10-13'));
  assert.deepEqual(await page.evaluate(() => sdFillTip('2026-10-13').fit.ids), ['s1', 's3', 's4', 's5', 's6'], 'one big one, never two');
  delete SUG[0].big; delete SUG[1].big;
  // b. A tick on a brand that left the list is dropped, never added unseen.
  await page.waitForSelector('[data-sdfck="s4"]');
  await page.check('[data-sdfck="s4"]');
  await page.check('[data-sdfck="s5"]');
  pinned13 = ['s4'];   // s4 went onto the day another way (dragged, Fill to 30)
  await page.evaluate(() => sdRefresh());
  await page.waitForFunction(() => !document.querySelector('[data-sdfillbox="2026-10-13"] [data-sdfck="s4"]') &&
    /Add 1 ticked/.test((document.querySelector('[data-sdfilltick="2026-10-13"]') || {}).textContent || ''));
  const adds13 = count('planAddBrands');
  await page.click('[data-sdfilltick="2026-10-13"]');
  await waitFor(() => count('planAddBrands') === adds13 + 1, 'the ticked add');
  assert.deepEqual(last('planAddBrands').args.brandIds, ['s5'], 'only the tick still on the list');
  // c. A failed add: the row reads "+ Add" again, not "Added ✓".
  await page.waitForSelector('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s6"]');
  failAdd = 's6';
  await page.click('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s6"]');
  await waitFor(() => last('planAddBrands').args.brandIds[0] === 's6', 'the failing add');
  await page.waitForFunction(() => { const b = document.querySelector('[data-sdfillbox="2026-10-13"] [data-sdmissadd="s6"]'); return b && /\+ Add/.test(b.textContent) && !b.disabled; });
  assert.equal(await page.$eval('[data-sdfillbox="2026-10-13"] .sd-orow[data-dragb="s6"]', (r) => r.classList.contains('sd-adding')), false, 'the failed row is not held as added');
  failAdd = '';
  // d. Plan my week: hand pins past the week's room aren't "Over by".
  const pwDay = await page.evaluate(() => {
    var keep = SCHED.pw;
    SCHED.pw = { data: { linkedin: { limit: 100, near: 90 } }, off: {} };
    var a = sdPwDayHtml({ date: '2026-10-16', cap: 10, keptPeople: 20, kept: [], add: [] });
    var b = sdPwDayHtml({ date: '2026-10-16', cap: 10, keptPeople: 33, kept: [], add: [] });
    SCHED.pw = keep;
    return [a, b];
  });
  assert.doesNotMatch(pwDay[0], /Over by/, 'twenty hand-pinned people on a week-capped day: not over');
  assert.match(pwDay[0], /Full ✓/);
  assert.match(pwDay[1], /Over by 3/, 'past the flat 30 still says so');
  // e. The off chip's Undo onto today names who leaves today's list.
  undoToday = true;
  skipDays = [{ date: '2026-10-08', to: '2026-10-13' }];
  await page.evaluate(() => sdRefresh());
  await page.waitForSelector('#sched-extra [data-sdskipundo="2026-10-08"]');
  dialogs.length = 0;
  const undo13 = count('undoMoveDay');
  await page.click('#sched-extra [data-sdskipundo="2026-10-08"]');
  await waitFor(() => count('undoMoveDay') === undo13 + 2, 'Undo preview then apply');
  assert.match(dialogs[0], /Out of today’s list, back to waiting: Moved Co \(2 people\)/);
  undoToday = false;
  console.log('✓ 13 review fixes: one big company in Fill to 30, stale ticks dropped, a failed add reads + Add, Plan my week over the flat 30, Undo names today\'s list');

  // 14. Second review (Oct 13 2026) ----------------------------------------
  skipDays = [];
  // a. × on today's card of a brand part-sent today: "the rest goes out Thu",
  // not "back tomorrow".
  await page.evaluate(() => sdRefresh());
  await page.waitForSelector('[data-drop="2026-10-07"] [data-sdunpin="p1"]');
  await page.click('[data-drop="2026-10-07"] [data-sdunpin="p1"]');
  await waitFor(() => count('planRemoveBrand') >= 1, 'the ×');
  await page.waitForFunction(() => /the rest of it goes out Thu Oct 8/.test(document.getElementById('toast').textContent));
  assert.doesNotMatch(await page.textContent('#toast'), /back tomorrow/);
  // b. Waiting on the one day for its rest: it says it rests after, not
  // "goes out <day>".
  endsCard = true;
  await page.evaluate(() => sdRefresh());
  await page.waitForSelector('[data-drop="2026-10-07"] [data-dragb="p8"]');
  const ends = await page.textContent('[data-drop="2026-10-07"] [data-dragb="p8"]');
  assert.match(ends, /the rest of its first outreach — move it up or send today anyway, or it rests until Tue Oct 20/);
  assert.doesNotMatch(ends, /goes out Thu/);
  endsCard = false;
  // c. Plan my week's Undo onto today names who leaves today's list and who
  // stays (sent today).
  dialogs.length = 0;
  const pwu = count('undoPlanWeek');
  await page.evaluate(() => sdPwUndo());
  await waitFor(() => count('undoPlanWeek') === pwu + 2, 'preview then apply');
  assert.match(dialogs[0], /Out of today’s LinkedIn list, back to waiting: BodyArmor \(2 people\)/);
  assert.match(dialogs[0], /Stays on today \(already sent some today\): Halfsent Co/);
  console.log('✓ 14 second review: × on a part-sent brand names the day for its rest, a waiting card on that day says it rests after, Plan my week\'s Undo names today\'s list');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All Schedule checks passed.');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
