// scripts/test-accepted.js — Home → Accepted on LinkedIn, a person's card opening
// their brand page at them (highlighted), back / forward between pages, and the
// top search bar emptying on any other page (Leo, Oct 18 2026). Drives
// public/app.html in Chromium against a fake /api/data:
//
//   1. Home's card lists everyone acceptedPeople gives, newest first, with the
//      counts (7 days / 30 days / total, brands) and the chips + filter box.
//   2. A card opens the brand page scrolled to that person's row, lit up.
//   3. ‹ goes back to Home where you were, › forward to the brand page again.
//   4. A search's person card does the same; the bar is empty on the brand
//      page and comes back with the words on the search page via Back; the
//      browser's own back / forward walk the same pages.
//   5. Any other page empties the bar (a search still being typed doesn't pull
//      you back); a "#" link isn't a page change; ‹ / › are greyed at the ends.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-accepted.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-accepted.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const person = (contactId, name, title, brandId, brandName, days, extra) => Object.assign({
  targetId: 't_' + contactId, contactId, name, title, linkedinUrl: null, brandId, brandName, category: 'beverage',
  archived: false, at: ago(days), kind: 'accepted', invitedAt: ago(days + 3), stage: 'accepted', label: 'accepted',
}, extra || {});
// Newest first, as the server sends them.
const PEOPLE = [
  person('c25', 'Pat Quinn', 'Director of Partnerships', 'b1', 'Liquid Death', 0),
  person('c203', 'Jamie Fox', 'Brand Manager', 'b2', 'Olipop', 2, { stage: 'replied', label: 'replied' }),
  person('c4', 'Dana Dunn', 'Marketing Manager', 'b1', 'Liquid Death', 12, { stage: 'call', label: 'call booked' }),
  person('c9', 'Ira Iles', 'VP Marketing', 'b3', 'Poppi', 45, { kind: 'replied' }),
];

function brand(id, name, contacts) {
  return {
    brand: {
      id, name, category: 'beverage', tier: 'growth', aka: '', about: name + ' makes drinks', topProducts: '',
      website: '', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null,
      doNotEmail: false, passedAt: null, workPeople: null, partner: null, kind: null,
      contacts, targets: [], shows: [], deals: [], documents: [],
    },
    events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [],
    boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [],
  };
}
const many = [];
for (let i = 1; i <= 30; i++) many.push({ id: 'c' + i, name: 'Person ' + i, title: 'Marketing', isDecisionMaker: false, source: 'linkedin' });
many[24] = { id: 'c25', name: 'Pat Quinn', title: 'Director of Partnerships', isDecisionMaker: true, source: 'linkedin' };
const BRANDS = {
  b1: brand('b1', 'Liquid Death', many),
  b2: brand('b2', 'Olipop', [
    { id: 'c201', name: 'Ann Able', title: 'Founder', isDecisionMaker: true, source: 'linkedin' },
    { id: 'c202', name: 'Ben Best', title: 'Events', isDecisionMaker: false, source: 'linkedin' },
    { id: 'c203', name: 'Jamie Fox', title: 'Brand Manager', isDecisionMaker: true, source: 'linkedin' },
  ]),
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo: () => ({ brands: [], people: 0, done: [], calls: [], held: [] }),
  brandPlanLine: () => ({}),
  acceptedPeople: () => ({ people: PEOPLE, total: PEOPLE.length, brands: 3 }),
  getBrand: (a) => BRANDS[a.brandId],
  search: (a) => ({
    q: a.q,
    brands: [{ id: 'b2', name: 'Olipop', category: 'beverage', tier: null, _count: { contacts: 3, shows: 0 } }],
    contacts: [{ id: 'c203', name: 'Jamie Fox', title: 'Brand Manager', linkedinUrl: null, isDecisionMaker: true, brand: { id: 'b2', name: 'Olipop' } }],
    sponsorships: [], shows: [],
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

  const active = () => page.evaluate(() => (document.querySelector('.view.active') || {}).id);
  const focusInView = (cid) => page.evaluate((cid) => {
    const row = document.querySelector('#brand-body [data-pcid="' + cid + '"]');
    if (!row) return 'missing';
    const r = row.getBoundingClientRect();
    if (!row.classList.contains('b-focus')) return 'not lit';
    return r.top >= 0 && r.bottom <= innerHeight ? 'ok' : 'off screen (' + Math.round(r.top) + ')';
  }, cid);
  const lit = () => page.evaluate(() => [...document.querySelectorAll('#brand-body .b-focus')].map((x) => x.getAttribute('data-pcid')));
  const navState = () => page.evaluate(() => ({ back: document.getElementById('nav-back').disabled, fwd: document.getElementById('nav-fwd').disabled }));

  await page.goto(base + '/app.html');
  await page.waitForSelector('#hm-accepted .ac-row');

  // 1. Home's card
  const names = await page.$$eval('#hm-accepted .ac-row .t-brand', (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ['Pat Quinn', 'Jamie Fox', 'Dana Dunn', 'Ira Iles'], 'newest first');
  const sum = await page.textContent('#ac-sum');
  assert.ok(/2 in the last 7 days · 3 in the last 30 days · 4 in total, at 3 brands/.test(sum), sum);
  const first = await page.textContent('#hm-accepted .ac-row');
  assert.ok(/Director of Partnerships/.test(first) && /Liquid Death/.test(first) && /accepted .*today/.test(first), first);
  assert.ok(/replied/.test(await page.textContent('#hm-accepted .ac-row:nth-child(4)')), 'a reply with no accept date says replied');
  assert.deepEqual(await navState(), { back: true, fwd: true }, 'nothing to go back or forward to yet');
  await page.click('#hm-accepted [data-acr="7"]');
  assert.equal(await page.$$eval('#hm-accepted .ac-row', (e) => e.length), 2, 'last 7 days');
  await page.click('#hm-accepted [data-acr="all"]');
  await page.fill('#ac-q', 'olipop');
  assert.deepEqual(await page.$$eval('#hm-accepted .ac-row .t-brand', (els) => els.map((e) => e.textContent)), ['Jamie Fox'], 'filter by brand');
  await page.fill('#ac-q', 'partnerships');
  assert.deepEqual(await page.$$eval('#hm-accepted .ac-row .t-brand', (els) => els.map((e) => e.textContent)), ['Pat Quinn'], 'filter by title');
  await page.fill('#ac-q', '');
  console.log('✓ Home lists everyone accepted, newest first, with counts, chips and a filter');

  // 2. A card opens the brand page at that person
  await page.evaluate(() => window.scrollTo(0, document.getElementById('hm-accepted').offsetTop - 100));
  const homeY = await page.evaluate(() => window.scrollY);
  assert.ok(homeY > 0, 'Home scrolled down to the card');
  await page.click('#hm-accepted .ac-row[data-focus="c25"] .t-title');
  await page.waitForSelector('#brand-body [data-pcid="c25"].b-focus');
  await page.waitForTimeout(400);
  assert.equal(await active(), 'brand');
  assert.equal(await focusInView('c25'), 'ok');
  assert.deepEqual(await lit(), ['c25'], 'only that person is lit');
  assert.ok(calls.some((c) => c.fn === 'getBrand' && c.args.brandId === 'b1'));
  assert.deepEqual(await navState(), { back: false, fwd: true });
  console.log('✓ a card opens the brand page scrolled to that person, highlighted');

  // 3. ‹ back to Home where you were, › forward to the brand page
  await page.click('#nav-back');
  await page.waitForFunction(() => document.getElementById('dashboard').classList.contains('active'));
  await page.waitForTimeout(600);
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - homeY) < 5, 'Home back where you were');
  assert.deepEqual(await navState(), { back: true, fwd: false });
  await page.click('#nav-fwd');
  await page.waitForSelector('#brand-body [data-pcid="c25"].b-focus');
  assert.equal(await active(), 'brand');
  assert.deepEqual(await navState(), { back: false, fwd: true });
  console.log('✓ ‹ goes back to Home where you were, › forward to the brand page');

  // 4. Search → a person's card → their brand page; the bar is empty there
  await page.click('#q');
  await page.keyboard.type('jamie');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#search-results [data-focus="c203"]');
  assert.equal(await active(), 'search');
  await page.click('#search-results [data-focus="c203"]');
  await page.waitForSelector('#brand-body [data-pcid="c203"].b-focus');
  assert.equal(await focusInView('c203'), 'ok');
  assert.equal(await page.inputValue('#q'), '', 'the search bar is empty on the brand page');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('search').classList.contains('active'));
  assert.equal(await page.inputValue('#q'), 'jamie', 'the search page has its words back');
  await page.waitForSelector('#search-results [data-focus="c203"]');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active') && /Liquid Death/.test(document.getElementById('brand-body').textContent));
  assert.equal(await page.inputValue('#q'), '');
  await page.waitForSelector('#brand-body [data-pcid="c25"].b-focus');
  await page.goForward();
  await page.waitForFunction(() => document.getElementById('search').classList.contains('active'));
  await page.goForward();
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active') && /Olipop/.test(document.getElementById('brand-body').textContent));
  await page.waitForSelector('#brand-body [data-pcid="c203"].b-focus');
  assert.deepEqual(await navState(), { back: false, fwd: true });
  console.log('✓ a search\'s person card opens their brand page at them; the browser\'s back / forward walk the pages');

  // 5. Any other page empties the bar; a search being typed doesn't pull you back
  await page.click('#q');
  await page.keyboard.type('ol');
  await page.click('.tabs .nav-item[data-view="brands"]');
  await page.waitForTimeout(500);
  assert.equal(await active(), 'brands');
  assert.equal(await page.inputValue('#q'), '', 'a tab empties the bar');
  await page.click('.tabs .nav-item[data-view="brands"]');
  await page.click('#nav-back');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  console.log('✓ another page empties the search bar; a tab clicked twice is one page');

  // A "#" link isn't a page change.
  await page.evaluate(() => {
    const a = document.createElement('a'); a.href = '#'; a.id = 'hash-link'; a.textContent = 'x';
    document.getElementById('brand-body').appendChild(a);
  });
  await page.click('#hash-link');
  await page.waitForTimeout(300);
  assert.equal(await active(), 'brand', 'still on the brand page');
  await page.click('#nav-back');
  await page.waitForTimeout(400);
  assert.equal(await active(), 'brand', 'back from the "#" entry is the same page');
  console.log('✓ a "#" link doesn\'t leave the page');

  // The logo goes Home and that is a page too.
  await page.click('#logo-home');
  await page.waitForFunction(() => document.getElementById('dashboard').classList.contains('active'));
  await page.click('#nav-back');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  console.log('✓ the logo goes Home; ‹ comes back');

  // Phone width: the card and the arrows fit.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('#logo-home');
  await page.waitForSelector('#hm-accepted .ac-row');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  console.log('✓ phone width');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
