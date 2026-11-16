// scripts/test-instantly.js — Outreach → Email's "Send them through Instantly"
// card (Leo, Nov 16 2026; src/lib/instantly.ts) in Chromium against a fake
// /api/data: not connected (the steps to connect, the key's name, never a
// box to type it in), picking the campaign, Review & send (everyone named,
// unverified unticked, the confirm says whether the campaign is running,
// Send sends only the ticked), a stale answer shown again with the ticks
// kept, Undo (names who comes back first), Sync now and the sync a tab open
// runs by itself, live updates on / off, who replied opening their brand
// page, an error from Instantly, and the phone width.
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

const CAMPS = [
  { id: 'camp-cold', name: 'Cold — no answer', status: 1, statusWord: 'Active', sends: true, dailyLimit: 30, inboxes: 1, steps: 3, warn: [] },
  { id: 'camp-wait', name: 'Not started', status: 2, statusWord: 'Paused', sends: false, dailyLimit: 30, inboxes: 1, steps: 3, warn: ['Open tracking is on — off lands in more inboxes'] },
];
const READY = [
  { contactId: 'r1', targetId: 't1', name: 'Flo Reyes', title: 'Head of Partnerships', brandId: 'b1', brandName: 'Alpha Energy', email: 'flo@alphaenergy.com', why: 'Verified by Hunter', tick: true },
  { contactId: 'r2', targetId: 't2', name: 'Gus Hall', title: 'VP Brand', brandId: 'b3', brandName: 'Gamma Drinks', email: 'gus@gammadrinks.com', why: 'Hunter couldn’t verify it', tick: false },
  { contactId: 'r3', targetId: 't3', name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Drinks', email: 'hana@gammadrinks.com', why: 'Already on file', tick: true },
  // At a brand not reached on LinkedIn yet, with no outreach row: can go, starts unticked.
  { contactId: 'r4', targetId: null, name: 'Nia New', title: 'Head of Partnerships', brandId: 'b7', brandName: 'Nova Pouch', email: 'nia@novapouch.com', why: 'Verified by Hunter · brand not reached on LinkedIn yet', tick: false, group: 'fresh' },
];
const S = {};
function reset() {
  Object.assign(S, { calls: [], connected: true, chosen: null, error: null, handed: [], stale: false, hook: false, last: null, synced: null, people: [], fail: '' });
}
reset();
const ready = () => READY.filter((r) => !S.handed.includes(r.contactId));
const campaign = () => CAMPS.find((c) => S.chosen && c.id === S.chosen) || null;
const status = () => ({
  connected: S.connected, keyName: 'INSTANTLY_API_KEY', scopes: ['campaigns:read', 'leads:all', 'emails:read', 'webhooks:all', 'block_list_entries:all'],
  chosen: campaign() ? { id: campaign().id, name: campaign().name } : null, campaign: S.error ? null : campaign(), campaignGone: false,
  campaigns: S.connected && !S.error ? CAMPS : null, error: S.error,
  counts: { waiting: S.handed.length, sent: 0, replied: S.people.filter((p) => p.state === 'replied').length, bounced: 0, unsubscribed: S.people.filter((p) => p.state === 'unsubscribed').length, done: 0, removed: 0, total: S.handed.length + S.people.length, emailed: S.people.length },
  people: S.people, hook: { on: S.hook, at: S.hook ? NOW : null, working: S.hook ? true : null }, sync: S.synced,
  last: S.last,
});
const plan = () => {
  const lines = ready().map((r) => Object.assign({ source: 'verified', action: 'send', group: r.contactId === 'r3' ? 'quiet' : 'noaccept' }, r))
    .concat([{ contactId: 'r9', targetId: 't9', name: 'Sy Stop', title: null, brandId: 'b9', brandName: 'Stopped Co', email: 'sy@stopped.com', source: 'onfile', action: 'stopped', why: 'Sy said they don’t want to continue', tick: false, group: null }]);
  return { lines, counts: { send: ready().length, handed: 0, bad: 0, stopped: 1, ticked: ready().filter((r) => r.tick).length, brands: new Set(ready().map((r) => r.brandId)).size, fresh: ready().filter((r) => r.group === 'fresh').length },
    expect: S.stale ? 'new' : 'abc', campaign: campaign(), connected: true, chosen: campaign() ? { id: campaign().id, name: campaign().name } : null, error: null };
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }), getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}), appVersion: () => ({ sha: 'test' }),
  getEmailStatus: () => ({ configured: false }),
  getBrand: (a) => ({ id: a.id || a.brandId, name: 'Alpha Energy', category: 'energy', tier: 'growth', contacts: [], targets: [], deals: [], notes: [] }),
  noAnswerList: () => ({
    minDays: 21, today: '2026-11-16', counts: { need: 0, needBrands: 0, noaccept: 0, quiet: 0, have: ready().length, handed: S.handed.length, emailed: 0, tooNew: 0, noName: 0, offBrands: 0, waitingBrands: 0, noDomain: 0 },
    people: [], ready: ready().map((r) => Object.assign({ first: r.name.split(' ')[0], last: r.name.split(' ')[1], group: 'noaccept' }, r)), last: null,
  }),
  instantlyStatus: status,
  setInstantlyCampaign: (a) => { S.chosen = a.campaignId; return { campaign: campaign() }; },
  sendToInstantly: (a) => {
    if (!a.confirm) return Object.assign({ preview: true }, plan());
    if (S.fail) throw new Error(S.fail);
    if (a.expect !== plan().expect) return Object.assign({ applied: false, stale: true }, plan());
    const c = campaign();
    S.handed = S.handed.concat(a.ids);
    S.last = { at: NOW, by: 'Leo', count: a.ids.length, campaignName: c.name, waiting: a.ids.length };
    return { applied: true, sent: a.ids.length, brands: 2, already: [], refused: [{ name: 'Kat Blocked', brandName: 'Block Co', email: 'kat@block.com' }], remaining: 23998, campaignName: c.name, sends: c.sends, statusWord: c.statusWord };
  },
  undoSendToInstantly: (a) => {
    const goes = [{ name: 'Flo Reyes', brandName: 'Alpha Energy', email: 'flo@alphaenergy.com' }];
    const stays = [{ name: 'Hana Ito', brandName: 'Gamma Drinks', email: 'hana@gammadrinks.com', why: 'already emailed' }];
    if (!a.confirm) return { preview: true, at: NOW, by: 'Leo', campaignName: 'Cold — no answer', count: 2, goes, stays };
    S.handed = S.handed.filter((id) => id !== 'r1'); S.last = null;
    return { applied: true, removed: 1, at: NOW, by: 'Leo', campaignName: 'Cold — no answer', count: 2, goes, stays };
  },
  instantlySync: () => {
    S.synced = { at: NOW, ok: true };
    S.people = [
      { state: 'replied', stateWord: 'Replied', email: 'hana@gammadrinks.com', note: null, at: NOW, name: 'Hana Ito', title: 'Events Lead', brandId: 'b3', brandName: 'Gamma Drinks', contactId: 'r3' },
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
  const open = async () => { await page.evaluate(() => loadEmailOutreach()); await wait(350); };
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  // ---- not connected ----
  S.connected = false;
  await page.goto(base + '/app.html');
  await page.waitForFunction(() => typeof window.loadEmailOutreach === 'function');
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('#ins-need');
  const need = await text('#ins-need');
  assert.match(need, /Create API Key/);
  assert.match(need, /INSTANTLY_API_KEY/);
  assert.match(need, /never in a chat/);
  for (const scope of ['campaigns:read', 'leads:all', 'emails:read', 'webhooks:all', 'block_list_entries:all']) assert.ok(need.includes(scope), scope);
  assert.equal(await page.$('#ins-card input, #ins-card textarea'), null, 'nowhere to type a key into the site');
  assert.equal(await page.$('#ins-card .ins-tiles'), null);
  assert.equal(calls('instantlySync').length, 0);
  ok('not connected: the steps to connect, the variable’s name and the scopes — and no box to type a key into');

  // ---- connected, no campaign yet ----
  S.connected = true;
  await open();
  await page.waitForSelector('#ins-pick');
  assert.deepEqual(await page.$$eval('#ins-pick option', (els) => els.map((o) => o.textContent)), ['Pick a campaign…', 'Cold — no answer · Active', 'Not started · Paused']);
  assert.equal(await text('#ins-ready'), '4');
  assert.equal(await page.$('[data-ins="review"]'), null, 'no Review button before a campaign is picked');
  assert.match(await text('.ins-go .su-sub'), /pick a campaign first/);
  assert.deepEqual(calls('instantlyStatus').pop().args, { live: true });
  ok('connected: its campaigns in a menu with their status; nothing can be sent before one is picked');

  // ---- pick the campaign ----
  await page.selectOption('#ins-pick', 'camp-cold');
  await page.waitForSelector('[data-ins="review"]');
  assert.deepEqual(calls('setInstantlyCampaign').pop().args, { campaignId: 'camp-cold' });
  assert.match(await text('#ins-camp'), /Active/);
  assert.match(await text('#ins-camp'), /on its next sending slot/);
  assert.equal(await page.$('#ins-warn'), null);
  ok('picking a campaign saves it and says it’s running');

  // ---- review: everyone named, nothing sent ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.deepEqual(await page.$$eval('#ins-pv tbody tr', (rows) => rows.map((r) => [r.cells[1].firstChild.textContent, r.cells[2].textContent, r.cells[3].textContent, r.querySelector('input').checked])),
    [['Flo Reyes', 'Alpha Energy', 'flo@alphaenergy.com', true], ['Gus Hall', 'Gamma Drinks', 'gus@gammadrinks.com', false], ['Hana Ito', 'Gamma Drinks', 'hana@gammadrinks.com', true],
      ['Nia New', 'Nova Pouch', 'nia@novapouch.com', false]]);
  assert.match(await text('#ins-pv .fe-pvh'), /4 people at 3 brands could go/);
  assert.match(await text('#ins-when'), /This campaign is running/);
  assert.match(await text('#ins-unsure'), /1 unticked — an address Hunter couldn’t verify/);
  assert.match(await text('#ins-fresh'), /1 at brands not reached on LinkedIn yet start unticked: once Instantly emails a brand, the LinkedIn queue stops picking it by itself/);
  assert.deepEqual(await page.$$eval('#ins-groups .chip', (els) => els.map((e) => [e.textContent, e.classList.contains('active')])),
    [['Didn’t accept · 1 of 2', false], ['Accepted, then no response · 1 of 1', true], ['Not reached out to yet · 0 of 1', false]]);
  assert.match(await text('#ins-pv .fe-skip'), /1 left out/);
  assert.match(await text('#ins-pv .fe-skip'), /Sy Stop · Stopped Co Sy said they don’t want to continue/);
  assert.equal(await text('#ins-send'), 'Send 2 people to Instantly');
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0);
  assert.deepEqual(calls('sendToInstantly').pop().args, { perBrand: 3 }, 'the same list the Hunter card shows');
  ok('Review names everyone who’d go — unverified unticked, brands not reached yet unticked with why, the stopped left out — and sends nobody');

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
  assert.match(dialogs.slice(-1)[0], /Send 2 people to “Cold — no answer” in Instantly\?/);
  assert.match(dialogs.slice(-1)[0], /The campaign is running — Instantly starts emailing them/);
  assert.equal(calls('sendToInstantly').filter((c) => c.args.confirm).length, 0, 'Cancel on the question sends nobody');
  ok('the Send button and the group chips count the ticks; the question names the campaign and says it’s running; Cancel sends nobody');

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
  assert.match(await text('#ins-note'), /Sent 2 people at 2 brands to “Cold — no answer”\./);
  assert.match(await text('#ins-note'), /1 Instantly wouldn’t take .*Kat Blocked/);
  assert.match(await text('#ins-note'), /23998 lead uploads left/);
  assert.equal(await text('#ins-waiting'), '2');
  assert.equal(await text('#ins-ready'), '2');
  assert.match(await text('#ins-last'), /Last sent: 2 people to “Cold — no answer”.*by Leo.*Undo \(2 not emailed yet\)/);
  assert.equal(await text('#fe-have'), '2 people', 'the Hunter card’s count follows');
  ok('Send sends exactly the ticked people; the card says what went, what Instantly refused, and counts them');

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
  assert.match(dialogs.slice(-1)[0], /Take 1 person back out of “Cold — no answer”\?/);
  assert.match(dialogs.slice(-1)[0], /• Flo Reyes \(Alpha Energy\)/);
  assert.match(dialogs.slice(-1)[0], /1 person stays — already emailed/);
  assert.equal(calls('undoSendToInstantly').filter((c) => c.args.confirm).length, 0);
  accept = true;
  await page.click('[data-ins="undo"]');
  await page.waitForFunction(() => !document.getElementById('ins-last'));
  assert.equal(calls('undoSendToInstantly').filter((c) => c.args.confirm).length, 1);
  assert.match(await text('#ins-note'), /Took 1 person back out of Instantly/);
  assert.equal(await text('#ins-waiting'), '1');
  assert.equal(await text('#ins-ready'), '3');
  ok('Undo names who comes back out and who stays before it takes anyone out');

  // ---- sync now, and who replied ----
  const before = calls('instantlySync').length;
  await page.click('[data-ins="sync"]');
  await page.waitForSelector('#ins-people details');
  assert.equal(calls('instantlySync').length, before + 1);
  assert.equal(await text('#ins-replied'), '1');
  assert.equal(await text('#ins-unsub'), '1');
  assert.match(await text('#ins-syncline'), /Last read/);
  assert.deepEqual(await page.$$eval('#ins-people summary', (els) => els.map((e) => e.textContent)), ['Replied · 1', 'Unsubscribed · 1']);
  await page.click('#ins-people details[data-insfold="replied"] summary');
  await page.click('#ins-people [data-brand="b3"]');
  await page.waitForFunction(() => document.querySelector('.view.active') && document.querySelector('.view.active').id !== 'email-out');
  assert.deepEqual(calls('getBrand').pop().args.id || calls('getBrand').pop().args.brandId, 'b3');
  ok('Sync now reads Instantly; who replied or unsubscribed is listed, and a name opens their brand page');

  // ---- opening the tab syncs by itself, at most every ten minutes ----
  await page.evaluate(() => gotoView('email-out'));
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

  // ---- a campaign that isn't running ----
  await page.selectOption('#ins-pick', 'camp-wait');
  await page.waitForSelector('#ins-warn');
  assert.match(await text('#ins-camp'), /Paused/);
  assert.match(await text('#ins-camp'), /Nothing goes out until you start it in Instantly/);
  assert.match(await text('#ins-warn'), /Open tracking is on/);
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  assert.match(await text('#ins-when'), /This campaign is paused: nothing goes out until you start it in Instantly/);
  accept = false;
  await page.click('#ins-send');
  await wait();
  assert.match(dialogs.slice(-1)[0], /The campaign is paused — nothing goes out until you start it in Instantly/);
  accept = true;
  await page.click('#ins-pv [data-ins="cancel"]');
  ok('a paused campaign says nothing goes out until it’s started, on the card, the list and the question');

  // ---- Instantly says no ----
  S.error = 'Instantly didn’t accept the key — check INSTANTLY_API_KEY in Vercel (it may have been revoked)';
  await open();
  await page.waitForSelector('#ins-err');
  assert.match(await text('#ins-err'), /didn’t accept the key/);
  assert.equal(await page.$('[data-ins="review"]'), null, 'nothing can be sent while Instantly can’t be reached');
  assert.equal(await text('#ins-waiting'), '1', 'what the dashboard knows still shows');
  S.error = null;
  await page.click('#ins-err [data-ins="retry"]');
  await page.waitForSelector('#ins-pick');
  ok('a refused key is said in words, with nothing to send until it’s fixed');

  // ---- a phone ----
  await page.click('[data-ins="review"]');
  await page.waitForSelector('#ins-pv .fe-table');
  await page.setViewportSize({ width: 390, height: 800 });
  await wait(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  const small = await page.$$eval('#ins-card *', (els) => els.filter((el) => el.offsetParent && el.childNodes.length && [].some.call(el.childNodes, (c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11.5).length);
  assert.equal(small, 0, 'no text under 11.5px');
  ok('fits a phone, no small print');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\n' + n + ' checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
