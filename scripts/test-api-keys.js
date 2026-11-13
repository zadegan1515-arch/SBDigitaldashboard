// scripts/test-api-keys.js — Operations → Team → Keys for other tools, in the
// page (public/app.html in Chromium against a fake /api/data): a founding
// member names a key and makes it, it's on screen once with Copy key / Copy
// instructions / Done, each key lists what it changed, Revoke asks first, and
// someone who can't manage Team sees no keys at all.
//   NODE_PATH=$(npm root -g) node scripts/test-api-keys.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-api-keys.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const SHOT = process.env.SHOT_DIR || '';
const calls = [];
const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);
const NEW_KEY = 'sbk_' + 'TestKeyNotReal0123456789abcdefghijklmnopqrs'.slice(0, 43);
const GUIDE = 'SB COMMAND CENTER — ADDING THINGS WITH A KEY\n\nPOST https://example.test/api/data';
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

let CAN = true;
let KEYS = [
  { id: 'k1', name: 'Zapier', tail: 'Zz9a', createdAt: ago(60 * 24 * 3), createdBy: 'leo@example.com', lastUsedAt: ago(125), changes: 42, revokedAt: null, revokedBy: null,
    log: [{ at: ago(125), fn: 'createBrand', text: 'Added Poppi' }, { at: ago(300), fn: 'upsertContact', text: 'Added Ann Able' }] },
  { id: 'k0', name: 'Old tool', tail: 'old1', createdAt: ago(60 * 24 * 30), createdBy: 'leo@example.com', lastUsedAt: null, changes: 0, revokedAt: ago(60 * 24 * 2), revokedBy: 'leo@example.com', log: [] },
];

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo' }),
  listOwners: () => [], listActivations: () => [], zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }),
  reachedBrands: () => ({}),
  listTeam: () => ({
    managers: ['leo@example.com'], invited: [{ email: 'mia@example.com', addedBy: 'leo@example.com', createdAt: ago(5000) }],
    denied: [], canManage: CAN, me: 'leo@example.com', reps: {}, repName: 'Elizabeth',
    keys: CAN ? { list: KEYS, max: 25, guide: GUIDE } : null,
  }),
  createApiKey: (a) => {
    if (KEYS.some((k) => !k.revokedAt && k.name.toLowerCase() === String(a.name).toLowerCase())) throw new Error('There’s already a key called “' + a.name + '” — revoke it first, or pick another name.');
    const row = { id: 'k2', name: a.name, tail: NEW_KEY.slice(-4), createdAt: ago(0), createdBy: 'leo@example.com', lastUsedAt: null, changes: 0, revokedAt: null, revokedBy: null, log: [] };
    KEYS = [row].concat(KEYS);
    return { key: NEW_KEY, row };
  },
  revokeApiKey: (a) => {
    const row = KEYS.find((k) => k.id === a.id);
    row.revokedAt = ago(0); row.revokedBy = 'leo@example.com';
    return { ok: true, row };
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOT ? 2 : 1 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  let accept = true;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); accept ? d.accept() : d.dismiss(); });
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
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const shot = async (name) => { if (SHOT) await page.screenshot({ path: path.join(SHOT, name + '.png'), fullPage: false }); };
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadTeam === 'function');

  // 1. The section, for a founding member.
  await page.evaluate(() => loadTeam());
  await page.waitForSelector('#team-keys-head');
  assert.match(await page.textContent('#team-keys-head'), /Keys for other tools\s*1 in use/);
  assert.equal(await page.textContent('#team h1'), 'Who can get in');
  let rows = await page.$$eval('[data-key-row]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Zapier.*ends …Zz9a.*made by leo@example\.com.*last used 2 h ago.*What it changed \(42\)/);
  assert.match(rows[1], /Old tool.*revoked.*revoked /);
  assert.ok(await page.$('[data-key-revoke="k1"]'), 'a live key has Revoke');
  assert.ok(!(await page.$('[data-key-revoke="k0"]')), 'a revoked key has none');
  assert.ok(!(await page.$('#key-new')), 'no key on screen');
  // What it changed: newest first, and how many more.
  await page.click('[data-key-log="k1"] > summary');
  const logText = (await page.textContent('[data-key-log="k1"]')).replace(/\s+/g, ' ');
  assert.match(logText, /Added Poppi.*Added Ann Able.*and 40 earlier/);
  await shot('team-keys');
  console.log('✓ Team shows each key: who made it, last used, what it changed');

  // 2. Copy instructions, any time.
  await page.click('.panel [data-key-guide]');
  await page.waitForFunction(() => /Instructions copied/.test(document.body.textContent));
  assert.equal(await clip(), GUIDE);
  console.log('✓ Copy instructions copies the guide');

  // 3. A name is needed; then the key is made and shown once.
  await page.click('#key-add');
  assert.ok(!last('createApiKey'), 'nothing sent without a name');
  await page.fill('#key-name', 'Zapier');
  await page.click('#key-add');
  await page.waitForFunction(() => /already a key called/.test(document.body.textContent));
  assert.ok(!(await page.$('#key-new')), 'a refusal shows nothing');
  assert.equal(await page.isDisabled('#key-add'), false, 'the button comes back');
  await page.fill('#key-name', 'Maya');
  await page.press('#key-name', 'Enter');
  await page.waitForSelector('#key-new');
  assert.deepEqual(last('createApiKey').args, { name: 'Maya' });
  assert.match(await page.textContent('#key-new'), /Maya’s key — copy it now\. It isn’t shown again\./);
  assert.equal(await page.inputValue('#key-new-val'), NEW_KEY);
  assert.match(await page.textContent('#team-keys-head'), /2 in use/);
  // The details opened before stays open through the refresh (keep my place).
  assert.ok(await page.$eval('[data-key-log="k1"]', (d) => d.open), 'the open list stayed open');
  await page.click('#key-new [data-key-copy]');
  await page.waitForFunction(() => /Key copied/.test(document.body.textContent));
  assert.equal(await clip(), NEW_KEY);
  await page.click('#key-new [data-key-guide]');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith('SB COMMAND CENTER'));
  await shot('team-key-new');
  // Nothing of the key in the browser's storage.
  const kept = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)));
  assert.ok(!kept.includes('sbk_'), 'the key is never stored in the browser');
  console.log('✓ Create key: named, shown once with Copy key / Copy instructions');

  // 4. Done asks first; after it the key is gone from the page.
  accept = false;
  await page.click('#key-new [data-key-done]');
  assert.match(dialogs[dialogs.length - 1], /Copied it\? The key can’t be shown again\./);
  assert.ok(await page.$('#key-new'), 'Cancel keeps it');
  accept = true;
  await page.click('#key-new [data-key-done]');
  await page.waitForFunction(() => !document.getElementById('key-new'));
  assert.ok(!(await page.content()).includes(NEW_KEY), 'the key is off the page');
  console.log('✓ Done takes the key off the page for good');

  // 5. A key made and then left: gone when you come back.
  await page.fill('#key-name', 'Sam');
  KEYS = KEYS.filter((k) => k.id !== 'k2');
  await page.click('#key-add');
  await page.waitForSelector('#key-new');
  await page.evaluate(() => gotoView('dashboard'));
  await page.waitForFunction(() => !document.getElementById('team').classList.contains('active'));
  await page.evaluate(() => loadTeam());
  assert.ok(!(await page.$('#key-new')), 'gone the moment Team opens again');
  await page.waitForSelector('#team-keys-head');
  assert.ok(!(await page.$('#key-new')) && !(await page.content()).includes('sbk_'), 'leaving Team drops the key from the page');
  console.log('✓ leaving Team takes the key off the page');

  // 6. Revoke asks first, names the key, then it reads revoked.
  accept = false;
  await page.click('[data-key-revoke="k1"]');
  assert.match(dialogs[dialogs.length - 1], /Revoke Zapier’s key\?[\s\S]*stops working right away[\s\S]*already added stays/);
  assert.ok(!last('revokeApiKey'), 'Cancel sends nothing');
  accept = true;
  await page.click('[data-key-revoke="k1"]');
  await page.waitForFunction(() => !document.querySelector('[data-key-revoke="k1"]'));
  assert.deepEqual(last('revokeApiKey').args, { id: 'k1' });
  assert.match((await page.textContent('[data-key-row="k1"]')).replace(/\s+/g, ' '), /Zapier.*revoked/);
  console.log('✓ Revoke asks first, then the key reads revoked');

  // 7. Someone who can't manage Team sees no keys.
  CAN = false;
  await page.evaluate(() => gotoView('dashboard'));
  await page.evaluate(() => loadTeam());
  await page.waitForFunction(() => /Founding members/.test(document.getElementById('team-body').textContent));
  assert.ok(!(await page.$('#team-keys-head')) && !(await page.$('#key-add')) && !(await page.$('[data-key-row]')));
  console.log('✓ no keys section for someone who can’t manage Team');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('api keys page: all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
