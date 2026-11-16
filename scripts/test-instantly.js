// scripts/test-instantly.js — Outreach → Instantly, its own tab (Leo, Nov 16
// 2026: "make this its own tab and make it all cleaner", then "for energy
// drinks I'll have one template, for alcohol companies … one template …
// attach the [Show Board] with the brand's own personal link … both on the
// dashboard and instantly, they should be connected"; src/lib/instantly.ts,
// src/lib/cold-templates.ts) in Chromium against a fake /api/data: the sub-tab
// and the pointer on the Email tab, not connected (the steps to connect, the
// key's name, never a box to type it in), a row per template with its
// Instantly campaign and whether the two match, the editor (live preview with
// the person's own board link, a warning without (BOARD), follow-ups added
// and removed, typing kept through a background redraw), Save here only,
// Create in Instantly (asked first), a campaign made by hand given to a
// template, Use Instantly's version / Update Instantly, the signature,
// Review & send (everyone named with their template, unverified unticked,
// the confirm says which campaigns are running, Send sends only the ticked),
// a stale answer shown again with the ticks kept, Undo (names who comes back
// first), Sync now and the sync a tab open runs by itself, who opened their
// board link, live updates on / off, an error from Instantly, and the phone.
//   NODE_PATH=$(npm root -g) node scripts/test-instantly.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Playwright is not installed: NODE_PATH=$(npm root -g) node scripts/test-instantly.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();
const SCOPES = ['campaigns:all', 'leads:all', 'emails:read', 'webhooks:all', 'block_list_entries:all'];
const WARN = 'Open tracking is on — off lands in more inboxes';

// The six template groups, as the server sends them.
const GROUPS = [
  ['energy', 'Energy drinks', ['energy']], ['alcohol', 'Alcohol', ['alcohol', 'rtd', 'spirits']], ['nicotine', 'Nicotine', ['nicotine']],
  ['beauty', 'Beauty', ['beauty']], ['food', 'Food, drinks & CPG', ['cpg', 'beverage', 'electrolytes', 'qsr']], ['general', 'Everyone else', []],
];
const draft = (label) => ({
  subject: '(BRAND) x SB Agency',
  steps: [
    { body: 'Hi (NAME),\n\nI’m Zach from SB Agency. A ' + label + ' line for (BRAND).\n\nHere’s your link to our live show board:\n(BOARD)\n\nBest,', wait: 0 },
    { body: 'Hi (NAME),\n\nFollowing up on my note.\n\nBest,', wait: 3 },
    { body: 'Hi (NAME),\n\nLast note from me.\n\nBest,', wait: 4 },
  ],
});
const READY = [
  { contactId: 'r1', targetId: 't1', name: 'Flo Reyes', title: 'Head of Partnerships', brandId: 'b1', brandName: 'Alpha Energy', email: 'flo@alphaenergy.com', why: 'Verified by Hunter', tick: true, tpl: 'energy', group: 'noaccept' },
  { contactId: 'r2', targetId: 't2', name: 'Gus Hall', title: 'VP Brand', brandId: 'b3', brandName: 'Gamma Glow', email: 'gus@gammaglow.com', why: 'Hunter couldn’t verify it', tick: false, tpl: 'beauty', group: 'noaccept' },
  { contactId: 'r3', targetId: 't3', name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Glow', email: 'hana@gammaglow.com', why: 'Already on file', tick: true, tpl: 'beauty', group: 'quiet' },
  // At a brand not reached on LinkedIn yet, with no outreach row: starts unticked, and can only go once Nicotine has a campaign.
  { contactId: 'r4', targetId: null, name: 'Nia New', title: 'Head of Partnerships', brandId: 'b7', brandName: 'Nova Pouch', email: 'nia@novapouch.com', why: 'Verified by Hunter · brand not reached on LinkedIn yet', tick: false, tpl: 'nicotine', group: 'fresh' },
];
const S = {};
function reset() {
  Object.assign(S, {
    calls: [], connected: true, error: null, handed: [], stale: false, hook: false, last: null, synced: null, people: [], fail: '', failTpl: '',
    signature: 'Zach Goldstein\nCo-CEO, SB Agency',
    tpl: Object.fromEntries(GROUPS.map(([k, label]) => [k, Object.assign({ edited: false }, draft(label))])),
    // Campaigns in Instantly, and which template each belongs to.
    camps: [
      { id: 'camp-cold', name: 'Cold — Energy', status: 1, statusWord: 'Active', sends: true, dailyLimit: 30, inboxes: 1, steps: 3, warn: [] },
      { id: 'camp-glow', name: 'Beauty test', status: 2, statusWord: 'Paused', sends: false, dailyLimit: 30, inboxes: 1, steps: 3, warn: [WARN] },
      { id: 'camp-own', name: 'My alcohol campaign', status: 0, statusWord: 'Draft', sends: false, dailyLimit: 30, inboxes: 0, steps: 0, warn: [] },
    ],
    link: { energy: 'camp-cold', beauty: 'camp-glow' },
    state: { energy: ['match', null], beauty: ['differs', 'instantly'] },
  });
}
reset();
const camp = (id) => S.camps.find((c) => c.id === id) || null;
const labelOf = (k) => GROUPS.find((g) => g[0] === k)[1];
const ready = () => READY.filter((r) => !S.handed.includes(r.contactId));
const groups = () => GROUPS.map(([key, label, categories]) => {
  const t = S.tpl[key], c = S.link[key] ? camp(S.link[key]) : null;
  const st = S.error ? [c ? 'unknown' : 'none', null] : S.state[key] || ['none', null];
  return {
    key, label, categories, subject: t.subject, steps: t.steps, edited: t.edited, at: t.edited ? NOW : null, by: t.edited ? 'Leo' : null,
    hasBoard: /\(BOARD\)/.test(t.steps[0].body), linked: c ? { id: c.id, name: c.name } : null, campaign: S.error ? null : c,
    state: st[0], newer: st[1], theirs: null,
  };
});
const status = () => ({
  connected: S.connected, keyName: 'INSTANTLY_API_KEY', scopes: SCOPES,
  campaigns: S.connected && !S.error ? S.camps : null, error: S.error,
  templates: { signature: S.signature, groups: groups() },
  counts: { waiting: S.handed.length, sent: 0, replied: S.people.filter((p) => p.state === 'replied').length, bounced: 0, unsubscribed: S.people.filter((p) => p.state === 'unsubscribed').length,
    done: 0, removed: 0, total: S.handed.length + S.people.length, emailed: S.people.length, opened: S.people.filter((p) => p.state === 'opened').length },
  people: S.people, hook: { on: S.hook, at: S.hook ? NOW : null, working: S.hook ? true : null }, sync: S.synced,
  last: S.last,
});
const plan = () => {
  const lines = ready().map((r) => {
    const c = S.link[r.tpl] ? camp(S.link[r.tpl]) : null;
    return Object.assign({ source: 'verified', tplLabel: labelOf(r.tpl), campaignId: c ? c.id : null }, r,
      c ? { action: 'send' } : { action: 'nocamp', tick: false, why: 'No Instantly campaign for ' + labelOf(r.tpl) + ' yet — set it up under Templates' });
  }).concat([{ contactId: 'r9', targetId: 't9', name: 'Sy Stop', title: null, brandId: 'b9', brandName: 'Stopped Co', email: 'sy@stopped.com', source: 'onfile', action: 'stopped',
    why: 'Sy said they don’t want to continue', tick: false, group: null, tpl: 'general', tplLabel: 'Everyone else', campaignId: null }]);
  const send = lines.filter((l) => l.action === 'send');
  const campaigns = GROUPS.map(([key, label]) => {
    const mine = lines.filter((l) => l.tpl === key && (l.action === 'send' || l.action === 'nocamp'));
    const c = S.link[key] ? camp(S.link[key]) : null;
    return { group: key, label, people: mine.length, canGo: mine.filter((l) => l.action === 'send').length, id: c ? c.id : null, name: c ? c.name : null, statusWord: c ? c.statusWord : null, sends: c ? c.sends : false };
  }).filter((c) => c.people > 0);
  return { lines, counts: { send: send.length, nocamp: lines.filter((l) => l.action === 'nocamp').length, handed: 0, bad: 0, stopped: 1, ticked: send.filter((r) => r.tick).length,
    brands: new Set(send.map((r) => r.brandId)).size, fresh: send.filter((r) => r.group === 'fresh').length },
    expect: S.stale ? 'new' : 'abc', campaigns, connected: true, error: null };
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  getEmailStatus: () => ({ configured: false }),
  getBrand: (a) => ({ id: a.id || a.brandId, name: 'Gamma Glow', category: 'beauty', tier: 'growth', contacts: [], targets: [], deals: [], notes: [] }),
  noAnswerList: () => ({
    minDays: 21, today: '2026-11-16', counts: { need: 0, needBrands: 0, noaccept: 0, quiet: 0, have: ready().length, handed: S.handed.length, emailed: 0, tooNew: 0, noName: 0, offBrands: 0, waitingBrands: 0, noDomain: 0 },
    people: [], ready: ready().map((r) => Object.assign({ first: r.name.split(' ')[0], last: r.name.split(' ')[1] }, r)), last: null,
  }),
  instantlyStatus: status,
  saveInstantlyTemplate: (a) => {
    if (S.failTpl) throw new Error(S.failTpl);
    if (a.signature !== undefined) S.signature = a.signature;
    if (a.group && a.reset) S.tpl[a.group] = Object.assign({ edited: false }, draft(labelOf(a.group)));
    else if (a.group && (a.subject !== undefined || a.steps !== undefined)) S.tpl[a.group] = { edited: true, subject: a.subject, steps: a.steps };
    const pushed = [];
    const push = (key) => {
      let created = false;
      if (!S.link[key]) {
        const c = { id: 'camp-' + key, name: 'SB cold · ' + labelOf(key), status: 0, statusWord: 'Draft', sends: false, dailyLimit: 30, inboxes: 0, steps: S.tpl[key].steps.length, warn: ['No inbox is attached — add one in Instantly'] };
        S.camps.push(c); S.link[key] = c.id; created = true;
      }
      S.state[key] = ['match', null];
      pushed.push({ group: key, label: labelOf(key), created, campaign: { id: S.link[key], name: camp(S.link[key]).name } });
    };
    if (a.push === 'all') Object.keys(S.link).forEach(push);
    else if (a.push) push(a.group);
    else if (a.group && S.link[a.group]) S.state[a.group] = ['differs', 'dashboard'];
    return { saved: {}, pushed, label: a.group ? labelOf(a.group) : null };
  },
  pullInstantlyTemplate: (a) => {
    S.tpl[a.group] = { edited: true, subject: 'From Instantly', steps: [{ body: 'Hi (NAME),\n\nWritten in Instantly.\n\n(BOARD)\n\nBest,', wait: 0 }] };
    S.state[a.group] = ['match', null];
    return { group: a.group, label: labelOf(a.group) };
  },
  setInstantlyCampaign: (a) => {
    S.link[a.group] = a.campaignId; S.state[a.group] = ['empty', null];
    return { group: a.group, label: labelOf(a.group), campaign: camp(a.campaignId) };
  },
  sendToInstantly: (a) => {
    if (!a.confirm) return Object.assign({ preview: true }, plan());
    if (S.fail) throw new Error(S.fail);
    if (a.expect !== plan().expect) return Object.assign({ applied: false, stale: true }, plan());
    const went = plan().campaigns.map((c) => ({ group: c.group, label: c.label, name: c.name, sends: c.sends, statusWord: c.statusWord,
      sent: plan().lines.filter((l) => l.tpl === c.group && a.ids.includes(l.contactId)).length })).filter((c) => c.sent);
    S.handed = S.handed.concat(a.ids);
    S.last = { at: NOW, by: 'Leo', count: a.ids.length, campaignName: went[0].name + (went.length > 1 ? ' + ' + (went.length - 1) + ' more' : ''), waiting: a.ids.length };
    return { applied: true, sent: a.ids.length, brands: 2, already: [], refused: [{ name: 'Kat Blocked', brandName: 'Block Co', email: 'kat@block.com' }], remaining: 23998,
      campaigns: went, campaignName: went.length > 1 ? went.length + ' campaigns' : went[0].name, sends: went.some((w) => w.sends), waitingToStart: went.filter((w) => !w.sends).map((w) => w.name) };
  },
  undoSendToInstantly: (a) => {
    const goes = [{ name: 'Flo Reyes', brandName: 'Alpha Energy', email: 'flo@alphaenergy.com' }];
    const stays = [{ name: 'Hana Ito', brandName: 'Gamma Glow', email: 'hana@gammaglow.com', why: 'already emailed' }];
    const name = S.last ? S.last.campaignName : '';
    if (!a.confirm) return { preview: true, at: NOW, by: 'Leo', campaignName: name, count: 2, goes, stays };
    S.handed = S.handed.filter((id) => id !== 'r1'); S.last = null;
    return { applied: true, removed: 1, at: NOW, by: 'Leo', campaignName: name, count: 2, goes, stays };
  },
  instantlySync: () => {
    S.synced = { at: NOW, ok: true };
    S.people = [
      { state: 'opened', stateWord: 'Opened the board', email: 'hana@gammaglow.com', note: '2 opens · 4 min on the board', at: NOW, name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Glow', contactId: 'r3' },
      { state: 'replied', stateWord: 'Replied', email: 'hana@gammaglow.com', note: null, at: NOW, name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Glow', contactId: 'r3' },
      { state: 'unsubscribed', stateWord: 'Unsubscribed', email: 'una@x.com', note: null, at: NOW, name: 'Una Sub', title: null, brandId: 'b5', brandName: 'Unsub Co', contactId: 'r5' },
    ];
    return { connected: true, at: NOW, ok: true, sent: 2, replies: 1, bounced: 0, unsubscribed: 1, pulledBack: 1, twins: 0 };
  },
  setInstantlyHook: (a) => { S.hook = !!a.on; return { on: S.hook }; },
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 250));
  const open = async () => { await page.evaluate(() => loadInstantly()); await wait(350); };
  const reads = (sel, v) => page.waitForFunction(([q, want]) => { const el = document.querySelector(q); return !!el && el.textContent.replace(/\s+/g, ' ').trim() === want; }, [sel, v]);
  const has = (sel, re) => page.waitForFunction(([q, src]) => { const el = document.querySelector(q); return !!el && new RegExp(src).test(el.textContent.replace(/\s+/g, ' ')); }, [sel, re.source]);
  const row = (key) => '[data-insg="' + key + '"]';
  const mailPart = (i, cls) => page.$$eval('#ins-edpv .ins-mail', (els, [k, c]) => els[k].querySelector(c).textContent.replace(/\s+/g, ' ').trim(), [i, cls]);
  const mailH = (i) => mailPart(i, '.ins-mail-h');
  const mailB = (i) => mailPart(i, '.ins-mail-b');
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  // ---- not connected ----
  S.connected = false;
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadInstantly === 'function');
  // Its own sub-tab under Outreach; the Email tab points to it.
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#ins-open');
  assert.equal(await page.$('#email-out #ins-card'), null, 'the card is no longer on the Email tab');
  await page.click('#ins-open');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id === 'instantly');
  assert.equal(await text('.nav-item.active[data-view="instantly"]'), 'Instantly', 'a sub-tab named Instantly, lit');
  assert.equal(await text('#instantly h1'), 'Instantly');
  ok('Instantly is its own tab under Outreach; the Email tab keeps a one-line pointer to it');

  await page.waitForSelector('#ins-need');
  const need = await text('#ins-need');
  assert.match(need, /Create API Key/);
  assert.match(need, /INSTANTLY_API_KEY/);
  assert.match(need, /never in a chat/);
  for (const scope of SCOPES) assert.ok(need.includes(scope), scope);
  assert.equal(await page.$('#ins-card input, #ins-card textarea'), null, 'nowhere to type a key into the site');
  assert.equal(await page.$('#ins-card .ins-tiles'), null);
  assert.equal(calls('instantlySync').length, 0);
  ok('not connected: the steps to connect, the variable’s name and the scopes — and no box to type a key into');

  // ---- connected: a row per template ----
  S.connected = true;
  await open();
  await page.waitForSelector('#ins-tpls');
  await reads('#ins-ready', '3');
  assert.deepEqual(await page.$$eval('#ins-tpls .ins-g-l b', (els) => els.map((e) => e.textContent)), GROUPS.map((g) => g[1]));
  assert.deepEqual(await page.$$eval('#ins-tpls .ins-g-l .fe-dim', (els) => els.map((e) => e.textContent)),
    ['1 person ready · Claude’s draft', '0 people ready · Claude’s draft', '1 person ready · Claude’s draft', '2 people ready · Claude’s draft', '0 people ready · Claude’s draft', '0 people ready · Claude’s draft']);
  assert.match(await text(row('energy')), /Matches Instantly/);
  assert.match(await text(row('energy') + ' .ins-g-camp'), /Cold — Energy Active ?sending/);
  assert.equal(await page.$(row('energy') + ' [data-ins="tpl-push"]'), null, 'nothing to do when they match');
  assert.match(await text(row('beauty')), /Differs from Instantly ?It was changed in Instantly\./);
  assert.deepEqual(await page.$$eval(row('beauty') + ' .ins-g-st button', (els) => els.map((e) => e.textContent)), ['Update Instantly', 'Use Instantly’s version']);
  assert.match(await text(row('beauty') + ' .ins-g-camp'), /Beauty test Paused ?nothing goes out until you start it in Instantly/);
  assert.match(await text(row('beauty') + ' .ins-warns'), /Open tracking is on/);
  assert.match(await text(row('nicotine') + ' .ins-g-st'), /No campaign yet/);
  assert.equal(await text(row('nicotine') + ' [data-ins="tpl-push"]'), 'Create in Instantly');
  assert.deepEqual(await page.$$eval(row('nicotine') + ' select.ins-link option', (els) => els.map((o) => o.textContent)),
    ['or use one you made…', 'Cold — Energy · Active', 'Beauty test · Paused', 'My alcohol campaign · Draft']);
  assert.match(await text('.ins-go .su-sub'), /have an email, never emailed · 1 more waiting on a campaign/);
  assert.match(await text('#ins-sigline'), /Zach Goldstein · Co-CEO, SB Agency/);
  assert.deepEqual(calls('sendToInstantly').pop().args, { perBrand: 3 }, 'the count is the send list’s own (a preview)');
  assert.deepEqual(calls('instantlyStatus').pop().args, { live: true });
  ok('connected: a row per template — who’s ready for it, its Instantly campaign and status, and whether the two match');

  // ---- the editor ----
  await page.click(row('nicotine') + ' [data-ins="tpl-edit"]');
  await page.waitForSelector('#ins-edit .ins-editor');
  assert.match(await text('#ins-edit .ins-sech'), /Template · Nicotine/);
  assert.match(await text('#ins-edit .ins-editor > .fe-dim'), /Goes to brands filed under: .*\(BOARD\) — each person’s own Show Board link/);
  assert.equal(await page.$eval('#ins-subj', (el) => el.value), '(BRAND) x SB Agency');
  assert.equal((await page.$$('#ins-edit textarea[data-insf="body"]')).length, 3);
  // The preview is someone real from the send list, with a board link of their own.
  assert.match(await text('#ins-edpv .ins-pvh'), /As Nia at Nova Pouch would read it$/);
  assert.match(await mailH(0), /Subject: Nova Pouch x SB Agency/);
  const first = await mailB(0);
  assert.match(first, /^Hi Nia,/);
  assert.match(first, /https:\/\/shows\.sboyagency\.com\/\?code=[A-Z0-9-]+&p=[A-Z0-9]+/);
  assert.match(first, /Zach Goldstein Co-CEO, SB Agency$/, 'the signature under it');
  assert.equal(first.includes('(BOARD)') || first.includes('(NAME)'), false);
  assert.match(await mailH(1), /Follow-up 1 · 3 days later, same thread/);
  // Typing shows in the preview at once.
  await page.fill('#ins-subj', 'A night for (BRAND)');
  assert.match(await mailH(0), /Subject: A night for Nova Pouch/);
  await page.fill('#ins-edit input[data-insf="wait"][data-i="1"]', '5');
  assert.match(await mailH(1), /5 days later/);
  // No (BOARD) in the first email: said at once.
  assert.equal(await page.$eval('#ins-noboard', (el) => el.hidden), true);
  await page.fill('#ins-edit textarea[data-i="0"]', 'Hi (NAME),\n\nNo link here.\n\nBest,');
  assert.equal(await page.$eval('#ins-noboard', (el) => el.hidden), false);
  await page.fill('#ins-edit textarea[data-i="0"]', 'Hi (NAME),\n\nYour board: (BOARD)\n\nBest,');
  assert.equal(await page.$eval('#ins-noboard', (el) => el.hidden), true);
  // A follow-up removed, one added back.
  await page.click('#ins-edit [data-ins="tpl-dropstep"][data-i="2"]');
  assert.equal((await page.$$('#ins-edit textarea[data-insf="body"]')).length, 2);
  await page.click('#ins-edit [data-ins="tpl-addstep"]');
  assert.equal((await page.$$('#ins-edit textarea[data-insf="body"]')).length, 3);
  assert.equal(await page.$('#ins-edit [data-ins="tpl-addstep"]'), null, 'three emails at most');
  await page.click('#ins-edit [data-ins="tpl-dropstep"][data-i="2"]');
  // A background read (the sync, the count) never takes what's being typed.
  await page.focus('#ins-edit textarea[data-i="1"]');
  await page.evaluate(() => { insRenderTop(); insRenderPeople(); return insLoad(true); });
  await wait();
  assert.equal(await page.$eval('#ins-edit textarea[data-i="0"]', (el) => el.value), 'Hi (NAME),\n\nYour board: (BOARD)\n\nBest,');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-i')), '1', 'the cursor stays where it was');
  assert.equal(await text('#ins-savepush'), 'Save & create in Instantly');
  ok('the editor: subject and up to three emails, a live preview as a real person with their own board link and the signature, a warning without (BOARD) — and typing survives a background read');

  // ---- save here only ----
  await page.click('#ins-edit [data-ins="tpl-save"]');
  await page.waitForFunction(() => !document.querySelector('#ins-edit .ins-editor'));
  assert.deepEqual(calls('saveInstantlyTemplate').pop().args, {
    group: 'nicotine', subject: 'A night for (BRAND)', push: false,
    steps: [{ body: 'Hi (NAME),\n\nYour board: (BOARD)\n\nBest,', wait: 0 }, { body: 'Hi (NAME),\n\nFollowing up on my note.\n\nBest,', wait: 5 }],
  });
  await has(row('nicotine') + ' .ins-g-l .fe-dim', /^1 person ready$/);
  assert.equal(S.link.nicotine, undefined, 'nothing made in Instantly');
  ok('Save here only keeps it on the dashboard — nothing is made in Instantly');

  // ---- create its campaign in Instantly (asked first) ----
  accept = false;
  await page.click(row('nicotine') + ' [data-ins="tpl-push"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Create a new campaign in Instantly for Nicotine\?/);
  assert.match(dialogs.slice(-1)[0], /made as a draft: nothing goes out until you attach your inbox and start it in Instantly/);
  assert.equal(calls('saveInstantlyTemplate').filter((c) => c.args.push).length, 0, 'Cancel makes nothing');
  accept = true;
  await page.click(row('nicotine') + ' [data-ins="tpl-push"]');
  await has(row('nicotine'), /Matches Instantly/);
  assert.deepEqual(calls('saveInstantlyTemplate').pop().args, { group: 'nicotine', push: true });
  assert.match(await text(row('nicotine') + ' .ins-g-camp'), /SB cold · Nicotine Draft ?nothing goes out until you start it in Instantly/);
  assert.match(await text(row('nicotine') + ' .ins-warns'), /No inbox is attached/);
  await reads('#ins-ready', '4');
  assert.doesNotMatch(await text('.ins-go .su-sub'), /waiting on a campaign/);
  ok('Create in Instantly asks first, makes the campaign as a draft, and its people join the send list');

  // ---- a campaign made in Instantly by hand, given to a template ----
  await page.selectOption(row('alcohol') + ' select.ins-link', 'camp-own');
  await has(row('alcohol'), /No email in its campaign yet/);
  assert.deepEqual(calls('setInstantlyCampaign').pop().args, { campaignId: 'camp-own', group: 'alcohol' });
  assert.match(await text(row('alcohol') + ' .ins-g-camp'), /My alcohol campaign Draft/);
  const pushes = calls('saveInstantlyTemplate').length, asked = dialogs.length;
  await page.click(row('alcohol') + ' [data-ins="tpl-push"]');
  await has(row('alcohol'), /Matches Instantly/);
  assert.deepEqual(calls('saveInstantlyTemplate').pop().args, { group: 'alcohol', push: true });
  assert.equal(calls('saveInstantlyTemplate').length, pushes + 1);
  assert.equal(dialogs.length, asked, 'an empty campaign of his own takes the emails without a question');
  ok('a campaign he made in Instantly can be given to a template, and gets its emails with one click');

  // ---- the two differ: take Instantly's, or overwrite it ----
  accept = false;
  await page.click(row('beauty') + ' [data-ins="tpl-pull"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Replace the dashboard’s Beauty template with what’s in Instantly’s “Beauty test”\?/);
  assert.equal(calls('pullInstantlyTemplate').length, 0);
  accept = true;
  await page.click(row('beauty') + ' [data-ins="tpl-pull"]');
  await has(row('beauty'), /Matches Instantly/);
  assert.deepEqual(calls('pullInstantlyTemplate').pop().args, { group: 'beauty' });
  await page.click(row('beauty') + ' [data-ins="tpl-edit"]');
  await page.waitForSelector('#ins-edit .ins-editor');
  assert.equal(await page.$eval('#ins-subj', (el) => el.value), 'From Instantly');
  assert.equal(await text('#ins-savepush'), 'Save & update Instantly');
  // Edited here and saved here only → the dashboard's copy is the newer one.
  await page.fill('#ins-subj', 'Beauty x (BRAND)');
  await page.click('#ins-edit [data-ins="tpl-save"]');
  await has(row('beauty'), /Differs from Instantly ?The dashboard’s copy is newer\./);
  accept = false;
  await page.click(row('beauty') + ' [data-ins="tpl-push"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Replace the emails in Instantly’s “Beauty test” with the dashboard’s Beauty template\?/);
  assert.notDeepEqual(calls('saveInstantlyTemplate').pop().args, { group: 'beauty', push: true });
  accept = true;
  await page.click(row('beauty') + ' [data-ins="tpl-push"]');
  await has(row('beauty'), /Matches Instantly/);
  assert.deepEqual(calls('saveInstantlyTemplate').pop().args, { group: 'beauty', push: true });
  ok('when the two differ the row says whose copy is newer; either can replace the other, each after a question naming both');

  // ---- an error from Instantly while saving keeps the editor open ----
  await page.click(row('energy') + ' [data-ins="tpl-edit"]');
  await page.waitForSelector('#ins-edit .ins-editor');
  await page.fill('#ins-subj', 'Energy x (BRAND)');
  S.failTpl = 'The Instantly key is missing a permission — make a new key with the scopes on the card';
  await page.click('#ins-savepush');
  await wait(350);
  assert.notEqual(await page.$('#ins-edit .ins-editor'), null, 'the editor stays open');
  assert.equal(await page.$eval('#ins-subj', (el) => el.value), 'Energy x (BRAND)', 'with what was typed');
  assert.equal(await page.$eval('#ins-savepush', (el) => el.disabled), false);
  S.failTpl = '';
  await page.click('#ins-edit [data-ins="tpl-close"]');
  await page.waitForFunction(() => !document.querySelector('#ins-edit .ins-editor'));
  ok('a refusal from Instantly while saving leaves the editor open with what was typed');

  // ---- the signature ----
  await page.click('[data-ins="sig-edit"]');
  await page.waitForSelector('#ins-sigbox');
  await page.fill('#ins-sigbox', 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY');
  await page.evaluate(() => insRenderTop());
  assert.equal(await page.$eval('#ins-sigbox', (el) => el.value), 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY', 'kept through a redraw');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ins-sigbox');
  await page.click('[data-ins="sig-save"]');
  await page.waitForSelector('#ins-sigline');
  assert.match(dialogs.slice(-1)[0], /Save the signature and update 4 campaigns in Instantly with it\?/);
  assert.deepEqual(calls('saveInstantlyTemplate').pop().args, { signature: 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY', push: 'all' });
  assert.match(await text('#ins-sigline'), /123 Main St, New York, NY/);
  ok('one signature under every email: saved, and written into every campaign after a question');

  // ---- review: everyone named, nothing sent ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.deepEqual(await page.$$eval('#ins-pv tbody tr', (rows) => rows.map((r) => [r.cells[1].firstChild.textContent, r.cells[2].firstChild.textContent, r.cells[2].querySelector('.fe-dim').textContent, r.cells[3].textContent, r.querySelector('input').checked])),
    [['Flo Reyes', 'Alpha Energy', 'Energy drinks template', 'flo@alphaenergy.com', true], ['Gus Hall', 'Gamma Glow', 'Beauty template', 'gus@gammaglow.com', false],
      ['Hana Ito', 'Gamma Glow', 'Beauty template', 'hana@gammaglow.com', true], ['Nia New', 'Nova Pouch', 'Nicotine template', 'nia@novapouch.com', false]]);
  assert.match(await text('#ins-pv .fe-pvh'), /4 people at 3 brands could go/);
  assert.match(await text('#ins-when'), /Running: “Cold — Energy” — Instantly starts emailing on its next sending slot/);
  assert.match(await text('#ins-notyet'), /Not started: “SB cold · Nicotine” \(draft\), “Beauty test” \(paused\) — nothing goes out until you start them in Instantly/);
  assert.equal(await page.$('#ins-missing'), null);
  assert.match(await text('#ins-unsure'), /1 unticked — an address Hunter couldn’t verify/);
  assert.match(await text('#ins-fresh'), /1 at brands not reached on LinkedIn yet start unticked: once Instantly emails a brand, the LinkedIn queue stops picking it by itself/);
  assert.deepEqual(await page.$$eval('#ins-groups .chip', (els) => els.map((e) => [e.textContent, e.classList.contains('active')])),
    [['Didn’t accept · 1 of 2', false], ['Accepted, then no response · 1 of 1', true], ['Not reached out to yet · 0 of 1', false]]);
  assert.match(await text('#ins-pv .fe-skip'), /1 left out/);
  assert.match(await text('#ins-pv .fe-skip'), /Sy Stop · Stopped Co Sy said they don’t want to continue/);
  assert.match(await text('#ins-pv .fe-foot:last-of-type'), /their own Show Board link go to Instantly/);
  assert.equal(await text('#ins-send'), 'Send 2 people to Instantly');
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0);
  assert.deepEqual(calls('sendToInstantly').pop().args, { perBrand: 3 }, 'the same list the Hunter card shows');
  ok('Review names everyone who’d go and the template each gets — unverified unticked, brands not reached yet unticked with why, the stopped left out — and sends nobody');

  // ---- ticks (one, a whole group, all, none), and a dismissed confirm ----
  await page.click('#ins-pv input[data-instick="r3"]');
  assert.equal(await text('#ins-send'), 'Send 1 person to Instantly');
  assert.equal(await text('#ins-groups [data-g="quiet"]'), 'Accepted, then no response · 0 of 1');
  await page.click('#ins-groups [data-g="fresh"]');
  assert.equal(await text('#ins-send'), 'Send 2 people to Instantly');
  assert.equal(await page.$eval('#ins-pv input[data-instick="r4"]', (b) => b.checked), true, 'the chip ticks its group');
  assert.equal(await page.$eval('#ins-groups [data-g="fresh"]', (b) => b.classList.contains('active')), true);
  await page.click('#ins-groups [data-g="fresh"]');
  assert.equal(await page.$eval('#ins-pv input[data-instick="r4"]', (b) => b.checked), false, 'and unticks it again');
  await page.click('[data-ins="ticknone"]');
  assert.equal(await page.$eval('#ins-send', (b) => b.disabled), true);
  await page.click('[data-ins="tickall"]');
  assert.equal(await text('#ins-send'), 'Send 4 people to Instantly');
  await page.click('#ins-pv input[data-instick="r2"]');
  await page.click('#ins-pv input[data-instick="r4"]');
  accept = false;
  await page.click('#ins-send');
  await wait();
  assert.match(dialogs.slice(-1)[0], /^Send 2 people to Instantly\?/);
  assert.match(dialogs.slice(-1)[0], /• 1 → “Cold — Energy” — running: Instantly starts emailing them on its next sending slot/);
  assert.match(dialogs.slice(-1)[0], /• 1 → “Beauty test” — paused: nothing goes out until you start it in Instantly/);
  assert.doesNotMatch(dialogs.slice(-1)[0], /Nicotine/, 'only campaigns someone ticked goes to');
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0, 'Cancel on the question sends nobody');
  ok('the Send button and the group chips count the ticks; the question says where each goes and which campaigns are running; Cancel sends nobody');

  // ---- a stale answer: shown again, ticks kept ----
  accept = true;
  S.stale = true;
  await page.click('#ins-send');
  await page.waitForSelector('#ins-pv .fe-warn');
  assert.match(await text('#ins-pv'), /Something changed since you looked/);
  assert.deepEqual(await page.$$eval('#ins-pv tbody input', (els) => els.map((e) => e.checked)), [true, false, true, false], 'his ticks are kept');
  assert.deepEqual(S.handed, []);
  ok('a stale answer shows the list again with the ticks kept, and sends nobody');

  // ---- send ----
  await page.click('#ins-send');
  await page.waitForSelector('#ins-last');
  const sendCall = calls('sendToInstantly').filter((c) => c.args.confirm).pop().args;
  assert.deepEqual(sendCall, { ids: ['r1', 'r3'], confirm: true, expect: 'new', perBrand: 3 });
  assert.equal(await page.$('#ins-pv .fe-table'), null);
  assert.match(await text('#ins-note'), /Sent 2 people at 2 brands: 1 to “Cold — Energy”, 1 to “Beauty test”\./);
  assert.match(await text('#ins-note'), /Not started yet: “Beauty test” — start it in Instantly when you’re ready\./);
  assert.match(await text('#ins-note'), /1 Instantly wouldn’t take .*Kat Blocked/);
  assert.match(await text('#ins-note'), /23998 lead uploads left/);
  assert.equal(await text('#ins-waiting'), '2');
  await reads('#ins-ready', '2');
  assert.match(await text('#ins-last'), /Last sent: 2 people to “Cold — Energy \+ 1 more”.*by Leo/);
  assert.equal(await text('.ins-foot [data-ins="undo"]'), 'Undo (2 not emailed yet)');
  ok('Send sends exactly the ticked people; the page says how many went to each campaign, which still need starting, and what Instantly refused');

  // ---- an error on send is said, nothing lost ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  await page.click('[data-ins="tickall"]');
  S.stale = false; S.fail = 'Instantly says this workspace has no active paid plan';
  await page.click('#ins-send');
  await wait();
  assert.notEqual(await page.$('#ins-pv .fe-table'), null, 'the list stays open');
  assert.equal(await text('#ins-send'), 'Send 2 people to Instantly');
  S.fail = '';
  await page.click('#ins-pv [data-ins="cancel"]');
  ok('a refusal from Instantly leaves the list open to try again');

  // ---- undo ----
  accept = false;
  await page.click('[data-ins="undo"]');
  await wait(400);
  assert.match(dialogs.slice(-1)[0], /Take 1 person back out of “Cold — Energy \+ 1 more”\?/);
  assert.match(dialogs.slice(-1)[0], /• Flo Reyes \(Alpha Energy\)/);
  assert.match(dialogs.slice(-1)[0], /1 person stays — already emailed/);
  assert.equal(calls('undoSendToInstantly').filter((c) => c.args.confirm).length, 0);
  accept = true;
  await page.click('[data-ins="undo"]');
  await page.waitForFunction(() => !document.getElementById('ins-last'));
  assert.equal(calls('undoSendToInstantly').filter((c) => c.args.confirm).length, 1);
  assert.match(await text('#ins-note'), /Took 1 person back out of Instantly/);
  assert.equal(await text('#ins-waiting'), '1');
  await reads('#ins-ready', '3');
  ok('Undo names who comes back out and who stays before it takes anyone out');

  // ---- sync now, who opened their board, who replied ----
  const before = calls('instantlySync').length;
  await page.click('[data-ins="sync"]');
  await page.waitForSelector('#ins-backlist');
  assert.equal(calls('instantlySync').length, before + 1);
  assert.equal(await text('#ins-opened'), '1');
  assert.equal(await text('#ins-replied'), '1');
  assert.equal(await text('#ins-unsub'), '1');
  assert.match(await text('#ins-syncline'), /Last read/);
  assert.deepEqual(await page.$$eval('#ins-people .chip', (els) => els.map((e) => [e.textContent, e.classList.contains('active')])),
    [['Opened the board · 1', true], ['Replied · 1', false], ['Unsubscribed · 1', false]]);
  assert.deepEqual(await page.$$eval('#ins-backlist thead th', (els) => els.map((e) => e.textContent)), ['Person', 'Brand', 'Email', 'When', 'On the board']);
  assert.deepEqual(await page.$$eval('#ins-backlist tbody tr', (rows) => rows.map((r) => [r.cells[0].firstChild.textContent, r.cells[4].textContent])), [['Hana Ito', '2 opens · 4 min on the board']]);
  assert.match(await text('#ins-people'), /can be a mail scanner checking the link/);
  await page.click('#ins-people .chip[data-s="unsubscribed"]');
  assert.deepEqual(await page.$$eval('#ins-backlist tbody tr', (rows) => rows.map((r) => r.cells[0].firstChild.textContent)), ['Una Sub']);
  await page.click('#ins-people .chip[data-s="replied"]');
  await page.click('#ins-people [data-brand="b3"]');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id !== 'instantly');
  assert.deepEqual(calls('getBrand').pop().args.id || calls('getBrand').pop().args.brandId, 'b3');
  ok('Sync now reads Instantly; who opened their own board link, replied or unsubscribed is one list with a chip each, and a name opens their brand page');

  // ---- opening the tab syncs by itself, at most every ten minutes ----
  await page.evaluate(() => gotoView('instantly'));
  await wait(400);
  const auto = calls('instantlySync').length;
  await open();
  assert.equal(calls('instantlySync').length, auto, 'not again inside ten minutes');
  await page.evaluate(() => localStorage.setItem('sb.insSync', String(Date.now() - 11 * 60 * 1000)));
  await open();
  await wait(300);
  assert.equal(calls('instantlySync').length, auto + 1);
  ok('opening the tab reads Instantly by itself — at most every ten minutes');

  // ---- live updates ----
  assert.match(await text('#ins-syncline'), /Live updates off/);
  await page.click('[data-ins="hookon"]');
  await page.waitForSelector('[data-ins="hookoff"]');
  assert.deepEqual(calls('setInstantlyHook').pop().args, { on: true });
  assert.match(await text('#ins-syncline'), /Live updates on/);
  accept = false;
  await page.click('[data-ins="hookoff"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Turn live updates off\?/);
  assert.equal(calls('setInstantlyHook').length, 1);
  accept = true;
  await page.click('[data-ins="hookoff"]');
  await page.waitForSelector('[data-ins="hookon"]');
  assert.deepEqual(calls('setInstantlyHook').pop().args, { on: false });
  ok('live updates turn on with one click and off after a question');

  // ---- a template with no campaign: its people wait, named ----
  delete S.link.nicotine; delete S.state.nicotine;
  await open();
  await has('.ins-go .su-sub', /1 more waiting on a campaign/);
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.match(await text('#ins-missing'), /No campaign yet for Nicotine \(1\) — create it under Templates and they’ll show here/);
  assert.match(await text('#ins-pv .fe-skip'), /Nia New · Nova Pouch No Instantly campaign for Nicotine yet/);
  assert.equal(await page.$('#ins-pv input[data-instick="r4"]'), null, 'nobody can be sent to a campaign that isn’t there');
  await page.click('#ins-pv [data-ins="cancel"]');
  ok('people whose template has no campaign yet can’t be ticked; the list says which template and where to make it');

  // ---- Instantly says no ----
  S.error = 'Instantly didn’t accept the key — check INSTANTLY_API_KEY in Vercel (it may have been revoked)';
  await open();
  await page.waitForSelector('#ins-err');
  assert.match(await text('#ins-err'), /didn’t accept the key/);
  assert.equal(await page.$('[data-ins="review"]'), null, 'nothing can be sent while Instantly can’t be reached');
  assert.equal(await page.$('#ins-tpls [data-ins="tpl-push"]'), null, 'nor a campaign made');
  assert.notEqual(await page.$(row('energy') + ' [data-ins="tpl-edit"]'), null, 'a template can still be edited');
  assert.equal(await text('#ins-waiting'), '1', 'what the dashboard knows still shows');
  S.error = null;
  await page.click('#ins-err [data-ins="retry"]');
  await has(row('energy'), /Matches Instantly/);
  ok('a refused key is said in words, with nothing to send or create until it’s fixed');

  // ---- a phone ----
  await page.click(row('energy') + ' [data-ins="tpl-edit"]');
  await page.waitForSelector('#ins-edit .ins-editor');
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  await page.setViewportSize({ width: 390, height: 800 });
  await wait(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  const small = await page.$$eval('#ins-card *', (els) => els.filter((el) => el.offsetParent && el.childNodes.length && [].some.call(el.childNodes, (c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11.5).length);
  assert.equal(small, 0, 'no text under 11.5px');
  ok('fits a phone with the editor and the list open, no small print');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\n' + n + ' checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
