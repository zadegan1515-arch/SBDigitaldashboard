// scripts/test-do-not-contact.js — "Doesn't want to continue" on Zach's list
// (Leo, Oct 15 2026: "some people respond but i want to make sure we dont
// reach out to them again"; the step asks: just this person, or the whole
// brand). Drives public/app.html in Chromium against a fake /api/data:
//
//   1. Home: the card's "Doesn't want to continue" asks Just <first> /
//      Everyone at <brand>; Cancel goes back. Just them = one handStep
//      (step declined, scope person): they leave the list, the others at the
//      brand stay; the Undo bar and the Done fold take it back.
//   2. Home, the whole brand: the first click previews (nothing written)
//      and names who stops and what's left as it is; Back goes back; Stop
//      sends the preview's expect; a stale answer is shown again, warned;
//      then everyone at the brand leaves the list, another brand stays.
//   3. Brand page: just them folds the card to one line with Undo and the
//      row's pill says so — in place (the page isn't read again).
//   4. Brand page of a brand that said it: the banner and its Undo (asks
//      first, then undoStopContact by brand), do-not-email / archive locked,
//      no → Queue or log buttons, the others' lines; phone width; no errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-do-not-contact.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-do-not-contact.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

// The fake server: who said no, and whether the whole brand did.
const S = { declined: {}, at: {}, brandStopped: null, sig: 'sig-1', staleOnce: false };
const NAMES = { t1: 'Alex Seamon', t2: 'Beth Baker', t9: 'Zoe Zhang' };

const person = (targetId, contactId, name, extra) => Object.assign({
  targetId, status: 'accepted', contactId, name, title: 'Marketing', email: null, linkedinUrl: null,
  invitedAt: ago(12), acceptedAt: ago(10), repliedAt: null, dmSentAt: null, autoEmailedAt: null, emailReplyAt: null, autoSubject: null,
  handSubject: null, handBody: null, handNote: null, emailedAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
  handDm: null, draftId: null, dmOwn: false, dm: null, final: null,
}, extra || {});

function zachTodo(a) {
  const brands = [];
  const alpha = [person('t1', 'c1', 'Alex Seamon'), person('t2', 'c2', 'Beth Baker')]
    .filter((p) => !S.declined[p.targetId] && !S.brandStopped);
  if (alpha.length) brands.push({ id: 'b1', name: 'Alpha Water', category: 'electrolytes', website: 'alphawater.com', linkedinUrl: null, hold: null, people: alpha });
  if (!a.brandId) brands.push({ id: 'b2', name: 'Bravo Soda', category: 'beverage', website: null, linkedinUrl: null, hold: null, people: [person('t9', 'c9', 'Zoe Zhang')] });
  const done = Object.keys(S.declined).map((id) => ({ targetId: id, brandId: 'b1', brandName: 'Alpha Water', name: NAMES[id], kind: 'declined', scope: S.declined[id], at: S.at[id] }));
  return {
    template: { subject: 'SB × (BRAND)', body: 'Hi (NAME)' }, dmTemplate: { subject: '', body: 'Great to hear from you' },
    firstTemplate: { subject: '', body: 'Thanks for connecting, (NAME)!' }, finalTemplate: { subject: '', body: 'One last note' },
    brands, people: brands.reduce((n, g) => n + g.people.length, 0), noAddress: 0, held: [], done,
    doneDays: 30, dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7,
    calls: S.brandStopped ? [] : [{ targetId: 't3', brandId: 'b1', brandName: 'Alpha Water', name: 'Carl Cole', title: 'VP Marketing', callAt: ahead(3) }],
    ...(a.brandId ? {
      declined: Object.keys(S.declined).map((id) => ({ targetId: id, name: NAMES[id], at: S.at[id], scope: S.declined[id] })),
      brandStopped: S.brandStopped ? { at: S.brandStopped, by: 'leo@example.com', targetId: 't1', name: 'Alex Seamon' } : null,
    } : {}),
  };
}

const PREVIEW = {
  scope: 'brand', contactName: 'Alex Seamon', brandName: 'Alpha Water',
  others: ['Beth Baker'], today: ['Dana Dunn'], waiting: ['Ed Ellis'], days: ['Thu, Oct 22'],
  calls: [{ name: 'Carl Cole', day: 'Mon, Oct 19' }], invites: ['Fay Fox'], deals: ['Alpha Water × Spring tour'], drafts: 2,
  archived: false, doNotEmail: false,
};
function handStep(a) {
  if (a.step !== 'declined') return { contactName: NAMES[a.targetId] };
  if (a.on === false) {
    const scope = S.declined[a.targetId];
    delete S.declined[a.targetId];
    if (scope === 'brand') S.brandStopped = null;
    return { ok: true, scope, contactName: NAMES[a.targetId], brandName: 'Alpha Water', back: scope === 'brand' ? ['Dana Dunn'] : [], stays: [] };
  }
  if (a.scope === 'person') { S.declined[a.targetId] = 'person'; S.at[a.targetId] = new Date().toISOString(); return { ok: true, scope: 'person', contactName: NAMES[a.targetId], brandName: 'Alpha Water' }; }
  if (a.preview) return { preview: true, ...PREVIEW, expect: S.sig };
  if (a.expect !== S.sig) return { stale: true, ...PREVIEW, others: ['Beth Baker', 'Gus Gray'], expect: S.sig };
  if (S.staleOnce) { S.staleOnce = false; S.sig = 'sig-2'; return { stale: true, ...PREVIEW, others: ['Beth Baker', 'Gus Gray'], expect: S.sig }; }
  S.declined[a.targetId] = 'brand'; S.at[a.targetId] = new Date().toISOString(); S.brandStopped = S.at[a.targetId];
  return { ok: true, ...PREVIEW, expect: S.sig, at: S.brandStopped };
}

const target = (id, contactId, status) => ({ id, contactId, status, sentAt: ago(12), emails: [], drafts: [], shelved: false, contact: { name: '' } });
function getBrand() {
  const b = {
    id: 'b1', name: 'Alpha Water', category: 'electrolytes', tier: 'growth', aka: '', about: 'Hydration drinks', topProducts: '',
    website: 'alphawater.com', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null,
    doNotEmail: !!S.brandStopped, passedAt: S.brandStopped, stoppedAt: S.brandStopped, workPeople: null, partner: null, kind: null,
    contacts: [
      { id: 'c1', name: 'Alex Seamon', title: 'Brand Activation Lead', isDecisionMaker: true, source: 'linkedin', doNotContactAt: S.declined.t1 ? S.at.t1 : null },
      { id: 'c2', name: 'Beth Baker', title: 'Director, Marketing', isDecisionMaker: true, source: 'linkedin', doNotContactAt: S.declined.t2 ? S.at.t2 : null },
      { id: 'c4', name: 'Dana Dunn', title: 'Marketing Manager', isDecisionMaker: false, source: 'linkedin' },
    ],
    targets: [target('t1', 'c1', 'accepted'), target('t2', 'c2', 'accepted'), Object.assign(target('t4', 'c4', 'queued'), { sentAt: null, shelved: !!S.brandStopped })],
    shows: [], deals: [], documents: [],
  };
  b.targets.forEach((t) => {
    t.contact = { name: b.contacts.find((c) => c.id === t.contactId).name };
    t.handDeclinedAt = S.declined[t.id] ? S.at[t.id] : null;
  });
  return { brand: b, events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [], boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [] };
}

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo, getBrand, handStep, brandPlanLine: () => ({}),
  undoStopContact: (a) => { assert.equal(a.brandId, 'b1'); S.brandStopped = null; delete S.declined.t1; return { ok: true, scope: 'brand', brandName: 'Alpha Water', contactName: 'Alex Seamon', back: ['Dana Dunn', 'back on Thu, Oct 22'], stays: [] }; },
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
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
  await page.waitForFunction(() => typeof window.loadDashboard === 'function');
  const home = (id) => '#zach-todo .zt-item[data-zt="' + id + '"]';
  const onHome = (id) => page.$(home(id));
  const openHome = async (id) => {
    if (!(await page.$(home(id) + '.open'))) await page.click(home(id) + ' .zt-row');
    await page.waitForSelector(home(id) + '.open .zt-comp');
  };

  // 1 ---------------------------------------------------------------
  await page.evaluate(() => loadDashboard());
  await page.waitForSelector(home('t1'));
  await openHome('t1');
  await page.click(home('t1') + ' [data-ztnode="declined"]');
  await page.waitForSelector(home('t1') + ' [data-ztact="decline"][data-scope="person"]');
  const picks = await page.textContent(home('t1') + ' .zt-panel');
  assert.match(picks, /They don’t want to continue/);
  assert.match(picks, /Just Alex[\s\S]*Others at Alpha Water stay as they are/);
  assert.match(picks, /Everyone at Alpha Water[\s\S]*Nobody there is contacted again/);
  await page.click(home('t1') + ' [data-ztact="declinecancel"]');
  await page.waitForFunction((s) => !document.querySelector(s + ' [data-ztact="decline"]'), home('t1'));
  assert.equal(all('handStep').length, 0, 'opening the choice writes nothing');
  await page.click(home('t1') + ' [data-ztnode="declined"]');
  await page.click(home('t1') + ' [data-ztact="decline"][data-scope="person"]');
  await page.waitForFunction((s) => !document.querySelector(s), home('t1'));
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't1', step: 'declined', scope: 'person' });
  assert.ok(await onHome('t2'), 'the others at the brand stay on the list');
  assert.match(await page.textContent('#zt-undo-text'), /Doesn’t want to continue: Alex Seamon/);
  await page.click('#zt-undo-btn');
  await page.waitForSelector(home('t1'));
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't1', step: 'declined', on: false });
  // Again, then from the Done fold.
  await openHome('t1');
  await page.click(home('t1') + ' [data-ztnode="declined"]');
  await page.click(home('t1') + ' [data-ztact="decline"][data-scope="person"]');
  await page.waitForFunction((s) => !document.querySelector(s), home('t1'));
  await page.evaluate(() => renderZachTodo());
  await page.waitForFunction(() => /Doesn’t want to continue · /.test((document.querySelector('#zt-done') || {}).textContent || ''));
  await page.evaluate(() => { document.getElementById('zt-done').open = true; });
  await page.click('#zt-done [data-ztundo="t1"][data-kind="declined"]');
  await page.waitForSelector(home('t1'));
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't1', step: 'declined', on: false });
  console.log('✓ 1. Home: Just them takes one person off (the brand’s others stay); the Undo bar and the Done fold bring them back');

  // 2 ---------------------------------------------------------------
  const before = all('handStep').length;
  await openHome('t1');
  await page.click(home('t1') + ' [data-ztnode="declined"]');
  await page.click(home('t1') + ' [data-ztact="decline"][data-scope="brand"]');
  await page.waitForSelector(home('t1') + ' [data-ztact="declinebrand"]');
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't1', step: 'declined', scope: 'brand', preview: true });
  const pv = await page.textContent(home('t1') + ' .zt-panel');
  assert.match(pv, /Stop everyone at Alpha Water\?/);
  assert.match(pv, /Off Zach’s list with Alex: Beth Baker/);
  assert.match(pv, /Out of today’s LinkedIn list: Dana Dunn/);
  assert.match(pv, /Out of the queue \(never contacted\): Ed Ellis/);
  assert.match(pv, /Off the Schedule: Thu, Oct 22/);
  assert.match(pv, /Archived and marked do not email/);
  assert.match(pv, /Left as they are:[\s\S]*Calls booked: Carl Cole \(Mon, Oct 19\)[\s\S]*Invites still out on LinkedIn: Fay Fox[\s\S]*Open deals: Alpha Water × Spring tour[\s\S]*2 email drafts won’t send/);
  assert.ok(await onHome('t2'), 'a preview takes nobody off');
  await page.click(home('t1') + ' [data-ztact="declineback"]');
  await page.waitForSelector(home('t1') + ' [data-ztact="decline"][data-scope="brand"]');
  await page.click(home('t1') + ' [data-ztact="decline"][data-scope="brand"]');
  await page.waitForSelector(home('t1') + ' [data-ztact="declinebrand"]');
  S.staleOnce = true;
  await page.click(home('t1') + ' [data-ztact="declinebrand"]');
  await page.waitForFunction((s) => /Something changed at Alpha Water/.test(document.querySelector(s + ' .zt-panel').textContent), home('t1'));
  assert.equal(all('handStep').slice(-1)[0].args.expect, 'sig-1', 'Stop sends the preview’s expect');
  assert.match(await page.textContent(home('t1') + ' .zt-panel'), /Beth Baker, Gus Gray/, 'the stale answer is shown again');
  assert.ok(await onHome('t2'), 'a stale answer takes nobody off');
  await page.click(home('t1') + ' [data-ztact="declinebrand"]');
  await page.waitForFunction(() => !document.querySelector('#zach-todo .zt-item[data-zt="t1"]') && !document.querySelector('#zach-todo .zt-item[data-zt="t2"]'));
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't1', step: 'declined', scope: 'brand', expect: 'sig-2' });
  assert.ok(await onHome('t9'), 'another brand stays');
  assert.match(await page.textContent('#zt-undo-text'), /Doesn’t want to continue: everyone at Alpha Water/);
  await page.evaluate(() => renderZachTodo());
  await page.waitForFunction(() => /Doesn’t want to continue \(whole brand\) · /.test((document.querySelector('#zt-done') || {}).textContent || ''));
  assert.ok(!(await page.$('#zt-calls')) || !/Carl Cole/.test(await page.textContent('#zt-calls')), 'the brand’s call is off Calls booked');
  assert.ok(all('handStep').length - before >= 3);
  console.log('✓ 2. Home, the whole brand: a preview first (named, left-as-is too), Back, a stale answer shown again, then the brand leaves the list');

  // 4 (the stopped brand) -------------------------------------------
  await page.evaluate(() => loadBrand('b1'));
  await page.waitForSelector('#b-stopped');
  assert.match(await page.textContent('#b-stopped'), /They said they don’t want to continue[\s\S]*nobody at Alpha Water is contacted again/);
  assert.ok(await page.$eval('#b-dne', (el) => el.disabled), 'do not email is locked while it stands');
  assert.ok(await page.$eval('#b-pass', (el) => el.disabled), 'archive is locked while it stands');
  assert.equal(await page.$('#brand-body [data-cqueue]'), null, 'no → Queue for anyone at the brand');
  assert.equal(await page.$('#brand-body [data-clog]'), null, 'no invite / accept logging');
  assert.equal(await page.$('#brand-body [data-bract]'), null, 'nothing to log on the Outreach rows');
  await page.waitForFunction(() => /Zach’s list: Doesn’t want to continue — nobody at the brand is contacted · Undo/.test(document.querySelector('#brand-body [data-bzt="t1"]').textContent));
  assert.match(await page.textContent('#brand-body [data-bzt="t2"]'), /Zach’s list: off — the brand said they don’t want to continue$/);
  assert.match(await page.textContent('#brand-body [data-opill="t1"]'), /doesn’t want to continue/);
  const reads = all('getBrand').length;
  await page.click('#b-stop-undo');
  await page.waitForFunction(() => !document.querySelector('#b-stopped'));
  assert.match(dialogs.slice(-1)[0] || '', /Reach out to Alpha Water again\?/, 'the banner’s Undo asks first');
  assert.ok(all('undoStopContact').length === 1 && all('getBrand').length > reads, 'undoStopContact by brand, then the page reads it again');
  await page.waitForSelector('#brand-body [data-bzt="t1"] .zt-item');
  assert.ok(await page.$('#brand-body [data-cqueue="c4"]'), '→ Queue is back');
  console.log('✓ 4. a brand that said it: the banner (Undo asks, then undoStopContact by brand), locked toggles, nothing to queue or log');

  // 3 ---------------------------------------------------------------
  await page.click('#brand-body [data-bzt="t2"] .zt-row');
  await page.waitForSelector('#brand-body [data-bzt="t2"] .zt-item.open .zt-comp');
  const r2 = all('getBrand').length;
  await page.click('#brand-body [data-bzt="t2"] [data-ztnode="declined"]');
  await page.click('#brand-body [data-bzt="t2"] [data-ztact="decline"][data-scope="person"]');
  await page.waitForFunction(() => /Zach’s list: Doesn’t want to continue — never contacted again · Undo/.test(document.querySelector('#brand-body [data-bzt="t2"]').textContent));
  assert.equal(await page.$eval('#brand-body [data-bzt="t2"]', (el) => el.previousElementSibling.querySelector('[data-cstate]').textContent), 'doesn’t want to continue');
  assert.match(await page.textContent('#brand-body [data-ostep="t2"]'), /Doesn’t want to continue/);
  assert.equal(all('getBrand').length, r2, 'in place: the page isn’t read again');
  assert.ok(await page.$('#brand-body [data-bzt="t1"] .zt-item'), 'the others keep their cards');
  await page.click('#brand-body [data-bzt="t2"] [data-bztundo]');
  await page.waitForSelector('#brand-body [data-bzt="t2"] .zt-item');
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't2', step: 'declined', on: false });
  console.log('✓ 3. brand page: just them folds the card to one line with Undo, the pill says so, in place');

  await page.setViewportSize({ width: 390, height: 800 });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('✓ 5. phone width; no page errors');

  await browser.close();
  server.close();
  console.log('doesn’t want to continue (page): all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
