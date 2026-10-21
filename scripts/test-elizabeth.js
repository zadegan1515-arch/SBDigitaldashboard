// scripts/test-elizabeth.js — the Elizabeth tab (Leo, Oct 21 2026) in Chromium
// against a fake /api/data:
//
//   1. Its own top tab next to Outreach, sub-tabs Today · Week plan ·
//      Follow-ups · Results.
//   2. Today: brands in order with her counts; an email row opens Gmail in her
//      account with the template filled; a LinkedIn row copies the invite note
//      (≤ 300); Email sent ✓ / Invite sent ✓ are steps; editing one email saves
//      her wording (the template's own text = follow the template); Take off
//      names who comes off first; a waiting brand says so.
//   3. Week plan: day tiles, the list of brands with a button per day (lit =
//      on it, a second click takes it off), search, Fill her week (preview →
//      Put them on with the same seed).
//   4. Follow-ups: chips by where people stand; Copy message + Messaged ✓;
//      Call booked asks for its day first.
//   5. Results.
//   6. A brand's window: people with her status, + Her list, + Add a person.
//   7. Templates: tabs, the note's 300 count, Save.
//   8. Her Reached tag beside Zach's.
//   9. Team: Make it Elizabeth's outreach only (asks first).
//  10. Her own account: only her part (no sidebar, no top tabs, no search,
//      no Home calls), the logo goes to her Today.
//  11. A phone: no sideways scroll. No page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-elizabeth.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-elizabeth.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const TODAY = NY.format(new Date());
const shift = (k, n) => new Date(new Date(k + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const dow = (k) => new Date(k + 'T12:00:00Z').getUTCDay();
const DAYS = [];
for (let k = TODAY; DAYS.length < 5; k = shift(k, 1)) if ([2, 3, 4].includes(dow(k))) DAYS.push(k);
const SENDING = [2, 3, 4].includes(dow(TODAY));
const now = new Date().toISOString();

const TPL = {
  email: { subject: 'SB Agency × (BRAND)', body: 'Hi (NAME),\n\nI’m Elizabeth with SB Agency. (BRAND) around our college events?\n\nElizabeth', saved: false },
  follow: { subject: 'Re: SB Agency × (BRAND)', body: 'Hi (NAME), just bumping this up.', saved: false },
  note: { subject: '', body: 'Hi (NAME), I’m Elizabeth with SB Agency — we book top artist talent for fraternities and sororities. Would love to connect and see if (BRAND) wants to activate at these events.', saved: false },
  dm: { subject: '', body: 'Hey (NAME), great to be connected. Would love to put something together with (BRAND).', saved: false },
  final: { subject: '', body: 'Hi (NAME), one last note from me.', saved: false },
};
const row = (o) => Object.assign({
  id: 'r', brandId: 'ba', brand: 'Alpha Hydrate', contactId: 'c', name: 'Ann Able', title: 'Head of Partnerships', email: null, linkedinUrl: null,
  channel: 'email', other: null, status: 'queued', day: TODAY, carried: false, sentAt: null, acceptedAt: null, dmAt: null, followAt: null,
  repliedAt: null, callAt: null, callBookedAt: null, doneAt: null, subject: null, body: null, note: null, blocked: null,
  stage: 'queued', group: 'list', due: TODAY, late: false, next: 'On your list', canBack: false, lastStep: null,
}, o);
let TODAY_ROWS = [
  row({ id: 'r1', name: 'Ann Able', email: 'ann@alpha.com', linkedinUrl: 'https://www.linkedin.com/in/annable', other: 'linkedin' }),
  row({ id: 'r2', name: 'Ben Bright', title: 'Marketing Manager', channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/benbright' }),
  row({ id: 'r3', brandId: 'bb', brand: 'Beta Beer', name: 'Gus Gray', title: 'CMO', email: 'gus@beta.com', carried: true, day: shift(TODAY, -1) }),
];
const FOLLOW = [
  row({ id: 'f1', name: 'Dee Dale', channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/deedale', status: 'accepted', stage: 'dmDue', group: 'todo', due: TODAY, next: 'Text them on LinkedIn', canBack: true }),
  row({ id: 'f2', brandId: 'bb', brand: 'Beta Beer', name: 'Eve Ely', email: 'eve@beta.com', status: 'replied', stage: 'replied', group: 'replied', due: TODAY, next: 'They replied — book a call', canBack: true }),
  row({ id: 'f3', name: 'Fay Fox', email: 'fay@alpha.com', status: 'sent', stage: 'followDue', group: 'todo', due: shift(TODAY, -2), late: true, next: 'Send a follow-up email', canBack: true }),
  row({ id: 'f4', name: 'Hal Hart', channel: 'linkedin', status: 'sent', stage: 'invited', group: 'waiting', due: null, next: 'Invite out — waiting for them to accept', canBack: true }),
];
let PLAN = { [DAYS[0]]: ['ba'] };
const BANK = [
  { id: 'bx', name: 'Xeno Energy', category: 'energy', fit: 81, tooSmall: false, work: 4, left: 5, size: 4, emails: 2, links: 3, archived: false, doNotEmail: false, stopped: false, notUs: false, day: null, reached: 0, big: false },
  { id: 'by', name: 'Yonder Water', category: 'beverage', fit: 64, tooSmall: false, work: 3, left: 3, size: 3, emails: 0, links: 3, archived: false, doNotEmail: true, stopped: false, notUs: false, day: null, reached: 0, big: false },
];
let REPS = {};
const calls = [];

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', rep: null }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo: () => ({ brands: [], people: 0, done: [], calls: [], held: [] }), acceptedPeople: () => ({ people: [], total: 0, brands: 0 }),
  reachedBrands: () => ({ brands: { bb: [shift(TODAY, -9), shift(TODAY, -9), 'i', 2, 0] }, el: { ba: [shift(TODAY, -1), TODAY, 'e', 0, 1] }, count: 1 }),
  elToday: () => ({
    today: TODAY, sending: SENDING, nextSending: DAYS[SENDING ? 1 : 0], cap: 30, count: TODAY_ROWS.length, sentToday: TODAY_ROWS.filter((r) => r.sentAt).length,
    liWeek: 12, liLimit: 100, rep: 'Elizabeth', repEmail: 'liz@example.com', templates: TPL,
    brands: [
      { id: 'ba', name: 'Alpha Hydrate', category: 'electrolytes', website: 'alphahydrate.com', linkedinUrl: null, fit: 77, planned: true, from: null, rows: TODAY_ROWS.filter((r) => r.brandId === 'ba') },
      { id: 'bb', name: 'Beta Beer', category: 'rtd', website: null, linkedinUrl: null, fit: 58, planned: false, from: shift(TODAY, -1), rows: TODAY_ROWS.filter((r) => r.brandId === 'bb') },
    ].filter((g) => g.rows.length),
    waits: [{ id: 'bz', name: 'Zeta Gin', need: 10, to: DAYS[1] }], nobody: [], next: SENDING ? null : { day: DAYS[0], brands: [{ id: 'ba', name: 'Alpha Hydrate', size: 3 }] },
  }),
  elStep: (a) => {
    const r = TODAY_ROWS.find((x) => x.id === a.id) || FOLLOW.find((x) => x.id === a.id);
    if (a.step === 'sent') Object.assign(r, { status: 'sent', sentAt: now, stage: 'followDue', group: 'waiting', canBack: true });
    if (a.step === 'save') { if ('subject' in a) r.subject = a.subject || null; if ('body' in a) r.body = a.body || null; }
    if (a.step === 'dm') Object.assign(r, { dmAt: now, stage: 'finalDue', group: 'waiting', due: shift(TODAY, 10) });
    if (a.step === 'call') Object.assign(r, { status: 'call', stage: 'call', group: 'call', due: a.callDay });
    return { row: r, word: { sent: 'Marked sent', save: 'Saved', dm: 'Messaged on LinkedIn', call: 'Call booked' }[a.step] || 'Done' };
  },
  elTakeOff: (a) => {
    const names = TODAY_ROWS.filter((r) => r.brandId === a.brandId && r.status === 'queued').map((r) => r.name);
    if (a.confirm) TODAY_ROWS = TODAY_ROWS.filter((r) => r.brandId !== a.brandId);
    return { applied: !!a.confirm, brand: a.brandId === 'bb' ? 'Beta Beer' : 'Alpha Hydrate', people: names, expect: 'x' };
  },
  elWeek: () => ({
    today: TODAY, cap: 30, bankTotal: BANK.length, spreadUndo: null,
    days: DAYS.map((d) => ({ date: d, week: 'this', today: d === TODAY, cap: 30, carried: 0,
      brands: (PLAN[d] || []).map((id) => ({ id, name: id === 'ba' ? 'Alpha Hydrate' : (BANK.find((b) => b.id === id) || {}).name, category: 'energy', fit: 70, size: 3, built: false, left: 3, stopped: false })),
      count: (PLAN[d] || []).length * 3 })),
    bank: BANK.map((b) => Object.assign({}, b, { day: Object.keys(PLAN).find((d) => PLAN[d].includes(b.id)) || null })),
  }),
  elPlan: (a) => {
    for (const d of Object.keys(PLAN)) PLAN[d] = PLAN[d].filter((x) => x !== a.brandId);
    if (a.op === 'add') (PLAN[a.day] = PLAN[a.day] || []).push(a.brandId);
    return { ok: true, name: (BANK.find((b) => b.id === a.brandId) || { name: 'Alpha Hydrate' }).name, day: a.day, from: null };
  },
  elSearch: (a) => ({ brands: /gin/i.test(a.q) ? [Object.assign({}, BANK[0], { id: 'bz', name: 'Zeta Gin', fit: 50 })] : [] }),
  elSpread: (a) => ({ applied: !!a.apply, seed: a.seed || 99, expect: 'sig', put: [{ date: DAYS[1], brands: [{ id: 'bx', name: 'Xeno Energy', size: 4, fit: 81 }] }] }),
  elFollow: () => ({ today: TODAY, rows: FOLLOW, templates: TPL, rep: 'Elizabeth', repEmail: 'liz@example.com' }),
  elResults: () => ({
    today: TODAY,
    week: { invites: 4, accepted: 2, emails: 6, replied: 1, calls: 1, acceptRate: 0.5, replyRate: 0.1 },
    month: { invites: 4, accepted: 2, emails: 6, replied: 1, calls: 1, acceptRate: 0.5, replyRate: 0.1 },
    all: { invites: 4, accepted: 2, emails: 6, replied: 1, calls: 1, acceptRate: 0.5, replyRate: 0.1 },
    byDay: [{ day: TODAY, invites: 2, emails: 3, accepted: 1, replied: 0 }],
    brands: [{ id: 'ba', name: 'Alpha Hydrate', people: 3, first: TODAY, last: TODAY, stage: 'e' }],
  }),
  elBrand: (a) => ({
    brand: { id: a.brandId, name: 'Alpha Hydrate', category: 'electrolytes', website: 'alphahydrate.com', linkedinUrl: null, about: 'Electrolyte drink mix.', archived: false, doNotEmail: false, stopped: null, person: false },
    fit: { score: 77, reasons: [] }, work: 4, orphans: [], day: DAYS[0], built: [], days: DAYS.map((date) => ({ date })), today: TODAY, sending: SENDING, nextSending: DAYS[0],
    people: [
      { id: 'c1', name: 'Ann Able', title: 'Head of Partnerships', email: 'ann@alpha.com', linkedinUrl: null, channel: 'email', problem: null, stopped: null, rows: [TODAY_ROWS[0]] },
      { id: 'c9', name: 'Ivy Ingram', title: 'Brand Manager', email: null, linkedinUrl: 'https://www.linkedin.com/in/ivy', channel: 'linkedin', problem: null, stopped: null, rows: [] },
      { id: 'c8', name: 'Ed Ely', title: 'VP Partnerships', email: 'ed@alpha.com', linkedinUrl: null, channel: 'email', problem: null, stopped: 'Ed Ely said they don\'t want to continue', rows: [] },
    ],
  }),
  elQueuePeople: (a) => ({ day: TODAY, added: ['Ivy Ingram'], skipped: [] }),
  elAddPerson: (a) => ({ contact: { id: 'cn', name: a.name }, queued: a.queue ? { day: TODAY, added: [a.name], skipped: [] } : null }),
  elTemplates: () => ({ templates: TPL }),
  elSaveTemplate: (a) => { TPL[a.kind] = { subject: a.subject, body: a.body, saved: true, savedBy: 'Leo', savedAt: now }; return { templates: TPL }; },
  listTeam: () => ({ managers: ['leo@example.com', 'liz@example.com'], invited: [], denied: [], canManage: true, me: 'leo@example.com', reps: REPS, repName: 'Elizabeth' }),
  setRepAccount: (a) => { if (a.on) REPS[a.email] = { rep: 'elizabeth' }; else delete REPS[a.email]; return { ok: true, reps: REPS }; },
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function open(browser, base0, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript((o) => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
    if (o && o.hint) try { localStorage.setItem('sb.rep', '1'); } catch (e) {}
  }, opts || {});
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base0 + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {}, ctx: (opts && opts.name) || 'leo' });
      let body;
      // Her account: the server answers 403 to everything but her part (REP_FNS).
      if (opts && opts.repOnly && !/^el[A-Z]/.test(fn) && !['getMe', 'listOwners', 'reachedBrands', 'appVersion'].includes(fn)) {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'This account opens only Elizabeth’s outreach.' }) });
      }
      try {
        const h = (opts && opts.H && opts.H[fn]) || H[fn];
        body = { ok: true, data: h ? h(args || {}) : {} };
      } catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base0)) return route.abort();
    return route.continue();
  });
  await page.goto(base0 + '/app.html');
  return { page, ctx, errors, dialogs };
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base0 = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const { page, errors, dialogs } = await open(browser, base0);
  const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);
  const text = (sel) => page.textContent(sel);
  await page.waitForSelector('.tabs .nav-item[data-view="elizabeth"]');

  // 1. The tab
  const tabs = await page.$$eval('.tabs.cc-only:not(#sub-tabs) .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(2, 5), ['Outreach', 'Elizabeth', 'In talks']);
  await page.click('.tabs .nav-item[data-view="elizabeth"]');
  await page.waitForSelector('#el-today .el-brand');
  const subs = await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(subs, ['Today', 'Week plan', 'Follow-ups', 'Results']);
  console.log('✓ its own tab next to Outreach, with Today · Week plan · Follow-ups · Results');

  // 2. Today
  assert.deepEqual(await page.$$eval('#el-today .el-bname', (els) => els.map((e) => e.textContent)), ['Alpha Hydrate', 'Beta Beer']);
  assert.match(await text('#el-today-sub'), /3 of 30/);
  assert.match(await text('#el-today-body'), /Zeta Gin.*waits/);
  assert.match(await text('#el-today-body'), /From /, 'a carried brand says where it came from');
  const gmail = await page.getAttribute('[data-el-row="r1"] a[href*="mail.google.com"]', 'href');
  const u = new URL(gmail);
  assert.equal(u.searchParams.get('authuser'), 'liz@example.com', 'her Google account');
  assert.equal(u.searchParams.get('to'), 'ann@alpha.com');
  assert.equal(u.searchParams.get('su'), 'SB Agency × Alpha Hydrate');
  assert.match(u.searchParams.get('body'), /^Hi Ann,/);
  await page.click('[data-el-row="r2"] [data-el-copy="note"]');
  const note = await page.evaluate(() => window.__copied);
  assert.match(note, /^Hi Ben, I’m Elizabeth/);
  assert.ok(note.length <= 300);
  // her own wording for one email
  await page.click('[data-el-row="r1"] .el-mail summary');
  await page.fill('[data-el-body="r1"]', 'Hi Ann — custom.');
  await page.click('#el-today-sub');
  await page.waitForFunction(() => document.querySelector('[data-el-row="r1"] .el-mail summary') && /Her own wording/.test(document.querySelector('[data-el-row="r1"] .el-mail summary').textContent));
  assert.deepEqual(last('elStep').args, { id: 'r1', step: 'save', body: 'Hi Ann — custom.' });
  await page.click('[data-el-row="r1"] .el-mail summary').catch(() => {});
  if (!(await page.isVisible('[data-el-body="r1"]'))) await page.click('[data-el-row="r1"] .el-mail summary');
  await page.fill('[data-el-body="r1"]', 'Hi Ann,\n\nI’m Elizabeth with SB Agency. Alpha Hydrate around our college events?\n\nElizabeth');
  await page.click('#el-today-sub');
  await page.waitForTimeout(150);
  assert.deepEqual(last('elStep').args, { id: 'r1', step: 'save', body: '' }, 'the template’s own text = follow the template');
  // a step
  await page.click('[data-el-row="r1"] [data-el-step="sent"]');
  await page.waitForFunction(() => /Email sent/.test(document.querySelector('[data-el-row="r1"] .el-next').textContent));
  assert.deepEqual(last('elStep').args, { id: 'r1', step: 'sent' });
  // Take off names who comes off first
  await page.click('[data-el-takeoff="bb"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('#el-today .el-bname')].some((e) => e.textContent === 'Beta Beer'));
  assert.match(dialogs[dialogs.length - 1], /Take Beta Beer off her list\?[\s\S]*Gus Gray/);
  assert.equal(last('elTakeOff').args.confirm, true);
  console.log('✓ today: brands in order, Gmail in her account, the invite note, her own wording, a step, Take off asks first');

  // 3. Week plan
  await page.click('#sub-tabs .nav-item[data-view="el-week"]');
  await page.waitForSelector('#el-strip .el-day');
  assert.equal(await page.$$eval('#el-strip .el-day', (els) => els.length), DAYS.length);
  assert.match(await text('#el-strip'), /Alpha Hydrate/);
  assert.match(await text('#el-list'), /Xeno Energy[\s\S]*Fit 81/);
  assert.match(await text('#el-list'), /Do not email/);
  await page.click('[data-el-card="bx"] [data-el-put="bx"][data-el-day="' + DAYS[2] + '"]');
  await page.waitForFunction((d) => document.querySelector('[data-el-card="bx"] [data-el-day="' + d + '"].on'), DAYS[2]);
  assert.deepEqual(last('elPlan').args, { op: 'add', brandId: 'bx', day: DAYS[2], index: null });
  await page.click('[data-el-card="bx"] [data-el-day="' + DAYS[2] + '"].on');
  await page.waitForFunction((d) => !document.querySelector('[data-el-card="bx"] [data-el-day="' + d + '"].on'), DAYS[2]);
  assert.deepEqual(last('elPlan').args, { op: 'remove', brandId: 'bx' });
  await page.fill('#el-q', 'gin');
  await page.waitForFunction(() => /Zeta Gin/.test(document.getElementById('el-list').textContent));
  await page.fill('#el-q', '');
  await page.waitForFunction(() => /Xeno Energy/.test(document.getElementById('el-list').textContent));
  await page.click('#el-spread-go');
  await page.waitForSelector('[data-el-spread-apply]');
  assert.match(await text('#el-spread-box'), /Xeno Energy \(4\)/);
  await page.click('[data-el-spread-apply]');
  await page.waitForFunction(() => !document.querySelector('[data-el-spread-apply]'));
  assert.deepEqual(last('elSpread').args, { apply: true, seed: 99, expect: 'sig' });
  console.log('✓ week plan: day tiles, a button per day (a second click takes it off), search, Fill her week');

  // 4. Follow-ups
  await page.click('#sub-tabs .nav-item[data-view="el-follow"]');
  await page.waitForSelector('#el-follow-chips .chip');
  assert.match(await text('#el-follow-chips'), /To do2/);
  assert.match(await text('[data-el-row="f3"] .el-next'), /2 days late/);
  await page.click('[data-el-row="f1"] [data-el-copy="dm"]');
  assert.equal(await page.evaluate(() => window.__copied), 'Hey Dee, great to be connected. Would love to put something together with Alpha Hydrate.');
  const fu = new URL(await page.getAttribute('[data-el-row="f3"] a[href*="mail.google.com"]', 'href'));
  assert.equal(fu.searchParams.get('su'), 'Re: SB Agency × Alpha Hydrate');
  await page.click('[data-el-row="f1"] [data-el-step="dm"]');
  await page.waitForFunction(() => !document.querySelector('#el-follow-body [data-el-row="f1"]') || /next step/.test(document.querySelector('[data-el-row="f1"] .el-next').textContent));
  assert.deepEqual(last('elStep').args, { id: 'f1', step: 'dm' });
  await page.click('#el-follow-chips [data-el-ff="replied"]');
  await page.waitForSelector('[data-el-row="f2"] [data-el-step="call"]');
  const before = calls.length;
  await page.click('[data-el-row="f2"] [data-el-step="call"]');
  await page.waitForTimeout(100);
  assert.equal(calls.slice(before).filter((c) => c.fn === 'elStep').length, 0, 'no call day, nothing sent');
  const callDay = shift(TODAY, 6);
  await page.fill('[data-el-callday="f2"]', callDay);
  await page.click('[data-el-row="f2"] [data-el-step="call"]');
  await page.waitForFunction(() => document.querySelector('#el-follow-chips .chip.active[data-el-ff="call"]') || !document.querySelector('[data-el-row="f2"] [data-el-step="call"]'));
  assert.deepEqual(last('elStep').args, { id: 'f2', step: 'call', callDay });
  console.log('✓ follow-ups: chips, late, Copy message, the follow-up email, Messaged ✓, Call booked asks for its day');

  // 5. Results
  await page.click('#sub-tabs .nav-item[data-view="el-results"]');
  await page.waitForSelector('#el-results-body .el-stat');
  assert.match(await text('#el-results-body'), /LinkedIn invites[\s\S]*50% of invites/);
  assert.match(await text('#el-results-body'), /Brands she reached \(1\)/);
  console.log('✓ results');

  // 6. A brand's window
  await page.click('#el-results-body [data-el-brand="ba"]');
  await page.waitForSelector('#el-brand-scrim.open .el-person');
  assert.match(await text('#el-brand-body'), /Ann Able[\s\S]*on her list/);
  assert.match(await text('#el-brand-body'), /don't want to continue/);
  await page.click('[data-el-queue="c9"]');
  await page.waitForTimeout(120);
  assert.deepEqual(last('elQueuePeople').args, { brandId: 'ba', contactIds: ['c9'] });
  await page.fill('#elp-name', 'Jo Jones');
  await page.fill('#elp-link', 'linkedin.com/in/jojones');
  await page.click('#elp-addq');
  await page.waitForTimeout(120);
  assert.equal(last('elAddPerson').args.queue, true);
  assert.equal(last('elAddPerson').args.name, 'Jo Jones');
  assert.ok(await page.isVisible('[data-el-full="ba"]'), 'Leo can open the full brand page');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#el-brand-scrim'), false);
  console.log('✓ a brand’s window: people with her status, + Her list, + Add a person');

  // 7. Templates
  await page.click('#sub-tabs .nav-item[data-view="el-today"]');
  await page.click('#el-today [data-el-tpl-open]');
  await page.waitForSelector('#el-tpl-scrim.open');
  await page.click('[data-el-tpltab="note"]');
  assert.equal(await page.isVisible('#el-tsubj'), false, 'a LinkedIn note has no subject');
  assert.match(await text('#el-tcount'), /\/ 300/);
  await page.fill('#el-tbody', 'Hi (NAME) — new note for (BRAND).');
  assert.equal(await text('#el-prev-body'), 'Hi Jamie — new note for Liquid Death.');
  await page.click('#el-tpl-save');
  await page.waitForTimeout(120);
  assert.deepEqual(last('elSaveTemplate').args, { kind: 'note', subject: '', body: 'Hi (NAME) — new note for (BRAND).' });
  await page.keyboard.press('Escape');
  console.log('✓ templates: tabs, the 300 count, preview, Save');

  // 8. Her Reached tag
  await page.click('#sub-tabs .nav-item[data-view="el-today"]');
  await page.waitForFunction(() => document.querySelector('#el-today .rb-tag.el'));
  assert.match(await page.textContent('#el-today .rb-tag.el'), /^Elizabeth /);
  console.log('✓ her own Reached tag');

  // 9. Team
  await page.evaluate(() => gotoView('team'));
  await page.waitForSelector('[data-team-rep="liz@example.com"]');
  assert.equal(await page.$('[data-team-rep="leo@example.com"]'), null, 'never on your own account');
  await page.click('[data-team-rep="liz@example.com"]');
  await page.waitForFunction(() => /outreach only/.test(document.getElementById('team-body').textContent) && document.querySelector('[data-team-rep="liz@example.com"][data-on="0"]'));
  assert.match(dialogs[dialogs.length - 1], /Elizabeth’s outreach only\?/);
  assert.deepEqual(last('setRepAccount').args, { email: 'liz@example.com', on: true });
  console.log('✓ Team: Make it Elizabeth’s outreach only (asks first; never your own)');

  // 11. A phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => gotoView('el-today'));
  await page.waitForSelector('#el-today .el-row');
  let wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll on Today (' + wide + 'px)');
  await page.evaluate(() => gotoView('el-week'));
  await page.waitForSelector('#el-strip .el-day');
  wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll on Week plan (' + wide + 'px)');
  console.log('✓ a phone: no sideways scroll');
  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));

  // 10. Her own account
  const repH = { getMe: () => ({ email: 'liz@example.com', name: 'Elizabeth Q', owner: 'Elizabeth', rep: 'Elizabeth' }) };
  const first = await open(browser, base0, { name: 'liz1', H: repH, repOnly: true });
  await first.page.waitForSelector('#el-today .el-brand');
  await first.page.waitForFunction(() => document.body.classList.contains('rep-only'));
  // Home's refused calls (her first visit starts them before getMe answers)
  // never pull the page off her Today.
  await first.page.waitForTimeout(2500);
  assert.equal(await first.page.evaluate(() => document.querySelector('.view.active').id), 'el-today');
  assert.equal(await first.page.isVisible('#recap'), false, 'no recap');
  assert.equal(await first.page.isVisible('.sidebar'), false);
  assert.equal(await first.page.isVisible('.tabs .nav-item[data-view="dashboard"]'), false, 'no top tabs');
  assert.equal(await first.page.isVisible('#q'), false, 'no search');
  assert.equal(await first.page.isVisible('#sub-tabs .nav-item[data-view="el-week"]'), true, 'her sub-tabs');
  assert.equal(await first.page.evaluate(() => localStorage.getItem('sb.rep')), '1', 'remembered for next time');
  await first.page.click('[data-el-brand="ba"]');
  await first.page.waitForSelector('#el-brand-scrim.open .el-person');
  assert.equal(await first.page.isVisible('[data-el-full="ba"]'), false, 'no full brand page for her');
  await first.page.keyboard.press('Escape');
  await first.page.evaluate(() => loadBrand('ba'));
  await first.page.waitForFunction(() => document.querySelector('.view.active').id === 'el-today');
  await first.page.evaluate(() => gotoView('el-follow'));
  assert.equal(await first.page.isVisible('#rep-home'), true, 'her SB mark in the top bar');
  await first.page.click('#rep-home');
  await first.page.waitForFunction(() => document.querySelector('.view.active').id === 'el-today');
  assert.deepEqual(first.errors, [], 'page errors: ' + first.errors.join(' | '));
  const second = await open(browser, base0, { name: 'liz2', H: repH, hint: true, repOnly: true });
  await second.page.waitForSelector('#el-today .el-brand');
  await second.page.waitForTimeout(800);
  const homeCalls = calls.filter((c) => c.ctx === 'liz2' && ['zachTodo', 'dayRecap', 'getActionQueue', 'getRateCard', 'acceptedPeople', 'weeklyScore'].includes(c.fn));
  assert.deepEqual(homeCalls.map((c) => c.fn), [], 'her next visit makes no Home calls');
  assert.deepEqual(second.errors, [], 'page errors: ' + second.errors.join(' | '));
  // A hint left in a browser that's now Leo's: the whole site comes back.
  const third = await open(browser, base0, { name: 'leo2', hint: true });
  await third.page.waitForFunction(() => !document.body.classList.contains('rep-only') && document.querySelector('.view.active').id === 'dashboard');
  assert.equal(await third.page.isVisible('.tabs .nav-item[data-view="dashboard"]'), true);
  assert.equal(await third.page.isVisible('#rep-home'), false);
  console.log('✓ her own account: only her part, the logo goes to her Today, no Home calls; a full account gets the whole site back');

  console.log('\nelizabeth page: all 11 passed');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
