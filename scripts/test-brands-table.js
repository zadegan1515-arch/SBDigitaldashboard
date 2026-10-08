// scripts/test-brands-table.js — Brands → All brands as one table (Leo,
// Oct 2026). Drives public/app.html in Chromium against a fake /api/data:
// buyer counts and the Needs people / Has enough filters, sort, search
// (name or also-known-as), a row opening to edit (saves on change), adding
// a person, the "Every brand a marketing / partnerships person" card
// (counts by reason, Show them, Pick their pages, the folded People on
// file card), and the phone width (no sideways page scroll).
//   NODE_PATH=$(npm root -g) node scripts/test-brands-table.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-brands-table.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();

function row(id, name, buyers, people, extra) {
  return Object.assign({
    id, name, category: 'energy', tier: 'growth', passedAt: null, aka: null, website: null, linkedinUrl: null, notes: null,
    source: 'manual', createdAt: NOW, contacts: [], _count: { contacts: people, targets: 0 },
    buyers: { partnerships: buyers, events: 0, marketing: 0, founder: 0, total: buyers },
    buyerPeople: Array.from({ length: buyers }, (_, i) => ({ id: id + 'p' + i, name: 'Buyer ' + i, title: 'Partnerships Manager', kind: 'partnerships', email: true, linkedin: true })),
    withEmail: buyers, withLinkedin: people, outreach: {},
  }, extra || {});
}

const S = { list: [], saves: [], adds: [], proposals: [], resolved: [] };
function reset() {
  S.list = [
    row('b1', 'Alpha Energy', 0, 4, { aka: 'Alpha Co' }),
    row('b2', 'Bravo Soda', 2, 6, { category: 'beverage' }),
    row('b3', 'Charlie Spirits', 1, 1, { category: 'spirits', outreach: { lastSentAt: NOW, invited: 1 } }),
    row('b4', 'Delta Gone', 0, 0, { passedAt: NOW }),
  ];
}
reset();

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listBrands: () => S.list,
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  findDuplicates: () => ({ groups: [] }),
  suMatchQueue: () => ({ proposals: S.proposals, missing: 0, capturePending: 0 }),
  suResolveMatch: (a) => { S.resolved.push(a); S.proposals = S.proposals.filter((p) => p.brandId !== a.brandId); return { ok: true, brandId: a.brandId, brandName: 'Halfday Iced Tea' }; },
  updateBrand: (a) => { S.saves.push(a); return { ok: true }; },
  upsertContact: (a) => {
    S.adds.push(a);
    const b = S.list.find((x) => x.id === a.brandId);
    b._count.contacts += 1;
    b.buyers.total += 1; b.buyers.partnerships += 1;
    b.buyerPeople.push({ id: 'n' + S.adds.length, name: a.name, title: a.title, kind: 'partnerships', email: !!a.email, linkedin: !!a.linkedinUrl });
    return { id: 'n' + S.adds.length };
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      // A slow answer, the way CI's runner gives one (S.slow[fn] ms).
      if (S.slow && S.slow[fn]) await new Promise(r => setTimeout(r, S.slow[fn]));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadBrands === 'function');
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');

  const names = () => page.$$eval('#brands-list [data-brow]', (rs) => rs.map((r) => r.getAttribute('data-name')));

  // Sub-tabs: Stock take and Needs contacts folded in, still reachable.
  const tabs = await page.$$eval('#sub-tabs .nav-item', (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(tabs, ['All brands', 'Discover', 'Clarify']);
  assert.ok(await page.$('#bq-stock') && await page.$('#bq-needs'), 'lanes and worklist buttons');
  console.log('✓ one Brands page; lanes / worklist are buttons');

  // Leo, Oct 2026 ("too much going on"): tools in one More menu, one
  // category dropdown, Brand / Category / Tier / Fit / Buyers only, and
  // archived hidden by default.
  assert.ok(await page.isHidden('#bq-dups'), 'tools sit in the More menu');
  await page.click('#bq-more > summary');
  assert.ok(await page.isVisible('#bq-dups') && await page.isVisible('#bq-fittools'));
  await page.click('#bq-more > summary');
  assert.ok(await page.isHidden('#brand-cat-chips'), 'no chip row');
  assert.ok(await page.$('#brands-list [data-brcat]'), 'one category dropdown');
  const heads = await page.$$eval('#brands-list thead th', (ts) => ts.map((t) => t.textContent.trim()).filter(Boolean));
  assert.deepEqual(heads, ['Brand', 'Category', 'Tier', 'Fit', 'Buyers']);
  assert.deepEqual(await names(), ['Alpha Energy', 'Charlie Spirits', 'Bravo Soda'], 'archived hidden by default');
  await page.uncheck('[data-brarch]');
  console.log('✓ More menu, category dropdown, five columns, archived hidden by default');

  // Default sort: fewest buyers first, archived last.
  assert.deepEqual(await names(), ['Alpha Energy', 'Charlie Spirits', 'Bravo Soda', 'Delta Gone']);
  // Counted over the brands in play: archived Delta Gone needs nobody.
  assert.match(await page.textContent('#brands-sub'), /^3 brands in play · 2 have a buyer · 1 need one$/);
  assert.match(await page.textContent('[data-brow="b1"] .br-buy'), /0/);
  assert.ok(await page.$('[data-brow="b1"] .br-buy.low') && await page.$('[data-brow="b2"] .br-buy.ok'));
  console.log('✓ buyer counts, fewest first, archived last');

  await page.click('[data-brshow="need"]');
  assert.deepEqual(await names(), ['Alpha Energy'], 'an archived brand never needs people');
  await page.check('[data-brarch]');
  assert.deepEqual(await names(), ['Alpha Energy']);
  await page.uncheck('[data-brarch]');
  await page.click('[data-brshow="enough"]');
  assert.deepEqual(await names(), ['Charlie Spirits', 'Bravo Soda']);
  await page.click('[data-brshow="all"]');
  await page.selectOption('[data-brsort]', 'most');
  assert.deepEqual(await names(), ['Bravo Soda', 'Charlie Spirits', 'Alpha Energy', 'Delta Gone']);
  await page.selectOption('[data-brsort]', 'fewest');
  console.log('✓ Needs people / Has enough / Hide archived / sort');

  await page.fill('#bq', 'alpha co');
  assert.deepEqual(await names(), ['Alpha Energy'], 'search matches also-known-as');
  await page.fill('#bq', '');
  assert.equal((await names()).length, 4);
  console.log('✓ search by name or also-known-as');

  // A row opens to edit; edits save on change.
  await page.click('[data-brow="b1"] .br-cat');
  await page.waitForSelector('[data-bropen="b1"]');
  await page.selectOption('[data-bropen="b1"] [data-bredit="category"]', 'electrolytes');
  await page.waitForFunction(() => document.querySelector('[data-brow="b1"] .br-cat').textContent === 'Electrolytes & Hydration');
  await page.fill('[data-bropen="b1"] [data-bredit="website"]', 'alpha.com');
  await page.press('[data-bropen="b1"] [data-bredit="website"]', 'Tab');
  await page.fill('[data-bropen="b1"] [data-bredit="notes"]', 'Met at expo');
  await page.click('[data-bropen="b1"] .br-h');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(S.saves, [
    { brandId: 'b1', category: 'electrolytes' },
    { brandId: 'b1', website: 'alpha.com' },
    { brandId: 'b1', notes: 'Met at expo' },
  ]);
  console.log('✓ a row opens to edit; category, website, notes save on change');

  // Add a person: Enter adds, list reloads, the row stays open, count goes up.
  await page.fill('[data-bropen="b1"] [data-bradd="name"]', 'Pat Lee');
  await page.fill('[data-bropen="b1"] [data-bradd="title"]', 'Brand Partnerships Manager');
  await page.fill('[data-bropen="b1"] [data-bradd="email"]', 'not-an-email');
  await page.click('[data-bropen="b1"] [data-bract="add"]');
  assert.equal(S.adds.length, 0, 'a bad email is refused before saving');
  await page.fill('[data-bropen="b1"] [data-bradd="email"]', 'pat@alpha.com');
  await page.press('[data-bropen="b1"] [data-bradd="email"]', 'Enter');
  await page.waitForFunction(() => /Pat Lee/.test((document.querySelector('[data-bropen="b1"]') || {}).textContent || ''));
  assert.deepEqual(S.adds[0], { brandId: 'b1', name: 'Pat Lee', title: 'Brand Partnerships Manager', email: 'pat@alpha.com', linkedinUrl: null });
  assert.match(await page.textContent('[data-brow="b1"] .br-buy'), /1/);
  console.log('✓ add a person from the row; the count updates and the row stays open');

  // The category dropdown switches the list.
  await page.selectOption('#brands-list [data-brcat]', 'energy');
  await page.waitForFunction(() => /Energy/.test(document.getElementById('brands-title').textContent));
  assert.equal(await page.$eval('#brands-list [data-brcat]', (s) => s.value), 'energy');
  await page.selectOption('#brands-list [data-brcat]', 'all');
  await page.waitForFunction(() => document.getElementById('brands-title').textContent === 'All brands');
  console.log('✓ the category dropdown switches the list');

  if (process.env.BRANDS_SHOT) await page.screenshot({ path: process.env.BRANDS_SHOT });

  // The name opens the brand page.
  await page.click('[data-brow="b2"] .br-link');
  await page.waitForFunction(() => document.getElementById('brand').classList.contains('active'));
  console.log('✓ the brand name opens the full brand page');

  // Clarify (Leo, Oct 2026): "Which SponsorUnited page is theirs?" is its
  // own tab, not on All brands; Use this resolves that brand and the list
  // redraws (empty state when nothing is left).
  S.proposals = [{ brandId: 'hd', brandName: 'Halfday Iced Tea', v: 2, at: Date.now(),
    candidates: [{ externalId: 'HD1', name: 'Halfday Iced Tea Beverage - Non-Alcoholic Tea' }] }];
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');
  assert.equal(await page.$('#brands #su-proposals'), null, 'not on All brands');
  await page.click('#sub-tabs [data-view="clarify"]');
  await page.waitForSelector('#su-proposals [data-suuse="hd"]');
  await page.click('#su-proposals [data-suuse="hd"]');
  await page.waitForSelector('#su-proposals .empty');
  assert.deepEqual(S.resolved, [{ brandId: 'hd', externalId: 'HD1', suName: 'Halfday Iced Tea Beverage - Non-Alcoholic Tea' }]);
  console.log('✓ Clarify tab: Use this resolves the brand, then "Nothing to clarify"');

  // Every brand a marketing / partnerships person (coverage.ts): counts
  // from the rows' `cover`, this week and the last LinkedIn run from
  // buyerCoverage; Show them = Needs people narrowed to that reason.
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  S.list = [
    row('c1', 'Next One', 0, 2, { cover: { state: 'next' } }),
    row('c2', 'Next Two', 0, 0, { cover: { state: 'next' } }),
    row('c3', 'Page Pick', 0, 0, { cover: { state: 'page' } }),
    row('c4', 'Rest Co', 0, 5, { cover: { state: 'resting', note: 'big company (173 people) — nobody new in its partnerships, sponsorship, brand manager, marketing searches', at: '2026-09-30T20:00:00.000Z', back: '2026-10-30T20:00:00.000Z' } }),
    row('c5', 'Covered Co', 2, 4, { cover: { state: 'covered' } }),
    row('c6', 'Gone Co', 0, 0, { passedAt: NOW, cover: { state: 'off' } }),
    // Leo's LinkedIn hid their marketing people: Zach's to read (li-hidden.ts).
    row('c7', 'Hidden Co', 0, 1, { cover: { state: 'zach' } }),
  ];
  H.buyerCoverage = () => ({
    target: 1, perDay: 100, week: { linkedin: 11, sponsorunited: 3, other: 1 }, coveredWeek: 4, latestScript: '1.28',
    run: { startedAt: ago(3), lastAt: ago(3), status: 'stopped', brands: 6, added: 11, script: '1.25' },
  });
  H.fillProgress = () => ({
    resting: 18, restDays: 14, cap: 25, brands: 486, atCap: 29, under: 457, underNoId: 437, empty: 200, peopleOnFile: 3999,
    roomReachable: 38, addedToday: 3, addedWeek: 3, lastAt: NOW, lastBrand: 'Knox Hydrate', nextUp: [],
  });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForFunction(() => /\+4 this week/.test(document.getElementById('cover-card').textContent));
  const card = await page.textContent('#cover-card');
  assert.match(card, /Buyer coverage\s*1 of 6/);
  assert.match(card, /\+4 this week/);
  assert.match(await page.getAttribute('#cover-card .cv-week', 'title'), /15 people added this week: 11 LinkedIn · 3 SponsorUnited · 1 by hand/);
  assert.deepEqual(
    await page.$$eval('#cover-card [data-cvrow]', (rs) => rs.map((r) => r.getAttribute('data-cvrow') + ':' + r.querySelector('.cv-n').textContent)),
    ['next:2', 'page:1', 'zach:1', 'resting:1'], 'one row per reason, empty reasons left out');
  assert.match(card, /Hidden from your LinkedIn · Zach reads them/);
  assert.match(card, /Next on the LinkedIn fill · about 1 day/);
  assert.match(card, /back on the fill Oct 30/);
  assert.ok(await page.$('#cover-card [data-cvrow="next"] a[href="https://www.linkedin.com/feed/#sb-fill"]'), 'Start the LinkedIn fill');
  assert.match(card, /Last LinkedIn run \w{3} \d{1,2} · 6 brands · \+11 people · idle/);
  assert.match(card, /script 1\.25 is old/);
  assert.ok(await page.$('#cover-card .cv-run.warn'), 'an idle fill and an old script are flagged');
  assert.equal(await page.textContent('#brands-sub'), '6 brands in play · 1 have a buyer · 5 need one');
  console.log('✓ the coverage card: counts by reason, this week, the last LinkedIn run');

  await page.click('#cover-card [data-cvshow="resting"]');
  assert.deepEqual(await names(), ['Rest Co']);
  const restLine = await page.textContent('[data-brow="c4"] .br-cvl');
  assert.match(restLine, /^LinkedIn Sep 30: big company \(173 people\) — nobody new in its partnerships/);
  assert.match(restLine, /… · back on the fill Oct 30$/, 'a long note is cut short; the whole note is in the tooltip');
  assert.deepEqual(await page.$$eval('#brands-list [data-brwhy]', (cs) => cs.map((c) => c.textContent)),
    ['Any reason5', 'Next in the LinkedIn fill2', 'Pick their LinkedIn page1', 'Hidden from your LinkedIn1', 'LinkedIn found nobody1']);
  await page.click('#brands-list [data-brwhy=""]');
  assert.deepEqual((await names()).sort(), ['Hidden Co', 'Next One', 'Next Two', 'Page Pick', 'Rest Co'], 'archived Gone Co needs nobody');
  assert.equal(await page.$('[data-brow="c1"] .br-cvl'), null, 'next in the fill: nothing to say on the row');
  await page.click('#brands-list [data-brwhy="page"]');
  assert.deepEqual(await names(), ['Page Pick']);
  assert.match(await page.textContent('[data-brow="c3"] .br-cvl'), /No clear LinkedIn page — pick it/);
  await page.click('[data-brshow="all"]');
  assert.equal(await page.$('#brands-list [data-brwhy]'), null, 'the reasons show under Needs people only');
  console.log('✓ Show them: Needs people narrowed to that reason; each row says why');

  // The People on file (SponsorUnited sweep) card: one line, opens as it was.
  const fold = await page.textContent('#fill-progress details:not([open]) summary');
  assert.equal(fold, 'People on file · 286 of 486 brands have someone · +3 from SponsorUnited today');
  await page.click('#fill-progress summary');
  await page.waitForFunction(() => /3 added this week/.test(document.querySelector('#fill-progress details[open]').textContent));
  console.log('✓ the People on file card is folded to one line and opens as it was');

  // "pick it" (and the card's Pick their pages) → Outreach → People's
  // "Which LinkedIn page is theirs?".
  H.linkedinPeople = () => ({
    brands: [], runs: [], latestScript: '1.28', liOwner: null,
    pageReview: [{ brandId: 'c3', name: 'Page Pick', category: 'energy', website: null, at: NOW, why: 'unclear', saved: null, pageIndustry: null, candidates: [] }],
  });
  H.liCleanup = () => ({ people: [], brands: [] });
  await page.click('#brands-list [data-brshow="need"]');
  await page.click('#brands-list [data-brwhy="page"]');
  await page.click('[data-brow="c3"] [data-bract="pickpage"]');
  await page.waitForFunction(() => document.getElementById('linkedin').classList.contains('active'));
  await page.waitForFunction(() => /Which LinkedIn page is theirs\?/.test(document.getElementById('li-review').textContent));
  console.log('✓ "pick it" opens Outreach → People on the page-picking card');

  // "Read on Zach's LinkedIn" (Leo, Oct 7 2026: "i dont want to miss out on
  // people if i do it from my own account"): the row's link and the card's
  // Open → land on it; links to the view to read, Copy for Zach, Done / Undo.
  S.zachReads = [];
  const zrow = (id, name, buyers, likely, url) => ({ brandId: id, name, category: 'rtd', onFile: 1 + buyers, buyers, n: likely + 1, likely,
    titles: ['Brand Manager', 'Partnerships Lead'].slice(0, likely), url, q: 'marketing', at: NOW, by: 'fill', zachAt: null, zachAdded: null });
  H.linkedinPeople = () => ({
    brands: [], runs: [], latestScript: '1.30', liOwner: null, pageReview: [], zachRestDays: 120,
    zachList: [
      zrow('c7', 'Hidden Co', 0, 2, 'https://www.linkedin.com/company/hidden-co/people/?keywords=marketing'),
      zrow('c8', 'Captain Morgan', 1, 1, 'https://www.linkedin.com/company/diageo/people/?keywords=Captain%20Morgan'),
    ],
    zachDone: [Object.assign(zrow('c9', 'Read Co', 1, 1, 'https://www.linkedin.com/company/read-co/people/'), { zachAt: NOW, zachAdded: 2 })],
  });
  H.zachRead = (a) => { S.zachReads.push(a); return { ok: true }; };
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list [data-brshow="need"]');
  await page.click('#brands-list [data-brshow="need"]');
  await page.click('#brands-list [data-brwhy="zach"]');
  assert.match(await page.textContent('[data-brow="c7"]'), /Your LinkedIn hid their marketing people/);
  await page.click('[data-brow="c7"] [data-bract="zachlist"]');
  await page.waitForFunction(() => document.getElementById('linkedin').classList.contains('active'));
  await page.waitForFunction(() => /Read on Zach\u2019s LinkedIn/.test(document.getElementById('li-zach').textContent));
  const zt = await page.textContent('#li-zach');
  assert.match(zt, /2 brands where your LinkedIn hid people who look like buyers/);
  assert.match(zt, /2 of 3 hidden look like buyers: Brand Manager, Partnerships Lead/);
  assert.match(zt, /no buyer on file/);
  assert.deepEqual(await page.$$eval('#li-zach [data-zach] a[target="_blank"]', (as) => as.map((a) => a.getAttribute('href'))),
    ['https://www.linkedin.com/company/hidden-co/people/?keywords=marketing', 'https://www.linkedin.com/company/diageo/people/?keywords=Captain%20Morgan']);
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  await page.click('#li-zach [data-zach-copy]');
  const copied = await page.evaluate(() => window.__copied);
  assert.match(copied, /^Read on your LinkedIn — 2 brands\. Open each link, press SB · Read people/);
  assert.match(copied, /Hidden Co\n  2 of 3 hidden look like buyers: Brand Manager, Partnerships Lead\n  https:\/\/www\.linkedin\.com\/company\/hidden-co\/people\/\?keywords=marketing/);
  assert.match(copied, /Captain Morgan\n  1 of 2 hidden looks like a buyer: Brand Manager\n  https:\/\/www\.linkedin\.com\/company\/diageo/);
  const zachCalls = async (n) => { for (let i = 0; i < 100 && S.zachReads.length < n; i++) await page.waitForTimeout(50); };
  await page.click('#li-zach [data-zach-done="c7"]');
  await zachCalls(1);
  await page.waitForSelector('#li-zach summary');
  await page.click('#li-zach summary');
  await page.click('#li-zach [data-zach-undo="c9"]');
  await zachCalls(2);
  assert.deepEqual(S.zachReads, [{ brandId: 'c7', undo: false }, { brandId: 'c9', undo: true }]);
  console.log('✓ Read on Zach\u2019s LinkedIn: reached from the row and the card, links to each view, Copy for Zach, Done and Undo');

  // The coverage card's Open → lands on it too.
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list [data-brshow="all"]');
  await page.click('#brands-list [data-brshow="all"]');
  await page.waitForSelector('#cover-card [data-cvzach]', { state: 'visible' });
  await page.click('#cover-card [data-cvzach]');
  await page.waitForFunction(() => document.getElementById('linkedin').classList.contains('active') && document.getElementById('li-zach').style.display !== 'none');
  console.log('✓ the coverage card\u2019s "Hidden from your LinkedIn" row opens Zach\u2019s list');

  // Operations → Team: sign-ins the list turned away (Oct 8 2026), with the
  // address Google gave and a one-click Add for a founding member.
  S.teamAdds = [];
  H.listTeam = () => ({ managers: ['leo@example.com'], invited: [], canManage: true,
    denied: [{ email: 'leonardo@example.com', name: 'Leo Z', at: NOW }] });
  H.addTeamEmail = (a) => { S.teamAdds.push(a); return { email: a.email }; };
  await page.evaluate(() => gotoView('team'));
  await page.waitForSelector('#team-body [data-team-denied="leonardo@example.com"]');
  assert.match(await page.textContent('#team-body'), /Tried to sign in[\s\S]*leonardo@example\.com[\s\S]*Leo Z/);
  // The Add answers slowly and Leo moves on first: the page must not be
  // pulled back to Team when the answer lands (the CI failure, Oct 8 2026).
  S.slow = { addTeamEmail: 400 };
  await page.click('#team-body [data-team-add-email="leonardo@example.com"]');
  for (let i = 0; i < 100 && !S.teamAdds.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(S.teamAdds, [{ email: 'leonardo@example.com' }]);
  await page.evaluate(() => gotoView('brands'));
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => document.getElementById('brands').classList.contains('active')), true, 'still on Brands after the Add came back');
  S.slow = null;
  console.log('✓ Team: turned-away sign-ins listed with one-click Add; moving on before it answers stays put');

  // Phone width: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list .br-table');
  await page.waitForSelector('#cover-card .cv-card');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  console.log('✓ phone width fits');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Brands table checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
