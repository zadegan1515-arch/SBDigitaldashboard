// scripts/test-instantly.js — Email → Instantly, its own tab (Leo, Nov 16
// 2026: "make this its own tab and make it all cleaner", then "for energy
// drinks I'll have one template, for alcohol companies … one template …
// attach the [Show Board] with the brand's own personal link … both on the
// dashboard and instantly, they should be connected"; src/lib/instantly.ts,
// src/lib/cold-templates.ts) in Chromium against a fake /api/data: the sub-tab
// and the pointer on the Email tab, not connected (the steps to connect, the
// key's name, never a box to type it in), a row per campaign (whose brands,
// its Instantly campaign, whether it says what Templates says and which part
// doesn't), Edit email opening that email on Templates, Create in Instantly
// (asked first), a campaign made by hand given to a row, Use Instantly's
// version / Update Instantly / Update all, another category given a campaign
// of its own, the footer, Review & send (everyone named with the email they
// get, unverified unticked, the confirm says which campaigns are running,
// Send sends only the ticked), a stale answer shown again with the ticks
// kept, Undo (names who comes back first), Sync now and the sync a tab open
// runs by itself, who opened their board link, live updates on / off, an
// error from Instantly, and the phone.
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

// The campaign rows Leo's picks get, as the server sends them, and the names
// of the other categories (a few are enough here).
const MAIN = [
  ['energy', 'Energy drinks', []], ['alcohol', 'Alcohol', ['rtd', 'spirits']], ['nicotine', 'Nicotine', []],
  ['beauty', 'Beauty', []], ['cpg', 'Food, drinks & CPG', ['beverage', 'electrolytes', 'qsr']], ['general', 'Everyone else', []],
];
const OTHERS = [['rtd', 'Beer, Seltzers & Canned Cocktails', 'alcohol'], ['spirits', 'Spirits', 'alcohol'], ['tech', 'Tech & Gadgets', 'general'], ['fintech', 'Fintech', 'general']];
const NAMES = Object.assign({}, Object.fromEntries(MAIN.map((m) => [m[0], m[1]])), Object.fromEntries(OTHERS.map((o) => [o[0], o[1]])));
const firstOf = (key) => (key === 'general' ? 'intro' : 'cat:' + key);
const READY = [
  { contactId: 'r1', targetId: 't1', name: 'Flo Reyes', title: 'Head of Partnerships', brandId: 'b1', brandName: 'Alpha Energy', email: 'flo@alphaenergy.com', why: 'Verified by Hunter', tick: true, cat: 'energy', group: 'noaccept' },
  { contactId: 'r2', targetId: 't2', name: 'Gus Hall', title: 'VP Brand', brandId: 'b3', brandName: 'Gamma Glow', email: 'gus@gammaglow.com', why: 'Hunter couldn’t verify it', tick: false, cat: 'beauty', group: 'noaccept' },
  { contactId: 'r3', targetId: 't3', name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Glow', email: 'hana@gammaglow.com', why: 'Already on file', tick: true, cat: 'beauty', group: 'quiet' },
  // At a brand not reached on LinkedIn yet, with no outreach row: starts unticked, and can only go once Nicotine has a campaign.
  { contactId: 'r4', targetId: null, name: 'Nia New', title: 'Head of Partnerships', brandId: 'b7', brandName: 'Nova Pouch', email: 'nia@novapouch.com', why: 'Verified by Hunter · brand not reached on LinkedIn yet', tick: false, cat: 'nicotine', group: 'fresh' },
  // A beer brand: goes with Alcohol's campaign until Beer has one of its own.
  { contactId: 'r6', targetId: 't6', name: 'Bea Brew', title: 'Brand Manager', brandId: 'b8', brandName: 'Hop House', email: 'bea@hophouse.com', why: 'Verified by Hunter', tick: true, cat: 'rtd', group: 'noaccept' },
];
const S = {};
function reset() {
  Object.assign(S, {
    calls: [], connected: true, error: null, handed: [], stale: false, hook: false, last: null, synced: null, people: [], fail: '', failTpl: '',
    signature: '', ownFirst: {}, noBoard: {},
    // Campaigns in Instantly, and which campaign key each belongs to.
    camps: [
      { id: 'camp-cold', name: 'Cold — Energy', status: 1, statusWord: 'Active', sends: true, dailyLimit: 30, inboxes: 1, steps: 3, warn: [] },
      { id: 'camp-glow', name: 'Beauty test', status: 2, statusWord: 'Paused', sends: false, dailyLimit: 30, inboxes: 1, steps: 3, warn: [WARN] },
      { id: 'camp-own', name: 'My alcohol campaign', status: 0, statusWord: 'Draft', sends: false, dailyLimit: 30, inboxes: 0, steps: 0, warn: [] },
    ],
    link: { energy: 'camp-cold', beauty: 'camp-glow' },
    // [state, newer, parts]
    state: { energy: ['match', null, null], beauty: ['differs', 'instantly', { first: true, follow: false }] },
  });
}
reset();
const camp = (id) => S.camps.find((c) => c.id === id) || null;
const labelOf = (k) => NAMES[k] || k;
const ready = () => READY.filter((r) => !S.handed.includes(r.contactId));
const hasCamp = (k) => !!S.link[k];
// cold-templates.ts campaignKeyOf, for the categories this fake knows.
const goesTo = (cat) => {
  if (hasCamp(cat)) return cat;
  const fam = MAIN.find((m) => m[0] === cat || m[2].includes(cat));
  if (fam && fam[0] !== 'general') return hasCamp(fam[0]) ? fam[0] : null;
  return hasCamp('general') ? 'general' : null;
};
const waitsOn = (cat) => { const fam = MAIN.find((m) => m[0] === cat || m[2].includes(cat)); return fam ? fam[0] : 'general'; };
const rowKeys = () => MAIN.map((m) => m[0]).concat(OTHERS.map((o) => o[0]).filter((k) => S.link[k]));
const groups = () => rowKeys().map((key) => {
  const c = S.link[key] ? camp(S.link[key]) : null;
  const st = S.error ? [c ? 'unknown' : 'none', null, null] : S.state[key] || ['none', null, null];
  const fam = MAIN.find((m) => m[0] === key);
  return {
    key, label: labelOf(key), main: !!fam, first: firstOf(key), also: fam ? fam[2].filter((k) => !S.link[k]) : [],
    subject: 'SB Agency x (BRAND)', own: !!S.ownFirst[key], hasBoard: !S.noBoard[key],
    linked: c ? { id: c.id, name: c.name } : null, campaign: S.error ? null : c,
    state: st[0], newer: st[1], parts: st[2],
  };
});
const others = () => OTHERS.filter((o) => !S.link[o[0]]).map((o) => ({ key: o[0], label: o[1], goesWith: o[2] }));
const status = () => ({
  connected: S.connected, keyName: 'INSTANTLY_API_KEY', scopes: SCOPES,
  campaigns: S.connected && !S.error ? S.camps : null, error: S.error,
  templates: { signature: S.signature, groups: groups(), others: others() },
  counts: { waiting: S.handed.length, sent: 0, replied: S.people.filter((p) => p.state === 'replied').length, bounced: 0, unsubscribed: S.people.filter((p) => p.state === 'unsubscribed').length,
    done: 0, removed: 0, total: S.handed.length + S.people.length, emailed: S.people.length, opened: S.people.filter((p) => p.state === 'opened').length },
  people: S.people, hook: { on: S.hook, at: S.hook ? NOW : null, working: S.hook ? true : null }, sync: S.synced,
  last: S.last,
});
const plan = () => {
  const lines = ready().map((r) => {
    const goes = goesTo(r.cat), tpl = goes || waitsOn(r.cat);
    const c = goes ? camp(S.link[goes]) : null;
    return Object.assign({ source: 'verified', tpl, tplLabel: labelOf(tpl), campaignId: c ? c.id : null }, r,
      c ? { action: 'send' } : { action: 'nocamp', tick: false, why: 'No Instantly campaign for ' + labelOf(tpl) + ' yet — set it up under Templates' });
  }).concat([{ contactId: 'r9', targetId: 't9', name: 'Sy Stop', title: null, brandId: 'b9', brandName: 'Stopped Co', email: 'sy@stopped.com', source: 'onfile', action: 'stopped',
    why: 'Sy said they don’t want to continue', tick: false, group: null, tpl: 'general', tplLabel: 'Everyone else', campaignId: null }]);
  const send = lines.filter((l) => l.action === 'send');
  const campaigns = rowKeys().map((key) => {
    const mine = lines.filter((l) => l.tpl === key && (l.action === 'send' || l.action === 'nocamp'));
    const c = S.link[key] ? camp(S.link[key]) : null;
    return { group: key, label: labelOf(key), people: mine.length, canGo: mine.filter((l) => l.action === 'send').length, id: c ? c.id : null, name: c ? c.name : null, statusWord: c ? c.statusWord : null, sends: c ? c.sends : false };
  }).filter((c) => c.people > 0);
  const byCategory = {};
  ready().forEach((r) => { byCategory[r.cat] = (byCategory[r.cat] || 0) + 1; });
  return { lines, counts: { send: send.length, nocamp: lines.filter((l) => l.action === 'nocamp').length, handed: 0, bad: 0, stopped: 1, ticked: send.filter((r) => r.tick).length,
    brands: new Set(send.map((r) => r.brandId)).size, fresh: send.filter((r) => r.group === 'fresh').length },
    expect: S.stale ? 'new' : 'abc', campaigns, byCategory, connected: true, error: null };
};
// Email → Templates, as listEmailTemplates sends it (the rows this test opens).
const tplRow = (key, extra) => Object.assign({ key, subject: 'SB Agency x (BRAND)', body: 'Hi (NAME),\n\nOur shows.\n\n(BOARD)\n\nBest,\nZach', own: false, at: null, by: null,
  def: { subject: 'SB Agency x (BRAND)', body: 'Hi (NAME),\n\nOur shows.\n\n(BOARD)\n\nBest,\nZach' } }, extra);
const templates = () => {
  const linked = Object.keys(S.link).length;
  const ins = (key) => (S.link[key] ? { key, campaign: camp(S.link[key]).name } : key === 'general' ? null : { goesWith: goesTo(key) || waitsOn(key), label: labelOf(goesTo(key) || waitsOn(key)), has: !!goesTo(key) });
  return {
    general: [
      tplRow('intro', { label: 'First email', instantly: ins('general') }),
      tplRow('followup', { label: 'Follow-up', subject: 're: SB Agency x (BRAND)', body: 'Hi (NAME),\n\nFloating this up.\n\nBest,\nZach', instantly: linked ? { campaigns: linked } : null }),
      tplRow('final', { label: 'Last follow-up', subject: 're: SB Agency x (BRAND)', body: 'Hi (NAME),\n\nLast note.\n\nBest,\nZach', instantly: linked ? { campaigns: linked } : null }),
    ],
    categories: ['energy', 'rtd', 'nicotine', 'beauty', 'tech'].map((c) => tplRow('cat:' + c, { category: c, priority: 'top', instantly: (function () { const i = ins(c); return i && i.goesWith === c ? null : i; })() })),
  };
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
  listEmailTemplates: templates,
  saveEmailTemplate: (a) => tplRow(a.key, { subject: a.subject, body: a.body, own: true, at: NOW, by: 'Leo' }),
  pushInstantlyTemplate: (a) => {
    if (S.failTpl) throw new Error(S.failTpl);
    const pushed = [];
    const push = (key) => {
      let created = false;
      if (!S.link[key]) {
        const c = { id: 'camp-' + key, name: 'SB cold · ' + labelOf(key), status: 0, statusWord: 'Draft', sends: false, dailyLimit: 30, inboxes: 0, steps: 3, warn: ['No inbox is attached — add one in Instantly'] };
        S.camps.push(c); S.link[key] = c.id; created = true;
      }
      S.state[key] = ['match', null, null];
      pushed.push({ group: key, label: labelOf(key), created, campaign: { id: S.link[key], name: camp(S.link[key]).name } });
    };
    if (a.all) Object.keys(S.link).forEach(push); else push(a.key);
    return { pushed, label: a.all ? null : labelOf(a.key) };
  },
  pullInstantlyTemplate: (a) => {
    S.ownFirst[a.key] = true; S.state[a.key] = ['match', null, null];
    return { group: a.key, label: labelOf(a.key), campaign: { id: S.link[a.key], name: camp(S.link[a.key]).name }, changed: [firstOf(a.key)] };
  },
  saveInstantlyFooter: (a) => {
    S.signature = a.signature;
    return { signature: S.signature, pushed: a.push ? Object.keys(S.link).map((k) => ({ group: k, label: labelOf(k), created: false, campaign: { id: S.link[k], name: camp(S.link[k]).name } })) : [] };
  },
  setInstantlyCampaign: (a) => {
    S.link[a.group] = a.campaignId; S.state[a.group] = ['empty', null, null];
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
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  // ---- not connected ----
  S.connected = false;
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadInstantly === 'function');
  // Its own sub-tab under the Email top tab; the Email sub-tab points to it.
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#ins-open');
  assert.equal(await page.$('#email-out #ins-card'), null, 'the card is no longer on the Email tab');
  await page.click('#ins-open');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id === 'instantly');
  assert.equal(await text('.nav-item.active[data-view="instantly"]'), 'Instantly', 'a sub-tab named Instantly, lit');
  assert.equal(await text('#instantly h1'), 'Instantly');
  ok('Instantly is its own tab under Email; the Email sub-tab keeps a one-line pointer to it');

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

  // ---- connected: a row per campaign ----
  S.connected = true;
  await open();
  await page.waitForSelector('#ins-tpls');
  await reads('#ins-ready', '3');
  assert.deepEqual(await page.$$eval('#ins-tpls .ins-g-l b', (els) => els.map((e) => e.textContent)), MAIN.map((m) => m[1]));
  assert.deepEqual(await page.$$eval('#ins-tpls [data-insready]', (els) => els.map((e) => e.textContent)),
    ['1 person ready', '1 person ready', '1 person ready', '2 people ready', '0 people ready', '0 people ready'], 'a beer brand counts on Alcohol’s row, where it will go');
  // Whose brands each takes: a family's other categories; everyone with no campaign of their own.
  assert.equal(await text(row('alcohol') + ' .ins-g-who'), 'with Beer, Seltzers & Canned Cocktails, Spirits');
  assert.equal(await text(row('general') + ' .ins-g-who'), 'every category with no campaign of its own');
  assert.equal(await page.$(row('energy') + ' .ins-g-who'), null);
  assert.match(await text(row('energy')), /Matches Templates/);
  assert.match(await text(row('energy') + ' .ins-g-camp'), /Cold — Energy Active ?sending/);
  assert.equal(await page.$(row('energy') + ' [data-ins="tpl-push"]'), null, 'nothing to do when they match');
  assert.match(await text(row('beauty')), /Differs from Templates ?Changed in Instantly: its first email\./);
  assert.deepEqual(await page.$$eval(row('beauty') + ' .ins-g-st button', (els) => els.map((e) => e.textContent)), ['Update Instantly', 'Use Instantly’s version']);
  assert.match(await text(row('beauty') + ' .ins-g-camp'), /Beauty test Paused ?nothing goes out until you start it in Instantly/);
  assert.match(await text(row('beauty') + ' .ins-warns'), /Open tracking is on/);
  assert.match(await text(row('nicotine') + ' .ins-g-st'), /No campaign yet/);
  assert.equal(await text(row('nicotine') + ' [data-ins="tpl-push"]'), 'Create in Instantly');
  assert.deepEqual(await page.$$eval(row('nicotine') + ' select.ins-link option', (els) => els.map((o) => o.textContent)),
    ['or use one you made…', 'Cold — Energy · Active', 'Beauty test · Paused', 'My alcohol campaign · Draft']);
  // A beer brand waits for Alcohol's campaign, a nicotine brand for Nicotine's.
  assert.match(await text('.ins-go .su-sub'), /have an email, never emailed · 2 more waiting on a campaign/);
  assert.match(await text('#ins-sigline'), /Footer under every email: none yet ?Add one/);
  assert.match(await text('#ins-tpls .ins-backh'), /Each sends its first email, then the two follow-ups, as written on Templates/);
  assert.equal(await page.$('#ins-edit'), null, 'no second editor here — the emails are written on Templates');
  assert.deepEqual(calls('sendToInstantly').pop().args, { perBrand: 3 }, 'the count is the send list’s own (a preview)');
  assert.deepEqual(calls('instantlyStatus').pop().args, { live: true });
  ok('connected: a row per campaign — whose brands go to it, who’s ready, its Instantly campaign and status, and whether it says what Templates says');

  // ---- Edit email opens that email on Templates ----
  await page.click(row('nicotine') + ' [data-ins="tpl-edit"]');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id === 'templates');
  await page.waitForSelector('[data-tplitem="cat:nicotine"] .tpl-ed');
  assert.equal(await page.$$eval('.tpl-ed', (els) => els.length), 1, 'that email, opened');
  assert.match(await text('#tpl-pv'), /https:\/\/shows\.sboyagency\.com\/\?code=[A-Z0-9-]+&p=[A-Z0-9]+/, 'the preview shows a board link of their own');
  assert.match(await text('[data-tplitem="cat:nicotine"] .tpl-btns .fe-dim'), /\(BOARD\) = their own Show Board link/);
  assert.match(await text('#tpl-insnote'), /No Instantly campaign yet — create it on Instantly/);
  assert.equal(await page.$('[data-tplitem="cat:nicotine"] [data-tpl="saveins"]'), null, 'nothing in Instantly to update yet');
  // No (BOARD) in a first email: said as it's typed.
  assert.equal(await page.$eval('#tpl-noboard', (el) => el.hidden), true);
  await page.fill('#tpl-text', 'Hi (NAME),\n\nNo link here.\n\nBest,\nZach');
  assert.equal(await page.$eval('#tpl-noboard', (el) => el.hidden), false);
  assert.match(await text('#tpl-noboard'), /No \(BOARD\) in this email — nobody would get their Show Board link/);
  await page.click('[data-tplitem="cat:nicotine"] [data-tpl="discard"]');
  // A category that goes with its family's campaign says whose email its brands get.
  await page.click('[data-tpl="open"][data-key="cat:rtd"]');
  assert.match(await text('#tpl-insnote'), /In Instantly, Beer, Seltzers & Canned Cocktails brands get the Alcohol email \(once it has a campaign\) until this category has a campaign of its own/);
  // One with a campaign is tagged, and can be saved straight into it.
  assert.equal(await text('[data-tplitem="cat:energy"] .tpl-tag.ins'), 'Instantly: Cold — Energy');
  assert.equal(await text('[data-tplitem="followup"] .tpl-tag.ins'), 'In 2 Instantly campaigns');
  await page.click('[data-tpl="open"][data-key="cat:energy"]');
  await page.fill('#tpl-subject', 'Energy x (BRAND)');
  accept = false;
  await page.click('[data-tplitem="cat:energy"] [data-tpl="saveins"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Replace the emails in Instantly’s “Cold — Energy” with what Templates says now\?/);
  assert.equal(calls('pushInstantlyTemplate').length, 0, 'Cancel writes nothing');
  assert.equal(calls('saveEmailTemplate').length, 0);
  accept = true;
  await page.click('[data-tplitem="cat:energy"] [data-tpl="saveins"]');
  await page.waitForFunction(() => { const b = document.querySelector('[data-tplitem="cat:energy"] [data-tpl="save"]'); return b && b.textContent === 'Save' && b.disabled; });
  assert.deepEqual(calls('saveEmailTemplate').pop().args, { key: 'cat:energy', subject: 'Energy x (BRAND)', body: 'Hi (NAME),\n\nOur shows.\n\n(BOARD)\n\nBest,\nZach' });
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'energy' });
  // A follow-up every campaign shares goes into all of them.
  await page.click('[data-tpl="open"][data-key="followup"]');
  await page.click('[data-tplitem="followup"] [data-tpl="saveins"]');
  await wait(350);
  assert.match(dialogs.slice(-1)[0], /Write this into all 2 Instantly campaigns\?/);
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { all: true });
  // A category in no family goes with Everyone else; its note links back to Instantly.
  await page.click('#templates [data-tpl="open"][data-key="cat:tech"]');
  assert.match(await text('#tpl-insnote'), /In Instantly, Tech & Gadgets brands get the Everyone else email \(once it has a campaign\)/);
  await page.click('#tpl-insnote [data-tpl="toins"]');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id === 'instantly');
  S.state.beauty = ['differs', 'instantly', { first: true, follow: false }];
  await open();
  ok('Edit email opens that email on Templates — the one editor: (BOARD) previewed as a link of their own, a warning without it, where the email goes in Instantly, and Save & update Instantly writes it there after a question');

  // ---- create its campaign in Instantly (asked first) ----
  accept = false;
  await page.click(row('nicotine') + ' [data-ins="tpl-push"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Create a new campaign in Instantly for Nicotine\?/);
  assert.match(dialogs.slice(-1)[0], /made as a draft: nothing goes out until you attach your inbox and start it in Instantly/);
  const made = calls('pushInstantlyTemplate').length;
  accept = true;
  await page.click(row('nicotine') + ' [data-ins="tpl-push"]');
  await has(row('nicotine'), /Matches Templates/);
  assert.equal(calls('pushInstantlyTemplate').length, made + 1, 'Cancel made nothing; the second click did');
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'nicotine' });
  assert.match(await text(row('nicotine') + ' .ins-g-camp'), /SB cold · Nicotine Draft ?nothing goes out until you start it in Instantly/);
  assert.match(await text(row('nicotine') + ' .ins-warns'), /No inbox is attached/);
  await reads('#ins-ready', '4');
  assert.match(await text('.ins-go .su-sub'), /1 more waiting on a campaign/);
  ok('Create in Instantly asks first, makes the campaign as a draft, and its people join the send list');

  // ---- a campaign made in Instantly by hand, given to a row ----
  await page.selectOption(row('alcohol') + ' select.ins-link', 'camp-own');
  await has(row('alcohol'), /No email in its campaign yet/);
  assert.deepEqual(calls('setInstantlyCampaign').pop().args, { campaignId: 'camp-own', group: 'alcohol' });
  assert.match(await text(row('alcohol') + ' .ins-g-camp'), /My alcohol campaign Draft/);
  const pushes = calls('pushInstantlyTemplate').length, asked = dialogs.length;
  await page.click(row('alcohol') + ' [data-ins="tpl-push"]');
  await has(row('alcohol'), /Matches Templates/);
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'alcohol' });
  assert.equal(calls('pushInstantlyTemplate').length, pushes + 1);
  assert.equal(dialogs.length, asked, 'an empty campaign of his own takes the emails without a question');
  // The beer brand now has somewhere to go.
  await reads('#ins-ready', '5');
  await has(row('alcohol') + ' [data-insready]', /^1 person ready$/);
  assert.doesNotMatch(await text('.ins-go .su-sub'), /waiting on a campaign/);
  ok('a campaign he made in Instantly can be given to a row, gets its emails with one click, and the family’s brands go to it');

  // ---- another category gets a campaign of its own ----
  assert.deepEqual(await page.$$eval('#ins-own option', (els) => els.map((o) => o.textContent)), ['Give another category its own campaign…',
    'Beer, Seltzers & Canned Cocktails · 1 ready — now goes with Alcohol', 'Spirits — now goes with Alcohol', 'Tech & Gadgets — now goes with Everyone else', 'Fintech — now goes with Everyone else']);
  accept = false;
  await page.selectOption('#ins-own', 'rtd');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Create a campaign in Instantly just for Beer, Seltzers & Canned Cocktails\?/);
  assert.match(dialogs.slice(-1)[0], /Its brands then get the Beer, Seltzers & Canned Cocktails first email from Templates/);
  assert.equal(calls('pushInstantlyTemplate').pop().args.key, 'alcohol', 'Cancel makes nothing');
  assert.equal(await page.$eval('#ins-own', (el) => el.value), '', 'and the menu goes back');
  accept = true;
  await page.selectOption('#ins-own', 'rtd');
  await page.waitForSelector(row('rtd'));
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'rtd' });
  assert.match(await text(row('rtd')), /Beer, Seltzers & Canned Cocktails ?1 person ready/);
  assert.match(await text(row('rtd') + ' .ins-g-camp'), /SB cold · Beer, Seltzers & Canned Cocktails Draft/);
  assert.equal(await text(row('alcohol') + ' .ins-g-who'), 'with Spirits', 'beer left the family’s campaign');
  await has(row('alcohol') + ' [data-insready]', /^0 people ready$/);
  assert.equal((await page.$$eval('#ins-own option', (els) => els.map((o) => o.textContent))).some((x) => /^Beer/.test(x)), false);
  ok('any other category can be given a campaign of its own (asked first): it gets a row, and its brands leave the family’s campaign');

  // ---- the two differ: take Instantly's, or overwrite it ----
  accept = false;
  await page.click(row('beauty') + ' [data-ins="tpl-pull"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Take what Instantly’s “Beauty test” says as the Beauty first email on Templates\?/);
  assert.doesNotMatch(dialogs.slice(-1)[0], /follow-ups/);
  assert.equal(calls('pullInstantlyTemplate').length, 0);
  accept = true;
  await page.click(row('beauty') + ' [data-ins="tpl-pull"]');
  await has(row('beauty'), /Matches Templates/);
  assert.deepEqual(calls('pullInstantlyTemplate').pop().args, { key: 'beauty' });
  // Its follow-ups changed in Instantly too: the question says that taking them changes everyone's.
  S.state.beauty = ['differs', 'instantly', { first: false, follow: true }];
  await open();
  assert.match(await text(row('beauty')), /Changed in Instantly: its follow-ups\./);
  accept = false;
  await page.click(row('beauty') + ' [data-ins="tpl-pull"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /taking them changes the Follow-up and Last follow-up for every category/);
  // Changed on Templates since: Update Instantly, after a question naming the campaign.
  S.state.beauty = ['differs', 'dashboard', { first: true, follow: true }];
  await open();
  assert.match(await text(row('beauty')), /Changed on Templates: its first email and its follow-ups\./);
  assert.equal(await page.$('#ins-pushall'), null, 'one campaign behind: its own button is enough');
  await page.click(row('beauty') + ' [data-ins="tpl-push"]');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Replace the emails in Instantly’s “Beauty test” with the ones on Templates\?/);
  assert.notDeepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'beauty' });
  accept = true;
  await page.click(row('beauty') + ' [data-ins="tpl-push"]');
  await has(row('beauty'), /Matches Templates/);
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { key: 'beauty' });
  ok('when the two differ the row says which part and whose copy is newer; either can replace the other, each after a question naming both');

  // ---- a shared follow-up changed on Templates: every campaign is behind, one click for all ----
  for (const k of Object.keys(S.link)) S.state[k] = ['differs', 'dashboard', { first: false, follow: true }];
  await open();
  await page.waitForSelector('#ins-pushall');
  assert.equal(await text('#ins-pushall'), 'Update all 5 in Instantly');
  accept = false;
  await page.click('#ins-pushall');
  await wait();
  assert.match(dialogs.slice(-1)[0], /Write the emails on Templates into all 5 campaigns in Instantly\?/);
  assert.notDeepEqual(calls('pushInstantlyTemplate').pop().args, { all: true });
  accept = true;
  await page.click('#ins-pushall');
  await page.waitForFunction(() => !document.getElementById('ins-pushall'));
  assert.deepEqual(calls('pushInstantlyTemplate').pop().args, { all: true });
  assert.equal((await page.$$eval('#ins-tpls .ins-pill', (els) => els.map((e) => e.textContent))).filter((x) => x === 'Matches Templates').length, 5);
  ok('when several campaigns are behind Templates, Update all writes every one after a question');

  // ---- an error from Instantly leaves the row as it was ----
  S.state.energy = ['differs', 'dashboard', { first: true, follow: false }];
  await open();
  S.failTpl = 'The Instantly key is missing a permission — make a new key with the scopes on the card';
  await page.click(row('energy') + ' [data-ins="tpl-push"]');
  await wait(350);
  assert.match(await text(row('energy')), /Differs from Templates/);
  assert.equal(await page.$eval(row('energy') + ' [data-ins="tpl-push"]', (el) => el.disabled), false, 'and it can be tried again');
  S.failTpl = '';
  await page.click(row('energy') + ' [data-ins="tpl-push"]');
  await has(row('energy'), /Matches Templates/);
  ok('a refusal from Instantly leaves the row as it was, to try again');

  // ---- the footer ----
  await page.click('[data-ins="sig-edit"]');
  await page.waitForSelector('#ins-sigbox');
  await page.fill('#ins-sigbox', 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY');
  await page.evaluate(() => insRenderTop());
  assert.equal(await page.$eval('#ins-sigbox', (el) => el.value), 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY', 'kept through a redraw');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ins-sigbox');
  await page.click('[data-ins="sig-save"]');
  await page.waitForSelector('#ins-sigline');
  assert.match(dialogs.slice(-1)[0], /Save the footer and update 5 campaigns in Instantly with it\?/);
  assert.deepEqual(calls('saveInstantlyFooter').pop().args, { signature: 'Zach Goldstein\nCo-CEO, SB Agency\n123 Main St, New York, NY', push: true });
  assert.match(await text('#ins-sigline'), /Zach Goldstein · Co-CEO, SB Agency · 123 Main St, New York, NY ?Edit/);
  ok('one footer under every email: saved, and written into every campaign after a question');

  // ---- review: everyone named, nothing sent ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.deepEqual(await page.$$eval('#ins-pv tbody tr', (rows) => rows.map((r) => [r.cells[1].firstChild.textContent, r.cells[2].firstChild.textContent, r.cells[2].querySelector('.fe-dim').textContent, r.cells[3].textContent, r.querySelector('input').checked])),
    [['Flo Reyes', 'Alpha Energy', 'Energy drinks email', 'flo@alphaenergy.com', true], ['Gus Hall', 'Gamma Glow', 'Beauty email', 'gus@gammaglow.com', false],
      ['Hana Ito', 'Gamma Glow', 'Beauty email', 'hana@gammaglow.com', true], ['Nia New', 'Nova Pouch', 'Nicotine email', 'nia@novapouch.com', false],
      ['Bea Brew', 'Hop House', 'Beer, Seltzers & Canned Cocktails email', 'bea@hophouse.com', true]]);
  assert.match(await text('#ins-pv .fe-pvh'), /5 people at 4 brands could go/);
  assert.match(await text('#ins-when'), /Running: “Cold — Energy” — Instantly starts emailing on its next sending slot/);
  assert.match(await text('#ins-notyet'), /Not started: “SB cold · Nicotine” \(draft\), “Beauty test” \(paused\), “SB cold · Beer, Seltzers & Canned Cocktails” \(draft\) — nothing goes out until you start them in Instantly/);
  assert.equal(await page.$('#ins-missing'), null);
  assert.match(await text('#ins-unsure'), /1 unticked — an address Hunter couldn’t verify/);
  assert.match(await text('#ins-fresh'), /1 at brands not reached on LinkedIn yet start unticked: once Instantly emails a brand, the LinkedIn queue stops picking it by itself/);
  assert.deepEqual(await page.$$eval('#ins-groups .chip', (els) => els.map((e) => [e.textContent, e.classList.contains('active')])),
    [['Didn’t accept · 2 of 3', false], ['Accepted, then no response · 1 of 1', true], ['Not reached out to yet · 0 of 1', false]]);
  assert.match(await text('#ins-pv .fe-skip'), /1 left out/);
  assert.match(await text('#ins-pv .fe-skip'), /Sy Stop · Stopped Co Sy said they don’t want to continue/);
  assert.match(await text('#ins-pv .fe-foot:last-of-type'), /their own Show Board link go to Instantly/);
  assert.equal(await text('#ins-send'), 'Send 3 people to Instantly');
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0);
  assert.deepEqual(calls('sendToInstantly').pop().args, { perBrand: 3 }, 'the same list the Hunter card shows');
  ok('Review names everyone who’d go and the email each gets — unverified unticked, brands not reached yet unticked with why, the stopped left out — and sends nobody');

  // ---- ticks (one, a whole group, all, none), and a dismissed confirm ----
  await page.click('#ins-pv input[data-instick="r3"]');
  assert.equal(await text('#ins-send'), 'Send 2 people to Instantly');
  assert.equal(await text('#ins-groups [data-g="quiet"]'), 'Accepted, then no response · 0 of 1');
  await page.click('#ins-groups [data-g="fresh"]');
  assert.equal(await text('#ins-send'), 'Send 3 people to Instantly');
  assert.equal(await page.$eval('#ins-pv input[data-instick="r4"]', (b) => b.checked), true, 'the chip ticks its group');
  assert.equal(await page.$eval('#ins-groups [data-g="fresh"]', (b) => b.classList.contains('active')), true);
  await page.click('#ins-groups [data-g="fresh"]');
  assert.equal(await page.$eval('#ins-pv input[data-instick="r4"]', (b) => b.checked), false, 'and unticks it again');
  await page.click('[data-ins="ticknone"]');
  assert.equal(await page.$eval('#ins-send', (b) => b.disabled), true);
  await page.click('[data-ins="tickall"]');
  assert.equal(await text('#ins-send'), 'Send 5 people to Instantly');
  await page.click('#ins-pv input[data-instick="r2"]');
  await page.click('#ins-pv input[data-instick="r4"]');
  await page.click('#ins-pv input[data-instick="r6"]');
  accept = false;
  await page.click('#ins-send');
  await wait();
  assert.match(dialogs.slice(-1)[0], /^Send 2 people to Instantly\?/);
  assert.match(dialogs.slice(-1)[0], /• 1 → “Cold — Energy” — running: Instantly starts emailing them on its next sending slot/);
  assert.match(dialogs.slice(-1)[0], /• 1 → “Beauty test” — paused: nothing goes out until you start it in Instantly/);
  assert.doesNotMatch(dialogs.slice(-1)[0], /Nicotine|Beer/, 'only campaigns someone ticked goes to');
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0, 'Cancel on the question sends nobody');
  ok('the Send button and the group chips count the ticks; the question says where each goes and which campaigns are running; Cancel sends nobody');

  // ---- a stale answer: shown again, ticks kept ----
  accept = true;
  S.stale = true;
  await page.click('#ins-send');
  await page.waitForSelector('#ins-pv .fe-warn');
  assert.match(await text('#ins-pv'), /Something changed since you looked/);
  assert.deepEqual(await page.$$eval('#ins-pv tbody input', (els) => els.map((e) => e.checked)), [true, false, true, false, false], 'his ticks are kept');
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
  await reads('#ins-ready', '3');
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
  assert.equal(await text('#ins-send'), 'Send 3 people to Instantly');
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
  await reads('#ins-ready', '4');
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

  // ---- a campaign that's missing: its people wait, named ----
  delete S.link.nicotine; delete S.state.nicotine;
  await open();
  await has('.ins-go .su-sub', /1 more waiting on a campaign/);
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.match(await text('#ins-missing'), /No campaign yet for Nicotine \(1\) — create it above and they’ll show here/);
  assert.match(await text('#ins-pv .fe-skip'), /Nia New · Nova Pouch No Instantly campaign for Nicotine yet/);
  assert.equal(await page.$('#ins-pv input[data-instick="r4"]'), null, 'nobody can be sent to a campaign that isn’t there');
  await page.click('#ins-pv [data-ins="cancel"]');
  ok('people with no campaign to go to yet can’t be ticked; the list says which campaign is missing and where to make it');

  // ---- Instantly says no ----
  S.error = 'Instantly didn’t accept the key — check INSTANTLY_API_KEY in Vercel (it may have been revoked)';
  await open();
  await page.waitForSelector('#ins-err');
  assert.match(await text('#ins-err'), /didn’t accept the key/);
  assert.equal(await page.$('[data-ins="review"]'), null, 'nothing can be sent while Instantly can’t be reached');
  assert.equal(await page.$('#ins-tpls [data-ins="tpl-push"]'), null, 'nor a campaign made');
  assert.equal(await page.$('#ins-own'), null);
  assert.notEqual(await page.$(row('energy') + ' [data-ins="tpl-edit"]'), null, 'an email can still be edited');
  assert.equal(await text('#ins-waiting'), '1', 'what the dashboard knows still shows');
  S.error = null;
  await page.click('#ins-err [data-ins="retry"]');
  await has(row('energy'), /Matches Templates/);
  ok('a refused key is said in words, with nothing to send or create until it’s fixed');

  // ---- a phone ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  await page.setViewportSize({ width: 390, height: 800 });
  await wait(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  const small = await page.$$eval('#ins-card *', (els) => els.filter((el) => el.offsetParent && el.childNodes.length && [].some.call(el.childNodes, (c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11.5).length);
  assert.equal(small, 0, 'no text under 11.5px');
  ok('fits a phone with the list open, no small print');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\n' + n + ' checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
