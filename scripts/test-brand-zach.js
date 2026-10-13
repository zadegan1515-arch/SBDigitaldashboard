// scripts/test-brand-zach.js — Zach's list on the brand page (Leo, Oct 13
// 2026: "you should be able to do the steps after they accept an invite on
// a company's card"). Drives public/app.html in Chromium against a fake
// /api/data:
//
//   1. A brand page asks zachTodo for that brand only; everyone who
//      accepted gets the card under their row (not the queued person); a
//      finished one (call booked) is one line with Undo.
//   2. The card opens with the first LinkedIn message from the template;
//      its tick is handStep, the card stays on the next step.
//   3. "They replied" turns the row's pill from accepted to replied and
//      reads the page again (the Outreach row follows); an address typed
//      in the card's To box reaches the person's ✎ Edit form; ← Back a
//      step takes the ticks back. Copy DM on the Outreach row copies the
//      card's message.
//   4. Not needed folds the card to one line; its Undo brings it back.
//   5. Home's list (the same people) still ticks on Home while the brand
//      page's copy is in the page too; back on the brand page it shows
//      the new step; phone width; no page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-brand-zach.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-brand-zach.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);
// Waits (in Node) until the fake server has seen what we expect.
async function until(ok, what) {
  for (let i = 0; i < 100; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for ' + what);
}
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

// Who's where on the fake server.
const S = { skipped: false, replied: false, wants: false, dm: {} };
const target = (id, contactId, status) => ({ id, contactId, status, sentAt: ago(12), emails: [], drafts: [], shelved: false, contact: { name: '' } });
const BRAND = {
  brand: {
    id: 'b1', name: 'Alpha Water', category: 'electrolytes', tier: 'growth', aka: '', about: 'Hydration drinks', topProducts: '',
    website: 'alphawater.com', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null,
    doNotEmail: false, passedAt: null, workPeople: null, partner: null, kind: null,
    contacts: [
      { id: 'c1', name: 'Alex Seamon', title: 'Brand Activation Lead', isDecisionMaker: true, source: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/alex' },
      { id: 'c2', name: 'Beth Baker', title: 'Director, Marketing', isDecisionMaker: true, source: 'linkedin' },
      { id: 'c3', name: 'Carl Cole', title: 'VP Marketing', isDecisionMaker: true, source: 'linkedin' },
      { id: 'c4', name: 'Dana Dunn', title: 'Marketing Manager', isDecisionMaker: false, source: 'linkedin' },
    ],
    targets: [target('t1', 'c1', 'accepted'), target('t2', 'c2', 'accepted'), target('t3', 'c3', 'replied'),
      Object.assign(target('t4', 'c4', 'queued'), { sentAt: null })],
    shows: [], deals: [], documents: [],
  },
  events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [],
  boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [],
};
BRAND.brand.targets.forEach((t) => { t.contact = { name: BRAND.brand.contacts.find((c) => c.id === t.contactId).name }; });
// The queue's own first DM, older than Leo's template.
BRAND.brand.targets[0].drafts = [{ id: 'd1', variant: 'man', firstMessage: 'OLD queue text', connectionNote: 'Hi Alex', createdAt: ago(12) }];
// The page reads the brand as the fake server has it now.
function getBrand() {
  const t1 = BRAND.brand.targets[0];
  t1.status = S.replied || S.wants ? 'replied' : 'accepted';
  t1.dmSentAt = S.dm.t1 || null;
  return BRAND;
}

const person = (targetId, contactId, name, extra) => Object.assign({
  targetId, status: 'accepted', contactId, name, title: 'Marketing', email: null, linkedinUrl: null,
  invitedAt: ago(12), acceptedAt: ago(10), repliedAt: null, dmSentAt: null, autoEmailedAt: null, emailReplyAt: null, autoSubject: null,
  handSubject: null, handBody: null, handNote: null, emailedAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
  handDm: null, draftId: null, dmOwn: false, dm: null, final: null,
}, extra || {});
const TPL = { subject: '', body: 'Thanks for connecting, (NAME)! What is (BRAND) focused on with college this year?' };

function zachTodo(a) {
  const mine = a.brandId === 'b1' || !a.brandId;   // Home: every brand
  const people = [];
  if (mine) {
    people.push(person('t1', 'c1', 'Alex Seamon', { dmSentAt: S.dm.t1 || null, status: S.replied || S.wants ? 'replied' : 'accepted',
      repliedAt: S.replied || S.wants ? ago(0) : null, wantsEmailAt: S.wants ? ago(0) : null }));
    if (!S.skipped) people.push(person('t2', 'c2', 'Beth Baker', { dmSentAt: S.dm.t2 || null }));
    // On the list but not one of the page's rows (another contact at the brand).
    people.push(person('t5', 'c5', 'Eve Elm'));
  }
  return {
    template: { subject: 'SB × (BRAND)', body: 'Hi (NAME)' }, dmTemplate: { subject: '', body: 'Great to hear from you' },
    firstTemplate: TPL, finalTemplate: { subject: '', body: 'One last note' },
    brands: people.length ? [{ id: 'b1', name: 'Alpha Water', category: 'electrolytes', website: 'alphawater.com', linkedinUrl: null, hold: null, people }] : [],
    people: people.length, noAddress: 0, held: [],
    done: mine && S.skipped ? [{ targetId: 't2', brandId: 'b1', brandName: 'Alpha Water', name: 'Beth Baker', kind: 'skipped', at: ago(0) }] : [],
    doneDays: 30, dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7,
    calls: mine ? [{ targetId: 't3', brandId: 'b1', brandName: 'Alpha Water', name: 'Carl Cole', title: 'VP Marketing', callAt: ahead(3) }] : [],
  };
}

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo,
  getBrand,
  setHandTo: (a) => ({ email: a.email, contactName: 'Alex Seamon', replaced: null, contactId: 'c1', notes: null }),
  brandPlanLine: () => ({}),
  handStep: (a) => {
    if (a.step === 'skip') S.skipped = a.on !== false;
    if (a.step === 'replied') S.replied = a.on !== false;
    if (a.step === 'wantsEmail') { S.wants = a.on !== false; if (a.on !== false) S.replied = true; }
    if (a.step === 'dm') S.dm[a.targetId] = a.on === false ? null : new Date().toISOString();
    return { contactName: a.targetId === 't1' ? 'Alex Seamon' : 'Beth Baker' };
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
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
      // A slow Home read: answered as the server had it when asked.
      if (fn === 'zachTodo' && !(args || {}).brandId && S.slowHome) await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadBrand === 'function');

  // 1 ---------------------------------------------------------------
  await page.evaluate(() => loadBrand('b1'));
  await page.waitForSelector('#brand-body .b-zt .zt-item[data-zt="t1"]');
  assert.ok(all('zachTodo').some((c) => c.args.brandId === 'b1'), 'asks for this brand only');
  const slots = await page.$$eval('#brand-body [data-bzt]', (els) => els.map((e) => e.getAttribute('data-bzt')));
  assert.deepEqual(slots, ['t1', 't2', 't3'], 'a card or line under everyone who accepted, none under the queued person');
  const slotAfter = await page.$eval('#brand-body [data-bzt="t1"]', (el) => el.previousElementSibling.textContent);
  assert.match(slotAfter, /Alex Seamon/, 'the card sits right under their own row');
  assert.match(await page.textContent('#brand-body [data-bzt="t1"] .zt-row'), /Zach’s list[\s\S]*Text back on LinkedIn/);
  assert.match(await page.textContent('#brand-body [data-bzt="t3"]'), /Zach’s list: Call scheduled for [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ · Undo/);
  console.log('✓ 1. the brand page shows Zach’s list under each accepted person; a booked call is one line');

  // 2 ---------------------------------------------------------------
  await page.click('#brand-body [data-bzt="t1"] .zt-row');
  await page.waitForSelector('#brand-body [data-bzt="t1"] .zt-item.open .zt-comp');
  const msg = await page.$eval('#brand-body [data-bzt="t1"] [data-ztdm]', (el) => el.value);
  assert.equal(msg, 'Thanks for connecting, Alex! What is Alpha Water focused on with college this year?');
  await page.click('#brand-body [data-bcopy="t1"][data-variant="dm"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), msg, 'the Outreach row’s Copy DM copies the card’s message');
  await page.click('#brand-body [data-bzt="t1"] [data-ztact="step"][data-step="dm"]');
  await page.waitForFunction(() => /Waiting on reply/.test(document.querySelector('#brand-body [data-bzt="t1"] .zt-row').textContent));
  assert.deepEqual(all('handStep').map((c) => c.args), [{ targetId: 't1', step: 'dm' }]);
  assert.ok(await page.$('#brand-body [data-bzt="t1"] .zt-item.open'), 'the card stays open on its next step');
  console.log('✓ 2. the card opens with the first message; its tick is handStep and it moves on');

  // 3 ---------------------------------------------------------------
  const pill = '#brand-body [data-bzt="t1"]';
  const rowPill = () => page.$eval(pill, (el) => el.previousElementSibling.querySelector('[data-cstate]').textContent);
  assert.equal(await rowPill(), 'LinkedIn · accepted');
  let reads = all('getBrand').length;
  await page.click('#brand-body [data-bzt="t1"] [data-ztact="step"][data-step="replied"]');
  await page.waitForFunction((s) => /^replied/.test(document.querySelector(s).previousElementSibling.querySelector('[data-cstate]').textContent), pill);
  assert.match(await page.textContent('#brand-body [data-bzt="t1"] .zt-row'), /Replied: email or LinkedIn\?/);
  await page.waitForFunction(() => /Replied ✓/.test(document.querySelector('#brand-body [data-ostep="t1"]').textContent));
  assert.match(await page.textContent('#brand-body [data-opill="t1"]'), /^replied/, 'the Outreach row’s pill follows');
  assert.equal(all('getBrand').length, reads, 'in place: the page isn’t read again (nobody typing gets cut off)');
  assert.ok(await page.$('#brand-body [data-bzt="t1"] .zt-item.open'), 'the card stays open');
  // Email path: the To box; the address reaches ✎ Edit.
  await page.click('#brand-body [data-bzt="t1"] [data-ztnode="wantEmail"]');
  await page.waitForSelector('#brand-body [data-bzt="t1"] [data-ztto]');
  await page.focus('#brand-body [data-bzt="t1"] [data-ztto]');
  await page.keyboard.type('alex@alphawater.com', { delay: 40 });
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-ztto')), true, 'typing in To is never cut off');
  await page.press('#brand-body [data-bzt="t1"] [data-ztto]', 'Tab');
  await page.waitForFunction(() => CURRENT_BRAND.brand.contacts[0].email === 'alex@alphawater.com');
  assert.deepEqual(all('setHandTo').slice(-1)[0].args, { targetId: 't1', email: 'alex@alphawater.com' });
  await page.click('#brand-body [data-cedit="c1"]');
  await page.waitForSelector('#nc-email');
  assert.equal(await page.inputValue('#nc-email'), 'alex@alphawater.com', 'the Edit form shows the address the card saved');
  await page.click('#nc-cancel');
  // Back twice: the email pick, then the reply.
  for (let i = 0; i < 2; i++) {
    const before = all('handStep').length;
    await page.click('#brand-body [data-bzt="t1"] [data-ztact="back"]');
    await until(() => all('handStep').length > before, 'Back a step');
    await page.waitForTimeout(200);
  }
  await page.waitForFunction((s) => document.querySelector(s).previousElementSibling.querySelector('[data-cstate]').textContent === 'LinkedIn · accepted', pill);
  assert.deepEqual(all('handStep').slice(-2).map((c) => [c.args.step, c.args.on]), [['wantsEmail', false], ['replied', false]]);
  await page.waitForFunction(() => /Accepted ✓/.test(document.querySelector('#brand-body [data-ostep="t1"]').textContent));
  console.log('✓ 3. They replied turns the pill and the Outreach row; the To address reaches ✎ Edit; ← Back a step takes them back');

  // 4 ---------------------------------------------------------------
  await page.click('#brand-body [data-bzt="t2"] .zt-row');
  await page.waitForSelector('#brand-body [data-bzt="t2"] .zt-item.open .zt-comp');
  await page.click('#brand-body [data-bzt="t2"] [data-ztact="step"][data-step="skip"]');
  await page.waitForFunction(() => /Zach’s list: Not needed · Undo/.test(document.querySelector('#brand-body [data-bzt="t2"]').textContent));
  assert.ok(!(await page.$('#brand-body [data-bzt="t2"] .zt-item')), 'the card folds to one line');
  const n = all('zachTodo').length;
  await page.click('#brand-body [data-bzt="t2"] [data-bztundo]');
  await page.waitForSelector('#brand-body [data-bzt="t2"] .zt-item');
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't2', step: 'skip', on: false });
  assert.ok(all('zachTodo').slice(n).some((c) => c.args.brandId === 'b1'), 'Undo reads the brand’s cards again');
  console.log('✓ 4. Not needed folds the card to one line; Undo brings it back');

  // 4b: Home's list read going out before a tick here, landing after it,
  // doesn't undo the tick.
  S.slowHome = true;
  await page.evaluate(() => { renderZachTodo(); });
  await page.click('#brand-body [data-bzt="t2"] [data-ztact="step"][data-step="dm"]').catch(async () => {
    await page.click('#brand-body [data-bzt="t2"] .zt-row');
    await page.click('#brand-body [data-bzt="t2"] [data-ztact="step"][data-step="dm"]');
  });
  await until(() => all('handStep').slice(-1)[0].args.targetId === 't2' && all('handStep').slice(-1)[0].args.step === 'dm', 'the tick');
  await page.waitForTimeout(1800);   // the slow Home read lands
  S.slowHome = false;
  assert.ok(await page.evaluate(() => !!ZT_BY_ID.t2.dmSentAt), 'the tick stands after an older read lands');
  assert.match(await page.textContent('#brand-body [data-bzt="t2"] .zt-row'), /Waiting on reply/);
  S.dm.t2 = null;   // as it was, for Home below
  console.log('✓ 4b. an older read landing after a tick doesn’t undo it');

  // 5 ---------------------------------------------------------------
  await page.evaluate(() => loadDashboard());
  await page.waitForSelector('#zach-todo .zt-item[data-zt="t2"]');
  // Home's rows keep each person's name (the second at a brand too).
  const homeWho = await page.$$eval('#zach-todo .zt-item .zt-who b', (els) => els.map((e) => e.textContent));
  assert.ok(homeWho.length >= 1 && homeWho.every((w) => w !== 'Zach’s list'), 'Home names every person: ' + homeWho.join(', '));
  // The card left open on the brand page is the open one on Home too.
  if (!(await page.$('#zach-todo .zt-item[data-zt="t2"].open'))) await page.click('#zach-todo .zt-item[data-zt="t2"] .zt-row');
  await page.waitForSelector('#zach-todo .zt-item[data-zt="t2"].open .zt-comp');
  await page.click('#zach-todo .zt-item[data-zt="t2"] [data-ztact="step"][data-step="dm"]');
  await page.waitForFunction(() => !document.querySelector('#zach-todo .zt-item[data-zt="t2"]'));
  assert.deepEqual(all('handStep').slice(-1)[0].args, { targetId: 't2', step: 'dm' });
  await page.evaluate(() => loadBrand('b1'));
  await page.waitForFunction(() => /Waiting on reply/.test((document.querySelector('#brand-body [data-bzt="t2"] .zt-row') || {}).textContent || ''));
  await page.setViewportSize({ width: 390, height: 800 });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('✓ 5. a tick on Home still works with the brand page’s copy in the page; back on the brand it shows; phone width; no errors');

  await browser.close();
  server.close();
  console.log('brand page Zach’s list: all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
