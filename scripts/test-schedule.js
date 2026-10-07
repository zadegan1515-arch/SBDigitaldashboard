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
const PLAN = () => ({
  today: '2026-10-07',
  pool: { total: 40, cap: 30 },
  priority: PRIORITY,
  themeUndo,
  linkedinWeek: { sentLast7: 40, limit: 100, near: 80, days: {} },
  plan: { '2026-10-07': { category: null, brandIds: ['p1'] }, '2026-10-08': { category: 'spirits', brandIds: [] } },
  labels: {},
  days: [
    {
      date: '2026-10-07', today: true, category: 'bestfit', auto: true, total: 7, sent: 0, offTheme: 1,
      pinned: [{ id: 'p1', name: 'BodyArmor', category: 'electrolytes', state: 'going', going: 2, people: [{ name: 'Ann' }] }],
      brands: [{ id: 'a1', name: 'Celsius', going: 4, people: [{ name: 'Bo' }], category: 'energy' }],
      sentPeople: [], overflow: [],
    },
    {
      date: '2026-10-08', category: 'spirits', auto: false, total: 4, sent: 0, offTheme: 0,
      pinned: [], brands: [{ id: 'a2', name: 'Patrón', going: 4, people: [], category: 'spirits' }],
      sentPeople: [], overflow: [],
    },
    {
      date: '2026-10-13', category: 'bestfit', auto: true, total: 0, sent: 0, offTheme: 0,
      pinned: [], brands: [], sentPeople: [], overflow: [],
    },
  ],
  categories: [], past: [], extraDays: [], nextOffDay: '2026-10-09',
});

const ROWS = [
  { id: 'c1', name: 'Celsius', category: 'energy', action: 'add', text: '4 would go out', going: 4, label: { kind: 'ready', reachable: 4, need: 3, onFile: 5 }, pinnedOn: null, fit: { score: 72 }, matched: 'fuzzy', exact: false },
  { id: 'c2', name: 'Celsius Heat', category: 'energy', action: 'addAnyway', text: 'Invited Sep 16 · already reached', going: 1, label: { kind: 'thin', reachable: 1, need: 3, onFile: 1 }, pinnedOn: null, fit: { score: 40 }, matched: 'name', exact: false },
];

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], listTargets: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  getOutreachPlan: () => PLAN(),
  categoryCoverage: () => ({ weeks: [], rows: [] }),
  categoryBrands: ({ category }) => ({ category, brands: [] }),
  suggestForDay: () => ({ brands: [], others: [], needPeople: [], hiddenSmall: 0 }),
  searchPlanBrands: ({ q }) => ({ brands: /^cel/i.test(q) ? ROWS : [] }),
  planAddBrands: ({ date, brandIds }) => ({ ok: true, results: brandIds.map((id) => ({ brandId: id, brandName: id, added: true, state: 'going', going: 4, people: [] })) }),
  matchBrandList: ({ text }) => ({ lines: text.split('\n').map((t) => ({ input: t, brand: null, suggestions: [] })) }),
  planApplyCategory: ({ date, category, preview, keepPins, expect }) => {
    if (category === 'beauty' && preview !== false) return { date, category, changes: 0, unpin: [], unqueue: [], reopen: null, expect: 'sig0' };
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
  page.on('dialog', (d) => d.accept());
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
  // Nothing to take off: applied at once.
  const before = applies();
  await page.selectOption('[data-sdcatsel="2026-10-13"]', 'beauty');
  await waitFor(() => applies() > before, 'the direct apply');
  assert.equal(last('planApplyCategory').args.expect, 'sig0');
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

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All Schedule checks passed.');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
