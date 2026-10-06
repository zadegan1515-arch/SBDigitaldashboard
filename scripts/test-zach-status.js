// scripts/test-zach-status.js
//
// Zach's list: the cadence and "Where every brand stands". Leo (Oct 5
// 2026): a right side showing every brand that accepted and where we are
// with it, with the days until the next reach-out, so nobody is
// forgotten. The cadence: the first LinkedIn message 2 days after the
// accept; no answer 10 days after it, the final reach-out; still quiet 7
// days after the final, No response (off the to-do, nothing written).
// This drives public/app.html in Chromium against a fake /api/data:
//
//   1. Stages: day-2 message (waits until then, due on the day, late
//      after), final reach-out 10 days after the message, No response 7
//      days after the final.
//   2. The board (Leo, Oct 6: "more defined ... move it higher up"): full
//      width above the list, one bordered card per stage side by side;
//      grouped by stage, most urgent first, "N late / due today" counts,
//      a brand with people at two stages under both.
//   3. A click on the right opens that person on the left, under the
//      filter they're in (To do / Waiting / No response).
//   4. The final reach-out follows its own template; a card's edit saves
//      as that person's own (saveHandEmail final), Reset hands it back;
//      the Templates window has a Final reach-out tab.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-zach-status.js   (~10s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-zach-status.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

// --- fake data ----------------------------------------------------

const FINAL_TPL = 'Hi (NAME), last note about (BRAND).';
function person(id, name, extra) {
  return Object.assign({
    targetId: id, status: 'accepted', contactId: 'c-' + id, name, title: 'Brand Manager', email: null,
    linkedinUrl: 'https://www.linkedin.com/in/' + id, invitedAt: ago(30), acceptedAt: null, repliedAt: null,
    dmSentAt: null, autoEmailedAt: null, emailReplyAt: null, autoSubject: null, handSubject: null, handBody: null,
    handNote: null, emailedAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
    handDm: null, draftId: 'd-' + id, dmOwn: false, dm: null, final: null,
  }, extra);
}
function brand(id, name, people, extra) {
  return Object.assign({ id, name, category: 'electrolytes', about: null, website: null, linkedinUrl: null, hold: null, people }, extra);
}
function payload() {
  return {
    template: { subject: 'Hi (NAME)', body: 'Email for (BRAND)', standIn: false, savedAt: null, savedBy: null },
    dmTemplate: { subject: '', body: 'DM for (BRAND)', standIn: false },
    firstTemplate: { subject: '', body: 'Hey (NAME), great to be connected.', standIn: false },
    finalTemplate: { subject: '', body: S.finalTpl, standIn: S.finalStandIn },
    brands: [
      brand('bA', 'Alpha Water', [person('tA', 'Ann Able', { acceptedAt: ago(1) })]),                    // soon: due tomorrow
      brand('bB', 'Bravo Hydration', [
        person('tB', 'Ben Bright', { acceptedAt: ago(2) }),                                               // dm: due today
        person('tI', 'Ida Iver', { acceptedAt: ago(14), dmSentAt: ago(11) }),                             // nudge: 1d late
      ]),
      brand('bC', 'Charlie Energy', [person('tC', 'Cal Crane', { acceptedAt: ago(5) })]),                 // dm: 3d late
      brand('bD', 'Delta Drinks', [person('tD', 'Dee Dunn', { acceptedAt: ago(7), dmSentAt: ago(4) })]),  // waiting: final in 6d
      brand('bE', 'Echo Soda', [person('tE', 'Eve Elm', { acceptedAt: ago(15), dmSentAt: ago(12), final: S.eveFinal })]), // nudge: 2d late
      brand('bF', 'Foxtrot Fizz', [person('tF', 'Fay Fox', { acceptedAt: ago(20), dmSentAt: ago(16), nudgedAt: ago(3) })]), // waiting after final
      brand('bG', 'Golf Seltzer', [person('tG', 'Gus Gray', { acceptedAt: ago(30), dmSentAt: ago(25), nudgedAt: ago(9) })]), // No response
      brand('bH', 'Hotel Tea', [person('tH', 'Hal Hart', {
        status: 'replied', acceptedAt: ago(9), dmSentAt: ago(7), repliedAt: ago(2), wantsEmailAt: ago(2) })],                // email to send
        { hold: 'do not email' }),
    ],
    people: 9, noAddress: 9, held: [], done: [], doneDays: 30,
    dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7,
    calls: [{ targetId: 'tK', brandId: 'bK', brandName: 'Kilo Kombucha', name: 'Kim Kane', title: 'CMO', callAt: ahead(3) }],
  };
}

const S = { calls: [], saves: [], tplSaves: [], finalTpl: FINAL_TPL, finalStandIn: true, eveFinal: null };

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  getRateCard: () => ({}),
  zachTodo: () => payload(),
  getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}),
  appVersion: () => ({ sha: 'test' }),
  saveHandEmail: (a) => { S.saves.push(a); if (a.targetId === 'tE' && 'final' in a) S.eveFinal = a.final; return { id: a.targetId }; },
  saveHandTemplate: (a) => { S.tplSaves.push(a); if (a.kind === 'final') { S.finalTpl = a.body; S.finalStandIn = false; } return { subject: '', body: a.body, standIn: false, savedAt: new Date().toISOString(), savedBy: 'leo' }; },
};

// --- page server ---------------------------------------------------

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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      S.calls.push(fn);
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base)) return route.abort();
    return route.continue();
  });
  await page.goto(base + '/app.html');
  await page.waitForSelector('#zach-todo .zs-row');

  // 1. Stages --------------------------------------------------------
  const stages = await page.evaluate(() => {
    const o = {};
    Object.keys(ZT_BY_ID).forEach((id) => { o[id] = ztStage(ZT_BY_ID[id]) + '/' + ztFilterOf(ZT_BY_ID[id]); });
    return o;
  });
  assert.deepEqual(stages, {
    tA: 'soon/waiting', tB: 'dm/todo', tI: 'nudge/todo', tC: 'dm/todo', tD: 'waiting/waiting',
    tE: 'nudge/todo', tF: 'waiting/waiting', tG: 'noreply/noreply', tH: 'email/todo',
  });
  const chips = await page.$$eval('#zach-todo .zt-chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(chips, ['To do5', 'Waiting3', 'No response1']);
  // To do never lists the No response person or anyone still waiting.
  const todoRows = await page.$$eval('#zach-todo .zt-main .zt-item', (els) => els.map((e) => e.getAttribute('data-zt')));
  assert.deepEqual([...todoRows].sort(), ['tB', 'tC', 'tE', 'tH', 'tI']);
  const pillE = await page.textContent('#zach-todo .zt-item[data-zt="tE"] .zt-next');
  assert.equal(pillE, 'Send the final reach-out');
  console.log('ok 1 - day-2 message, final 10 days later, No response 7 days after the final');

  // 2. The right side --------------------------------------------------
  const geo = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const m = document.querySelector('#zach-todo .zt-main').getBoundingClientRect();
    const z = document.querySelector('#zach-todo .zs').getBoundingClientRect();
    return { sideBottom: z.bottom, mainTop: m.top, sideWidth: z.width, mainWidth: m.width, pos: getComputedStyle(document.querySelector('#zach-todo .zs')).position };
  });
  assert.ok(geo.sideBottom <= geo.mainTop, 'the board sits above the list ' + JSON.stringify(geo));
  assert.ok(Math.abs(geo.sideWidth - geo.mainWidth) < 4, 'the board is as wide as the list ' + JSON.stringify(geo));
  assert.equal(geo.pos, 'static');
  const tops = await page.$$eval('#zach-todo .zs-grp', (els) => els.map((g) => Math.round(g.getBoundingClientRect().top)));
  assert.ok(tops.length >= 4 && tops[0] === tops[1] && tops[1] === tops[2], 'stages side by side on a wide screen ' + tops);
  const groups = await page.$$eval('#zach-todo .zs-grp', (els) => els.map((g) => ({
    head: g.querySelector('.zs-gh span').textContent,
    rows: Array.from(g.querySelectorAll('.zs-row')).map((r) => r.querySelector('.zs-name b').textContent + ' | ' + r.querySelector('.zs-when').textContent),
  })));
  assert.deepEqual(groups, [
    { head: 'Accepted', rows: ['Charlie Energy | 3d late', 'Bravo Hydration | today', 'Alpha Water | tomorrow'] },
    { head: 'Messaged', rows: ['Echo Soda | 2d late', 'Bravo Hydration | 1d late', 'Delta Drinks | in 6d'] },
    { head: 'Final sent', rows: ['Foxtrot Fizz | sent ' + await page.evaluate((d) => shortDate(d), payload().brands[5].people[0].nudgedAt)] },
    { head: 'Replied / emailed', rows: ['Hotel Tea | email to send'] },
    { head: 'Call booked', rows: ['Kilo Kombucha | ' + await page.evaluate((d) => shortDate(d), payload().calls[0].callAt)] },
    { head: 'No response', rows: ['Golf Seltzer | ' + 'final ' + await page.evaluate((d) => shortDate(d), payload().brands[6].people[0].nudgedAt)] },
  ]);
  const sum = await page.textContent('#zach-todo .zs-sum');
  assert.equal(sum.replace(/\s+/g, ' ').trim(), '3 late1 due today9 brands');
  const hold = await page.textContent('#zach-todo .zs-row[data-zsopen="tH"] em');
  assert.equal(hold, 'do not email');
  const rule = await page.textContent('#zach-todo .zs-rule');
  assert.match(rule, /day 2 .* 10 days later .* 7 quiet days/);
  console.log('ok 2 - the board: above the list, full width, a card per stage, most urgent first, counts');
  if (process.env.SHOT_BOARD) {
    await page.evaluate(() => document.getElementById('zach-todo').scrollIntoView());
    await page.screenshot({ path: process.env.SHOT_BOARD });
    for (const w of [1100, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      await page.evaluate(() => { ztRender(); document.getElementById('zach-todo').scrollIntoView(); });
      await page.screenshot({ path: process.env.SHOT_BOARD.replace('.png', '-' + w + '.png') });
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => ztRender());
  }

  // 3. A click on the right opens them on the left ---------------------
  await page.click('#zach-todo .zs-row[data-zsopen="tG"]');
  await page.waitForTimeout(400);
  let st = await page.evaluate(() => ({ f: ZT_FILTER, cur: ZT_CUR, open: !!document.querySelector('#zach-todo .zt-item[data-zt="tG"].open') }));
  assert.deepEqual(st, { f: 'noreply', cur: 'tG', open: true });
  const gPanel = await page.textContent('#zach-todo .zt-item[data-zt="tG"] .zt-panel');
  assert.match(gPanel, /No response/);
  assert.match(gPanel, /nothing more goes out/);
  await page.click('#zach-todo .zs-row[data-zsopen="tA"]');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({ f: ZT_FILTER, cur: ZT_CUR }));
  assert.deepEqual(st, { f: 'waiting', cur: 'tA' });
  assert.equal(await page.textContent('#zach-todo .zt-item[data-zt="tA"] .zt-next'), 'Text them tomorrow');
  await page.click('#zach-todo .zs-row[data-zsopen="tE"]');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({ f: ZT_FILTER, cur: ZT_CUR }));
  assert.deepEqual(st, { f: 'todo', cur: 'tE' });
  // A call on the right shows its row in the left "Calls booked" fold.
  await page.evaluate(() => { document.getElementById('zt-calls').open = false; });
  await page.click('#zach-todo .zs-row[data-zscall="tK"]');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.getElementById('zt-calls').open), true);
  assert.equal(await page.$eval('#zt-calls [data-ztundo="tK"]', (b) => b.closest('.zt-done-row').classList.contains('zs-flash')), true);
  // Arrow keys on the right stay on the right (they used to jump to the list).
  await page.focus('#zach-todo .zs-row[data-zsopen="tD"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.zs')), true);
  console.log('ok 3 - a brand on the right opens its person on the left, under their filter');

  // 4. The final reach-out's own template ------------------------------
  const box = '#zach-todo .zt-item[data-zt="tE"] [data-ztnudge]';
  assert.equal(await page.inputValue(box), 'Hi Eve, last note about Echo Soda.');
  assert.match(await page.textContent('#zach-todo .zt-item[data-zt="tE"] .zt-ph'), /Late: it was due/);
  await page.fill(box, 'Eve, my own last note.');
  await page.evaluate((sel) => document.querySelector(sel).dispatchEvent(new Event('change', { bubbles: true })), box);
  await page.waitForTimeout(200);
  assert.deepEqual(S.saves.pop(), { targetId: 'tE', final: 'Eve, my own last note.' });
  await page.waitForSelector('#zach-todo .zt-item[data-zt="tE"] [data-ztact="finalreset"]');
  await page.click('#zach-todo .zt-item[data-zt="tE"] [data-ztact="finalreset"]');
  await page.waitForTimeout(200);
  assert.deepEqual(S.saves.pop(), { targetId: 'tE', final: null });
  assert.equal(await page.inputValue(box), 'Hi Eve, last note about Echo Soda.');
  // Stand-in pill names it until Leo saves his.
  assert.match(await page.textContent('#zach-todo .zt-standin'), /Stand-in final reach-out/);
  await page.click('#zach-todo .zt-standin');
  await page.waitForSelector('#zt-scrim.open');
  assert.equal(await page.getAttribute('#zt-scrim [data-tpltab="final"]', 'class'), 'chip active');
  assert.equal(await page.inputValue('#zt-tbody'), FINAL_TPL);
  assert.match(await page.textContent('#zt-tbody-lbl'), /10 days after the first message/);
  await page.fill('#zt-tbody', 'Hey (NAME), closing the loop on (BRAND).');
  await page.click('#zt-tsave');
  await page.waitForTimeout(250);
  assert.equal(S.tplSaves.pop().kind, 'final');
  assert.equal(await page.$('#zach-todo .zt-standin'), null);
  await page.click('#zach-todo .zs-row[data-zsopen="tE"]');
  await page.waitForTimeout(400);
  assert.equal(await page.inputValue(box), 'Hey Eve, closing the loop on Echo Soda.');
  console.log('ok 4 - final reach-out: own template, card edits save per person, Reset, Templates tab');

  // 5. Narrow screen: still above the list, nothing off the side ------
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(150);
  const narrow = await page.evaluate(() => {
    const m = document.querySelector('#zach-todo .zt-main').getBoundingClientRect();
    const z = document.querySelector('#zach-todo .zs').getBoundingClientRect();
    return { above: z.bottom <= m.top + 1, pos: getComputedStyle(document.querySelector('#zach-todo .zs')).position, scrollX: document.documentElement.scrollWidth > window.innerWidth };
  });
  assert.deepEqual(narrow, { above: true, pos: 'static', scrollX: false });
  console.log('ok 5 - narrow screen: the board stays above the list, no sideways scroll');

  // 6. Everyone left went quiet: To do points at No response, not an empty Waiting.
  await page.evaluate(() => {
    ZT.brands = ZT.brands.filter((g) => g.id === 'bG');
    ZT_BY_ID = { tG: ZT.brands[0].people[0] };
    ZT_FILTER = 'todo'; ZT_CUR = null; ztRender();
  });
  const none = await page.textContent('#zach-todo .zt-none');
  assert.match(none, /1 went quiet after the final reach-out/);
  await page.click('#zach-todo .zt-none [data-ztf="noreply"]');
  assert.equal(await page.evaluate(() => ZT_FILTER), 'noreply');
  assert.ok(await page.$('#zach-todo .zt-item[data-zt="tG"]'));
  console.log('ok 6 - To do with only No response left links to it');

  assert.deepEqual(errors, []);
  if (process.env.SHOT) {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.evaluate(() => { ZT_FILTER = 'todo'; ZT_CUR = null; ztRender(); document.getElementById('zach-todo').scrollIntoView(); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.SHOT });
  }
  await browser.close();
  server.close();
  console.log('all ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
