// scripts/test-board-lookup.js — Show Board → Access codes lookup. Drives public/app.html
// in Chromium against a fake /api/data: typing asks the server (boardCodeLookup — the whole
// roster, not listBrands' first 500), only the newest answer draws, a pick opens the code panel.
//   NODE_PATH=$(npm root -g) node scripts/test-board-lookup.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-board-lookup.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const ROWS = [
  { id: 'b1', name: 'Ultra Pouches', boardCode: 'ULTR-A123', person: false, archived: false, aka: null },
  { id: 'b2', name: 'Nicotine Co', boardCode: null, person: false, archived: true, aka: 'Ultra Po Labs' },
  { id: 'p1', name: 'Ultra Pete', boardCode: null, person: true, archived: true, aka: null },
];
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  listAccessRequests: () => ({ pending: [] }),
  boardCodeLookup: (a) => ({ brands: ROWS.filter((r) => (r.name + ' ' + (r.aka || '')).toLowerCase().includes(a.q.toLowerCase())) }),
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  await page.waitForFunction(() => typeof window.loadBoard === 'function');
  await page.evaluate(() => { try { loadBoard(); } catch (e) {} });
  await page.waitForSelector('#bd-q', { state: 'visible' });
  assert.ok(!calls.some((c) => c.fn === 'listBrands' && c.args.category === 'all'), 'no capped roster download any more');

  await page.type('#bd-q', 'ultra po');
  await page.waitForSelector('#bd-results [data-bdpick]');
  const looks = calls.filter((c) => c.fn === 'boardCodeLookup');
  assert.equal(looks[looks.length - 1].args.q, 'ultra po');
  assert.ok(looks.length <= 3, 'typing is debounced (' + looks.length + ' calls)');
  const text = await page.textContent('#bd-results');
  assert.ok(/Ultra Pouches.*has code/.test(text), text);
  assert.ok(/Nicotine Co.*archived.*aka Ultra Po Labs/.test(text), text);
  console.log('✓ typing asks the server; brands, archived ones and aka matches show');

  await page.fill('#bd-q', 'zzz nothing');
  await page.waitForFunction(() => /No brand with that name/.test(document.getElementById('bd-results').textContent));
  console.log('✓ no match says so');

  await page.fill('#bd-q', 'ultra pe');
  await page.waitForSelector('#bd-results [data-bdpick="p1"]');
  assert.ok(/Ultra Pete.*person/.test(await page.textContent('#bd-results')));
  await page.click('[data-bdpick="p1"]');
  assert.equal(await page.inputValue('#bd-q'), 'Ultra Pete');
  assert.ok(await page.isVisible('#bd-gen'), 'Generate code for a person with none');
  await page.fill('#bd-q', 'ultra pou');
  await page.click('#bd-results [data-bdpick="b1"]');
  assert.ok(/ULTR-A123/.test(await page.textContent('#bd-code')));
  console.log('✓ a pick opens the code panel (people too)');

  await browser.close();
  server.close();
  console.log('board lookup: all passed');
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
