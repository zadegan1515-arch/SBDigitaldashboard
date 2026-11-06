// scripts/test-supply.js — Brands → All brands' "What the queue has to work
// with" (Leo, Nov 5 2026; src/lib/supply.ts) in Chromium against a fake
// /api/data: the four tiles' counts, Show narrowing the table to exactly a
// count's brands (and back), the fill's Brand Fit floor, the Giants / Too
// small switches (asked first), Category priority, Reach out again's day
// buttons, Archive dead weight (preview, untick, apply only the ticked, Undo
// names them first), and the phone width.
//   NODE_PATH=$(npm root -g) node scripts/test-supply.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-supply.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();
const dayKey = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function row(id, name, fit, extra) {
  return Object.assign({
    id, name, category: 'electrolytes', tier: 'growth', passedAt: null, aka: null, website: null, linkedinUrl: null, notes: null,
    source: 'manual', createdAt: NOW, contacts: [], _count: { contacts: 2, targets: 0 },
    buyers: { partnerships: 1, events: 0, marketing: 0, founder: 0, total: 1 }, buyerPeople: [],
    withEmail: 0, withLinkedin: 2, outreach: {}, fit: { score: fit }, cover: { state: 'covered' },
  }, extra || {});
}

const S = { calls: [] };
function reset() {
  S.calls = [];
  S.smallOn = false; S.giantsOn = false; S.deadDone = false;
  S.list = [
    row('bReady', 'Ready Hydration', 80),
    row('bShort', 'Short Hydration', 70, { cover: { state: 'next' }, buyers: { partnerships: 0, events: 0, marketing: 0, founder: 0, total: 0 } }),
    row('bNone', 'Nobody Hydration', 65),
    row('bSmall', 'Small Hydration', 40),
    row('bAgain', 'Again Hydration', 75, { outreach: { invited: 1, lastSentAt: NOW } }),
    row('bDead', 'Metro League', 20),
    row('bNotUs', 'Faraway Drinks', 30),
  ];
}
reset();
const supply = (a) => ({
  today: dayKey(0), minFit: a.minFit == null ? 57 : a.minFit, appFloor: { minFit: 57, at: NOW }, perDay: 30, readyPeople: 4,
  switches: { giantsOn: S.giantsOn, smallOn: S.smallOn },
  ids: {
    ready: S.smallOn ? ['bReady', 'bSmall'] : ['bReady'], short: ['bShort', 'bNone'], none: ['bNone'], pass: [],
    giant: S.giantsOn ? [] : ['bGiant'], skip: ['bSkip'], small: S.smallOn ? [] : ['bSmall'],
  },
  lets: { giant: 1, skip: 1, small: S.smallOn ? 0 : 1 },
  skipCats: [{ key: 'betting', n: 1 }],
  fill: { ids: { new: ['bShort'], again: [], reread: ['bNone'] }, total: 2, belowFit: 5, bigSkipped: 0, resting: 9, stuck: 0, shortFirst: 2, reread: 1, perDay: 100 },
  again: {
    total: 1, due: 1, late: 0, ids: ['bAgain'],
    rows: [{ id: 'bAgain', name: 'Again Hydration', category: 'electrolytes', fit: 75, state: 'due', last: dayKey(-9), daysSince: 9, dueBy: dayKey(5),
      fresh: [{ id: 'c1', name: 'Pat Lee', title: 'Head of Partnerships' }], freshTotal: 1, going: 1, accepted: 0, pinnedOn: null, inToday: false }],
  },
  days: [{ date: dayKey(1), label: 'Tomorrow', today: false }, { date: dayKey(2), label: 'Later', today: false }],
  dead: { count: S.deadDone ? 0 : 2, last: S.deadDone ? { at: NOW, by: 'leo', count: 1, names: ['Metro League'] } : null },
});

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listBrands: () => S.list, categoryReach: () => ({ categories: {}, newFromLinkedIn: 0, recentlyAdded: 0 }),
  findDuplicates: () => ({ groups: [] }), suMatchQueue: () => ({ proposals: [], missing: 0, capturePending: 0 }),
  buyerCoverage: () => ({ perDay: 100, week: { linkedin: 0, sponsorunited: 0, other: 0 }, coveredWeek: 0, run: null }),
  brandSupply: supply,
  setSmallOn: (a) => { S.smallOn = a.on === true; return { smallOn: S.smallOn }; },
  setGiantsOn: (a) => { S.giantsOn = a.on === true; return { giantsOn: S.giantsOn }; },
  reachAgain: (a) => ({ ok: true, brandId: a.brandId, brandName: 'Again Hydration', date: a.date, label: 'Tomorrow', people: [{ name: 'Pat Lee' }], going: 1 }),
  deadWeight: (a) => {
    if (a.preview !== false) {
      return { brands: [
        { id: 'bNotUs', name: 'Faraway Drinks', category: 'electrolytes', fit: 30, why: 'notus', whyText: 'Not sold in the US', note: null, onFile: 2, contacted: false, queued: 0, plannedLabel: null },
        { id: 'bDead', name: 'Metro League', category: 'electrolytes', fit: 20, why: 'seller', whyText: 'Sells sponsorships (a league, team or agency)', note: null, onFile: 2, contacted: false, queued: 1, plannedLabel: 'Thu Nov 12' },
      ], last: null };
    }
    S.deadDone = true;
    return { ok: true, archived: a.brandIds.length, names: ['Metro League'], shelved: 1, offDays: 1 };
  },
  deadWeightUndo: (a) => (a.preview !== false ? { brands: ['Metro League'], at: NOW, total: 1 } : (S.deadDone = false, { ok: true, back: ['Metro League'] })),
  getCategoryPriority: () => ({ categories: [{ key: 'betting', priority: 'skip', default: 'skip', custom: false }], points: { top: 30, middle: 15, low: 0 } }),
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      S.calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadBrands === 'function');
  await page.evaluate(() => { try { localStorage.removeItem('sb.fillFit'); } catch (e) {} gotoView('brands'); });
  await page.waitForSelector('#supply-card .su-grid');
  const names = () => page.$$eval('#brands-list [data-brow]', (rs) => rs.map((r) => r.getAttribute('data-name')));
  const calls = (fn) => S.calls.filter((c) => c.fn === fn);

  // ---- the tiles ----
  const text = await page.textContent('#supply-card');
  assert.match(text, /Ready to go out\s*1 brand/);
  assert.match(text, /about 4 people/);
  assert.match(text, /2short on people to go out whole/);
  assert.match(text, /1 with nobody to reach/);
  assert.match(text, /1not read yet/);
  assert.match(text, /1read before founders & events were searched/);
  assert.match(text, /The floor your LinkedIn Fill app’s run uses/);
  assert.match(text, /The 2 short on people go first/);
  assert.match(text, /5 under Fit 57 left off/);
  assert.match(text, /Reach out again\s*1 brand/);
  assert.match(text, /Giants 1 held back/);
  assert.match(text, /Too small 1 held back/);
  assert.match(text, /Betting & DFS 1/);
  assert.doesNotMatch(text, /read again — the last read/, 'a fill line at 0 is left out');
  assert.match(text, /Dead weight 2 brands/);
  assert.equal(calls('brandSupply')[0].args.minFit, undefined, 'the fill app’s own floor (the server knows it)');
  assert.ok(await page.$('#supply-card a[href*="#sb-fill"]'), 'Start the fill');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 1440, height: 760 } });
  console.log('✓ the four tiles: ready, needs a fill, reach out again, held back by the rules');

  // ---- Show: the table narrowed to exactly that count ----
  assert.equal((await names()).length, 7);
  await page.click('#supply-card [data-supshow="short"]');
  assert.deepEqual(await names(), ['Short Hydration', 'Nobody Hydration'], 'best Brand Fit first');
  assert.match(await page.textContent('#brands-list .su-filter'), /Only Short on people to go out/);
  assert.ok(await page.$('#supply-card [data-supshow="short"].on'), 'the count shows it is on');
  await page.click('#supply-card [data-supshow="freread"]');
  assert.deepEqual(await names(), ['Nobody Hydration']);
  await page.click('#brands-list [data-supclear]');
  assert.equal((await names()).length, 7, '× shows every brand again');
  await page.click('#supply-card [data-supshow="small"]');
  assert.deepEqual(await names(), ['Small Hydration'], 'a too small brand shows though Hide too small is on');
  await page.click('#supply-card [data-supshow="small"]');
  assert.equal((await names()).length, 7, 'a second click clears it');
  await page.click('#supply-card [data-supshow="nobuyer"]');
  assert.deepEqual(await names(), ['Short Hydration'], 'no buyer = Needs people');
  await page.click('#brands-list [data-brclear]');
  console.log('✓ Show narrows the table to that count’s brands; × and a second click put it back');

  // ---- the floor ----
  await page.fill('#supply-card [data-supfloor]', '60');
  await page.dispatchEvent('#supply-card [data-supfloor]', 'change');
  await page.waitForFunction(() => document.querySelector('#supply-card [data-supfloor]') && document.querySelector('#supply-card [data-supfloor]').value === '60');
  assert.equal(calls('brandSupply').slice(-1)[0].args.minFit, 60);
  assert.equal(await page.evaluate(() => localStorage.getItem('sb.fillFit')), '60', 'shared with the Fill schedule');
  assert.match(await page.textContent('#supply-card'), /Your LinkedIn Fill app’s run uses 57/);
  await page.click('#supply-card [data-supappfloor]');
  await page.waitForFunction(() => document.querySelector('#supply-card [data-supfloor]') && document.querySelector('#supply-card [data-supfloor]').value === '57');
  assert.equal(calls('brandSupply').slice(-1)[0].args.minFit, undefined, 'back to the app’s floor');
  console.log('✓ the fill’s Brand Fit floor counts again and is remembered');

  // ---- the switches ----
  await page.click('#supply-card [data-supsw="small"]');
  await page.waitForFunction(() => /Too small let in/.test(document.querySelector('#supply-card').textContent));
  assert.deepEqual(calls('setSmallOn').map((c) => c.args.on), [true]);
  assert.match(dialogs.slice(-1)[0], /Let too small brands/);
  await page.click('#supply-card [data-supsw="small"]');
  await page.waitForFunction(() => /Too small 1 held back/.test(document.querySelector('#supply-card').textContent));
  assert.deepEqual(calls('setSmallOn').map((c) => c.args.on), [true, false]);
  await page.click('#supply-card [data-supsw="giants"]');
  await page.waitForFunction(() => /Giants let in/.test(document.querySelector('#supply-card').textContent));
  assert.deepEqual(calls('setGiantsOn').map((c) => c.args.on), [true]);
  await page.click('#supply-card [data-supcp]');
  await page.waitForSelector('#cp-scrim.open');
  await page.click('#cp-close');
  console.log('✓ Too small / Giants switches ask first and count again; Category priority opens');

  // ---- Reach out again ----
  await page.click('#supply-card [data-supagain]');
  await page.waitForSelector('#supply-card .su-arow');
  assert.match(await page.textContent('#supply-card .su-again'), /Pat Lee — Head of Partnerships/);
  await page.click('#supply-card [data-supday="' + dayKey(2) + '"]');
  await page.waitForFunction(() => !document.querySelector('#supply-card [data-supday]'));
  assert.deepEqual(calls('reachAgain').map((c) => [c.args.brandId, c.args.date]), [['bAgain', dayKey(2)]]);
  assert.match(await page.textContent('#supply-card .su-arow'), /On /, 'the row says the day it is on');
  console.log('✓ Reach out again: who would go, a button per sending day');

  // ---- Archive dead weight ----
  await page.click('#supply-card [data-supdead]');
  await page.waitForSelector('#supply-card [data-supdtick]');
  const dead = await page.textContent('#supply-card .su-dead');
  assert.match(dead, /Not sold in the US · 1/);
  assert.match(dead, /Sells sponsorships/);
  assert.match(dead, /on Thu Nov 12 — comes off/);
  assert.match(await page.textContent('#supply-card [data-supdeadgo]'), /Archive 2 ticked/);
  await page.uncheck('#supply-card [data-supdtick="bNotUs"]');
  assert.match(await page.textContent('#supply-card [data-supdeadgo]'), /Archive 1 ticked/);
  assert.equal(calls('deadWeight').filter((c) => c.args.preview === false).length, 0, 'nothing archived before the click');
  await page.click('#supply-card [data-supdeadgo]');
  await page.waitForFunction(() => /Archived 1 on/.test(document.querySelector('#supply-card').textContent));
  assert.deepEqual(calls('deadWeight').filter((c) => c.args.preview === false).map((c) => c.args.brandIds), [['bDead']], 'only the ticked one');
  assert.match(dialogs.slice(-1)[0], /Archive 1 brand\?/);
  await page.click('#supply-card [data-supundo]');
  await page.waitForFunction(() => /Dead weight 2 brands/.test(document.querySelector('#supply-card').textContent));
  assert.match(dialogs.slice(-1)[0], /Bring back 1 brand\?\s+Metro League/);
  assert.deepEqual(calls('deadWeightUndo').map((c) => c.args.preview), [true, false]);
  console.log('✓ Archive dead weight: preview, untick, only the ticked archived, Undo names them first');

  // ---- not on other lists; phone width ----
  await page.evaluate(() => loadBrands('energy'));
  await page.waitForFunction(() => !document.querySelector('#supply-card .su-grid'));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => loadBrands('all'));
  await page.waitForSelector('#supply-card .su-grid');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  console.log('✓ only on All brands; fits a phone');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All supply page checks passed');
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
