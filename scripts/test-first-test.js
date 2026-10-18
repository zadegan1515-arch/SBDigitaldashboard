// scripts/test-first-test.js — the first message test on the page (Leo, Oct
// 18 2026: "which first message gets replies"; src/lib/first-test.ts).
// Drives public/app.html in Chromium against a fake /api/data:
//
//   1. On Zach's list a version A brand's card shows Leo's first message and
//      says "Test · version A"; a version B brand's card shows B for a man,
//      with For a man / For a woman — the woman's text on a click, and Copy
//      copies what's shown ((NAME) and [Name] both filled).
//   2. Messaged sends the version the card showed (A / B); a card someone
//      rewrote is out of the test (no label, no version).
//   3. Stopped: every card shows A, no label, no version.
//   4. Edit template has Test B · man / Test B · woman tabs, and saves them
//      as their own kinds.
//   5. Results: the First message test card (answered of judged, said no,
//      waiting, too few to tell, the messages) and Stop the test → confirm →
//      setFirstTest; no page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-first-test.js   (~6s)
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-first-test.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);
async function until(ok, what) {
  for (let i = 0; i < 100; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for ' + what);
}
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const S = { on: true, dm: {} };
const A_TPL = { subject: '', body: 'Hey (NAME), great to be connected. Would love to put something together with (BRAND).' };
const B_TPL = { subject: '', body: "(NAME) – what's up man! Would love to see if (BRAND) is interested." };
const BW_TPL = { subject: '', body: 'Hey [Name], great to meet you! Would love to see if [Brand] is interested.' };

const person = (targetId, name, brandId, brandName, extra) => Object.assign({
  targetId, status: 'accepted', contactId: 'c' + targetId, name, title: 'Marketing Manager', email: null, linkedinUrl: null,
  invitedAt: ago(14), acceptedAt: ago(10), repliedAt: null, dmSentAt: S.dm[targetId] || null, autoEmailedAt: null, emailReplyAt: null, autoSubject: null,
  handSubject: null, handBody: null, handNote: null, emailedAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
  handDm: null, draftId: 'd' + targetId, dmOwn: false, dm: null, final: null, firstSent: null,
}, extra || {});
const brand = (id, name, people) => ({ id, name, category: 'electrolytes', website: null, linkedinUrl: null, hold: null, people });

function zachTodo() {
  const v = (x) => (S.on ? x : 'A');
  const brands = [
    brand('bA', 'Alpha Water', [person('pA', 'Ann Able', 'bA', 'Alpha Water', { firstVersion: v('A') })]),
    brand('bB', 'Bravo Fizz', [
      person('pB', 'Ben Bright', 'bB', 'Bravo Fizz', { firstVersion: v('B') }),
      person('pO', 'Olive Own', 'bB', 'Bravo Fizz', { firstVersion: v('B'), dmOwn: true, dm: 'Olive, my own words for Bravo Fizz' }),
    ]),
  ].map((g) => ({ ...g, people: g.people.filter((p) => !S.dm[p.targetId]) })).filter((g) => g.people.length);
  return {
    template: { subject: 'SB × (BRAND)', body: 'Hi (NAME)' }, dmTemplate: { subject: '', body: 'Great to hear from you' },
    firstTemplate: A_TPL, firstBTemplate: B_TPL, firstBWTemplate: BW_TPL, firstTest: { on: S.on },
    finalTemplate: { subject: '', body: 'One last note' },
    brands, people: brands.reduce((n, g) => n + g.people.length, 0), noAddress: 0, held: [], done: [],
    doneDays: 30, dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7, calls: [],
  };
}

const cell = (key, sent, judged, answered, saidNo, waiting) => ({ key, sent, judged, answered, saidNo, waiting, rate: judged ? answered / judged : null, few: judged < 30 });
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo,
  handStep: (a) => { if (a.step === 'dm') S.dm[a.targetId] = a.on === false ? null : new Date().toISOString(); return { contactName: 'them' }; },
  saveHandTemplate: (a) => {
    const t = { firstB: B_TPL, firstBW: BW_TPL, first: A_TPL }[a.kind];
    if (t) t.body = a.body;
    return { subject: '', body: a.body, standIn: false, savedAt: new Date().toISOString(), savedBy: 'Leo' };
  },
  listReached: () => ({ brands: [], totals: { invited: 10, accepted: 4, replied: 1 } }),
  sentByDay: () => ({ days: [], cap: 30 }),
  outcomeTable: () => ({ few: 30, acceptAfterDays: 7, depth: { personRate: null, byTotal: [] } }),
  firstMessageTest: () => ({
    on: S.on, startedAt: ago(20), judgeDays: 10, few: 30,
    versions: [cell('A', 14, 12, 2, 0, 2), cell('B', 15, 11, 4, 1, 4)],
    texts: { A: A_TPL.body, B: B_TPL.body, BW: BW_TPL.body },
  }),
  setFirstTest: (a) => { S.on = a.on !== false; return { on: S.on }; },
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
  const dialogs = [];
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
  try {
    await page.goto(base + '/app.html');
    await page.waitForFunction(() => typeof window.loadDashboard === 'function');
    const item = (id) => '#zach-todo .zt-item[data-zt="' + id + '"]';
    const open = async (id) => {
      // After a tick the list opens the next person by itself: let it.
      await page.waitForSelector(item(id) + '.open', { timeout: 700 }).catch(() => {});
      if (!(await page.$(item(id) + '.open'))) await page.click(item(id) + ' .zt-row');
      await page.waitForSelector(item(id) + '.open .zt-comp [data-ztdm]');
    };
    const msg = (id) => page.$eval(item(id) + ' [data-ztdm]', (el) => el.value);
    const label = (id) => page.$eval(item(id) + ' .zt-mail', (el) => (el.querySelector('.zt-ver') || {}).textContent || '');
    await page.evaluate(() => loadDashboard());
    await page.waitForSelector(item('pB'));

    // 1. Version A, version B, For a woman, Copy ------------------------
    await open('pA');
    assert.equal(await msg('pA'), 'Hey Ann, great to be connected. Would love to put something together with Alpha Water.');
    assert.equal(await label('pA'), 'Test · version A');
    assert.equal(await page.$(item('pA') + ' [data-ztact="bgender"]'), null, 'no man / woman on version A');
    await open('pB');
    assert.equal(await label('pB'), 'Test · version B');
    assert.equal(await msg('pB'), "Ben – what's up man! Would love to see if Bravo Fizz is interested.", 'B for a man first, (NAME) filled');
    assert.equal(await page.getAttribute(item('pB') + ' [data-g="man"]', 'aria-pressed'), 'true');
    await page.click(item('pB') + ' [data-g="woman"]');
    await page.waitForFunction((s) => /great to meet you/.test(document.querySelector(s).value), item('pB') + ' [data-ztdm]');
    assert.equal(await msg('pB'), 'Hey Ben, great to meet you! Would love to see if Bravo Fizz is interested.', '[Name] / [Brand] filled too');
    assert.equal(await page.getAttribute(item('pB') + ' [data-g="woman"]', 'aria-pressed'), 'true');
    await page.click(item('pB') + ' [data-ztact="copydm"]');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hey Ben, great to meet you! Would love to see if Bravo Fizz is interested.');
    console.log('✓ 1. version A / B on the card, For a woman switches the text, Copy copies it');

    // 2. Messaged sends the version; a rewritten card is out ------------
    await page.click(item('pB') + ' [data-ztact="step"][data-step="dm"]');
    await until(() => all('handStep').length === 1, 'the B tick');
    assert.deepEqual(all('handStep')[0].args, { targetId: 'pB', step: 'dm', version: 'B' });
    await page.waitForFunction(() => !document.querySelector('#zach-todo .zt-item[data-zt="pB"].open'));
    await open('pA');
    await page.click(item('pA') + ' [data-ztact="step"][data-step="dm"]');
    await until(() => all('handStep').length === 2, 'the A tick');
    assert.deepEqual(all('handStep')[1].args, { targetId: 'pA', step: 'dm', version: 'A' });
    await open('pO');
    assert.equal(await label('pO'), '', 'a rewritten card says nothing about the test');
    assert.equal(await msg('pO'), 'Olive, my own words for Bravo Fizz');
    await page.click(item('pO') + ' [data-ztact="step"][data-step="dm"]');
    await until(() => all('handStep').length === 3, 'the own tick');
    assert.deepEqual(all('handStep')[2].args, { targetId: 'pO', step: 'dm' }, 'no version for a rewritten card');
    console.log('✓ 2. Messaged sends A / B; a rewritten card is out of the test');

    // 3. Stopped: A for everyone, no label, no version -----------------
    S.on = false; S.dm = {};
    await page.evaluate(() => loadDashboard());
    await page.waitForFunction(() => ZT && ZT.firstTest && ZT.firstTest.on === false);
    await page.waitForSelector(item('pB'));
    await open('pB');
    assert.equal(await label('pB'), '');
    assert.equal(await msg('pB'), 'Hey Ben, great to be connected. Would love to put something together with Bravo Fizz.', 'A for everyone');
    await page.click(item('pB') + ' [data-ztact="step"][data-step="dm"]');
    await until(() => all('handStep').length === 4, 'the stopped tick');
    assert.deepEqual(all('handStep')[3].args, { targetId: 'pB', step: 'dm' });
    console.log('✓ 3. stopped: everyone gets A, nothing recorded');

    // 4. The template editor's B tabs -----------------------------------
    S.on = true; S.dm = {};
    await page.evaluate(() => loadDashboard());
    await page.waitForFunction(() => ZT && ZT.firstTest && ZT.firstTest.on === true);
    await page.waitForSelector(item('pA'));
    await open('pA');
    await page.click(item('pA') + ' [data-ztact="tpl"][data-kind="first"]');
    await page.waitForSelector('#zt-scrim.open');
    assert.ok(await page.$('#zt-scrim [data-tpltab="firstB"]') && await page.$('#zt-scrim [data-tpltab="firstBW"]'), 'Test B · man / woman tabs');
    assert.match(await page.textContent('#zt-tbody-lbl'), /version A/);
    await page.click('#zt-scrim [data-tpltab="firstBW"]');
    assert.equal(await page.inputValue('#zt-tbody'), BW_TPL.body);
    assert.match(await page.textContent('#zt-prev-body'), /Hey Ann, great to meet you![\s\S]*Alpha Water/, 'the preview fills [Name] / [Brand]');
    await page.fill('#zt-tbody', 'Hey [Name], new B for a woman at [Brand].');
    await page.click('#zt-tsave');
    await until(() => all('saveHandTemplate').length === 1, 'the save');
    assert.deepEqual([all('saveHandTemplate')[0].args.kind, all('saveHandTemplate')[0].args.body], ['firstBW', 'Hey [Name], new B for a woman at [Brand].']);
    await page.waitForFunction(() => ZT.firstBWTemplate.body === 'Hey [Name], new B for a woman at [Brand].').catch(() => {});
    assert.equal(await page.evaluate(() => ZT.firstBWTemplate.body), 'Hey [Name], new B for a woman at [Brand].', 'the cards use it now');
    console.log('✓ 4. Edit template: Test B · man / woman tabs, previewed and saved as their own');

    // 5. Results: the card, Stop the test --------------------------------
    await page.evaluate(() => gotoView('reached'));
    await page.waitForSelector('#rc-firsttest .rcd tbody tr');
    const rows = await page.$$eval('#rc-firsttest .rcd tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepEqual(rows[0].slice(0, 6), ['Version A · your first message', '', '17%', '2 of 12 answered', '2 waiting', 'too few to tell']);
    assert.deepEqual(rows[1].slice(2, 4), ['36%', '4 of 11 answered · 1 said no']);
    assert.match(await page.textContent('#rc-firsttest .count-head'), /First message test\s*since [A-Z][a-z]{2} \d+/);
    assert.match(await page.textContent('#rc-firsttest .rcf-msgs'), /B · for a woman[\s\S]*new B for a woman/);
    await page.click('#rc-firsttest [data-rcft="stop"]');
    await until(() => all('setFirstTest').length === 1, 'Stop');
    assert.deepEqual(all('setFirstTest')[0].args, { on: false });
    assert.match(dialogs.slice(-1)[0], /Stop the first message test\?/);
    await page.waitForSelector('#rc-firsttest [data-rcft="start"]');
    assert.match(await page.textContent('#rc-firsttest .count-head'), /stopped/);
    assert.equal(await page.evaluate(() => ZT.firstTest.on), false, 'Zach’s list follows');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
    console.log('✓ 5. Results: the First message test card; Stop the test asks first');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
