// scripts/test-results-depth.js
//
// Results → Acceptance by people reached (Leo, Oct 18 2026: "on the results
// page a count for when we do outreach to x amount of people the percentage
// for an acceptance"). Drives public/app.html in Chromium against a fake
// /api/data:
//
//   1. Opening Results reads outcomeTable beside listReached and draws one row
//      per people count (1, 2, 3, 4, 5–9, 10+ — only the ones with brands), in
//      that order: the share of brands where someone accepted, "N of M brands",
//      each person's rate, and "too few to tell" under 30 brands.
//   2. The bar's width is that share; the hint gives each person's rate.
//   3. Nothing to judge yet (no per-person rate) → no card; an outcomeTable
//      error → no card, and the rest of Results still draws.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-results-depth.js   (~4s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-results-depth.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const cell = (key, brands, brandsYes, people, peopleYes) => ({
  key, brands, brandsYes, brandRate: brands ? brandsYes / brands : null,
  people, peopleYes, personRate: people ? peopleYes / people : null, few: brands < 30,
});
let OUTCOME = {
  days: 180, acceptAfterDays: 7, replyAfterDays: 19, few: 30,
  overall: { n: 278, accepted: 46, acceptRate: 0.165, replyN: 107, replied: 5, replyRate: 0.047 },
  byCategory: [], bySize: [], byBuyer: [], byThreads: [], suggestions: [],
  depth: {
    personRate: 0.165, day: 30, byOrder: [], byFirstDay: [], byFit: [], model: [],
    // Out of order on purpose: the page puts them 1, 2, 3, 4, 5–9, 10+.
    byTotal: [cell('4', 26, 13, 104, 19), cell('1', 40, 9, 40, 9), cell('10+', 2, 2, 24, 2), cell('3', 21, 9, 63, 10), cell('2', 0, 0, 0, 0)],
  },
};
let OUTCOME_ERR = null;

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  listReached: () => ({ brands: [], totals: { invited: 278, accepted: 46, replied: 5 } }),
  sentByDay: () => ({ days: [{ date: '2026-10-15', count: 12 }], cap: 30 }),
  outcomeTable: () => { if (OUTCOME_ERR) throw new Error(OUTCOME_ERR); return OUTCOME; },
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
  try {
    await page.goto(base + '/app.html');
    await page.waitForFunction(() => typeof window.loadReached === 'function');

    // 1. The rows, in order, with their numbers ---------------------------
    await page.evaluate(() => gotoView('reached'));
    await page.waitForSelector('#rc-depth .rcd tbody tr');
    assert.ok(calls.some((c) => c.fn === 'outcomeTable'), 'Results reads outcomeTable');
    assert.ok(calls.some((c) => c.fn === 'listReached'), 'and listReached beside it');
    const rows = await page.$$eval('#rc-depth .rcd tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepEqual(rows.map((r) => r[0]), ['1 person', '3 people', '4 people', '10+ people'], 'in order; a count with no brands is left out');
    assert.deepEqual(rows[2], ['4 people', '', '50%', '13 of 26 brands', '18% · 19 of 104', 'too few to tell'], 'share, brands, each person, too few');
    assert.deepEqual(rows[0].slice(2, 6), ['23%', '9 of 40 brands', '23% · 9 of 40', ''], '40 brands: enough to tell');
    const head = await page.textContent('#rc-depth .count-head');
    assert.match(head, /Acceptance by people reached/);
    assert.match(head, /invites 7\+ days old/);

    // 2. The bar and the hint ----------------------------------------------
    const width = await page.$eval('#rc-depth tbody tr:nth-child(3) .rcd-track i', (i) => i.style.width);
    assert.equal(width, '50%', 'the bar is the share');
    assert.match(await page.textContent('#rc-depth .hint'), /Each person accepts about 17% on their own/);
    assert.match(await page.getAttribute('#rc-depth tbody tr:nth-child(3)', 'title'), /someone accepted at 13 of 26 brands; 19 of 104 people accepted — too few to tell yet/);
    assert.ok(await page.$('#rc-kpis .kpi'), 'the tiles still draw');

    // 3. Nothing to judge / an error: no card, Results still draws ----------
    OUTCOME = { ...OUTCOME, depth: { ...OUTCOME.depth, personRate: null } };
    await page.evaluate(() => loadReached());
    await page.waitForFunction(() => !document.querySelector('#rc-depth .rcd'));
    OUTCOME_ERR = 'boom';
    await page.evaluate(() => loadReached());
    await page.waitForTimeout(200);
    assert.equal(await page.$('#rc-depth .rcd'), null, 'an error draws no card');
    assert.ok(await page.$('#rc-kpis .kpi'), 'the rest of Results still draws');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
    console.log('✓ Results: acceptance by people reached — rows in order, share / brands / each person / too few, bar, hint, no card when empty or failing');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
