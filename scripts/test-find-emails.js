// scripts/test-find-emails.js — Outreach → Email's "Emails for people who
// didn't answer on LinkedIn" (Leo, Nov 16 2026; src/lib/find-emails.ts) in
// Chromium against a fake /api/data: the counts, the two groups and the
// wait, the file it downloads for Hunter (its columns, exactly the people
// shown), Hunter's file brought back (a preview of every line, unverified
// ones unticked, Save sends only the ticked), a stale answer shown again
// with the ticks kept, the wrong file, Undo (names who loses theirs first),
// a person opening their brand page, and the phone width. Also the brands not
// reached out to yet (the third group, their best few people a brand) and the
// second file — the websites of brands with nobody to look up, one a line,
// for Hunter's Domain Search. And the whole roster on one line (every brand
// in exactly one place), and the category: a menu that narrows the counts,
// the list and the files, which are sorted by category and name it.
//   NODE_PATH=$(npm root -g) node scripts/test-find-emails.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-find-emails.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'find-emails-ui-'));

const person = (id, first, last, brandId, brandName, group, extra) => Object.assign({
  contactId: id, name: first + ' ' + last, first, last, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id + '/', email: null,
  brandId, brandName, category: 'energy', group, lastAt: new Date(Date.now() - 30 * 864e5).toISOString(), by: 'zach',
  company: brandName, domain: brandName.toLowerCase().replace(/[^a-z]/g, '') + '.com', domainFrom: 'website', parent: null,
}, extra || {});

const S = { calls: [] };
function reset() {
  S.calls = [];
  S.last = null; S.stale = false; S.saved = [];
  S.people = [
    person('c1', 'Ann', 'Lee', 'b1', 'Alpha Energy', 'noaccept'),
    person('c2', 'Bo', 'Chen', 'b1', 'Alpha Energy', 'quiet', { title: 'VP, "Brand"' }),
    person('c3', 'Cy', 'Young', 'b2', 'Ketel One', 'noaccept', { company: 'Diageo', domain: null, domainFrom: null, parent: 'Diageo' }),
    person('c4', 'Di', 'Park', 'b3', 'Gamma Drinks', 'quiet'),
  ];
}
reset();
const fresh = (id, first, last, extra) => Object.assign(person(id, first, last, 'b5', 'Nova Pouch', 'fresh'), { lastAt: null, by: null, category: 'nicotine' }, extra || {});
const list = (a) => {
  const days = a.minDays == null ? 21 : a.minDays;
  const per = a.perBrand == null ? 3 : a.perBrand;
  let people = days === 0 ? S.people.concat([person('c5', 'Ed', 'Nolan', 'b4', 'Fresh Co', 'noaccept')]) : S.people;
  // Brands not reached yet: their best 3 a brand — everyone lets one more in.
  people = people.concat([fresh('f1', 'Hal', 'Frost')], per === 0 || per > 3 ? [fresh('f2', 'Ida', 'Moss', { title: 'Brand Manager' })] : []);
  const left = people.filter((p) => !S.saved.includes(p.contactId));
  return {
    minDays: days, perBrand: per, today: '2026-11-16',
    counts: {
      need: left.length, needBrands: new Set(left.map((p) => p.brandId)).size,
      noaccept: left.filter((p) => p.group === 'noaccept').length, quiet: left.filter((p) => p.group === 'quiet').length,
      have: 3, emailed: 3, tooNew: days === 0 ? 0 : 1, noName: 2, offBrands: 1, waitingBrands: 4, noDomain: left.filter((p) => !p.domain).length,
      fresh: left.filter((p) => p.group === 'fresh').length, freshBrands: 1, freshHave: 1, freshMore: per === 3 ? 1 : 0, freshNoName: 0, nobodyBrands: 2,
      heldBrands: 2, held: { giant: 1, skip: 1, small: 0 }, dealBrands: 1,
    },
    people: left,
    ready: [
      Object.assign(person('r1', 'Flo', 'Reyes', 'b1', 'Alpha Energy', 'noaccept'), { email: 'flo@alphaenergy.com' }),
      Object.assign(person('r2', 'Gus', 'Hall', 'b3', 'Gamma Drinks', 'quiet'), { email: 'gus@gammadrinks.com' }),
      fresh('r3', 'Jo', 'Vale', { email: 'jo@novapouch.com' }),
    ],
    // Every brand in one place, per category.
    tally: {
      energy: { list: left.filter((p) => p.category === 'energy').map((p) => p.brandId).filter((v, i, a) => a.indexOf(v) === i).length, tooNew: days === 0 ? 0 : 1, waiting: 4, talking: 2, off: 1 },
      nicotine: { list: 1, held: 1 }, beverage: { nobody: 2, held: 1 }, spirits: { nobody: 1, known: 1 }, '': { off: 2 },
    },
    brandTotal: 20,
    domains: [
      { brandId: 'b6', brandName: 'Zest Soda', category: 'beverage', company: 'Zest Soda', domain: 'zestsoda.com', parent: null },
      { brandId: 'b7', brandName: 'Casamigos', category: 'spirits', company: 'Diageo', domain: null, parent: 'Diageo' },
      { brandId: 'b8', brandName: 'Zest Zero', category: 'beverage', company: 'Zest Zero', domain: 'zestsoda.com', parent: null },
    ],
    last: S.last,
  };
};
const LINES = () => [
  { line: 2, contactId: 'c1', name: 'Ann Lee', brandName: 'Alpha Energy', email: 'ann.lee@alphaenergy.com', verdict: 'valid', status: 'valid', score: 96, action: 'save', why: 'Verified', tick: true },
  { line: 3, contactId: 'c2', name: 'Bo Chen', brandName: 'Alpha Energy', email: 'bo@alphaenergy.com', verdict: 'unverified', status: 'accept_all', score: 71, action: 'save', why: 'Not verified (accept_all)', tick: false },
  { line: 4, contactId: 'c3', name: 'Cy Young', brandName: 'Ketel One', email: 'cy.young@diageo.com', verdict: 'valid', status: 'valid', score: 99, action: 'save', why: 'Verified', tick: true },
  { line: 5, contactId: 'c9', name: 'Hal Roy', brandName: 'Beta', email: 'hal@beta.com', verdict: 'valid', status: 'valid', score: 90, action: 'has', why: 'Already has hal@other.com — left as it is', tick: false },
  { line: 6, contactId: null, name: 'Zed Zero', brandName: 'Nowhere', email: 'zed@nowhere.com', verdict: 'valid', status: 'valid', score: 90, action: 'unknown', why: 'Not someone on the dashboard', tick: false },
  { line: 7, contactId: 'c8', name: 'Ivy Ng', brandName: 'Beta', email: 'ivy@beta.com', verdict: 'invalid', status: 'invalid', score: 10, action: 'invalid', why: 'Hunter says this address doesn’t work', tick: false },
];
const pv = () => ({
  lines: LINES(), counts: { save: 3, same: 0, has: 1, invalid: 1, bad: 0, unknown: 1, stopped: 0, taken: 0, twice: 0, ticked: 2 },
  cols: { email: 'Email address', status: 'Verification status', score: 'Confidence score', id: 'SB id' }, rows: 8, notFound: 2, expect: S.stale ? '3.new' : '3.abc',
});

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  getEmailStatus: () => ({ configured: false }),
  getBrand: (a) => ({ id: a.id || a.brandId, name: 'Alpha Energy', category: 'energy', tier: 'growth', contacts: [], targets: [], deals: [], notes: [] }),
  noAnswerList: list,
  saveFoundEmails: (a) => {
    if (/WRONG/.test(a.csv)) throw new Error('No email addresses in that file. Choose the file Hunter gave back, not the one you uploaded to it.');
    if (!a.confirm) return Object.assign({ preview: true }, pv());
    if (a.expect !== pv().expect) return Object.assign({ applied: false, stale: true }, pv());
    S.saved = a.ids.slice();
    S.last = { at: NOW, by: 'leo@example.com', count: a.ids.length };
    return Object.assign({ applied: true, saved: a.ids.length, skipped: 0, brands: 2 }, pv());
  },
  undoFoundEmails: (a) => {
    const goes = [{ name: 'Ann Lee', brandName: 'Alpha Energy', email: 'ann.lee@alphaenergy.com' }, { name: 'Bo Chen', brandName: 'Alpha Energy', email: 'bo@alphaenergy.com' }];
    const stays = [{ name: 'Cy Young', brandName: 'Ketel One', why: 'an email to them was drafted or sent since' }];
    if (!a.confirm) return { preview: true, at: NOW, by: 'leo@example.com', count: 3, goes, stays };
    S.last = null; S.saved = [];
    return { applied: true, removed: 2, at: NOW, by: 'leo@example.com', count: 3, goes, stays };
  },
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// The page's file reader, as text: a tiny CSV parser for what it downloads.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((v) => v !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [], dialogs = [];
  let accept = true;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); accept ? d.accept() : d.dismiss(); });
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
  const calls = (fn) => S.calls.filter((c) => c.fn === fn);
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadEmailOutreach === 'function');
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#fe-card .fe-grid');

  // ---- the counts ----
  let text = await page.textContent('#fe-card');
  assert.match(text, /Find emails with Hunter — every brand we’re not talking to/);
  assert.match(text, /Need an email\s*5 people\s*at 4 brands we’re not talking to/);
  assert.match(text, /Already have an email\s*3 people\s*never emailed/);
  assert.match(text, /Download the list for Hunter \(5\)/);
  assert.match(text, /Didn’t accept · 2/);
  assert.match(text, /Accepted, then no response · 2/);
  assert.match(text, /Not reached out to yet · 1/);
  assert.match(text, /1 of them has no company website on file — Hunter looks that one up by company name/);
  assert.match(text, /People left out: 2 whose name LinkedIn cut short · 3 already emailed · 1 more at brands not reached yet, past the best 3 a brand\./);
  // Every brand, each in one place — the numbers add up to the roster.
  assert.match(await page.textContent('#fe-tally'), /^All 20 brands: 4 have someone to look up · 3 have nobody on file · 1 invited less than 21 days ago Include them · 4 where someone accepted — on Zach’s list · 2 replied, in talks or said no · 2 the queue holds back \(giants, Skip categories, too small\) · 1 with a deal, a show or a Show Board request · 3 archived or set aside\.$/);
  assert.match(text, /Nothing is emailed from here/);
  assert.equal(await page.getAttribute('#fe-card a[href^="https://hunter.io"]', 'target'), '_blank');
  assert.equal(calls('noAnswerList')[0].args.minDays, 21);
  assert.equal(calls('noAnswerList')[0].args.perBrand, 3);
  ok('the card counts who needs an email, who has one, and who is left out');

  // ---- the file for Hunter ----
  const grab = async (sel) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    const to = path.join(TMP, dl.suggestedFilename());
    await dl.saveAs(to);
    return { name: dl.suggestedFilename(), grid: parseCsv(fs.readFileSync(to, 'utf8')) };
  };
  let f = await grab('#fe-card [data-fe="download"]');
  assert.equal(f.name, 'sb-need-emails-2026-11-16.csv');
  assert.deepEqual(f.grid[0], ['First name', 'Last name', 'Company', 'Company website', 'SB brand', 'SB category', 'SB title', 'SB LinkedIn', 'SB id']);
  assert.deepEqual(f.grid.slice(1).map((r) => r[8]), ['c1', 'c2', 'c3', 'c4', 'f1']);
  assert.deepEqual(f.grid[5], ['Hal', 'Frost', 'Nova Pouch', 'novapouch.com', 'Nova Pouch', 'Nicotine Pouches', 'Head of Partnerships', 'https://www.linkedin.com/in/f1/', 'f1']);
  assert.deepEqual(f.grid[1], ['Ann', 'Lee', 'Alpha Energy', 'alphaenergy.com', 'Alpha Energy', 'Energy Drinks', 'Head of Partnerships', 'https://www.linkedin.com/in/c1/', 'c1']);
  assert.equal(f.grid[2][6], 'VP, "Brand"');
  // A label under a parent: looked up by the parent's name, no website.
  assert.deepEqual(f.grid[3].slice(0, 5), ['Cy', 'Young', 'Diageo', '', 'Ketel One']);
  ok('Download gives Hunter first name, last name, company, website and our id');

  // ---- the groups ----
  await page.click('#fe-card [data-g="quiet"]');
  assert.match(await page.textContent('#fe-need'), /^3 people/);
  assert.match(await page.textContent('#fe-card'), /at 3 brands we’re not talking to/);
  f = await grab('#fe-card [data-fe="download"]');
  assert.deepEqual(f.grid.slice(1).map((r) => r[8]), ['c1', 'c3', 'f1']);
  // The brands not reached yet are a group of their own.
  await page.click('#fe-card [data-g="fresh"]');
  assert.match(await page.textContent('#fe-need'), /^2 people/);
  assert.match(await page.textContent('#fe-have'), /^1 person/);
  f = await grab('#fe-card [data-fe="download"]');
  assert.deepEqual(f.grid.slice(1).map((r) => r[8]), ['c1', 'c3']);
  // Never all off: the last one on stays on.
  await page.click('#fe-card [data-g="noaccept"]');
  assert.equal(await page.getAttribute('#fe-card [data-g="noaccept"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#fe-card [data-g="quiet"]', 'aria-pressed'), 'false');
  await page.click('#fe-card [data-g="quiet"]');
  await page.click('#fe-card [data-g="noaccept"]');
  f = await grab('#fe-card [data-fe="download"]');
  assert.deepEqual(f.grid.slice(1).map((r) => r[8]), ['c2', 'c4']);
  await page.click('#fe-card [data-g="noaccept"]');
  await page.click('#fe-card [data-g="fresh"]');
  assert.match(await page.textContent('#fe-need'), /^5 people/);
  ok('a group off leaves its people out of the count and the file');

  // ---- the wait ----
  await page.selectOption('#fe-days', '0');
  await page.waitForFunction(() => /^6 people/.test(document.getElementById('fe-need').textContent));
  assert.equal(calls('noAnswerList').slice(-1)[0].args.minDays, 0);
  assert.doesNotMatch(await page.textContent('#fe-card'), /invited less than/);
  await page.selectOption('#fe-days', '21');
  await page.waitForFunction(() => /^5 people/.test(document.getElementById('fe-need').textContent));
  ok('the wait is a choice: any time lets fresh invites in');

  // ---- how many people at a brand not reached yet ----
  await page.selectOption('#fe-per', '0');
  await page.waitForFunction(() => /^6 people/.test(document.getElementById('fe-need').textContent));
  assert.deepEqual([calls('noAnswerList').slice(-1)[0].args.perBrand, calls('noAnswerList').slice(-1)[0].args.minDays], [0, 21]);
  assert.match(await page.textContent('#fe-card'), /Not reached out to yet · 2/);
  assert.doesNotMatch(await page.textContent('#fe-card'), /more at brands not reached yet/);
  f = await grab('#fe-card [data-fe="download"]');
  assert.deepEqual(f.grid.slice(1).map((r) => r[8]), ['c1', 'c2', 'c3', 'c4', 'f1', 'f2']);
  await page.selectOption('#fe-per', '3');
  await page.waitForFunction(() => /^5 people/.test(document.getElementById('fe-need').textContent));
  ok('brands not reached yet give their best 3 — or everyone, when asked');

  // ---- brands with nobody to look up: their websites, one a line ----
  assert.match(await page.textContent('#fe-doms'), /2 brands not reached yet have nobody on file to look up\. Download their websites \(2\) for Hunter’s Bulks → Domain Search/);
  assert.equal(await page.getAttribute('#fe-doms a', 'href'), 'https://hunter.io/bulks/domain-search');
  f = await grab('#fe-doms [data-fe="domains"]');
  assert.equal(f.name, 'sb-brand-websites-2026-11-16.csv');
  // One company a line, a website once, a parent's label by the parent's name.
  assert.deepEqual(f.grid, [['zestsoda.com'], ['Diageo']]);
  ok('brands with nobody on file download as a list of websites for Domain Search');

  // ---- by category ----
  assert.deepEqual(await page.$$eval('#fe-cat option', (o) => o.map((x) => x.textContent)),
    ['All categories', 'Energy Drinks (3)', 'Soda, Water & Other Drinks (0)', 'Spirits (0)', 'Nicotine Pouches (1)', 'No category (0)']);
  await page.selectOption('#fe-cat', 'nicotine');
  assert.match(await page.textContent('#fe-need'), /^1 person/);
  assert.match(await page.textContent('#fe-have'), /^1 person/);
  text = await page.textContent('#fe-card');
  assert.match(text, /Didn’t accept · 0/);
  assert.match(text, /Not reached out to yet · 1/);
  assert.match(await page.textContent('#fe-tally'), /^Nicotine Pouches — 2 brands: 1 have someone to look up · 1 the queue holds back/);
  assert.equal(await page.$('#fe-left'), null);
  assert.equal(await page.$('#fe-doms'), null);
  f = await grab('#fe-card [data-fe="download"]');
  assert.equal(f.name, 'sb-need-emails-nicotine-2026-11-16.csv');
  assert.deepEqual(f.grid.slice(1).map((r) => [r[8], r[5]]), [['f1', 'Nicotine Pouches']]);
  // A category with nobody to look up: only its websites file.
  await page.selectOption('#fe-cat', 'beverage');
  assert.match(await page.textContent('#fe-need'), /^0 people/);
  assert.equal(await page.isDisabled('#fe-card [data-fe="download"]'), true);
  assert.match(await page.textContent('#fe-doms'), /1 brand not reached yet has nobody on file to look up/);
  f = await grab('#fe-doms [data-fe="domains"]');
  assert.equal(f.name, 'sb-brand-websites-beverage-2026-11-16.csv');
  assert.deepEqual(f.grid, [['zestsoda.com']]);
  // A redraw (another answer from the server) keeps the category.
  await page.selectOption('#fe-per', '5');
  await page.waitForFunction(() => document.getElementById('fe-per').value === '5' && document.getElementById('fe-cat').value === 'beverage');
  await page.selectOption('#fe-per', '3');
  await page.selectOption('#fe-cat', '');
  await page.waitForFunction(() => /^5 people/.test(document.getElementById('fe-need').textContent));
  ok('a category narrows the counts, the every-brand line and the files, which name it');

  // ---- "Include them": the brands invited too recently ----
  await page.click('#fe-tally [data-fe="anytime"]');
  await page.waitForFunction(() => /^6 people/.test(document.getElementById('fe-need').textContent));
  assert.equal(await page.inputValue('#fe-days'), '0');
  assert.doesNotMatch(await page.textContent('#fe-tally'), /invited less than/);
  assert.match(await page.textContent('#fe-tally'), /^All 20 brands: 5 have someone to look up/);
  await page.selectOption('#fe-days', '21');
  await page.waitForFunction(() => /^5 people/.test(document.getElementById('fe-need').textContent));
  ok('Include them lets in the brands invited less than 21 days ago');

  // ---- the people who already have an email ----
  f = await grab('#fe-card [data-fe="ready"]');
  assert.equal(f.name, 'sb-have-emails-2026-11-16.csv');
  assert.deepEqual(f.grid[0], ['First name', 'Last name', 'Email', 'Brand', 'Category', 'Title', 'LinkedIn', 'Why']);
  assert.deepEqual(f.grid.slice(1).map((r) => [r[2], r[7]]), [['flo@alphaenergy.com', 'Didn’t accept'], ['gus@gammadrinks.com', 'Accepted, then no response'], ['jo@novapouch.com', 'Not reached out to yet']]);
  ok('the people who already have an email download as their own file');

  // ---- who's on it ----
  await page.click('#fe-card [data-fe="more"]');
  await page.waitForSelector('#fe-list .fe-table');
  text = await page.textContent('#fe-list');
  assert.match(text, /Ann Lee/);
  assert.match(text, /Diageo \(by name — its parent company\)/);
  assert.match(text, /Accepted, then no response/);
  assert.match(text, /Hal Frost[\s\S]*Nova Pouch[\s\S]*Nicotine Pouches[\s\S]*Not reached out to yet/);
  assert.equal(await page.$$eval('#fe-list tbody tr', (r) => r.length), 5);
  await page.click('#fe-list [data-focus="c1"]');
  await page.waitForFunction(() => document.getElementById('brand') && document.getElementById('brand').classList.contains('active'));
  assert.equal(calls('getBrand').length >= 1, true);
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#fe-list .fe-table');
  ok('See who’s on it lists them; a name opens their brand page at them');

  // ---- Hunter's file, brought back ----
  const hunter = path.join(TMP, 'hunter-result.csv');
  fs.writeFileSync(hunter, 'First name,Last name,SB id,Email address,Verification status\r\nAnn,Lee,c1,ann.lee@alphaenergy.com,valid\r\n');
  await page.setInputFiles('#fe-file', hunter);
  await page.waitForSelector('#fe-pv .fe-table');
  assert.equal(calls('saveFoundEmails').length, 1);
  assert.equal(calls('saveFoundEmails')[0].args.confirm, undefined);
  assert.match(calls('saveFoundEmails')[0].args.csv, /SB id,Email address/);
  text = await page.textContent('#fe-pv');
  assert.match(text, /hunter-result\.csv/);
  assert.match(text, /8 rows · 6 with an email · 2 Hunter found nothing for/);
  assert.match(text, /1 not verified by Hunter is unticked/);
  assert.match(text, /3 left as they are — 1 already have another email — left as it is · 1 not someone on the dashboard · 1 Hunter says the address doesn’t work/);
  assert.deepEqual(await page.$$eval('#fe-pv [data-fetick]', (b) => b.map((x) => [x.getAttribute('data-fetick'), x.checked])), [['c1', true], ['c2', false], ['c3', true]]);
  assert.equal(await page.textContent('#fe-save'), 'Save 2 emails');
  ok('Hunter’s file shows every line first; the unverified one is unticked');

  // Ticks change the button, never the server.
  await page.check('#fe-pv [data-fetick="c2"]');
  assert.equal(await page.textContent('#fe-save'), 'Save 3 emails');
  await page.click('#fe-pv [data-fe="tickok"]');
  assert.equal(await page.textContent('#fe-save'), 'Save 2 emails');
  await page.click('#fe-pv [data-fe="tickall"]');
  assert.equal(await page.textContent('#fe-save'), 'Save 3 emails');
  await page.uncheck('#fe-pv [data-fetick="c3"]');
  assert.equal(await page.textContent('#fe-save'), 'Save 2 emails');
  assert.equal(calls('saveFoundEmails').length, 1);
  ok('ticks, Tick all and Only verified change what Save will save');

  // ---- something changed since: shown again, ticks kept, nothing saved ----
  S.stale = true;
  await page.click('#fe-save');
  await page.waitForFunction(() => /Something changed since you looked/.test(document.getElementById('fe-pv').textContent));
  assert.deepEqual(await page.$$eval('#fe-pv [data-fetick]', (b) => b.map((x) => x.checked)), [true, true, false]);
  assert.deepEqual(S.saved, []);
  ok('a stale answer is shown again with the ticks kept — nothing saved');

  // ---- Save: exactly the ticked, with the preview's signature ----
  await page.click('#fe-save');
  await page.waitForSelector('#fe-note');
  const save = calls('saveFoundEmails').slice(-1)[0].args;
  assert.deepEqual([save.confirm, save.expect, save.ids], [true, '3.new', ['c1', 'c2']]);
  assert.match(await page.textContent('#fe-note'), /Saved 2 emails at 2 brands\./);
  await page.waitForSelector('#fe-last');
  assert.match(await page.textContent('#fe-last'), /Last file: 2 emails saved .* by leo@example\.com · Undo/);
  assert.match(await page.textContent('#fe-need'), /^3 people/);
  assert.equal(await page.$('#fe-pv .fe-table'), null);
  ok('Save sends only the ticked people and the preview’s signature');

  // ---- the wrong file ----
  const wrong = path.join(TMP, 'wrong.csv');
  fs.writeFileSync(wrong, 'WRONG,file\r\n1,2\r\n');
  await page.setInputFiles('#fe-file', wrong);
  await page.waitForFunction(() => /No email addresses in that file/.test((document.getElementById('fe-note') || {}).textContent || ''));
  assert.equal(await page.$('#fe-pv .fe-table'), null);
  ok('the wrong file says what’s wrong and saves nothing');

  // ---- Cancel ----
  S.stale = false;
  await page.setInputFiles('#fe-file', hunter);
  await page.waitForSelector('#fe-pv .fe-table');
  await page.click('#fe-pv [data-fe="cancel"]');
  assert.equal(await page.$('#fe-pv .fe-table'), null);
  ok('Cancel closes the preview');

  // ---- Undo: names who loses theirs first ----
  accept = false;
  await page.click('#fe-last [data-fe="undo"]');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(dialogs.slice(-1)[0], /Take back 2 emails saved/);
  assert.match(dialogs.slice(-1)[0], /• Ann Lee \(Alpha Energy\)/);
  assert.match(dialogs.slice(-1)[0], /1 person keeps theirs/);
  assert.equal(calls('undoFoundEmails').filter((c) => c.args.confirm).length, 0);
  accept = true;
  await page.click('#fe-last [data-fe="undo"]');
  await page.waitForFunction(() => !document.getElementById('fe-last'));
  assert.equal(calls('undoFoundEmails').filter((c) => c.args.confirm).length, 1);
  assert.match(await page.textContent('#fe-need'), /^5 people/);
  ok('Undo names who loses their email first; No changes nothing');

  // ---- a refresh keeps an open preview ----
  await page.setInputFiles('#fe-file', hunter);
  await page.waitForSelector('#fe-pv .fe-table');
  await page.evaluate(() => loadEmailOutreach());
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(await page.$('#fe-pv .fe-table'), null);
  await page.click('#fe-pv [data-fe="cancel"]');
  ok('a refresh of the tab keeps the preview open');

  // ---- a phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await new Promise((r) => setTimeout(r, 150));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  const small = await page.$$eval('#fe-card *', (els) => els.filter((el) => el.childNodes.length && [].some.call(el.childNodes, (c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11.5).length);
  assert.equal(small, 0, 'no text under 11.5px');
  ok('fits a phone, no small print');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\n' + n + ' checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
