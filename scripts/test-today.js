// scripts/test-today.js
//
// Home → Today (Leo, Oct 6 2026): the recap that opens on the first visit
// of each Tue–Fri — full screen, a card per section (who we reached, what
// to do today, brands found, what Claude did, what Leo needs to do,
// ideas), scroll or click through, the last click closes — and Today's
// log, where pasted Claude Code chats are kept by day. Drives
// public/app.html in Chromium against a fake /api/data:
//
//   1. #today opens the recap; the glance tiles count each section.
//   2. Cards in order; a click on a card goes to the next, Done closes;
//      Esc closes; seen today is remembered.
//   3. Ticking a pasted NEED saves it (setWorkNeedDone); Build this saves
//      the pick (pickBuildIdea).
//   4. Today's log: paste → addWorkLog with the text and day; Delete shows
//      what goes first, then deletes; another day loads dayRecap({day}).
//   5. A phone-width recap has no sideways scroll.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-today.js   (~8s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-today.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const S = { calls: [], args: {} };

function recap(day) {
  const isToday = !day || day === TODAY;
  return {
    day: day || TODAY, today: TODAY, isToday,
    reached: {
      invites: 3,
      companies: [{ brandId: 'b1', name: 'Alpha Water', category: 'electrolytes', people: ['Ann Able', 'Ben Bright'] },
                  { brandId: 'b2', name: 'Bravo Energy', category: 'energy', people: ['Cal Crane'] }],
      accepted: [{ brandId: 'b3', brand: 'Charlie Spirits', name: 'Dee Dunn' }],
      emails: [], replies: [], steps: [{ brandId: 'b3', brand: 'Charlie Spirits', name: 'Eve Elm', step: 'First LinkedIn message' }],
      previous: null,
    },
    todo: isToday ? { sendingDay: true, cap: 30, category: 'energy', planned: [{ id: 'b2', name: 'Bravo Energy' }], queued: 7,
      actions: 1, overdue: 0, actionItems: [{ brandId: 'b4', brandName: 'Delta', contactName: 'Fay Fox', reason: 'reply', overdue: false, nextStep: null }],
      calls: [] } : null,
    found: {
      discovered: [{ id: 'd1', name: 'Flerish', category: 'electrolytes', status: 'new', signals: 'sponsors,genz', reason: 'Rolling Loud hydration partner', source: 'Claude hunt', brandId: null }],
      brands: [{ id: 'b9', name: 'Huel', category: 'wellness', source: 'research' }],
    },
    asks: [{ key: 'discover', n: 49, label: 'brands found, waiting for Add or ×', view: 'discover' }],
    chats: [{ id: 'w1', title: 'Brand hunt', raw: 'Brand hunt\n- posted 49', source: 'paste', addedBy: null, createdAt: new Date().toISOString(),
      done: ['Posted 49 brands', 'See https://example.com/x'], ideas: ['Score finds by funding'],
      needs: [{ i: 0, label: 'Review the 49 finds', steps: ['Open Discover', 'Add or ×'], done: false }] }],
    ideas: [{ id: 'board-alert', area: 'Show Board', title: 'Board-open alerts', why: 'Follow up while they look.', picked: false }],
    picked: [],
    logDays: [{ day: TODAY, n: 1 }, { day: '2026-10-01', n: 2 }],
  };
}

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}), listBrands: () => ({ brands: [], total: 0 }),
  zachTodo: () => ({ template: {}, dmTemplate: {}, firstTemplate: {}, finalTemplate: {}, brands: [], people: 0, noAddress: 0, held: [], done: [], doneDays: 30,
    dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7, calls: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}),
  dayRecap: (a) => recap(a.day),
  addWorkLog: (a) => ({ day: a.day, saved: 2, chats: [], needs: 1 }),
  setWorkNeedDone: (a) => ({ id: a.id, needsDone: a.done ? [a.index] : [] }),
  pickBuildIdea: (a) => ({ picked: a.on ? [a.id] : [] }),
  todaySendList: () => ({ day: TODAY, sendingDay: true, cap: 30, sentToday: 0, people: 3, flagged: 2, brands: [
    { brandId: 'b1', name: 'Alpha Water', people: [
      { targetId: 't1', contactId: 'c1', name: 'Ann Able', title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/ann', problem: null, better: null },
      { targetId: 't2', contactId: 'c2', name: 'Sam Store', title: 'Store Manager', linkedinUrl: 'https://www.linkedin.com/in/sam', problem: 'looks like store staff (Store Manager)',
        better: { contactId: 'c9', name: 'Pat Partner', title: 'Partnerships Lead', linkedinUrl: 'https://www.linkedin.com/in/pat', why: 'a partnerships person instead' } } ] },
    { brandId: 'b2', name: 'Bravo Energy', people: [
      { targetId: 't3', contactId: 'c3', name: 'Mo Market', title: 'Marketing Manager', linkedinUrl: null, problem: null,
        better: { contactId: 'c8', name: 'Spo Lead', title: 'Sponsorship Director', linkedinUrl: null, why: 'partnerships beats marketing' } } ] } ] }),
  queueContact: (a) => ({ queued: true, contactName: 'Pat Partner' }),
  passContact: (a) => ({ passed: true, contactName: 'Sam Store' }),
  deleteWorkLog: (a) => (a.confirm ? { deleted: a.id, title: 'Brand hunt' } : { preview: true, day: TODAY, title: 'Brand hunt', chars: 24 }),
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { S.dialog = d.message(); d.accept(); });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      S.calls.push(fn); (S.args[fn] = S.args[fn] || []).push(args || {});
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; } catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });

  // 1 ---------------------------------------------------------------
  await page.goto(base + '/app.html#today');
  await page.waitForSelector('#recap:not([hidden]) .rc-card', { timeout: 8000 });
  const tiles = await page.$$eval('#hm-glance .hm-tile', (els) => els.map((e) => e.querySelector('.k').textContent + '=' + e.querySelector('.v').textContent));
  // reached = 3 invites + 1 step; todo = 7 queued + 1 action; found = Flerish + Huel; needs = 1 ask + 1 pasted need
  assert.deepEqual(tiles, ['Reached out today=4', 'To do today=8', 'Brands found today=2', 'Needs you=2']);
  console.log('ok 1 - #today opens the recap; tiles count each section');

  // 2 ---------------------------------------------------------------
  const titles = await page.$$eval('#recap .rc-card h2', (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ['Who we reached today', 'What to do today', 'Brands we found', 'What Claude did', 'What I need from you', 'Ideas to build next']);
  assert.equal(await page.evaluate(() => lsGet('sb.recapSeen')), TODAY, 'seen today remembered');
  const linkOk = await page.$eval('#recap .rc-card[data-rc-i="3"] a[href="https://example.com/x"]', (a) => a.target);
  assert.equal(linkOk, '_blank');
  await page.click('#recap .rc-card[data-rc-i="0"] h2');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => RC_I), 1, 'a click on a card goes to the next');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => RC_I), 2, 'arrow down goes on');
  await page.click('#recap .rc-dot[data-rc-dot="5"]');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => RC_I), 5);
  // 3 ---------------------------------------------------------------
  await page.click('#recap [data-rc-idea="board-alert"]');
  await page.waitForTimeout(200);
  assert.deepEqual(S.args.pickBuildIdea[0], { id: 'board-alert', on: true });
  assert.equal(await page.textContent('#recap [data-rc-idea="board-alert"]'), 'Picked ✓');
  await page.click('#recap .rc-dot[data-rc-dot="4"]');
  await page.waitForTimeout(700);
  await page.click('#recap [data-need="w1"]');
  await page.waitForTimeout(200);
  assert.deepEqual(S.args.setWorkNeedDone[0], { id: 'w1', index: 0, done: true });
  assert.equal(await page.evaluate(() => RC_I), 4, 'ticking a need does not move the card');
  console.log('ok 3 - need tick and idea pick save');
  await page.click('#recap .rc-dot[data-rc-dot="5"]');
  await page.waitForTimeout(700);
  await page.click('#recap .rc-card[data-rc-i="5"] [data-rc-next]');
  assert.equal(await page.isHidden('#recap'), true, 'Done closes it');
  await page.click('#hm-recap');
  await page.waitForSelector('#recap:not([hidden])');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#recap'), true, 'Esc closes it');
  console.log('ok 2 - cards in order, click / arrows / dots move, Done and Esc close');

  // 4 ---------------------------------------------------------------
  await page.click('#hm-paste');
  await page.waitForSelector('#dl-text');
  await page.fill('#dl-text', 'Chat A\n- did a\n---\nChat B\nNEED: do b');
  await page.click('[data-dl-save]');
  await page.waitForTimeout(300);
  assert.equal(S.args.addWorkLog[0].text, 'Chat A\n- did a\n---\nChat B\nNEED: do b');
  assert.equal(S.args.addWorkLog[0].day, TODAY);
  assert.equal(await page.$('#dl-text'), null, 'paste box closes after a save');
  await page.click('[data-dl-chat="w1"] summary');
  await page.click('[data-dl-del="w1"]');
  await page.waitForTimeout(300);
  assert.match(S.dialog, /Delete “Brand hunt”/);
  assert.deepEqual(S.args.deleteWorkLog.map((a) => !!a.confirm), [false, true], 'preview, then delete');
  await page.selectOption('[data-dl-pick]', '2026-10-01');
  await page.waitForTimeout(300);
  assert.ok(S.args.dayRecap.some((a) => a.day === '2026-10-01'), 'another day loads that day');
  assert.match(await page.textContent('#day-log .section-head'), /Log · Thursday, October 1/);
  console.log('ok 4 - paste saves, delete previews first, past days load');

  // 6 ---------------------------------------------------------------
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; window.scrollTo(0, 0); });
  await page.click('#hm-sendlist');
  await page.waitForSelector('#hm-send .sl-row');
  assert.match(await page.textContent('#hm-send .sl-head'), /3 people · 2 companies · 2 to check/);
  assert.match(await page.textContent('#hm-send .sl-row.bad .sl-flag'), /store staff/);
  await page.click('#hm-send [data-sl-copy]');
  let copied = await page.evaluate(() => window.__copied);
  assert.match(copied, /LinkedIn invites for .* — 2 people, 2 companies/);
  assert.ok(copied.includes('• Ann Able — Head of Partnerships\n  https://www.linkedin.com/in/ann'));
  assert.ok(!copied.includes('Sam Store'), 'a flagged person is left out of the copy');
  await page.check('#hm-send [data-sl-keep="t2"]');
  await page.click('#hm-send [data-sl-copy]');
  copied = await page.evaluate(() => window.__copied);
  assert.ok(copied.includes('Sam Store'), 'send anyway puts them back');
  await page.click('#hm-send [data-sl-swap="c2"]');
  await page.waitForTimeout(300);
  assert.deepEqual(S.args.queueContact[0], { contactId: 'c9' });
  assert.deepEqual(S.args.passContact[0], { contactId: 'c2' });
  console.log('ok 6 - today’s list: flags, copy for Zach (flagged left out), send anyway, swap');

  // 5 ---------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('#hm-recap');
  await page.waitForSelector('#recap:not([hidden])');
  const over = await page.$eval('#rc-track', (t) => t.scrollWidth - t.clientWidth);
  assert.ok(over <= 1, 'no sideways scroll on a phone: ' + over);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  console.log('ok 5 - phone width fits');

  // 7 ---------------------------------------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('about:blank');
  await page.goto(base + '/app.html#stock');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => location.hash), '', 'a reopened screen is dropped');
  assert.equal(await page.evaluate(() => document.getElementById('dashboard').classList.contains('active')), true, 'opens on Home');
  await page.evaluate(() => gotoView('brands'));
  await page.waitForTimeout(300);
  await page.click('#logo-home');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.getElementById('dashboard').classList.contains('active')), true, 'the SB logo goes Home');
  console.log('ok 7 - opening the site lands on Home; the SB logo goes Home');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('all ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
