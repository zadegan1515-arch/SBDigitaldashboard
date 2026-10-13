// scripts/test-discover.js — Brands → Discover as one clean list (Leo, Oct
// 2026: "make this cleaner … more simple and clean"). Drives public/app.html
// in Chromium against a fake /api/data: To review / Added, the source and
// category dropdowns, a row opening for the pitch and links, Add and ×,
// and the phone width.
//   NODE_PATH=$(npm root -g) node scripts/test-discover.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-discover.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();


const NAMES = ['Aéropostale', 'Blenders Eyewear', 'Lucky Energy', 'Garage Beer', 'Flerish'];
// listDiscoveries' grade (discover-grade.ts); best grade first by default.
const GRADES = [['D', 22], ['C', 37], ['A', 69], ['B', 52], ['A', 62]];
const BY_GRADE = ['Lucky Energy', 'Flerish', 'Garage Beer', 'Blenders Eyewear', 'Aéropostale'];
const grade = ([g, score]) => ({ grade: g, score, word: 'w', capped: null,
  reasons: [{ good: true, text: 'Top priority category', points: 30 }, { good: null, text: 'money not known — size not known', points: 15 }] });
const S = { rows: [], adds: [], dismissed: [], bulk: [], undo: [], bulkUndo: null };
function reset() {
  S.rows = NAMES.map((n, i) => ({
    id: 'd' + i, name: n, category: ['apparel', 'apparel', 'energy', 'rtd', 'electrolytes'][i],
    query: i < 4 ? 'Claude hunt · Oct 5' : 'LinkedIn: similar to Levi\'s', source: i < 4 ? 'Claude hunt' : 'LinkedIn',
    signals: i % 2 ? 'sponsors,genz' : 'midsize', status: 'new', inSystem: false, contactCount: 0, brandId: null,
    reason: 'A long reason about why ' + n + ' fits SB Agency, with a fact or two that could run past one line on a narrow screen and should be cut off neatly.',
    activation: 'Sampling at the door for ' + n + '.', website: 'https://example.com/' + i, sourceUrl: 'https://news.example.com/' + i, linkedinUrl: null,
    grade: grade(GRADES[i]),
  }));
  S.rows.push({ id: 'dx', name: 'Already Here', category: 'energy', query: 'Claude hunt · Oct 5', source: 'Claude hunt', signals: 'genz',
    status: 'added', inSystem: true, contactCount: 3, brandId: 'b9', reason: 'r', activation: null, website: null, sourceUrl: null, linkedinUrl: null,
    grade: grade(['B', 50]) });
}
reset();
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  listDiscoveries: () => ({ rows: S.rows.filter((r) => !S.dismissed.includes(r.id)), bulkUndo: S.bulkUndo }),
  // Add all A's (Leo, Oct 13 2026): preview, then the ticked ids.
  addDiscoveredBulk: (a) => {
    S.bulk.push(a);
    const rows = S.rows.filter((r) => r.status !== 'added' && r.grade.grade === 'A').map((r) => ({ id: r.id, name: r.name, category: r.category, score: r.grade.score, source: r.source }));
    // A second find of Flerish joins it; a namesake of the held one is held too.
    if (rows.some((r) => r.id === 'd4')) rows.push({ id: 'dj', name: 'Flerish Hydration', category: 'electrolytes', score: 60, source: 'Search', group: 'd4', joins: 'Flerish' });
    if (S.bulkGrew) rows.push({ id: 'dn', name: 'Newcomer Soda', category: 'soda', score: 61, source: 'Claude hunt', group: 'dn' });
    const held = [{ id: 'dh', name: 'Lucky Energy Co', match: 'Lucky Energy', why: ['name'] },
      { id: 'dh2', name: 'Lucky Energy Co', match: 'Lucky Energy', why: ['name'], sameAs: 'Lucky Energy Co' }];
    const expect = S.bulkGrew ? 'sigB' : 'sigA';
    if (!a.confirm) return { applied: false, grade: 'A', rows, held, expect };
    // The list changed while Leo was ticking: a new find came in.
    if (S.bulkStale) { S.bulkStale = false; S.bulkGrew = true; return { applied: false, stale: true, grade: 'A', rows, held, expect: 'sigB' }; }
    for (const id of a.ids) { const r = S.rows.find((x) => x.id === id); if (r) { r.status = 'added'; r.inSystem = true; } }
    S.bulkUndo = { at: new Date().toISOString(), grade: 'A', n: a.ids.length };
    return { applied: true, added: a.ids.length, linked: 0, names: [] };
  },
  undoDiscoverBulk: (a) => {
    S.undo.push(a);
    const pv = { goes: ['Flerish'], stays: [{ name: 'Lucky Energy', why: '2 people on file' }], backToReview: 2, expect: S.undoMoved ? 'u2' : 'u1' };
    if (a.confirm && a.expect !== pv.expect) return { applied: false, stale: true, ...pv };
    if (a.confirm && S.undoMoveOnce) { S.undoMoveOnce = false; S.undoMoved = true; return { applied: false, stale: true, ...pv, expect: 'u2', stays: [] }; }
    if (a.confirm) { S.bulkUndo = null; return { applied: true, ...pv }; }
    return { applied: false, ...pv };
  },
  addDiscoveredBrand: ({ id }) => { S.adds.push(id); return { ok: true, brandId: 'nb' + id }; },
  dismissDiscovered: ({ id }) => { S.dismissed.push(id); return { ok: true }; },
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; } catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadDiscover === 'function');
  await page.evaluate(() => gotoView('discover'));
  await page.waitForSelector('#disc-body .dc-row');
  const names = () => page.$$eval('#disc-body .dc-row b', (bs) => bs.map((b) => b.textContent));

  assert.deepEqual(await names(), BY_GRADE, 'To review lists everything not added, best grade first');
  assert.deepEqual(await page.$$eval('#disc-body .dc-grade', (e) => e.map((x) => x.textContent)), ['A', 'A', 'B', 'C', 'D'], 'every row shows its grade');
  assert.match(await page.textContent('[data-dctab="review"]'), /5/);
  assert.match(await page.textContent('[data-dctab="added"]'), /1/);
  assert.equal(await page.$('#disc-q'), null, 'the old search box is gone');
  console.log('✓ one list, To review / Added');

  await page.selectOption('[data-dcsel="source"]', 'LinkedIn');
  assert.deepEqual(await names(), ['Flerish']);
  await page.selectOption('[data-dcsel="source"]', '');
  await page.selectOption('[data-dcsel="cat"]', 'apparel');
  assert.deepEqual(await names(), ['Blenders Eyewear', 'Aéropostale']);
  await page.selectOption('[data-dcsel="cat"]', '');
  console.log('✓ source and category dropdowns');

  await page.selectOption('[data-dcsel="grade"]', 'A');
  assert.deepEqual(await names(), ['Lucky Energy', 'Flerish']);
  assert.match(await page.textContent('[data-dcsel="grade"]'), /Grade A \(2\)/);
  await page.selectOption('[data-dcsel="grade"]', '');
  await page.selectOption('[data-dcsel="sort"]', 'new');
  assert.deepEqual(await names(), NAMES, 'Newest first keeps the server order');
  await page.selectOption('[data-dcsel="sort"]', 'grade');
  console.log('✓ grade filter and sort');

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.click('[data-disc="d0"] .dc-name');
  await page.waitForSelector('[data-disc="d0"] .dc-more');
  assert.match(await page.textContent('[data-disc="d0"] .dc-more'), /Sampling at the door/);
  assert.match(await page.textContent('[data-disc="d0"] .dc-more'), /Grade\s*D · 22\/100[\s\S]*\+30Top priority category/);
  assert.ok(await page.$('[data-disc="d0"] a[href="https://news.example.com/0"]'));
  console.log('✓ a row opens for the pitch and links');

  await page.click('[data-disc="d2"] [data-dcact="add"]');
  await page.waitForFunction(() => !document.querySelector('[data-disc="d2"]'));
  assert.deepEqual(S.adds, ['d2']);
  await page.click('[data-disc="d3"] [data-dcact="dismiss"]');
  await page.waitForFunction(() => !document.querySelector('[data-disc="d3"]'));
  assert.deepEqual(S.dismissed, ['d3']);
  await page.click('[data-dctab="added"]');
  assert.deepEqual(await names(), ['Lucky Energy', 'Already Here']);
  console.log('✓ Add moves a brand to Added; × dismisses');

  // Add all A's: one button, a preview with ticks, the held one named, Add
  // sends the preview's stamp and the ticked ids; Undo after.
  reset(); S.dismissed = []; S.adds = [];
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.evaluate(() => loadDiscover());
  await page.click('[data-dctab="review"]');
  await page.waitForSelector('#dc-bulk-a');
  assert.match(await page.textContent('#dc-bulk-a'), /Add all A’s \(2\)/);
  await page.click('#dc-bulk-a');
  await page.waitForSelector('#dc-bulk-card');
  assert.equal(S.bulk[0].confirm, undefined, 'the button only previews');
  const card = await page.textContent('#dc-bulk-card');
  assert.match(card, /Add 3 grade-A finds as brands/);
  assert.match(card, /Lucky Energy[\s\S]*Flerish/);
  assert.match(card, /Flerish Hydration[\s\S]*same brand as Flerish — goes in as one/);
  assert.match(card, /Left out — may already be on the roster: Lucky Energy Co \(looks like Lucky Energy\), Lucky Energy Co \(same as Lucky Energy Co, which looks like Lucky Energy\)/);
  assert.equal(await page.textContent('#dc-bulk-go'), 'Add 3 brands');
  await page.uncheck('[data-dcpick="d2"]');
  assert.equal(await page.textContent('#dc-bulk-go'), 'Add 2 brands');
  assert.equal(await page.isChecked('#dc-bulk-all'), false, 'Tick all shows it isn\'t all');
  // The list changes before Add lands: it opens again, Leo's untick kept,
  // the new find unticked and marked.
  S.bulkStale = true;
  await page.click('#dc-bulk-go');
  await page.waitForSelector('[data-dcpick="dn"]');
  assert.equal(S.bulk[1].expect, 'sigA');
  assert.equal(await page.isChecked('[data-dcpick="d2"]'), false, 'still unticked after the list changed');
  assert.equal(await page.isChecked('[data-dcpick="dn"]'), false, 'a find that wasn\'t there before comes in unticked');
  assert.equal(await page.isChecked('[data-dcpick="d4"]'), true);
  assert.match(await page.textContent('#dc-bulk-card'), /Newcomer Soda[\s\S]*new/);
  assert.equal(await page.textContent('#dc-bulk-go'), 'Add 2 brands');
  await page.click('#dc-bulk-go');
  await page.waitForSelector('#dc-bulk-undo');
  assert.deepEqual(S.bulk[S.bulk.length - 1], { grade: 'A', confirm: true, expect: 'sigB', ids: ['d4', 'dj'] });
  assert.equal(await page.$('#dc-bulk-card'), null, 'the preview closes');
  assert.match(await page.textContent('#dc-bulk-undo'), /Added 2 grade-A brands · Undo/);
  assert.ok(!(await names()).includes('Flerish'), 'Flerish left To review');
  // Undo: the dialog says what goes and what stays; a change in between
  // shows it again before anything goes.
  S.undoMoveOnce = true;
  await page.click('[data-dcundo]');
  await page.waitForFunction(() => !document.getElementById('dc-bulk-undo'));
  assert.deepEqual(S.undo.map((u) => [!!u.confirm, u.expect]), [[false, undefined], [true, 'u1'], [true, 'u2']], 'Undo previews, sends its stamp, and asks again after a change');
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[0], /1 brand comes off the roster: Flerish\n2 finds go back to To review\.[\s\S]*These stay \(touched since\): Lucky Energy — 2 people on file/);
  assert.match(dialogs[1], /^Something changed since — here it is again\./);
  assert.doesNotMatch(dialogs[1], /These stay/);
  console.log('✓ Add all A\u2019s: preview with ticks, held ones named, ticks kept when the list changes; Undo names what goes and asks again after a change');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('[data-dctab="review"]');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways page scroll at phone width (' + wide + 'px)');
  console.log('✓ phone width fits');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('All Discover checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
