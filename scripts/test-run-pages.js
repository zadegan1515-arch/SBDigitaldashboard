// scripts/test-run-pages.js — Outreach → People → the run card's "Brands with
// no LinkedIn page" tiles (Leo, Nov 16 2026: "how many brands dont have a
// linkedin page", then "i want updates on these numbers after the linkedin
// fills run"). Drives public/app.html in Chromium against a fake /api/data:
// before this run → now while it's going, → after it once finished (with
// "now N" when something moved since), a run with no count yet, and the link
// up to "Which LinkedIn page is theirs?".
//   NODE_PATH=$(npm root -g) node scripts/test-run-pages.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-run-pages.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const pc = (at, noPage, waiting, next, nobody) => ({ at, brands: 938, noPage, inPlay: noPage - 29, waiting, next, nobody });
const run = (o) => Object.assign({ id: 'r1', startedAt: '2026-11-16T19:52:00Z', lastAt: '2026-11-16T21:10:00Z', script: '1.47', status: 'running',
  added: 221, pauses: [], brands: [{ name: 'LMNT', brandId: 'b1', added: 3, ms: 40000 }] }, o || {});
const BEFORE = pc('2026-11-16T19:52:01Z', 300, 122, 64, 166);
const S = { people: null };
const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  linkedinPeople: () => S.people,
  liCleanup: () => ({ people: [], brands: [] }),
  fillSchedule: () => ({ today: '2026-11-16', doneToday: 0, perDay: 100, minFit: 50, focus: 'electrolyte', total: 0, days: [] }),
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  const tile = (k) => page.$eval('#li-run-pages [data-lip="' + k + '"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const head = () => page.$eval('#li-run-pages .lip-h', (e) => e.textContent.replace(/\s+/g, ' ').trim());

  // 1. Through the People list: a run going now — before it started → now.
  S.people = {
    brands: [], zachList: [], zachDone: [], latestScript: '1.47', liOwner: null,
    pageReview: [{ brandId: 'c3', name: 'Page Pick', category: 'energy', website: null, at: '2026-11-16T20:30:00Z', why: 'unclear', saved: null, pageIndustry: null, candidates: [] }],
    runs: [run({ pages: { before: BEFORE } })],
    pagesNow: pc('2026-11-16T21:10:30Z', 284, 131, 40, 150),
  };
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadLinkedin === 'function');
  await page.evaluate(() => loadLinkedin());
  await page.waitForSelector('#li-run-pages');
  assert.equal(await head(), 'Brands with no LinkedIn page · before this run → now');
  assert.equal(await tile('noPage'), 'No LinkedIn page saved300→28416 fewer · 255 in play');
  assert.equal(await tile('waiting'), 'Waiting on your pick122→1319 more · Pick them ↑');
  assert.equal(await tile('next'), 'Next for the fill to find64→4024 fewer');
  assert.equal(await tile('nobody'), 'Nobody on file166→15016 fewer');
  assert.equal(await page.$eval('#li-run-pages [data-lip="noPage"] .lip-d span', (e) => e.className), 'good', 'fewer without a page is the fill working');
  assert.equal(await page.$eval('#li-run-pages [data-lip="waiting"] .lip-d span', (e) => e.className), 'warn', 'more to pick is work for Leo');
  assert.ok(!(await page.$('#li-run-pages .t-meta')), 'no "shows from" note once there is a before');
  for (const sz of await page.$$eval('#li-run-pages *', (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize))))
    assert.ok(sz >= 11.5, 'no text under 11.5px (' + sz + ')');
  console.log('✓ a run going now: before it started → now, with what changed');
  await page.screenshot({ path: process.env.SHOT || path.join(require('os').tmpdir(), 'run-pages.png'), clip: await page.$eval('#li-runs', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, width: r.width, height: Math.min(r.height, 700) }; }) }).catch(() => {});

  // "Pick them ↑" goes up to "Which LinkedIn page is theirs?".
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('#li-run-pages [data-lipages-pick]');
  await page.waitForFunction(() => { const r = document.getElementById('li-review').getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; });
  console.log('✓ Pick them ↑ goes to "Which LinkedIn page is theirs?"');

  // 2. Finished: what it kept at its end; "now N" where something moved since.
  const draw = (runs, now) => page.evaluate(([r, n]) => renderLiRuns(r, '1.47', null, n), [runs, now]);
  const AFTER = pc('2026-11-16T22:40:00Z', 284, 131, 40, 150);
  await draw([run({ status: 'finished', pages: { before: BEFORE, after: AFTER } })], pc('2026-11-17T15:00:00Z', 280, 127, 40, 150));
  assert.equal(await head(), 'Brands with no LinkedIn page · before this run → after it');
  assert.equal(await tile('noPage'), 'No LinkedIn page saved300→28416 fewer · 255 in play · now 280');
  assert.equal(await tile('waiting'), 'Waiting on your pick122→1319 more · now 127 · Pick them ↑');
  assert.equal(await tile('next'), 'Next for the fill to find64→4024 fewer', 'nothing moved since: no "now"');
  // …and with nothing to read now, the run's own two counts still show.
  await draw([run({ status: 'finished', pages: { before: BEFORE, after: AFTER } })], null);
  assert.equal(await tile('nobody'), 'Nobody on file166→15016 fewer');
  // A paused run reads now, not the count its pause kept.
  await draw([run({ status: 'paused', pauses: [{ at: '2026-11-16T21:00:00Z', why: 'paused' }], pages: { before: BEFORE, after: pc('2026-11-16T21:00:00Z', 290, 125, 55, 158) } })], AFTER);
  assert.equal(await head(), 'Brands with no LinkedIn page · before this run → now');
  assert.equal(await tile('noPage'), 'No LinkedIn page saved300→28416 fewer · 255 in play');
  console.log('✓ a finished run: before → after it, and "now" where it moved since');

  // 3. No change, and more brands without a page (new ones added): plain words.
  await draw([run({ status: 'finished', pages: { before: BEFORE, after: pc('2026-11-16T22:40:00Z', 303, 122, 67, 166) } })], null);
  assert.equal(await tile('noPage'), 'No LinkedIn page saved300→3033 more · 274 in play');
  assert.equal(await page.$eval('#li-run-pages [data-lip="noPage"] .lip-d span', (e) => e.className), '', 'more is not coloured as good news');
  assert.equal(await tile('waiting'), 'Waiting on your pick122→122no change · Pick them ↑');
  console.log('✓ no change and more are said plainly');

  // 4. A run from before the dashboard kept counts: now alone, and when the change starts showing.
  await draw([run()], AFTER);
  assert.equal(await head(), 'Brands with no LinkedIn page · now');
  assert.equal(await tile('noPage'), 'No LinkedIn page saved284255 in play');
  assert.equal(await tile('waiting'), 'Waiting on your pick131Pick them ↑');
  assert.ok(/The change shows here from this run’s next brand\./.test(await page.textContent('#li-run-pages')));
  await draw([run({ status: 'finished' })], AFTER);
  assert.ok(/The change shows here from the next run\./.test(await page.textContent('#li-run-pages')));
  // …and once it has taken its first count mid-run, the card says since when.
  await draw([run({ pages: { before: pc('2026-11-16T21:30:00Z', 290, 125, 55, 158) } })], AFTER);
  assert.ok(/^Brands with no LinkedIn page · since Nov 16, .* → now$/.test(await head()), await head());
  assert.equal(await tile('noPage'), 'No LinkedIn page saved290→2846 fewer · 255 in play');
  console.log('✓ a run with no count yet shows now; one counted late says since when');

  // 5. Nothing to show: no block, and the rest of the card is as it was.
  await draw([run()], null);
  assert.equal(await page.$('#li-run-pages'), null);
  assert.ok(/Last LinkedIn run/.test(await page.textContent('#li-runs')));
  await draw([run({ pages: { before: { at: 'x' }, after: 'junk' } })], { noPage: 'many' });
  assert.equal(await page.$('#li-run-pages'), null, 'a count that isn’t one is left out');
  // 6. An earlier run's line carries its own before → after.
  await draw([run({ pages: { before: BEFORE } }), run({ id: 'r0', startedAt: '2026-11-13T19:27:00Z', status: 'finished',
    pages: { before: pc('2026-11-13T19:27:00Z', 310, 120, 70, 170), after: pc('2026-11-13T21:00:00Z', 300, 122, 64, 166) } })], AFTER);
  assert.ok(/Before: Nov 13, .* · no LinkedIn page 310 → 300 · what it did/.test((await page.textContent('#li-runs')).replace(/\s+/g, ' ')), await page.textContent('#li-runs'));
  console.log('✓ nothing to show draws nothing; an earlier run keeps its own before → after');

  // On a phone the tiles wrap and nothing runs off the side.
  await page.setViewportSize({ width: 390, height: 800 });
  await draw([run({ pages: { before: BEFORE } })], AFTER);
  const wide = await page.$$eval('#li-run-pages .lip-tile', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= 0; }));
  assert.ok(wide.length === 4 && wide.every(Boolean), 'every tile fits a phone');
  console.log('✓ fits a phone');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('run card page counts: all passed');
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
