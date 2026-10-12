// scripts/test-add-person.js — + Add brand → Person (Leo, Oct 12 2026: "sometimes we want
// to send the show board to individual people"). Drives public/app.html in Chromium
// against a fake /api/data: the Brand / Person switch, what the person form asks for,
// what Add person sends, the person's page (board link first, outreach parts hidden),
// and "This is a person…" on a brand page (preview, then confirm).
//   NODE_PATH=$(npm root -g) node scripts/test-add-person.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-add-person.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);

const brand = (extra) => ({
  brand: Object.assign({
    id: 'p1', name: 'Miles Carter', category: null, tier: null, aka: '', about: null, topProducts: '',
    website: '', goals: '', notes: 'Friend of Zach', owner: null, linkedinUrl: '', externalId: null, boardCode: 'ABCD-EFGH',
    doNotEmail: true, passedAt: '2026-10-12T15:00:00.000Z', workPeople: null, partner: null, kind: 'person',
    contacts: [{ id: 'c1', name: 'Miles Carter', email: 'miles@example.com', phone: '555-0100', title: null, isDecisionMaker: false }],
    targets: [], shows: [], deals: [], documents: [],
  }, extra || {}),
  events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [],
  boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [],
});
let BRAND = brand();

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  suggestCategory: () => ({ category: 'energy', confidence: 'high', method: 'keyword' }),
  createBrand: (a) => ({ brand: { id: 'p1', name: a.name }, created: true, person: a.kind === 'person' }),
  getBrand: () => BRAND,
  setBrandKind: (a) => a.confirm ? { id: a.brandId, kind: a.kind } : { preview: true, name: BRAND.brand.name, changes: ['Archived: off the queue, Schedule and every automatic pick'] },
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
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
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
  await page.waitForFunction(() => typeof window.openAddBrand === 'function');

  // The box opens as Brand, as before.
  await page.click('#btn-add-brand');
  assert.equal(await page.textContent('#nb-h'), 'Add a brand');
  assert.ok(await page.isVisible('#nb-cat') && await page.isVisible('#nb-su') && await page.isHidden('#nb-email'));
  console.log('✓ + Add brand opens as Brand');

  // Person: name, email, phone, owner, notes — no category, SponsorUnited, list paste.
  await page.click('[data-nbkind="person"]');
  assert.equal(await page.textContent('#nb-h'), 'Add a person');
  assert.equal(await page.textContent('#nb-save'), 'Add person');
  for (const id of ['#nb-email', '#nb-phone', '#nb-owner', '#nb-notes']) assert.ok(await page.isVisible(id), id + ' shows');
  for (const id of ['#nb-cat', '#nb-tier', '#nb-su', '#nb-bulk-open', '#nb-site']) assert.ok(await page.isHidden(id), id + ' hidden');
  await page.fill('#nb-name', 'Miles Carter');
  await page.waitForTimeout(700);
  assert.ok(!last('suggestCategory'), 'no category guess for a person');
  await page.fill('#nb-email', 'miles@example.com');
  await page.fill('#nb-phone', '555-0100');
  await page.fill('#nb-notes', 'Friend of Zach');
  await page.click('#nb-save');
  await page.waitForSelector('#brand-body h1');
  const sent = last('createBrand').args;
  assert.equal(sent.kind, 'person'); assert.equal(sent.name, 'Miles Carter');
  assert.equal(sent.email, 'miles@example.com'); assert.equal(sent.phone, '555-0100');
  assert.ok(!('category' in sent), 'no category sent');
  console.log('✓ Add person sends name, email, phone, notes as a person');

  // Their page: board link first, open; outreach parts hidden.
  assert.match(await page.textContent('#brand-body .sub'), /Person · gets the Show Board/);
  const firstFold = await page.$eval('#brand-body details.fold', (d) => ({ text: d.querySelector('summary').textContent, open: d.open }));
  assert.match(firstFold.text, /Show Board access/); assert.ok(firstFold.open);
  assert.ok(await page.isVisible('#b-code-link'), 'Copy board link right there');
  assert.ok(!(await page.$('#b-fit')), 'no Brand Fit line');
  for (const id of ['#b-plan', '#b-enrich', '#b-dne', '#b-workpeople', '#b-pass', '#b-split']) {
    const el = await page.$(id);
    assert.ok(!el || await el.isHidden(), id + ' hidden on a person');
  }
  assert.equal(await page.textContent('#b-kind'), 'It\'s a brand, not a person');
  assert.ok(!last('getOutreachPlan') && !last('brandPlanLine'), 'no Schedule read for a person');
  console.log('✓ a person\'s page leads with their board link; no outreach parts');

  // A brand page: "This is a person…" previews, then confirms.
  BRAND = brand({ id: 'b2', name: 'Miles (personal)', kind: null, category: 'unresolved', passedAt: null, doNotEmail: false, boardCode: null });
  BRAND.fit = null;
  await page.evaluate(() => loadBrand('b2'));
  await page.waitForFunction(() => document.querySelector('#brand-body h1').textContent === 'Miles (personal)');
  await page.click('#brand-body details.fold:has(#b-kind) > summary');
  assert.ok(await page.isVisible('#b-pass'), 'a brand keeps its outreach buttons');
  await page.click('#b-kind');
  await page.waitForTimeout(300);
  const kinds = calls.filter((c) => c.fn === 'setBrandKind');
  assert.equal(kinds.length, 2);
  assert.ok(!kinds[0].args.confirm && kinds[1].args.confirm && kinds[1].args.kind === 'person');
  assert.match(dialogs[dialogs.length - 1], /Make Miles \(personal\) a person\?[\s\S]*Archived/);
  console.log('✓ This is a person… shows what changes, then makes it');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('add person: all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
