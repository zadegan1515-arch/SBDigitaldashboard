// scripts/test-first-message.js — the first LinkedIn message ("Text them on
// LinkedIn") is Leo's LinkedIn DM (Oct 21 2026: "make the text back on
// linkedin the linkedin dm not the other stuff" — one message for everyone,
// no man / woman). Drives public/app.html in Chromium against a fake
// /api/data:
//
//   1. On Zach's list every card's first message is the LinkedIn DM, filled
//      ((NAME) / [Name] both), with no For a man / For a woman, and Copy
//      copies what's shown. No "version" anywhere.
//   2. Messaged is a plain tick; a card someone rewrote shows its own words.
//   3. Edit template: Email / LinkedIn DM / Final reach-out (no first-message
//      tabs); the card's button opens the LinkedIn DM, saved as kind dm, and
//      the cards follow it.
//   4. Results: They accepted's one Copy DM copies the LinkedIn DM filled for
//      that person (the saved one, not an old one); no page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-first-message.js   (~6s)
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-first-message.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);
async function until(ok, what) {
  for (let i = 0; i < 100; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for ' + what);
}
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const S = { dm: {} };
const DM_TPL = { subject: '', body: 'Hey (Name), great to be connected. Would love to put something together with [Brand].' };
// The old man / woman messages: never shown any more.
const M_TPL = { subject: '', body: "(NAME) – what's up man! Would love to see if (BRAND) is interested." };
const W_TPL = { subject: '', body: 'Hey [Name], great to meet you! Would love to see if [Brand] is interested.' };

const person = (targetId, name, extra) => Object.assign({
  targetId, status: 'accepted', contactId: 'c' + targetId, name, title: 'Marketing Manager', email: null, linkedinUrl: null,
  invitedAt: ago(14), acceptedAt: ago(10), repliedAt: null, dmSentAt: S.dm[targetId] || null, autoEmailedAt: null, emailReplyAt: null, autoSubject: null,
  handSubject: null, handBody: null, handNote: null, emailedAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
  handDm: null, draftId: 'd' + targetId, dmOwn: false, dm: null, final: null,
}, extra || {});

function zachTodo() {
  const brands = [
    { id: 'bA', name: 'Alpha Water', people: [person('pA', 'Ann Able')] },
    { id: 'bB', name: 'Bravo Fizz', people: [person('pB', 'Ben Bright'), person('pO', 'Olive Own', { dmOwn: true, dm: 'Olive, my own words for Bravo Fizz' })] },
  ].map((g) => ({ category: 'electrolytes', website: null, linkedinUrl: null, hold: null, ...g, people: g.people.filter((p) => !S.dm[p.targetId]) }))
    .filter((g) => g.people.length);
  return {
    template: { subject: 'SB × (BRAND)', body: 'Hi (NAME)' }, dmTemplate: DM_TPL, finalTemplate: { subject: '', body: 'One last note' },
    brands, people: brands.reduce((n, g) => n + g.people.length, 0), noAddress: 0, held: [], done: [],
    doneDays: 30, dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7, calls: [],
  };
}

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo,
  handStep: (a) => { if (a.step === 'dm') S.dm[a.targetId] = a.on === false ? null : new Date().toISOString(); return { contactName: 'them' }; },
  saveHandTemplate: (a) => {
    const t = { dm: DM_TPL, firstB: M_TPL, firstBW: W_TPL }[a.kind];
    if (t) t.body = a.body;
    return { subject: '', body: a.body, standIn: false, savedAt: new Date().toISOString(), savedBy: 'Leo' };
  },
  handTemplate: (a) => ({ dm: DM_TPL, firstB: M_TPL, firstBW: W_TPL }[a.kind] || { subject: '', body: '' }),
  listReached: () => ({ brands: [], totals: { invited: 10, accepted: 4, replied: 1 } }),
  sentByDay: () => ({ days: [], cap: 30 }),
  outcomeTable: () => ({ few: 30, acceptAfterDays: 7, depth: { personRate: null, byTotal: [] } }),
  listTargets: (a) => (a.status === 'accepted' ? [{
    id: 'tr1', brandId: 'bR', status: 'accepted', dmSentAt: null, emailedAt: null, drafts: [],
    brand: { id: 'bR', name: 'Rally Pop' }, contact: { name: 'Rita Reyes', title: 'Brand Manager', email: null, linkedinUrl: null },
  }] : []),
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
    await page.evaluate(() => loadDashboard());
    await page.waitForSelector(item('pB'));

    // 1. The LinkedIn DM, one for everyone, Copy ---------------------------
    await open('pA');
    assert.equal(await msg('pA'), 'Hey Ann, great to be connected. Would love to put something together with Alpha Water.', '(Name) / [Brand] filled');
    assert.equal(await page.$(item('pA') + ' [data-g]'), null, 'no For a man / For a woman');
    assert.doesNotMatch(await page.textContent(item('pA')), /for a (man|woman)/i);
    assert.match(await page.textContent(item('pA') + ' .zt-mail'), /LinkedIn DM/);
    assert.doesNotMatch(await page.textContent('#zach-todo'), /version/i, 'no version A / B anywhere');
    await open('pB');
    assert.equal(await msg('pB'), 'Hey Ben, great to be connected. Would love to put something together with Bravo Fizz.');
    await page.click(item('pB') + ' [data-ztact="copydm"]');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hey Ben, great to be connected. Would love to put something together with Bravo Fizz.');
    console.log('✓ 1. the first message is the LinkedIn DM, no man / woman, Copy copies what’s shown');

    // 2. Messaged is a plain tick; a rewritten card keeps its words -------
    await page.click(item('pB') + ' [data-ztact="step"][data-step="dm"]');
    await until(() => all('handStep').length === 1, 'the tick');
    assert.deepEqual(all('handStep')[0].args, { targetId: 'pB', step: 'dm' }, 'no version sent');
    await open('pO');
    assert.equal(await msg('pO'), 'Olive, my own words for Bravo Fizz');
    console.log('✓ 2. Messaged is a plain tick; a rewritten card keeps its own words');

    // 3. The template editor ----------------------------------------------
    await open('pA');
    await page.click(item('pA') + ' [data-ztact="tpl"][data-kind="dm"]');
    await page.waitForSelector('#zt-scrim.open');
    const tabs = await page.$$eval('#zt-scrim [data-tpltab]', (bs) => bs.map((b) => b.textContent));
    assert.deepEqual(tabs, ['Email', 'LinkedIn DM', 'Final reach-out'], 'no first-message tabs: ' + tabs.join(', '));
    assert.equal(await page.inputValue('#zt-tbody'), DM_TPL.body, 'the card’s button opens the LinkedIn DM');
    assert.match(await page.textContent('#zt-tbody-lbl'), /LinkedIn DM \(Text them on LinkedIn/);
    assert.match(await page.textContent('#zt-prev-body'), /great to be connected/);
    await page.fill('#zt-tbody', 'Hey (NAME), new words for (BRAND).');
    await page.click('#zt-tsave');
    await until(() => all('saveHandTemplate').length === 1, 'the save');
    assert.equal(all('saveHandTemplate')[0].args.kind, 'dm');
    await page.waitForFunction(() => ZT.dmTemplate.body === 'Hey (NAME), new words for (BRAND).');
    await open('pA');
    assert.equal(await msg('pA'), 'Hey Ann, new words for Alpha Water.', 'the cards follow the saved DM');
    // An old link to the first-message template opens the LinkedIn DM.
    await page.evaluate(() => ztOpenTpl('firstBW'));
    assert.equal(await page.getAttribute('#zt-scrim [data-tpltab="dm"]', 'class'), 'chip active');
    await page.keyboard.press('Escape');
    console.log('✓ 3. Edit template: Email / LinkedIn DM / Final reach-out; saving the DM changes the cards');

    // 4. Results: one Copy DM ---------------------------------------------
    await page.evaluate(() => { document.getElementById('zt-scrim').classList.remove('open'); gotoView('reached'); });
    await page.waitForSelector('#rc-accepted [data-rcdm="copy"]');
    assert.equal(await page.$('#rc-firsttest'), null, 'no first message test card');
    assert.equal((await page.$$('#rc-accepted [data-rcdm="copy"]')).length, 1, 'one Copy DM per person');
    assert.match(await page.textContent('#rc-accepted'), /Copy DM(?! ·)/);
    await page.click('#rc-accepted [data-rcdm="copy"]');
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /^Hey Rita/.test(t)));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hey Rita, new words for Rally Pop.', 'the saved DM, not an old one');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
    console.log('✓ 4. Results: one Copy DM copies the LinkedIn DM for that person');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
