// scripts/test-claude-day.js — Home → Claude's day (Leo, Oct 14 2026: "at
// the end of each day i want a review of everything that was updated
// through claude"). Drives public/app.html in Chromium against a fake
// /api/data, on a fixed clock:
//
//   1. 6:30pm New York, first visit: Claude's day opens by itself (not the
//      morning recap): the site's changes, the data's, the sessions' logs,
//      what's needed — each a card; a NEED ticks through setWorkNeedDone.
//   2. ‹ reads the day before (claudeDay({ day })); the button on Home opens it.
//   3. Seen today: a reload doesn't open it again. 10am: the morning recap
//      opens, not Claude's day.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-claude-day.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-claude-day.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const DAY = '2026-10-14';   // a Wednesday
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);

function claudeDay(a) {
  const d = a.day || DAY;
  return {
    day: d, today: DAY, isToday: d === DAY,
    commits: d === DAY ? [   // oldest first, as the server sends them
      { sha: '2777cea', at: d + 'T15:56:00Z', title: "Discover Add all A's: safer Undo", lines: [], url: '' },
      { sha: '1c4fe1a', at: d + 'T21:30:00Z', title: "Brand page: Zach's list steps under each person who accepted", lines: ['The same card as Home’s list.', 'Undo refills the cards.'], url: 'https://github.com/x/y/commit/1c4fe1a' },
    ] : [],
    commitsError: null,
    actions: d === DAY ? [{ at: d + 'T14:10:00Z', fn: 'combineParent', text: "Combined Diageo's brands into one (13 brands)" }] : [],
    hunt: { found: d === DAY ? 7 : 0, added: 2, names: ['Koloa Rum', 'Bayou Rum'] },
    chats: d === DAY ? [{ id: 'w1', title: 'Brand page session', raw: 'x', source: 'cli', done: ['Built the brand page card'], ideas: [],
      needs: [{ i: 0, label: 'Say use both', steps: ['Reply in the chat'], done: false }] }] : [],
    olderNeeds: [{ id: 'w0', title: 'Add a brand chat', day: '2026-10-12', needs: [{ i: 1, label: 'Pull the new instructions', steps: [], done: false }] }],
    asks: [{ key: 'research', n: 3, label: 'researched brands to review (Brand Fit)', view: 'stock' }],
  };
}
const RECAP = {
  day: DAY, to: DAY, range: false, today: DAY, isToday: true,
  reached: { invites: 0, companies: [], accepted: [], emails: [], replies: [], steps: [], previous: null },
  todo: { sendingDay: true, cap: 30, category: null, planned: [], queued: 0, actions: 0, overdue: 0, actionItems: [], calls: [] },
  found: { discovered: [], brands: [] }, asks: [], chats: [], ideas: [], picked: [], logDays: [],
};
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}), listBrands: () => ({ brands: [], total: 0 }),
  zachTodo: () => ({ template: {}, dmTemplate: {}, firstTemplate: {}, finalTemplate: {}, brands: [], people: 0, noAddress: 0, held: [], done: [], doneDays: 30, calls: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  dayRecap: () => RECAP, weeklyScore: () => ({ today: DAY, goals: {}, weeks: [] }), staleDeals: () => ({ days: 14, deals: [] }),
  claudeDay,
  setWorkNeedDone: (a) => ({ id: a.id, needsDone: a.done ? [a.index] : [] }),
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function openAt(browser, base, iso, keepContext) {
  const ctx = keepContext || await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(iso) });
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; } catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  return { ctx, page, errors };
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });

  // 1 ---------------------------------------------------------------
  const { ctx, page, errors } = await openAt(browser, base, DAY + 'T22:30:00Z');   // 6:30pm New York
  await page.waitForSelector('#recap:not([hidden]) .rc-card', { timeout: 15000 });
  assert.match(await page.textContent('#recap .rc-day'), /Claude’s day · Wednesday, October 14 · today/);
  const titles = await page.$$eval('#recap .rc-card h2', (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ['What Claude changed on the site', 'What Claude changed in the data', 'What Claude’s sessions said', 'What Claude needs from you']);
  const site = await page.textContent('#recap [data-rc-i="0"]');
  assert.match(site, /2 updates went live[\s\S]*Brand page: Zach's list steps[\s\S]*Undo refills the cards[\s\S]*the change ↗[\s\S]*Discover Add all A's/);
  const data = await page.textContent('#recap [data-rc-i="1"]');
  assert.match(data, /Combined Diageo's brands into one \(13 brands\)[\s\S]*Brand hunt: found 7 brands for Discover \(2 added since\)/);
  const needs = await page.textContent('#recap [data-rc-i="3"]');
  assert.match(needs, /3[\s\S]*researched brands to review[\s\S]*Say use both[\s\S]*Pull the new instructions[\s\S]*Add a brand chat · Mon, Oct 12/);
  await page.check('#recap [data-need="w1"]');
  await page.waitForTimeout(200);
  assert.deepEqual(all('setWorkNeedDone').slice(-1)[0].args, { id: 'w1', index: 0, done: true });
  assert.equal(all('dayRecap').filter((c) => !c.args.to).length >= 0, true);
  console.log('✓ 1. 6:30pm, first visit: Claude’s day opens by itself — site, data, sessions, needs; a NEED ticks');

  // 2 ---------------------------------------------------------------
  await page.click('#recap [data-cd-day="2026-10-13"]');
  await page.waitForFunction(() => /Tuesday, October 13/.test(document.querySelector('#recap .rc-day').textContent));
  assert.deepEqual(all('claudeDay').slice(-1)[0].args, { day: '2026-10-13' });
  assert.match(await page.textContent('#recap [data-rc-i="0"]'), /No changes to the site that day/);
  // The ✕ takes the click (its all:unset used to leave it click-through).
  await page.click('#recap [data-rc-close]');
  await page.click('#hm-claudeday');
  await page.waitForFunction(() => /· today/.test((document.querySelector('#recap .rc-day') || {}).textContent || ''));
  await page.click('#recap [data-rc-close]');
  console.log('✓ 2. ‹ reads the day before; the Home button opens today’s');

  // 3 ---------------------------------------------------------------
  const before = all('claudeDay').length;
  const again = await openAt(browser, base, DAY + 'T22:40:00Z', ctx);
  await again.page.waitForTimeout(2500);
  assert.equal(await again.page.isHidden('#recap'), true, 'seen today: not again');
  assert.equal(all('claudeDay').length, before, 'not even asked');
  const morning = await openAt(browser, base, DAY + 'T14:00:00Z');   // 10am, fresh browser
  await morning.page.waitForSelector('#recap:not([hidden]) .rc-card', { timeout: 15000 });
  assert.doesNotMatch(await morning.page.textContent('#recap .rc-day'), /Claude/, 'the morning recap, not Claude’s day');
  console.log('✓ 3. seen today stays shut; 10am opens the morning recap');

  assert.deepEqual(errors.concat(again.errors, morning.errors), [], 'no page errors');
  await browser.close();
  server.close();
  console.log('Claude’s day: all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
