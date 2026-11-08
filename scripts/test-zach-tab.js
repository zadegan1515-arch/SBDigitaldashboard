// scripts/test-zach-tab.js — Zach's tab (Leo, Nov 8 2026: "one tab for Zach …
// so he can just look at everything and see what's going on … how many brands,
// how many outreaches have been sent out, how many brands have been outreached
// to … what deals are happening … show board stats, like what brands have
// viewed the show board this week … click on it and it should go to the show
// board tab. Same with the results"). Chromium against a fake /api/data:
//
//   1. Its own top tab right after Home; it reads zachOverview.
//   2. The tiles: brands, brands outreached to, outreach sent (invites +
//      emails, this week, today, Elizabeth's), accepted · replied, In talks,
//      the Show Board's 7 days, deals (open and won money apart).
//   3. The cards: In talks by stage + calls coming up, deals happening, who
//      opened the Show Board, where every brand stands, this week vs last.
//   4. Every card opens its tab: Show Board, Results, Deals, Brands, Every
//      brand reached (a step = only that step), In talks (a stage = only that
//      stage; a call = that brand's profile).
//   5. A phone: two tiles a row, no sideways scroll. No page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-zach-tab.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-zach-tab.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const SHOTS = process.env.SHOTS || '';
const calls = [];
const DAY = 864e5;
const at = (d) => new Date(Date.now() + d * DAY).toISOString();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const monday = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();

const STAGES = [['replied', 'Replied'], ['call_booked', 'Call booked'], ['call_done', 'Call done'], ['proposal', 'Proposal sent'],
  ['negotiating', 'Negotiating'], ['verbal', 'Verbal yes'], ['contract', 'Contract signed'], ['won', 'Won']].map(([key, label]) => ({ key, label }));
const ENDS = [{ key: 'lost', label: 'Lost' }, { key: 'quiet', label: 'Gone quiet' }];
const TRACK = [['reached', 'Reached out'], ['accepted', 'Accepted'], ['replied', 'Replied'], ['continue', 'Wants to continue'],
  ['emailed', 'Email sent'], ['talks', 'In talks'], ['out', 'Out']].map(([key, label]) => ({ key, label, hint: label }));

const OVERVIEW = {
  today, weekStart: monday,
  brands: { total: 1520, inPlay: 1310 },
  outreach: { brands: 412, brandsThisWeek: 23, acceptedBrands: 140, invites: 1630, invitesThisWeek: 74, invitesToday: 28,
    emails: 210, emailsThisWeek: 6, accepted: 380, replied: 61, elizabeth: { sent: 44, thisWeek: 12 } },
  week: { now: { invites: 74, accepts: 21, replies: 6, calls: 2, deals: 1, brands: 30 }, before: { invites: 90, accepts: 25, replies: 4, calls: 1, deals: 0, brands: 55 },
    goals: { invites: 90, accepts: 25, replies: 8, calls: 3, deals: 1, brands: 50 } },
  steps: { stages: TRACK, counts: { reached: 250, accepted: 90, replied: 30, continue: 8, emailed: 5, talks: 12, out: 17 },
    onUs: { reached: 40, accepted: 12, replied: 6, continue: 8, emailed: 0, talks: 0, out: 0 }, total: 412 },
  talks: {
    total: 14, stages: STAGES, ends: ENDS,
    counts: { replied: 6, call_booked: 3, call_done: 1, proposal: 2, negotiating: 0, verbal: 1, contract: 0, won: 0, lost: 1, quiet: 0 },
    calls: [{ id: 'b1', name: 'Electrolit', at: at(2), with: 'Jason Robinson', stage: 'Call booked' }],
    brands: [
      { id: 'b1', name: 'Electrolit', stage: { key: 'call_booked', label: 'Call booked', at: at(-1) }, nextCall: { at: at(2), name: 'Jason Robinson' }, stopped: false, lastAt: at(-1) },
      { id: 'b2', name: 'Garage Beer', stage: { key: 'proposal', label: 'Proposal sent', at: at(-2) }, nextCall: null, stopped: false, lastAt: at(-2) },
    ],
  },
  deals: {
    open: [{ id: 'd1', name: 'Garage Beer — fall', stage: 'proposal', valueCents: 1500000, nextStep: 'Send the deck', followUpAt: at(2), updatedAt: at(-2), brand: { id: 'b2', name: 'Garage Beer' } }],
    openCount: 1, openCents: 1500000, wonCents: 250000, won: [], wonCount: 1, stages: { proposal: 1, closed: 1 },
  },
  board: { visits: 9, anonymous: 2, brands: [
    { id: 'b1', name: 'Electrolit', opens: 4, lastAt: at(-0.2), minutes: 12, person: false },
    { id: 'b5', name: 'Celsius', opens: 3, lastAt: at(-3), minutes: 0, person: false },
  ] },
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  reachedBrands: () => ({ brands: { b1: ['2026-10-01', '2026-10-20', 'a', 2, 0, '2026-10-22'] }, el: {}, count: 1 }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo: () => ({ brands: [], people: 0, done: [], calls: [], held: [] }),
  acceptedPeople: () => ({ people: [], total: 0, brands: 0 }),
  zachOverview: () => OVERVIEW,
  listReached: () => ({ brands: [], totals: { invited: 0, accepted: 0, replied: 0 } }),
  listDeals: () => ({ deals: [], openCents: 0, wonCents: 0 }),
  listBoardActivity: () => ({ visits: [], brandsToday: 0, last7: 9, requestCount: 0, topShows: [], total: 9, today: 0, uniqueVisitors: 0, daily: [], avgMinutes: null, sheet: null }),
  listAccessRequests: () => ({ pending: [], decided: [] }),
  outreachTracker: () => ({ brands: [], stages: TRACK, counts: {}, onUs: {}, ever: {}, total: 0, today }),
  listInTalks: () => ({ brands: [{
    id: 'b1', name: 'Electrolit', category: 'electrolytes', tier: 'growth', kind: null, why: 'reply', since: at(-9), stopped: null, archived: false,
    nextCall: { at: at(2), name: 'Jason Robinson' }, lastCall: null, people: [], invited: [], others: 0, notes: [], deal: null,
    board: { code: null, opens: 4, lastAt: at(-0.2) }, journey: [], stage: { key: 'call_booked', label: 'Call booked', at: at(-1), hand: false, by: null, why: 'call booked' },
    stageDates: { replied: at(-9), call_booked: at(-1) }, lastAt: at(-1), fit: 70,
  }], stages: STAGES, ends: ENDS, stageCounts: {}, logKinds: [], sponsorUrl: '', today }),
  talksLog: () => ({ items: [] }),
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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
  const text = (sel) => page.textContent(sel);
  const active = () => page.evaluate(() => document.querySelector('.view.active').id);
  const open = async () => {
    await page.click('.tabs .nav-item[data-view="zachtab"]');
    await page.waitForSelector('#zv-body .zv-tile');
  };

  await page.goto(base + '/app.html');
  await page.waitForSelector('.tabs .nav-item[data-view="zachtab"]');

  // 1. The tab
  const tabs = await page.$$eval('.tabs.cc-only:not(#sub-tabs) .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 2), ['Home', 'Zach']);
  await open();
  assert.equal(await active(), 'zachtab');
  assert.ok(calls.some((c) => c.fn === 'zachOverview'));
  assert.equal(await page.$eval('.tabs.cc-only:not(#sub-tabs) .nav-item.active', (e) => e.textContent), 'Zach');
  console.log('✓ its own tab right after Home');

  // 2. The tiles
  const tiles = await page.$$eval('#zv-body .zv-tile', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const tile = (k) => tiles.find((t) => t.toLowerCase().startsWith(k.toLowerCase())) || '';
  assert.ok(/1,520/.test(tile('Brands')) && /1,310 in play/.test(tile('Brands')), tile('Brands'));
  assert.ok(/412/.test(tile('Brands outreached to')) && /\+23 new this week/.test(tile('Brands outreached to')), tile('Brands outreached to'));
  const sent = tile('Outreach sent');
  assert.ok(/1,840/.test(sent) && /1,630 LinkedIn invites/.test(sent) && /210 emails/.test(sent) && /80 this week · 28 today/.test(sent) && /44 by Elizabeth/.test(sent), sent);
  assert.ok(/380 · 61/.test(tile('Accepted · replied')), tile('Accepted · replied'));
  assert.ok(/14/.test(tile('In talks')) && /1 call coming up/.test(tile('In talks')), tile('In talks'));
  assert.ok(/Show Board · 7 days 9/i.test(tile('Show Board')) && /2 brands opened it/.test(tile('Show Board')), tile('Show Board'));
  assert.ok(/\$15,000 open · \$2,500 won/.test(tile('Deals')), tile('Deals'));
  console.log('✓ the tiles: brands, outreached to, outreach sent, accepted · replied, In talks, the Show Board, deals');

  // 3. The cards
  const body = await text('#zv-body');
  assert.ok(/Calls coming up/.test(body) && /Electrolit/.test(body) && /with Jason Robinson/.test(body));
  assert.ok(/Garage Beer — fall/.test(body) && /next: Send the deck/.test(body));
  assert.ok(/Celsius/.test(body) && /3 opens/.test(body) && /\+ 2 opens without a brand code/.test(body));
  assert.ok(/Where every brand stands/.test(body) && /40 to do/.test(body));
  const wk = await page.$$eval('.zv-wk tbody tr', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.equal(wk[0], 'LinkedIn invites 74 90 90');
  assert.ok(await page.$('.zv-row .rb-tag'), 'the Outreached / Accepted tag on the Show Board rows');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'zach-tab.png'), fullPage: true });
  console.log('✓ the cards: In talks by stage + calls, deals, Show Board opens, every brand’s step, this week');

  // 4. Every card opens its tab
  await page.click('.zv-tile:has-text("Show Board")');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'board');
  await open();
  await page.click('.zv-tile:has-text("Outreach sent")');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'reached');
  assert.equal(await page.$eval('#sub-tabs .nav-item.active', (e) => e.textContent), 'Results');
  await open();
  await page.click('.zv-tile:has-text("Deals")');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'pipeline');
  await open();
  await page.click('.zv-tile:has-text("Brands"):not(:has-text("outreached"))');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'brands');
  await open();
  await page.click('[data-zv-step="replied"]');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'tracker');
  assert.equal(await page.evaluate(() => TK.stage), 'replied', 'only that step');
  await open();
  await page.click('[data-zv-stage="proposal"]');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'intalks');
  assert.equal(await page.evaluate(() => IT.stageF), 'proposal', 'only that stage');
  await open();
  await page.click('.zv-row[data-zv-talk="b1"]');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'intalks');
  assert.equal(await page.evaluate(() => IT.sel), 'b1');
  assert.equal(await page.evaluate(() => IT.stageF), null);
  await open();
  await page.click('.zv-row:has-text("Celsius")');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'board');
  console.log('✓ every card opens its tab: Show Board, Results, Deals, Brands, Every brand reached (a step), In talks (a stage, a brand)');

  // 5. A phone
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll (' + wide + 'px)');
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.zv-tiles')).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 2, 'two tiles a row');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'zach-tab-phone.png'), fullPage: true });
  console.log('✓ a phone: two tiles a row, no sideways scroll');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('\nzach tab: all 5 passed');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
