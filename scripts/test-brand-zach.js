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
//   3. "They replied" turns the row's pill from accepted to replied;
//      ← Back a step takes the last tick back.
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
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

// Who's where on the fake server.
const S = { skipped: false, replied: false, dm: {} };
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
    people.push(person('t1', 'c1', 'Alex Seamon', { dmSentAt: S.dm.t1 || null, status: S.replied ? 'replied' : 'accepted', repliedAt: S.replied ? ago(0) : null }));
    if (!S.skipped) people.push(person('t2', 'c2', 'Beth Baker', { dmSentAt: S.dm.t2 || null }));
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
  getBrand: () => BRAND,
  brandPlanLine: () => ({}),
  handStep: (a) => {
    if (a.step === 'skip') S.skipped = a.on !== false;
    if (a.step === 'replied') S.replied = a.on !== false;
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
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
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
  await page.click('#brand-body [data-bzt="t1"] [data-ztact="step"][data-step="dm"]');
  await page.waitForFunction(() => /Waiting on reply/.test(document.querySelector('#brand-body [data-bzt="t1"] .zt-row').textContent));
  assert.deepEqual(all('handStep').map((c) => c.args), [{ targetId: 't1', step: 'dm' }]);
  assert.ok(await page.$('#brand-body [data-bzt="t1"] .zt-item.open'), 'the card stays open on its next step');
  console.log('✓ 2. the card opens with the first message; its tick is handStep and it moves on');

  // 3 ---------------------------------------------------------------
  const pill = '#brand-body [data-bzt="t1"]';
  const rowPill = () => page.$eval(pill, (el) => el.previousElementSibling.querySelector('[data-cstate]').textContent);
  assert.equal(await rowPill(), 'LinkedIn · accepted');
  await page.click('#brand-body [data-bzt="t1"] [data-ztact="step"][data-step="replied"]');
  await page.waitForFunction((s) => /^replied/.test(document.querySelector(s).previousElementSibling.querySelector('[data-cstate]').textContent), pill);
  assert.match(await page.textContent('#brand-body [data-bzt="t1"] .zt-row'), /Replied: email or LinkedIn\?/);
  await page.click('#brand-body [data-bzt="t1"] [data-ztact="back"]');
  await page.waitForFunction((s) => document.querySelector(s).previousElementSibling.querySelector('[data-cstate]').textContent === 'LinkedIn · accepted', pill);
  assert.deepEqual(all('handStep').slice(-2).map((c) => [c.args.step, c.args.on]), [['replied', undefined], ['replied', false]]);
  console.log('✓ 3. They replied turns the row’s pill to replied; ← Back a step takes it back');

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

  // 5 ---------------------------------------------------------------
  await page.evaluate(() => loadDashboard());
  await page.waitForSelector('#zach-todo .zt-item[data-zt="t2"]');
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
