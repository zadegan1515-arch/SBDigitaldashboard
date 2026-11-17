// scripts/test-email-coverage.js — Email → "Where we stand on emails" (Leo,
// Nov 17 2026; src/lib/email-coverage.ts) in Chromium against a fake
// /api/data: the four numbers (have an email, a buyer's email, no email, no
// website) and what's under each, who's left out, "since the start" and the
// history, the brand lists and the by-category table, the files, the websites
// waiting for a yes (every one named, the not-looked-up ones unticked, Save
// sends only the ticked — a preview first, then exactly that), Not theirs,
// the ones from email addresses, Undo (names what goes first), the one-page
// report, and the phone width.
//   NODE_PATH=$(npm root -g) node scripts/test-email-coverage.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-email-coverage.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'email-coverage-ui-'));

const S = { calls: [] };
const row = (id, name, category, people, emails, buyerEmails, extra) => Object.assign({
  id, name, category, people, emails, buyerEmails, hunterOnly: false, buyerHunterOnly: false, website: null, mailDomain: null, linkedin: false, parent: null, find: 'name',
}, extra || {});
function reset() {
  S.calls = [];
  S.sites = { b1: 'alphaenergy.com', b5: 'deltawater.com' };
  S.staged = [
    { brandId: 'b3', website: 'gammadrinks.com', how: 'search', note: 'its own store', at: '2026-11-17T16:00:00Z', by: 'Claude' },
    { brandId: 'b6', website: 'echoseltzer.com', how: 'memory', note: '', at: '2026-11-17T16:00:00Z', by: 'Claude' },
  ];
  S.dropped = [];
  S.lastWeb = { at: '2026-11-17T14:00:00Z', by: 'Claude', count: 1 };
  S.stale = false;
}
reset();
const rows = () => [
  row('b1', 'Alpha Energy', 'energy', 4, 2, 1, { find: 'domain' }),
  row('b2', 'Beta Pouch', 'nicotine', 2, 1, 0, { hunterOnly: true, mailDomain: 'betapouch.com', linkedin: true, find: 'domain' }),
  row('b3', 'Gamma Drinks', 'beverage', 3, 0, 0, { linkedin: true }),
  row('b4', 'Ketel One', 'spirits', 1, 0, 0, { parent: 'Diageo', find: 'parent' }),
  row('b5', 'Delta Water', 'beverage', 0, 0, 0, { find: 'domain' }),
  row('b6', 'Echo Seltzer', 'rtd', 0, 0, 0),
  row('b7', 'Zeta Beauty', 'beauty', 2, 2, 2, { hunterOnly: true, buyerHunterOnly: true, mailDomain: 'zetabeauty.com', find: 'domain' }),
].map((r) => {
  const site = S.sites[r.id] || null;
  return Object.assign(r, { website: site, mailDomain: site ? null : r.mailDomain, find: r.find === 'name' && site ? 'domain' : r.find });
});
const count = (list) => {
  const n = { brands: 0, email: 0, emailHunter: 0, buyerEmail: 0, buyerHunter: 0, noEmail: 0, noEmailPeople: 0, noEmailNobody: 0, website: 0, noWebsite: 0, noWebsiteMail: 0, noWebsitePage: 0, noWebsiteNothing: 0, findDomain: 0, findParent: 0, findName: 0, people: 0, emails: 0 };
  for (const r of list) {
    n.brands++; n.people += r.people; n.emails += r.emails;
    if (r.emails) { n.email++; if (r.hunterOnly) n.emailHunter++; if (r.buyerEmails) { n.buyerEmail++; if (r.buyerHunterOnly) n.buyerHunter++; } }
    else { n.noEmail++; if (r.people) n.noEmailPeople++; else n.noEmailNobody++; n[r.find === 'domain' ? 'findDomain' : r.find === 'parent' ? 'findParent' : 'findName']++; }
    if (r.website) n.website++;
    else { n.noWebsite++; if (r.mailDomain) n.noWebsiteMail++; else if (r.linkedin) n.noWebsitePage++; else n.noWebsiteNothing++; }
  }
  return n;
};
const cover = () => {
  const list = rows();
  const cats = {};
  for (const r of list) (cats[r.category] = cats[r.category] || []).push(r);
  const nameOf = Object.fromEntries(list.map((r) => [r.id, r.name]));
  return {
    today: '2026-11-18', at: '2026-11-18T18:00:00Z',
    n: count(list), total: 13, out: { talking: 2, known: 1, off: 3, other: 0 },
    byCategory: Object.keys(cats).map((k) => ({ key: k, n: count(cats[k]) })).sort((a, b) => b.n.brands - a.n.brands || a.key.localeCompare(b.key)),
    rows: list,
    marks: [
      { at: '2026-11-17T15:00:00Z', by: 'Claude', why: 'start', label: 'The start', n: { brands: 7, email: 1, buyerEmail: 1, noEmail: 6, website: 1, noWebsite: 6, emails: 2 } },
      { at: '2026-11-18T15:00:00Z', by: 'leo@example.com', why: 'file', label: 'After Hunter’s file — 3 emails saved', n: { brands: 7, email: 3, buyerEmail: 2, noEmail: 4, website: 1, noWebsite: 6, emails: 5 } },
    ],
    staged: S.staged.filter((s) => !S.sites[s.brandId]).map((s) => Object.assign({ name: nameOf[s.brandId], counted: true }, s)),
    lastWebsites: S.lastWeb, lastFile: null,
  };
};
const sig = (list) => list.length + '.' + list.map((r) => r.brandId).sort().join('');

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  getEmailStatus: () => ({ configured: false }),
  getBrand: (a) => ({ id: a.id || a.brandId, name: 'Gamma Drinks', category: 'beverage', tier: 'growth', contacts: [], targets: [], deals: [], notes: [] }),
  noAnswerList: () => ({}),
  emailCoverage: cover,
  saveBrandWebsites: (a) => {
    const todo = a.rows.filter((r) => !S.sites[r.brandId]);
    const lines = a.rows.map((r) => ({ brandId: r.brandId, name: r.brandId, website: 'https://' + r.website, action: S.sites[r.brandId] ? 'has' : 'save', why: '' }));
    const counts = { save: todo.length, has: a.rows.length - todo.length, bad: 0, unknown: 0, twice: 0 };
    const expect = sig(todo);
    if (!a.confirm) return { preview: true, lines, counts, expect };
    // S.stale = something changed between the look and the save.
    if (S.stale || a.expect !== expect) return { applied: false, stale: true, lines, counts, expect: 'changed' };
    for (const r of todo) S.sites[r.brandId] = r.website;
    S.lastWeb = { at: '2026-11-18T18:00:00Z', by: 'leo@example.com', count: todo.length };
    return { applied: true, saved: todo.length, skipped: 0, counts };
  },
  dropStagedWebsites: (a) => {
    S.dropped.push(...a.brandIds);
    S.staged = S.staged.filter((s) => !a.brandIds.includes(s.brandId));
    return { ok: true, dropped: a.brandIds.length };
  },
  undoBrandWebsites: (a) => {
    const goes = [{ name: 'Gamma Drinks', website: 'https://gammadrinks.com' }];
    const stays = [{ name: 'Old Co', why: 'its website was changed since' }];
    if (!a.confirm) return { preview: true, at: '2026-11-18T18:00:00Z', by: 'leo@example.com', count: 2, goes, stays };
    delete S.sites.b3; S.lastWeb = null;
    return { applied: true, removed: 1, goes, stays };
  },
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

function parseCsv(text) {
  const out = []; let r = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; r.push(cell); cell = ''; if (r.some((v) => v !== '')) out.push(r); r = []; }
    else cell += c;
  }
  r.push(cell); if (r.some((v) => v !== '')) out.push(r);
  return out;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
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
  const flat = (s) => s.replace(/\s+/g, ' ').trim();

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadEmailOutreach === 'function');
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#ec-card .ec-grid');

  // ---- 1. the four numbers ----
  assert.equal(flat(await page.textContent('#ec-email')), '3 of 7 · 43%');
  assert.equal(flat(await page.textContent('#ec-buyer')), '2 of 7 · 29%');
  assert.equal(flat(await page.textContent('#ec-noemail')), '4 of 7 · 57%');
  assert.equal(flat(await page.textContent('#ec-nosite')), '5 of 7 · 71%');
  let text = flat(await page.textContent('#ec-card'));
  assert.match(text, /Where we stand on emails\s*The 7 brands we’re not talking to — 6 more are left out \(2 replied, in talks or said no · 1 with a deal, a show or a Show Board request · 3 archived or set aside\)\./);
  assert.match(text, /Have an email\s*3 of 7 · 43%\s*anyone there · \+2 thanks to Hunter/);
  assert.match(text, /Have a buyer’s email\s*2 of 7 · 29%\s*partnerships, events, marketing or a founder · \+1 thanks to Hunter/);
  assert.match(text, /No email yet\s*4 of 7 · 57%\s*2 have people to look up · 2 have nobody on file\s*Hunter can search 1 by website, 1 under their parent company, 2 by name only/);
  assert.match(text, /No website saved\s*5 of 7 · 71%\s*2 we know the email domain · 1 has only a LinkedIn page · 2 just the name/);
  // The card sits above the Hunter card.
  assert.equal(await page.evaluate(() => !!(document.getElementById('ec-card').compareDocumentPosition(document.getElementById('fe-card')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.equal(calls('emailCoverage').length, 1);
  ok('the four numbers, what’s under each, and who’s left out');

  // ---- 2. since the start, and the history ----
  assert.equal(flat(await page.textContent('#ec-since')), 'Since Nov 17 (The start): brands with an email 1 → 3 (+2) · with a buyer’s email 1 → 2 (+1) · websites saved 1 → 2 (+1). History');
  await page.click('#ec-since [data-k="hist"]');
  let grid = await page.$$eval('#ec-hist tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  assert.deepEqual(grid, [
    ['Now', '', '7', '3', '2', '4', '5'],
    ['Nov 18', 'After Hunter’s file — 3 emails saved · leo@example.com', '7', '3', '2', '4', '6'],
    ['Nov 17', 'The start · Claude', '7', '1', '1', '6', '6'],
  ]);
  await page.click('#ec-since [data-k="hist"]');
  assert.equal(await page.$('#ec-hist'), null);
  ok('since the start, and every line of the history, newest first');

  // ---- 3. the brand lists ----
  assert.deepEqual(await page.$$eval('#ec-card .ec-row .chip', (b) => b.map((x) => x.textContent.trim())),
    ['No email yet · 4', 'An email, but not a buyer’s · 1', 'No website saved · 5', 'By category']);
  await page.click('#ec-card [data-k="noemail"]');
  grid = await page.$$eval('#ec-rows tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
  const CN = await page.evaluate(() => ({ beverage: CAT_NAMES.beverage, spirits: CAT_NAMES.spirits, rtd: CAT_NAMES.rtd }));
  assert.deepEqual(grid, [
    ['Gamma Drinks', CN.beverage, '3', '0', 'none — LinkedIn page saved', 'By name only'],
    ['Ketel One', CN.spirits, '1', '0', 'none', 'Under its parent company (Diageo)'],
    ['Delta Water', CN.beverage, '0', '0', 'deltawater.com', 'By its website'],
    ['Echo Seltzer', CN.rtd, '0', '0', 'none', 'By name only'],
  ]);
  await page.click('#ec-card [data-k="nobuyer"]');
  assert.deepEqual(await page.$$eval('#ec-rows tbody tr', (trs) => trs.map((tr) => tr.children[0].textContent.trim() + ' | ' + tr.children[3].textContent.replace(/\s+/g, ' ').trim() + ' | ' + tr.children[4].textContent.trim())),
    ['Beta Pouch | 1 (0 a buyer’s) | none saved — their mail is @betapouch.com']);
  // A brand's name opens its page.
  await page.click('#ec-rows .fe-link');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id === 'brand');
  assert.equal(calls('getBrand').length, 1);
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#ec-card .ec-grid');
  ok('the lists: no email, an email but not a buyer’s — and a name opens the brand');

  // ---- 4. by category ----
  await page.evaluate(() => { EC.open = ''; ecRender(); });
  await page.click('#ec-card [data-k="cats"]');
  grid = await page.$$eval('#ec-cats tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  assert.equal(grid.length, 7);                                              // six categories and the total
  assert.deepEqual(grid[0].slice(1), ['2', '0', '0', '2', '1']);             // beverage: 2 brands, no emails, 1 with no website
  assert.deepEqual(grid[grid.length - 1], ['All', '7', '3', '2', '4', '5']);
  assert.equal(grid.slice(0, -1).reduce((s, r) => s + Number(r[1]), 0), 7);
  ok('by category: every brand once, and the columns add up to the totals');

  // ---- 5. the files ----
  const grab = async (sel) => {
    await new Promise((r) => setTimeout(r, 250));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    const to = path.join(TMP, dl.suggestedFilename());
    await dl.saveAs(to);
    return { name: dl.suggestedFilename(), grid: parseCsv(fs.readFileSync(to, 'utf8')) };
  };
  await page.click('#ec-card [data-k="nosite"]');
  let f = await grab('#ec-list [data-ec="dl"]');
  assert.equal(f.name, 'sb-brands-no-website-2026-11-18.csv');
  assert.deepEqual(f.grid[0], ['Brand', 'Category', 'People on file', 'With an email', 'With a buyer’s email', 'Website', 'Their mail domain', 'LinkedIn page saved', 'How Hunter looks it up', 'Parent company']);
  assert.deepEqual(f.grid.slice(1).map((r) => r[0]), ['Beta Pouch', 'Gamma Drinks', 'Ketel One', 'Echo Seltzer', 'Zeta Beauty']);
  assert.deepEqual(f.grid[1].slice(2), ['2', '1', '0', '', 'betapouch.com', 'yes', 'By its website', '']);
  // Still to find = no website, no mail domain, nothing waiting for a yes.
  assert.match(flat(await page.textContent('#ec-tofind')), /^1 brand still to find — Claude looks them up on the web in rounds, and each list lands here for your yes before anything is saved\. Download the list$/);
  f = await grab('#ec-tofind [data-ec="dl"]');
  assert.equal(f.name, 'sb-brands-website-to-find-2026-11-18.csv');
  assert.deepEqual(f.grid.slice(1).map((r) => [r[0], r[9]]), [['Ketel One', 'Diageo']]);
  ok('the files: the brands with no website, and the ones still to find');

  // ---- 6. websites waiting for a yes ----
  assert.match(flat(await page.textContent('#ec-staged')), /^2 websites found, waiting for your yes\. Review them$/);
  await page.click('#ec-staged [data-ec="review"]');
  await page.waitForSelector('#ec-sites');
  grid = await page.$$eval('#ec-sites tbody tr', (trs) => trs.map((tr) => [tr.querySelector('input').checked, tr.children[1].textContent.trim(), tr.children[2].textContent.trim(), tr.children[3].textContent.replace(/\s+/g, ' ').trim()]));
  assert.deepEqual(grid, [
    [true, 'Gamma Drinks', 'gammadrinks.com ↗', 'Found on the web · its own store'],
    [false, 'Echo Seltzer', 'echoseltzer.com ↗', 'A well-known brand — not looked up'],
  ]);
  assert.equal(await page.getAttribute('#ec-sites a.ec-site', 'href'), 'https://gammadrinks.com');
  assert.equal(await page.getAttribute('#ec-sites a.ec-site', 'target'), '_blank');
  assert.equal(flat(await page.textContent('#ec-unsure')), '1 is less sure — a well-known brand Claude didn’t look up, or a find it couldn’t confirm — and is unticked. Tick the ones you trust.');
  assert.equal(await page.textContent('#ec-save'), 'Save 1 website');
  // Nothing was written by looking.
  assert.equal(calls('saveBrandWebsites').length, 0);
  // Untick all → nothing to save; tick all → both; only the ones looked up → one.
  await page.click('#ec-pv [data-ec="ticknone"]');
  assert.equal(await page.isDisabled('#ec-save'), true);
  await page.click('#ec-pv [data-ec="tickall"]');
  assert.equal(await page.textContent('#ec-save'), 'Save 2 websites');
  await page.click('#ec-pv [data-ec="tickok"]');
  assert.equal(await page.textContent('#ec-save'), 'Save 1 website');
  ok('the websites found: every one named, the not-looked-up one unticked, nothing written by looking');

  // Not theirs: off the list, the server told, nothing saved.
  await page.click('#ec-sites tr:nth-child(2) [data-ec="notsite"]');
  await page.waitForFunction(() => document.querySelectorAll('#ec-sites tbody tr').length === 1);
  assert.deepEqual(calls('dropStagedWebsites').map((c) => c.args), [{ brandIds: ['b6'] }]);
  assert.match(flat(await page.textContent('#ec-staged')), /^1 website found, waiting for your yes\./);
  assert.match(flat(await page.textContent('#ec-tofind')), /^2 brands still to find/);
  ok('Not theirs takes one off the list, and it’s back among the ones to find');

  // Save: a preview first, then exactly that with its expect.
  await page.click('#ec-save');
  await page.waitForFunction(() => !document.getElementById('ec-pv'));
  let sv = calls('saveBrandWebsites');
  assert.equal(sv.length, 2);
  assert.deepEqual(sv[0].args, { rows: [{ brandId: 'b3', website: 'gammadrinks.com' }] });
  assert.deepEqual(sv[1].args, { rows: [{ brandId: 'b3', website: 'gammadrinks.com' }], confirm: true, expect: '1.b3' });
  await page.waitForFunction(() => /Saved 1 website\./.test(document.getElementById('ec-note') ? document.getElementById('ec-note').textContent : ''));
  assert.equal(flat(await page.textContent('#ec-nosite')), '4 of 7 · 57%');
  assert.equal(await page.$('#ec-staged'), null);
  assert.match(flat(await page.textContent('#ec-lastweb')), /^Last list: 1 website saved Nov 18 by leo@example\.com · Undo$/);
  // The Hunter card's companies changed too: it reads again.
  assert.ok(calls('noAnswerList').length >= 2);
  assert.ok(calls('emailCoverage').length >= 2);
  ok('Save asks what it would save, then saves exactly that — and both cards read again');

  // ---- 7. the ones from email addresses ----
  assert.match(flat(await page.textContent('#ec-frommail')), /^2 brands — their people’s email addresses already give the domain, so Hunter can search them now\. Review & save as websites$/);
  await page.click('#ec-frommail [data-ec="review"]');
  await page.waitForSelector('#ec-sites');
  grid = await page.$$eval('#ec-sites tbody tr', (trs) => trs.map((tr) => [tr.querySelector('input').checked, tr.children[1].textContent.trim(), tr.children[2].textContent.trim(), tr.children[3].textContent.trim(), tr.children[4].textContent.trim()]));
  assert.deepEqual(grid, [
    [true, 'Beta Pouch', 'betapouch.com ↗', 'Their people’s email addresses', ''],
    [true, 'Zeta Beauty', 'zetabeauty.com ↗', 'Their people’s email addresses', ''],
  ]);
  // A stale answer: nothing saved, said so, the list stays.
  S.stale = true; S.calls = [];
  await page.uncheck('#ec-sites [data-ectick="b7"]');
  await page.click('#ec-save');
  await page.waitForSelector('#ec-pvnote');
  assert.match(await page.textContent('#ec-pvnote'), /Something changed while saving — look again and save once more\./);
  assert.equal(S.sites.b2, undefined);
  S.stale = false;
  await page.click('#ec-save');
  await page.waitForFunction(() => document.querySelectorAll('#ec-sites tbody tr').length === 1);
  assert.equal(S.sites.b2, 'betapouch.com');
  assert.equal(S.sites.b7, undefined);                      // unticked: left alone, still listed
  assert.deepEqual(await page.$$eval('#ec-sites tbody tr', (trs) => trs.map((tr) => tr.children[1].textContent.trim())), ['Zeta Beauty']);
  await page.click('#ec-pv [data-ec="closereview"]');
  assert.equal(await page.$('#ec-pv'), null);
  ok('the ones from email addresses: a stale answer saves nothing; only the ticked one is saved');

  // ---- 8. Undo names what goes first ----
  accept = false; dialogs.length = 0; S.calls = [];
  await page.click('#ec-lastweb [data-ec="undoweb"]');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /^Take back 1 website saved Nov 18\?\n\n• Gamma Drinks — https:\/\/gammadrinks\.com\n\n1 brand keeps theirs \(changed since\)\.$/);
  assert.deepEqual(calls('undoBrandWebsites').map((c) => c.args), [{}]);          // said no: nothing taken back
  accept = true;
  await page.click('#ec-lastweb [data-ec="undoweb"]');
  await page.waitForFunction(() => /Took back 1 website\./.test(document.getElementById('ec-note') ? document.getElementById('ec-note').textContent : ''));
  assert.deepEqual(calls('undoBrandWebsites').map((c) => c.args), [{}, {}, { confirm: true }]);
  assert.equal(await page.$('#ec-lastweb'), null);
  ok('Undo names the websites that go and the ones that stay before anything changes');

  // ---- 9. the one-page report ----
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('#ec-card [data-ec="report"]')]);
  await pop.waitForLoadState();
  const rep = flat(await pop.textContent('body'));
  assert.match(rep, /SB AGENCY · EMAIL COVERAGE\s*Where we stand on emails\s*November 18, 2026 · the 7 brands we’re not talking to \(6 more left out: in talks, a deal, or archived\)/);
  assert.match(rep, /3Have an email43% of brands · 2 thanks to Hunter/);
  assert.match(rep, /2Have a buyer’s email29% · partnerships, events, marketing or a founder/);
  assert.match(rep, /4No email yet2 with people to look up · 2 with nobody on file/);
  assert.match(rep, /By category/);
  assert.match(rep, /Since Nov 17/);
  assert.match(rep, /All73245?/);
  assert.match(rep, /Print \/ save as PDF/);
  assert.equal(await pop.$$eval('table', (t) => t.length), 2);
  await pop.close();
  ok('the report: the same numbers on one page, with the history and every category');

  // ---- 10. a phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { EC.open = 'noemail'; ecRender(); });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'the page scrolls sideways on a phone by ' + wide + 'px');
  assert.equal(await page.$$eval('#ec-card .ec-grid .su-tile', (t) => new Set(t.map((x) => Math.round(x.getBoundingClientRect().left))).size), 1);
  ok('on a phone the tiles stack and nothing runs off the side');

  // ---- 11. an error says so, with a way to try again ----
  await page.setViewportSize({ width: 1440, height: 900 });
  const real = H.emailCoverage;
  H.emailCoverage = () => { throw new Error('The database is busy'); };
  await page.evaluate(() => { EC.data = null; return ecLoad(); });
  assert.match(flat(await page.textContent('#ec-top')), /Couldn’t count them: The database is busy Try again/);
  H.emailCoverage = real;
  await page.click('#ec-top [data-ec="refresh"]');
  await page.waitForSelector('#ec-card .ec-grid');
  ok('a failed read says so and Try again brings the numbers back');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('\n' + n + ' checks passed');
  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
