// scripts/test-outreach-lists.js
//
// Outreach lists (Leo, Sep 2026): "a button on the outreach tab for the
// list i have planned out so i can send to zach for approval … then once
// things are sent out … a list of companies and the number of people i
// reached". He sends them himself; the page only builds the text. This
// drives public/app.html in Chromium against a fake /api/data:
//
//   1. Both buttons are on the LinkedIn tab and the Schedule's top row,
//      and open the same window.
//   2. Plan for Zach: every Schedule day, each company with how many
//      people go out, in the order they go. On today, who already went is
//      added to the ones still to go (and said so); a planned brand that
//      waits for a later day is named, not counted; a blocked one isn't
//      listed. A total when there's more than one day.
//   3. Unticking a day takes it out of the text; Copy puts exactly the
//      text on screen on the clipboard.
//   4. What went out: LinkedIn invites per company for today, then the
//      quick ranges (Yesterday, This week, Last week) and typed dates ask
//      the server for the right days; an empty day says so and can't be
//      copied.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-outreach-lists.js   (~5s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-outreach-lists.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];

const PLAN = {
  today: '2026-09-29',
  pool: { total: 40, cap: 30 },
  days: [
    {
      date: '2026-09-29', category: 'electrolytes', auto: false, total: 13, sent: 3,
      pinned: [
        { id: 'b1', name: 'LMNT', state: 'going', going: 4 },
        { id: 'b2', name: 'Nuun', state: 'going', going: 3, waits: '2026-10-01' },
        { id: 'b3', name: 'Skratch', state: 'sent', going: 0, sentToday: 2 },
        { id: 'b9', name: 'Blocked Co', state: 'blocked', going: 0 },
      ],
      brands: [{ id: 'b4', name: 'Liquid I.V.', going: 3, people: [{ name: 'Ann' }] }],
      sentPeople: [
        { brandId: 'b3', brand: 'Skratch' }, { brandId: 'b3', brand: 'Skratch' }, { brandId: 'b1', brand: 'LMNT' },
      ],
    },
    {
      date: '2026-09-30', category: 'energy', auto: true, total: 7, sent: 0,
      pinned: [{ id: 'b5', name: 'Celsius', state: 'going', going: 3 }],
      brands: [{ id: 'b6', name: 'Ghost', going: 4, people: [] }],
      sentPeople: [],
    },
  ],
};

const SENT = {
  total: 5,
  companies: [{ brandId: 'b1', name: 'LMNT', people: 3 }, { brandId: 'b5', name: 'Celsius', people: 2 }],
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  appVersion: () => ({ sha: 'test' }),
  getOutreachPlan: () => PLAN,
  sentByCompany: ({ from, to }) => (from === '2000-01-01' ? { from, to, total: 0, companies: [] } : { from, to, ...SENT }),
  getTodayQueue: () => ({ targets: [], sentList: [], more: [], theme: 'energy', labels: {}, sendingDay: true, sentToday: 0, cap: 30 }),
  listTargets: () => [],
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
  await page.waitForFunction(() => typeof window.olOpen === 'function');
  const text = () => page.textContent('#ol-text');
  const lastSent = () => calls.filter((c) => c.fn === 'sentByCompany').slice(-1)[0];
  const waitCall = async (n) => {
    for (let i = 0; i < 100 && calls.length <= n; i++) await page.waitForTimeout(20);
    await page.waitForTimeout(60);
  };

  // 1. The buttons ------------------------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  await page.waitForSelector('#queue-head [data-olopen="plan"]');
  assert.ok(await page.$('#queue-head [data-olopen="sent"]'), 'LinkedIn tab: What went out');
  await page.evaluate(() => renderSchedExtra());
  assert.ok(await page.$('#sched-extra [data-olopen="plan"]'), 'Schedule: Plan for Zach');
  assert.ok(await page.$('#sched-extra [data-olopen="sent"]'), 'Schedule: What went out');
  await page.click('#queue-head [data-olopen="plan"]');
  await page.waitForSelector('#ol-scrim.open');
  console.log('✓ 1 both buttons, on the LinkedIn tab and the Schedule');

  // 2. Plan for Zach ------------------------------------------------------
  await page.waitForFunction(() => /LinkedIn outreach plan/.test(document.getElementById('ol-text').textContent));
  const plan = await text();
  const want = [
    'LinkedIn outreach plan',
    '',
    'Tue Sep 29 (today) · Electrolytes & Hydration — 10 people, 3 companies (3 already sent)',
    '• LMNT — 5 (1 sent)',
    '• Skratch — 2 (2 sent)',
    '• Liquid I.V. — 3',
    'Waiting for a later day: Nuun',
    '',
    'Wed Sep 30 · Energy Drinks — 7 people, 2 companies',
    '• Celsius — 3',
    '• Ghost — 4',
    '',
    'Total: 17 people, 5 companies',
  ].join('\n');
  assert.equal(plan, want, 'the plan text:\n' + plan);
  assert.equal(await page.textContent('#ol-meta'), '2 days · 17 people · 5 companies');
  assert.deepEqual(await page.$$eval('#ol-ctrl [data-olday]', (b) => b.map((x) => x.textContent)), ['Tue Sep 29 · 10', 'Wed Sep 30 · 7']);
  console.log('✓ 2 the plan: companies and people by day, sent added in, waiting named, blocked left out');

  // 3. Untick a day, copy ------------------------------------------------
  await page.click('#ol-ctrl [data-olday="2026-09-30"]');
  const one = await text();
  assert.ok(!/Wed Sep 30|Total:/.test(one), 'an unticked day is out of the text');
  assert.ok(/LMNT — 5/.test(one));
  await page.click('#ol-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), one, 'Copy takes exactly what is on screen');
  await page.waitForSelector('#toast.show');
  console.log('✓ 3 unticking a day and Copy');

  // 4. What went out -----------------------------------------------------
  await page.click('[data-oltab="sent"]');
  await page.waitForFunction(() => /LinkedIn outreach,/.test(document.getElementById('ol-text').textContent));
  const today = await page.evaluate(() => olToday());
  const dayName = (k) => page.evaluate((key) => sdDayName(key), k);
  assert.deepEqual(lastSent().args, { from: today, to: today }, 'opens on today');
  assert.equal(await text(), 'LinkedIn outreach, ' + await dayName(today) + '\n5 people, 2 companies\n\n• LMNT — 3\n• Celsius — 2');
  const keyAdd = (k, n) => page.evaluate(([key, d]) => olKey(key, d), [k, n]);
  const monday = await keyAdd(today, -(((new Date(today + 'T12:00:00Z').getUTCDay()) + 6) % 7));
  const expect = [
    ['yesterday', await keyAdd(today, -1), await keyAdd(today, -1)],
    ['week', monday, today],
    ['lastweek', await keyAdd(monday, -7), await keyAdd(monday, -1)],
  ];
  for (const [preset, from, to] of expect) {
    const n = calls.length;
    await page.click('[data-olpreset="' + preset + '"]');
    await waitCall(n);
    assert.deepEqual(lastSent().args, { from, to }, preset + ' asks for ' + from + ' to ' + to);
  }
  assert.ok((await text()).startsWith('LinkedIn outreach, ' + await dayName(expect[2][1]) + ' to ' + await dayName(expect[2][2])), 'a range says both ends');
  // Typed dates, and a day nothing went out.
  let n0 = calls.length;
  await page.fill('[data-olfrom]', '2000-01-01');
  await page.dispatchEvent('[data-olfrom]', 'change');
  await waitCall(n0);
  assert.equal(lastSent().args.from, '2000-01-01', 'a typed date asks for it');
  await page.fill('[data-olto]', '2000-01-01');
  await page.dispatchEvent('[data-olto]', 'change');
  await page.waitForFunction(() => /No LinkedIn invites went out/.test(document.getElementById('ol-text').textContent));
  assert.equal(await page.isDisabled('#ol-copy'), true, 'nothing to copy on an empty day');
  console.log('✓ 4 what went out: today, quick ranges, typed dates, an empty day');

  await page.keyboard.press('Escape');
  assert.equal(await page.$('#ol-scrim.open'), null, 'Escape closes it');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All outreach-list checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
