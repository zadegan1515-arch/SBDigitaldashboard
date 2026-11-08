// scripts/test-tracker.js — In talks → Every brand reached (Leo, Nov 6 2026)
// in Chromium against a fake /api/data:
//
//   1. The In talks top tab opens it; its sub-tabs are Every brand reached ·
//      In talks.
//   2. A tile per step with its count and "N to do"; the "So far" line.
//   3. The list: furthest step first (Out last), a row per brand with what's
//      next, late, To do / Elizabeth / archived tags and the step dots.
//   4. A tile shows only its step (again = every step); the find box matches
//      brands and people; "Only ones with a step for us"; Show every brand.
//   5. A row opens its people (step, next, dates, who reached them, LinkedIn);
//      a person opens the brand page at them; Open its In talks profile opens
//      the profile as a look; Brand page →.
//   6. A long step shows 40, then Show all N.
//   7. A phone: two tiles a row, no sideways scroll. No page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-tracker.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-tracker.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const DAY = 864e5;
const at = (d) => new Date(Date.now() + d * DAY).toISOString();
const nyKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const TODAY = nyKey(Date.now());

const STAGES = [
  { key: 'reached', label: 'Reached out', hint: 'Invite or email out — no answer yet' },
  { key: 'accepted', label: 'Accepted', hint: 'Accepted on LinkedIn — no reply yet' },
  { key: 'replied', label: 'Replied', hint: 'Wrote back — how do they want to continue?' },
  { key: 'continue', label: 'Wants to continue', hint: 'Asked for an email or a LinkedIn DM — send it' },
  { key: 'emailed', label: 'Email sent', hint: 'We sent it — next, book the call' },
  { key: 'talks', label: 'In talks', hint: 'Call booked, or a deal going' },
  { key: 'out', label: 'Out', hint: 'Said no, doesn’t want to continue, or never answered' },
];
const P = (o) => Object.assign({
  key: 't:' + Math.random().toString(36).slice(2), by: 'zach', channel: 'linkedin', contactId: null, name: 'Someone', title: null, email: null, linkedinUrl: null,
  invitedAt: at(-20), acceptedAt: null, repliedAt: null, emailedAt: null, callAt: null,
  stage: 'reached', out: null, label: 'invited', next: 'Invite sent — no answer yet', onUs: false, due: null, at: at(-20), lastAt: at(-20),
}, o);
const B = (o) => Object.assign({
  id: 'x', name: 'Brand', category: 'energy', tier: 'growth', archived: false, doNotEmail: false,
  stage: 'reached', out: null, next: 'Invite sent — no answer yet', onUs: false, due: null, at: at(-20), lastAt: at(-20), nextCallAt: null,
  inTalks: false, deal: null, lead: null, elizabeth: false, steps: ['reached'], people: [],
}, o);

const BRANDS = [
  B({ id: 'b1', name: 'Electrolit', category: 'electrolytes', stage: 'talks', next: 'Call ' + 'Nov 12', inTalks: true, nextCallAt: at(5), lastAt: at(-2),
    steps: ['reached', 'accepted', 'replied', 'continue', 'emailed', 'talks'],
    people: [P({ contactId: 'c1', name: 'Jason Robinson', title: 'VP Marketing', stage: 'talks', label: 'call booked', next: 'Call Nov 12',
      linkedinUrl: 'https://www.linkedin.com/in/jasonr/', email: 'jason@electrolit.com', acceptedAt: at(-15), repliedAt: at(-10), emailedAt: at(-8), callAt: at(5) })] }),
  B({ id: 'b2', name: 'Liquid Death', category: 'beverage', stage: 'emailed', next: 'Emailed Nov 4 — book the call', lastAt: at(-2),
    steps: ['reached', 'accepted', 'replied', 'continue', 'emailed'],
    people: [P({ contactId: 'c2', name: 'Andy Pearson', title: 'VP Creative', stage: 'emailed', label: 'emailed', next: 'Emailed Nov 4 — book the call', acceptedAt: at(-12), repliedAt: at(-5), emailedAt: at(-2) })] }),
  B({ id: 'b3', name: 'Olipop', category: 'beverage', stage: 'continue', next: 'Send them the email', onUs: true, lastAt: at(-1),
    steps: ['reached', 'accepted', 'replied', 'continue'],
    people: [
      P({ contactId: 'c3', name: 'Melanie Ross', title: 'Head of Partnerships', stage: 'continue', label: 'wants an email', next: 'Send them the email', onUs: true, acceptedAt: at(-9), repliedAt: at(-1) }),
      P({ contactId: 'c4', name: 'Kai Lee', title: 'Brand Manager', stage: 'reached', label: 'invited', next: 'Invite sent Oct 28 — no answer yet' }),
    ] }),
  B({ id: 'b4', name: 'Neutonic', category: 'energy', stage: 'replied', next: 'They replied to Elizabeth — book a call', onUs: true, elizabeth: true, lastAt: at(-3),
    steps: ['reached', 'replied'],
    people: [P({ key: 'e:1', by: 'elizabeth', channel: 'email', contactId: 'c5', name: 'Kerry Szostak', title: 'Founder', stage: 'replied', label: 'replied',
      next: 'They replied to Elizabeth — book a call', onUs: true, invitedAt: null, emailedAt: at(-6), repliedAt: at(-3) })] }),
  B({ id: 'b5', name: 'Celsius', category: 'energy', stage: 'accepted', next: 'Text them on LinkedIn', onUs: true, due: nyKey(Date.now() - 2 * DAY), lastAt: at(-4),
    steps: ['reached', 'accepted'],
    people: [P({ contactId: 'c6', name: 'Toby David', title: 'Events Manager', stage: 'accepted', label: 'accepted', next: 'Text them on LinkedIn', onUs: true, due: nyKey(Date.now() - 2 * DAY), acceptedAt: at(-4) })] }),
  B({ id: 'b6', name: 'Ghost', category: 'energy', stage: 'accepted', next: 'Messaged Nov 3 — waiting', lastAt: at(-3), archived: true,
    steps: ['reached', 'accepted'],
    people: [P({ contactId: 'c7', name: 'Ryan Hughes', title: 'Marketing Director', stage: 'accepted', label: 'messaged', next: 'Messaged Nov 3 — waiting', acceptedAt: at(-6) })] }),
  B({ id: 'b7', name: 'Gone Soda', category: 'beverage', stage: 'out', out: 'stopped', next: 'Doesn’t want to continue', lastAt: at(-7), steps: ['reached', 'accepted', 'replied'],
    people: [P({ contactId: 'c8', name: 'Pat Moe', stage: 'out', out: 'stopped', label: 'doesn’t want to continue', next: 'Doesn’t want to continue' })] }),
];
// A long Reached out step: 50 brands.
for (let i = 0; i < 50; i++) {
  BRANDS.push(B({ id: 'r' + i, name: 'Reach Brand ' + String(i).padStart(2, '0'), lastAt: at(-1 - i / 10),
    people: [P({ contactId: 'rc' + i, name: 'Person ' + i, title: 'Partnerships Lead', next: 'Invite sent — no answer yet' })] }));
}
const counts = {}, onUs = {};
STAGES.forEach((s) => { counts[s.key] = 0; onUs[s.key] = 0; });
BRANDS.forEach((b) => { counts[b.stage]++; if (b.onUs) onUs[b.stage]++; });
const TRACKER = { brands: BRANDS, stages: STAGES, counts, onUs, ever: { reached: 57, accepted: 7, replied: 5, continue: 3, emailed: 2, talks: 1 }, total: BRANDS.length, today: TODAY };

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo: () => ({ brands: [], people: 0, done: [], calls: [], held: [] }),
  acceptedPeople: () => ({ people: [], total: 0, brands: 0 }),
  outreachTracker: () => JSON.parse(JSON.stringify(TRACKER)),
  // Nov 8 2026: Every brand reached is drawn in Deals → Overview, from zachOverview's tracker.
  zachOverview: () => ({ tracker: JSON.parse(JSON.stringify(TRACKER)), today: TRACKER.today, brands: {}, outreach: {}, talks: {}, deals: {}, board: {}, week: {} }),
  listInTalks: (a) => ({
    brands: [], suggestions: [], sponsorUrl: 'https://shows.example.com', today: TODAY,
    preview: a.preview ? {
      id: a.preview, name: (BRANDS.find((b) => b.id === a.preview) || {}).name, category: 'energy', tier: 'growth', kind: null, website: null, linkedinUrl: null,
      instagramUrl: null, tiktokUrl: null, about: null, topProducts: null, brandNotes: null, liMembers: null, salesCents: null, fundingCents: null, lastRoundAt: null,
      sponsorsCollege: null, sponsorNote: null, usStatus: null, fit: 60, overview: null, overviewBy: null, overviewAt: null, idea: null, ideaBy: null, ideaAt: null,
      why: 'reply', since: null, addedBy: null, stopped: null, archived: false, nextCall: null, lastCall: null, people: [], invited: [], others: 0, notes: [], deal: null,
      board: { code: null, opens: 0, lastAt: null }, lastAt: null, preview: true, repliedAt: null,
      journey: ['invited', 'accepted', 'replied', 'call', 'deal'].map((k, i) => ({ key: k, label: k, done: i < 2, at: null })),
    } : null,
  }),
  getBrand: (a) => ({
    brand: {
      id: a.brandId, name: (BRANDS.find((b) => b.id === a.brandId) || {}).name || 'Brand', category: 'energy', tier: 'growth', aka: '',
      about: '', topProducts: '', website: '', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null,
      doNotEmail: false, passedAt: null, workPeople: null, partner: null, kind: null, contacts: [], targets: [], shows: [], deals: [], documents: [],
    },
    events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [], boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [],
    talks: { on: false, why: null, since: null },
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
  const base0 = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base0 + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base0)) return route.abort();
    return route.continue();
  });
  const text = (sel) => page.textContent(sel);
  const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);
  const names = () => page.$$eval('#tk-list .tk-row .tk-name b', (els) => els.map((e) => e.textContent));
  const groups = () => page.$$eval('#tk-list .tk-gh b', (els) => els.map((e) => e.textContent));
  const shot = process.env.TK_SHOTS;

  await page.goto(base0 + '/app.html');
  await page.waitForSelector('.tabs .nav-item[data-view="zachtab"]');

  // 1. The page (Nov 8 2026: under Deals, the Overview's full list — its blocks link here)
  assert.equal(await text('.tabs .nav-item[data-view="zachtab"]'), 'Deals');
  await page.evaluate(() => gotoView('tracker'));
  await page.waitForSelector('#tk-list .tk-row');
  assert.equal(await page.evaluate(() => document.querySelector('.view.active').id), 'zachtab', 'the old page opens the Overview');
  assert.equal(await page.$eval('.tabs.cc-only:not(#sub-tabs) .nav-item.active', (e) => e.textContent), 'Deals');
  assert.deepEqual(await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => [e.textContent, e.classList.contains('active')])),
    [['Overview', true], ['In talks', false], ['Deals board', false], ['Sponsorships', false]]);
  assert.ok(/57 brands we’ve reached out to · 3 with a step for us to do/.test(await text('#tk-sub')), await text('#tk-sub'));
  console.log('✓ Every brand reached sits under Deals (the Overview stays lit — its blocks link here)');

  // 2. Tiles
  const tiles = await page.$$eval('.tk-tile', (els) => els.map((e) => [e.getAttribute('data-tk-stage'), e.querySelector('.tk-tile-n').firstChild.textContent, (e.querySelector('.tk-tile-u') || {}).textContent || '']));
  assert.deepEqual(tiles, [['reached', '50', ''], ['accepted', '2', '1 to do'], ['replied', '1', '1 to do'], ['continue', '1', '1 to do'], ['emailed', '1', ''], ['talks', '1', ''], ['out', '1', '']]);
  assert.ok(/So far: 57 reached out to · 7 had someone accept · 5 replied · 3 wanted to continue · 2 got the email · 1 in talks/.test(await text('#tk-ever')));
  console.log('✓ a tile per step with its count and to-dos; the So far line');

  // 3. The list
  assert.deepEqual(await groups(), ['In talks', 'Email sent', 'Wants to continue', 'Replied', 'Accepted', 'Reached out', 'Out']);
  assert.deepEqual((await names()).slice(0, 6), ['Electrolit', 'Liquid Death', 'Olipop', 'Neutonic', 'Celsius', 'Ghost']);
  const celsius = await text('[data-tk-id="b5"]');
  assert.ok(/Text them on LinkedIn · 2 days late/.test(celsius) && /To do/.test(celsius) && /Toby David — Events Manager · accepted/.test(celsius), celsius);
  assert.ok(/Elizabeth/.test(await text('[data-tk-id="b4"] .tk-name')));
  assert.ok(/archived/.test(await text('[data-tk-id="b6"] .tk-name')));
  assert.ok(/\+1 more person/.test(await text('[data-tk-id="b3"] .tk-who')));
  const dots = await page.$$eval('[data-tk-id="b3"] .tk-dots i', (els) => els.map((e) => e.className));
  assert.deepEqual(dots, ['on', 'on', 'on', 'now', '', '']);
  assert.equal(await text('[data-tk-id="b7"] .tk-pill'), 'Out');
  if (shot) await page.screenshot({ path: shot + '/tracker-wide.png', fullPage: false });
  console.log('✓ the list: furthest step first, Out last; next step, late, tags, the step dots');

  // 4. Filters
  await page.click('.tk-tile[data-tk-stage="accepted"]');
  assert.deepEqual(await names(), ['Celsius', 'Ghost']);
  assert.ok(/Showing 2 of 57/.test(await text('#tk-showing')));
  assert.equal(await page.getAttribute('.tk-tile[data-tk-stage="accepted"]', 'aria-pressed'), 'true');
  await page.click('.tk-tile[data-tk-stage="accepted"]');
  assert.equal((await groups()).length, 7, 'a second click shows every step');
  await page.fill('#tk-find', 'melanie');
  assert.deepEqual(await names(), ['Olipop'], 'the find box matches people');
  await page.fill('#tk-find', 'liquid');
  assert.deepEqual(await names(), ['Liquid Death']);
  await page.fill('#tk-find', 'zzz');
  assert.ok(/No brand matches “zzz”/.test(await text('#tk-list')));
  await page.click('[data-tk-clear]');
  assert.equal(await page.inputValue('#tk-find'), '');
  await page.click('#tk-mine');
  assert.deepEqual(await names(), ['Olipop', 'Neutonic', 'Celsius']);
  assert.ok(/\(3\)/.test(await text('#tk-mine')));
  await page.click('#tk-mine');
  console.log('✓ a tile shows only its step; find matches brands and people; only ones with a step for us; Show every brand');

  // 5. A row opens
  await page.click('[data-tk-row="b3"]');
  await page.waitForSelector('[data-tk-id="b3"] .tk-body');
  const people = await page.$$eval('[data-tk-id="b3"] .tk-person', (els) => els.map((e) => e.textContent));
  assert.equal(people.length, 2);
  assert.ok(/Melanie Ross — Head of Partnerships/.test(people[0]) && /Wants to continue/.test(people[0]) && /Send them the email/.test(people[0]) && /LinkedIn · invited .* · accepted .* · replied/.test(people[0]), people[0]);
  assert.equal(await page.getAttribute('[data-tk-row="b3"]', 'aria-expanded'), 'true');
  await page.click('[data-tk-row="b4"]');
  assert.ok(/Elizabeth · email · emailed .* · replied/.test(await text('[data-tk-id="b4"] .tk-person')));
  await page.click('[data-tk-row="b4"]');
  assert.equal(await page.$('[data-tk-id="b4"] .tk-body'), null, 'a second click closes it');
  await page.click('[data-tk-row="b1"]');
  const li = await page.$$eval('[data-tk-id="b1"] .tk-person a', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('target')]));
  assert.deepEqual(li.map((x) => x[0]), ['LinkedIn', 'Email']);
  if (shot) await page.screenshot({ path: shot + '/tracker-open.png', fullPage: false });
  // A person: the brand page at them.
  await page.click('[data-tk-id="b3"] .tk-person[data-focus="c3"] .tk-pname');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'brand');
  assert.equal(last('getBrand').args.brandId, 'b3');
  assert.equal(await page.evaluate(() => B_FOCUS && B_FOCUS.contactId), 'c3');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'zachtab');
  await page.waitForSelector('[data-tk-id="b3"] .tk-body');
  // Open its In talks profile: a look at a brand not in talks.
  await page.click('[data-tk-profile="b3"]');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'intalks' && document.querySelector('.it-name'));
  assert.equal(last('listInTalks').args.preview, 'b3');
  assert.equal(await text('.it-name'), 'Olipop');
  assert.ok(/not in talks yet/.test(await text('.it-hero')) && !/replied —/.test(await text('.it-hero')));
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'zachtab');
  await page.waitForSelector('[data-tk-brand="b3"]');
  await page.click('[data-tk-brand="b3"]');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'brand');
  assert.equal(last('getBrand').args.brandId, 'b3');
  console.log('✓ a row opens its people; a person opens the brand page at them; In talks profile; Brand page →');

  // 6. A long step
  await page.evaluate(() => gotoView('tracker'));
  await page.waitForSelector('#tk-list .tk-row');
  const reached = () => page.$$eval('.tk-group.tk-s-reached .tk-row', (els) => els.length);
  assert.equal(await reached(), 40);
  await page.click('[data-tk-more="reached"]');
  assert.equal(await reached(), 50);
  console.log('✓ a long step shows 40, then Show all');

  // 7. A phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll (' + wide + 'px)');
  const cols = await page.$eval('.tk-tiles', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 2);
  if (shot) await page.screenshot({ path: shot + '/tracker-phone.png', fullPage: false });
  console.log('✓ a phone: two tiles a row, no sideways scroll');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('\ntracker page: all 7 passed');
  await browser.close();
  server.close();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
