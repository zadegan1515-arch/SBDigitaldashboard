// scripts/test-brand-fit-ui.js — Brand Fit on the page (public/app.html
// in Chromium against a fake /api/data):
//
//   1. Brands: asks for fit, best fit first, a too-small brand nobody has
//      contacted is hidden (one already invited still shows), "show them"
//      flips the one switch, and the switch is remembered.
//   2. Brand page: the Fit line with its reasons; the facts edit prefills
//      whole dollars and Save sends them back as `facts`.
//   3. Stock take: asks with hideSmall; the Brand Fit panel lists
//      Claude's research — an unticked brand is left out of the save —
//      and suggest Archive sends exactly the ticked brands.
//   4. Schedule Fill box: asks with hideSmall, says how many it hid, and
//      flipping its switch asks again without.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-brand-fit-ui.js   (~10s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-brand-fit-ui.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const NOW = '2026-10-05T15:00:00.000Z';
const calls = [];
const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);

const fit = (score, extra) => ({ score, size: 'target', tooSmall: false, tooSmallWhy: null, ruledOut: null, archiveWhy: null, usUnknown: true, ...extra });
const row = (id, name, f, outreach) => ({
  id, name, tier: 'growth', passedAt: null, category: 'energy', about: name + ' makes things', contacts: [],
  _count: { contacts: 3 }, outreach: outreach || {}, source: null, createdAt: NOW, notes: null, fit: f,
  hideSmall: false, // the server's call: too small and nobody's touched it
});
const LIST = [
  row('b_low', 'Low Fit Co', fit(30)),
  row('b_high', 'High Fit Co', fit(88, { usUnknown: false })),
  { ...row('b_tiny', 'Tiny Hidden Co', fit(20, { tooSmall: true, tooSmallWhy: '6 people on LinkedIn (under 20)' })), hideSmall: true },
  row('b_tinysent', 'Tiny Invited Co', fit(25, { tooSmall: true }), { invited: 1, lastSentAt: NOW }),
];

const BRAND = {
  brand: {
    id: 'b_high', name: 'High Fit Co', category: 'energy', tier: 'growth', aka: '', about: 'Energy drinks', topProducts: '',
    website: '', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null, doNotEmail: false,
    passedAt: null, workPeople: null, partner: null, contacts: [], targets: [], shows: [], deals: [], documents: [],
    salesCents: 1234567850, fundingCents: 3000000000, lastRoundAt: '2024-03-01T00:00:00.000Z', usStatus: 'yes',
    sponsorsCollege: true, sponsorNote: 'Rolling Loud', bizStatus: 'active', acquiredBy: null,
    researchedAt: NOW, researchNote: 'Crunchbase',
  },
  events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [], boardViews: { count: 0, last: null, recent: [] },
  fit: {
    ...fit(88, { usUnknown: false }),
    reasons: [
      { good: true, text: 'raised $30M · last round 2024-03', points: 36 },
      { good: true, text: 'already sponsors college / music', points: 20 },
      { good: false, text: 'no one we can reach yet', points: 0 },
    ],
  },
};

const STOCK = {
  goal: 15, refile: 0, lastRefile: null,
  totals: { business: 0, replied: 0, reached: 0, ready: 1, needs: 0, off: 0, total: 1, people: 3, under25: 1, noProfile: 1, touched: 0, small: 2, categories: 1 },
  lanes: [], others: [],
};

const PLAN = {
  today: '2026-09-29',
  pool: { total: 40, cap: 30 },
  days: [{
    date: '2026-09-29', category: 'energy', auto: false, total: 4, sent: 0,
    pinned: [{ id: 'p1', name: 'Pinned Co', state: 'going', going: 4 }], brands: [], sentPeople: [],
  }],
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  listBrands: () => LIST,
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  findDuplicates: () => ({ groups: [] }),
  getBrand: () => BRAND,
  updateBrand: () => ({ ok: true }),
  brandStock: () => STOCK,
  researchList: () => ({ scope: 'schedule', total: 1, shown: 1, scheduled: 1, rows: [{ id: 'b_euro', name: 'Euro Co' }], text: 'Research these brands…\n- {"id":"b_euro"}' }),
  researchImport: (a) => (a.preview === false ? { ok: true, updated: a.keep.length, names: [] } : {
    rows: [
      { brandId: 'b_euro', brandName: 'Euro Co', input: 'Euro Co', archived: false, row: {}, changes: [{ field: 'usStatus', label: 'In the US', from: '—', fromRaw: null, to: 'no', raw: 'no' }] },
      { brandId: 'b_tiny', brandName: 'Tiny Hidden Co', input: 'tiny', archived: false, row: {}, changes: [{ field: 'salesCents', label: 'Sales', from: '—', fromRaw: null, to: '$300K', raw: 30000000 }] },
      { brandId: 'b_same', brandName: 'Same Co', input: 'Same Co', archived: false, row: {}, changes: [] },
    ],
    unmatched: [{ name: 'Nobody Brand', several: [] }], errors: [], staged: { at: NOW, rows: 3 }, last: null,
  }),
  fitArchive: (a) => (a.preview === false ? { ok: true, archived: a.brandIds.length, names: [], shelved: 0, offDays: 0 } : {
    brands: [
      { id: 'b_euro', name: 'Euro Co', category: 'beverage', score: 40, why: 'not sold in the US', ruledOut: true, contacted: false, queued: 1, plannedOn: '2026-10-07', plannedLabel: 'Wed Oct 7' },
      { id: 'b_dead', name: 'Dead Co', category: 'cpg', score: 10, why: 'out of business', ruledOut: true, contacted: true, queued: 0, plannedOn: null, plannedLabel: null },
    ],
    last: null,
  }),
  getOutreachPlan: () => PLAN,
  suggestForDay: (a) => ({
    date: a.date, category: a.category || '', needPeople: [], needPeopleTotal: 0, others: [],
    brands: [{ id: 's1', name: 'Suggested Co', category: 'energy', tier: 'growth', label: { kind: 'ready', reachable: 3, need: 3, onFile: 3 }, going: 3, people: [], text: '3 would go out', fit: fit(77) }],
    hiddenSmall: a.hideSmall ? 4 : 0, ruledOut: 0, hideSmall: !!a.hideSmall,
  }),
  getTodayQueue: () => ({ targets: [], sentList: [], more: [], theme: 'energy', labels: {}, sendingDay: true, sentToday: 0, cap: 30 }),
  listTargets: () => [],
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

let n = 0;
const ok = (name) => { n++; console.log('✓ ' + n + ' ' + name); };

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
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
  await page.waitForFunction(() => typeof window.loadBrand === 'function');

  try {
    // 1. Brands (the roster table).
    await page.evaluate(() => gotoView('brands'));
    await page.waitForSelector('#brands-list tr[data-brow="b_high"]');
    assert.equal(last('listBrands').args.fit, true);
    const rowsNow = () => page.$$eval('#brands-list tr[data-brow]', (els) => els.map((e) => e.getAttribute('data-brow')));
    assert.ok(!(await rowsNow()).includes('b_tiny'), 'the uncontacted tiny brand is hidden');
    assert.ok((await rowsNow()).includes('b_tinysent'), 'a contacted tiny brand still shows');
    assert.match(await page.textContent('#brands-list'), /1 brand too small hidden/);
    assert.match(await page.textContent('#brands-list tr[data-brow="b_high"]'), /Fit 88/);
    assert.match(await page.textContent('#brands-list tr[data-brow="b_tinysent"]'), /too small/);
    await page.selectOption('#brands-list [data-brsort]', 'fit');
    await page.waitForFunction(() => document.querySelector('#brands-list tr[data-brow]').getAttribute('data-brow') === 'b_high');
    assert.deepEqual(await rowsNow(), ['b_high', 'b_low', 'b_tinysent'], 'best fit first');
    await page.click('#brands-list [data-brshowsmall]');
    await page.waitForSelector('#brands-list tr[data-brow="b_tiny"]');
    assert.equal(await page.isChecked('#brands-list [data-hidesmall="brands"]'), false, 'the switch went off');
    assert.equal(await page.evaluate(() => localStorage.getItem('sb.hideSmall')), '0', 'remembered');
    await page.check('#brands-list [data-hidesmall="brands"]');
    await page.waitForFunction(() => !document.querySelector('#brands-list tr[data-brow="b_tiny"]'));
    // A search still finds a brand the switch hides — and doesn't offer to add it again.
    await page.fill('#bq', 'Tiny Hidden Co');
    await page.waitForSelector('#brands-list tr[data-brow="b_tiny"]');
    assert.equal(await page.isHidden('#bq-add'), true);
    await page.fill('#bq', '');
    await page.waitForFunction(() => !document.querySelector('#brands-list tr[data-brow="b_tiny"]'));
    ok('Brands table: Fit column, best fit first, too small hidden unless contacted, "show them", the switch, search');

    // 2. Brand page.
    await page.evaluate(() => loadBrand('b_high'));
    await page.waitForSelector('#b-fit');
    const fitLine = await page.textContent('#b-fit');
    assert.match(fitLine, /Fit 88/);
    assert.match(fitLine, /raised \$30M/);
    assert.match(fitLine, /no one we can reach yet/);
    assert.match(await page.textContent('#brand-body'), /\$12\.3M a year/);
    await page.evaluate(() => { document.querySelectorAll('#brand-body details.fold')[0].open = true; });
    await page.click('#b-edit-toggle');
    assert.equal(await page.inputValue('[data-bfact="sales"]'), '12,345,678.5', 'whole dollars, every digit');
    assert.equal(await page.inputValue('[data-bfact="lastRound"]'), '2024-03-01');
    assert.equal(await page.inputValue('[data-bfact="us"]'), 'yes');
    await page.selectOption('[data-bfact="sponsorsCollege"]', 'no');
    await page.click('#b-save');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    const save = last('updateBrand').args;
    assert.deepEqual(save.facts, { sponsorsCollege: 'no' }, 'only the fact Leo changed');
    await page.waitForSelector('#b-edit-toggle');
    ok('brand page: Fit line with reasons, facts prefilled exactly, Save sends only what changed');

    // 3. Stock take.
    await page.evaluate(() => gotoView('stock'));
    await page.waitForSelector('#st-fit [data-fitact="copy"]');
    assert.equal(last('brandStock').args.hideSmall, true);
    assert.match(await page.textContent('#st-sub'), /2 too small hidden/);
    const fitBox = await page.textContent('#st-fit');
    assert.match(fitBox, /Research from Claude/);
    assert.match(fitBox, /Nobody Brand/);
    await page.click('#st-fit [data-fitact="copy"]');
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Research these brands/);
    await page.uncheck('[data-fitr="b_tiny"]');
    await page.click('[data-fitact="apply"]');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    const imp = calls.filter((c) => c.fn === 'researchImport' && c.args.preview === false)[0];
    assert.deepEqual([imp.args.staged, imp.args.stagedAt, imp.args.keep], [true, NOW, ['b_euro', 'b_same']], 'only ticked brands, from the batch Leo saw');
    assert.deepEqual(imp.args.expect, { b_euro: '[["usStatus",null,"no"]]', b_same: '[]' }, 'with exactly what was shown');
    // Suggest Archive.
    await page.waitForSelector('[data-fitsec="archive"]');
    await page.evaluate(() => { document.querySelector('[data-fitsec="archive"]').open = true; });
    await page.uncheck('[data-fita="b_dead"]');
    assert.match(await page.textContent('[data-fitact="archive"]'), /Archive 1 brand/, 'the button counts the ticks');
    assert.equal(await page.evaluate(() => document.querySelector('[data-fitsec="archive"]').open), true, 'a tick leaves the section open');
    await page.click('[data-fitact="archive"]');
    await page.waitForTimeout(200);
    const arc = calls.filter((c) => c.fn === 'fitArchive' && c.args.preview === false)[0];
    assert.deepEqual(arc.args.brandIds, ['b_euro']);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('[data-fitsec="archive"]').open), true, 'still open after the panel reloads');
    await page.uncheck('#st-small');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    assert.equal(last('brandStock').args.hideSmall, false);
    await page.check('#st-small');
    ok('Stock take: hides on the switch, research saves only ticked brands, suggest Archive sends only ticked ones');

    // 4. Schedule Fill box.
    await page.evaluate(() => gotoView('schedule'));
    await page.waitForSelector('#sched-days [data-sdfillbox] .sd-orow');
    assert.equal(last('suggestForDay').args.hideSmall, true);
    const box = await page.textContent('#sched-days [data-sdfillbox]');
    assert.match(box, /4 too small hidden/);
    assert.match(box, /Fit 77/);
    const before = calls.filter((c) => c.fn === 'suggestForDay').length;
    await page.uncheck('#sched-days [data-hidesmall="sched"]');
    await page.waitForFunction((b) => window.__calls === undefined, before);
    await page.waitForTimeout(300);
    const after = calls.filter((c) => c.fn === 'suggestForDay');
    assert.ok(after.length > before, 'asked again');
    assert.equal(after[after.length - 1].args.hideSmall, false);
    ok('Schedule Fill box: hides on the switch, says how many, asks again when flipped');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('All Brand Fit page checks passed.');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
