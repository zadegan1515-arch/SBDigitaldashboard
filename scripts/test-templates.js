// scripts/test-templates.js — the Email top tab and Email → Templates (Leo,
// Nov 16 2026: "keep the Outreach tab but then I want a tab that says Email …
// put the Email and Instantly tabs there … a Template tab under the Email tab
// with templates … separate by category") in Chromium against a fake
// /api/data: the top tab and its three sub-tabs (Outreach no longer lists
// Email / Instantly), a row per category under its priority, the editor
// (preview as you type, Save, typed text kept through a redraw, Discard),
// Copy and Copy for Instantly, Back to the standard text (its confirm quotes
// what goes), the find box, an error, and the phone width.
//   NODE_PATH=$(npm root -g) node scripts/test-templates.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-templates.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const DEF = (extra) => ({ subject: 'SB Agency x (BRAND)', body: 'Hi (NAME),\n\n' + (extra ? extra + '\n\n' : '') + "We'd love to understand (BRAND)'s goals.\n\nBest,\nZach" });
const CATS = [['energy', 'top', 'Cold cans for (BRAND).'], ['rtd', 'top', '21+ sampling for (BRAND).'], ['beauty', 'middle', 'House drops for (BRAND).'], ['apparel', 'low', 'Seeding for (BRAND).'], ['betting', 'skip', 'Signups for (BRAND).']];
const S = {};
function reset() { Object.assign(S, { calls: [], own: {}, fail: '', failList: '' }); }
reset();
const row = (key, def) => {
  const o = S.own[key];
  return Object.assign({ key, def }, o ? { subject: o.subject, body: o.body, own: true, at: '2026-11-16T20:00:00Z', by: 'Leo' } : { subject: def.subject, body: def.body, own: false, at: null, by: null });
};
const defOf = (key) => key.startsWith('cat:') ? DEF(CATS.find((c) => 'cat:' + c[0] === key)[2]) : DEF(key === 'intro' ? '' : key === 'followup' ? 'Floating this back up.' : 'Last note from me.');
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  getEmailStatus: () => ({ configured: false }),
  noAnswerList: () => ({ minDays: 21, today: '2026-11-16', counts: {}, people: [], ready: [], last: null }),
  instantlyStatus: () => ({ connected: false, keyName: 'INSTANTLY_API_KEY', scopes: [], counts: {}, people: [], hook: {}, campaigns: null }),
  listEmailTemplates: () => {
    if (S.failList) throw new Error(S.failList);
    return {
      general: [['intro', 'First email'], ['followup', 'Follow-up'], ['final', 'Last follow-up']].map(([k, label]) => Object.assign(row(k, defOf(k)), { label })),
      categories: CATS.map(([c, priority]) => Object.assign(row('cat:' + c, defOf('cat:' + c)), { category: c, priority })),
    };
  },
  saveEmailTemplate: (a) => {
    if (S.fail) throw new Error(S.fail);
    if (a.reset) delete S.own[a.key]; else S.own[a.key] = { subject: a.subject, body: a.body };
    return row(a.key, defOf(a.key));
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const texts = (sel) => page.$$eval(sel, (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 250));
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadTemplates === 'function');

  // ---- the top tab ----
  assert.deepEqual(await texts('.tabs > .nav-item, .tabs .nav-item:not(#sub-tabs .nav-item)').then((a) => a.filter((x, i, all) => all.indexOf(x) === i).slice(0, 5)), ['Home', 'Deals', 'Brands', 'Outreach', 'Email']);
  await page.click('.tabs .nav-item[data-view="outreach"]');
  await wait();
  const outSubs = await texts('#sub-tabs .nav-item');
  assert.ok(!outSubs.includes('Email') && !outSubs.includes('Instantly'), 'Outreach no longer lists Email or Instantly: ' + outSubs.join(', '));
  assert.ok(outSubs.includes('LinkedIn') && outSubs.includes('Schedule') && outSubs.includes('Email stats'));
  await page.click('.tabs .nav-item[data-view="email-out"]');
  await page.waitForSelector('#email-out.active');
  assert.deepEqual(await texts('#sub-tabs .nav-item'), ['Email', 'Instantly', 'Templates']);
  assert.equal(await text('#sub-tabs .nav-item.active'), 'Email');
  assert.equal(await text('.tabs .nav-item.active[data-view="email-out"]'), 'Email', 'the Email top tab is lit');
  await page.click('#sub-tabs .nav-item[data-view="instantly"]');
  await page.waitForSelector('#instantly.active');
  assert.equal(await page.$('.tabs .nav-item.active[data-view="outreach"]'), null, 'Outreach isn’t lit on Instantly');
  assert.equal(await text('.tabs .nav-item.active[data-view="email-out"]'), 'Email');
  ok('Email is its own top tab after Outreach: Email · Instantly · Templates; Outreach keeps the rest');

  // ---- the list ----
  await page.click('#sub-tabs .nav-item[data-view="templates"]');
  await page.waitForSelector('#templates.active .tpl-item');
  assert.equal(await text('#templates h1'), 'Templates');
  assert.deepEqual(await texts('#templates .tpl-h'), ['Every category', 'By category · Top priority', 'By category · Middle priority', 'By category · Low priority', 'By category · Skip priority']);
  assert.deepEqual(await texts('#templates .tpl-name'), ['First email', 'Follow-up', 'Last follow-up', 'Energy Drinks', 'Beer, Seltzers & Canned Cocktails', await page.evaluate(() => CAT_NAMES.beauty), 'Clothing & Fashion', await page.evaluate(() => CAT_NAMES.betting)]);
  assert.equal((await texts('#templates .tpl-name')).length, 8);
  assert.match(await text('#tpl-count'), /5 categories · all on the standard text/);
  assert.equal(await page.$('.tpl-ed'), null, 'nothing open to start');
  ok('one row per template: the three every category shares, then each category under its priority');

  // ---- open, type, preview, save ----
  await page.click('[data-tplitem="cat:energy"] .tpl-row');
  await page.waitForSelector('#tpl-text');
  assert.match(await page.inputValue('#tpl-text'), /Cold cans for \(BRAND\)\./);
  assert.match(await text('#tpl-pv'), /SB Agency x Liquid Sun.*Hi Alex,.*Cold cans for Liquid Sun\./);
  assert.equal(await page.$eval('[data-tpl="save"]', (b) => b.disabled), true, 'nothing to save yet');
  await page.focus('#tpl-text');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nP.S. (NAME), cold ones on us.');
  assert.match(await text('#tpl-pv'), /P\.S\. Alex, cold ones on us\./, 'the preview follows the typing');
  assert.equal(await text('[data-tplitem="cat:energy"] [data-tpltag]'), 'Not saved');
  assert.equal(await page.$eval('[data-tpl="save"]', (b) => b.disabled), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tpl-text', 'still typing in the box');
  await page.fill('#tpl-subject', '(BRAND) x SB Agency — campus');
  assert.equal(await text('[data-tplitem="cat:energy"] .tpl-subj'), '(BRAND) x SB Agency — campus');
  // A refresh of the page keeps what's typed.
  await page.evaluate(() => loadTemplates());
  await wait(300);
  assert.match(await page.inputValue('#tpl-text'), /P\.S\. \(NAME\), cold ones on us\.$/, 'typed text survives a refresh');
  await page.click('[data-tpl="save"]');
  await page.waitForFunction(() => /Yours/.test(document.querySelector('[data-tplitem="cat:energy"] [data-tpltag]').textContent));
  assert.equal(calls('saveEmailTemplate').length, 1);
  assert.equal(calls('saveEmailTemplate')[0].args.key, 'cat:energy');
  assert.equal(calls('saveEmailTemplate')[0].args.subject, '(BRAND) x SB Agency — campus');
  assert.match(calls('saveEmailTemplate')[0].args.body, /cold ones on us\.$/);
  assert.match(await text('#tpl-count'), /1 with your own text/);
  assert.ok(await page.$('[data-tpl="reset"]'), 'a saved one can go back to the standard text');
  ok('a row opens its editor; the preview follows the typing; Save stores that one template');

  // ---- copy ----
  await page.click('[data-tpl="copy"]');
  await wait(150);
  assert.match(await clip(), /^\(BRAND\) x SB Agency — campus\n\nHi \(NAME\),/);
  await page.click('[data-tpl="copyins"]');
  await wait(150);
  const ins = await clip();
  assert.match(ins, /^\{\{companyName\}\} x SB Agency — campus\n\nHi \{\{firstName\}\},/);
  assert.match(ins, /P\.S\. \{\{firstName\}\}, cold ones/);
  assert.doesNotMatch(ins, /\(NAME\)|\(BRAND\)/);
  ok('Copy gives the text as written; Copy for Instantly swaps in Instantly’s tags');

  // ---- discard, one open at a time ----
  await page.fill('#tpl-subject', 'Scrap this');
  await page.waitForSelector('[data-tpl="discard"]');
  await page.click('[data-tpl="discard"]');
  assert.equal(await page.inputValue('#tpl-subject'), '(BRAND) x SB Agency — campus');
  await page.click('[data-tplitem="followup"] .tpl-row');
  await wait(100);
  assert.equal((await page.$$('.tpl-ed')).length, 1, 'one editor open at a time');
  assert.match(await page.inputValue('#tpl-text'), /Floating this back up\./);
  await page.click('[data-tplitem="followup"] .tpl-row');
  assert.equal(await page.$('.tpl-ed'), null, 'a second click closes it');
  ok('Discard puts the saved text back; one editor at a time');

  // ---- a save that fails keeps the text ----
  await page.click('[data-tplitem="cat:rtd"] .tpl-row');
  await page.fill('#tpl-subject', 'Will fail');
  S.fail = 'Database is down';
  await page.click('[data-tpl="save"]');
  await page.waitForFunction(() => /Database is down/.test(document.body.textContent));
  assert.equal(await page.inputValue('#tpl-subject'), 'Will fail', 'what was typed is still there');
  assert.equal(await text('[data-tplitem="cat:rtd"] [data-tpltag]'), 'Not saved');
  S.fail = '';
  await page.click('[data-tpl="discard"]');
  ok('a failed save says why and keeps the text');

  // ---- back to the standard text ----
  await page.click('[data-tplitem="cat:energy"] .tpl-row');
  accept = false; dialogs.length = 0;
  await page.click('[data-tpl="reset"]');
  await wait(150);
  assert.match(dialogs[0], /Put “Energy Drinks” back on the standard text\?[\s\S]*Your saved version goes:[\s\S]*campus[\s\S]*cold ones on us/);
  assert.equal(calls('saveEmailTemplate').filter((c) => c.args.reset).length, 0, 'Cancel changes nothing');
  accept = true;
  await page.click('[data-tpl="reset"]');
  await page.waitForFunction(() => document.querySelector('[data-tplitem="cat:energy"] [data-tpltag]').textContent === 'Standard');
  assert.deepEqual(calls('saveEmailTemplate').filter((c) => c.args.reset)[0].args, { key: 'cat:energy', reset: true });
  assert.doesNotMatch(await page.inputValue('#tpl-text'), /cold ones/);
  assert.equal(await page.$('[data-tpl="reset"]'), null);
  ok('Back to the standard text quotes what goes first; Cancel changes nothing');

  // ---- find ----
  await page.click('[data-tplitem="cat:energy"] .tpl-row'); // closes it
  await page.fill('#tpl-q', '');
  await page.type('#tpl-q', 'beau');
  assert.deepEqual(await texts('#templates .tpl-name'), [await page.evaluate(() => CAT_NAMES.beauty)]);
  assert.equal(await page.inputValue('#tpl-q'), 'beau', 'the box keeps its text and focus');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tpl-q');
  await page.fill('#tpl-q', 'zzz');
  assert.match(await text('#tpl-body'), /No category called “zzz”/);
  await page.fill('#tpl-q', '');
  assert.equal((await texts('#templates .tpl-name')).length, 8);
  ok('the find box narrows to a category and keeps its focus');

  // ---- an error ----
  await page.evaluate(() => { TPL.data = null; });
  S.failList = 'Could not reach the database';
  await page.evaluate(() => loadTemplates());
  await page.waitForFunction(() => /Couldn’t read the templates: Could not reach the database/.test(document.getElementById('tpl-body').textContent));
  S.failList = '';
  await page.click('[data-tpl="retry"]');
  await page.waitForSelector('.tpl-item');
  ok('a failed read says why, with Try again');

  // ---- a phone ----
  await page.click('[data-tplitem="cat:energy"] .tpl-row');
  await page.setViewportSize({ width: 390, height: 800 });
  await wait(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  const small = await page.$$eval('#tpl-body *', (els) => els.filter((el) => el.offsetParent && [].some.call(el.childNodes, (c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11.5).length);
  assert.equal(small, 0, 'no text under 11.5px');
  ok('fits a phone, no small print');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\n' + n + ' checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
