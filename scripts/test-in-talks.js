// scripts/test-in-talks.js — the In talks tab (Leo, Oct 18 2026) in Chromium
// against a fake /api/data:
//
//   1. Its own top tab between Outreach and Show Board; Show Board's old
//      "In talks" sub-tab reads "Board codes".
//   2. The list: calls coming up first, then a group per stage (furthest
//      first, the ways out last); a find box that also matches people.
//   3. A profile: call card, links (website / Instagram / TikTok / LinkedIn),
//      the journey, facts, overview, the activation idea, people with LinkedIn,
//      Gmail and the email, invited-no-answer, notes and the brand page's note.
//   4. Another brand is a page of its own: ‹ goes back to the one before.
//   5. Editing the idea, the overview and the links saves through
//      saveTalksProfile; notes add (⌘↵), edit and delete (the confirm names it).
//   6. Copy for a new chat: the brand, our notes, the idea and the brainstorm
//      steps (21+ for an alcohol brand), money lines kept apart.
//   7. (Nov 8 2026) The stage strip filters the list; the stage bar sets a
//      stage (setTalksStage) with Undo; a brand not in talks opened for a look
//      goes in when a stage is set; the log adds (↵), edits and deletes lines
//      (the confirm names it); + Add a brand searches any brand and puts it in
//      talks; Take off In talks asks first. Notes sit right of the idea.
//   8. The brand page: + Add to In talks, or Open its In talks profile.
//   9. A phone: the list, a tap opens the profile with ‹ All brands, no
//      sideways scroll. No page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-in-talks.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-in-talks.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const DAY = 864e5;
const at = (d) => new Date(Date.now() + d * DAY).toISOString();

const journey = (n) => ['Invited', 'Accepted', 'Replied', 'Call booked', 'Deal'].map((label, i) => ({
  key: ['invited', 'accepted', 'replied', 'call', 'deal'][i], label, done: i < n, at: i < n ? at(-30 + i * 5) : null,
}));
const base = (o) => Object.assign({
  category: 'energy', tier: 'growth', kind: null, website: null, linkedinUrl: null, instagramUrl: null, tiktokUrl: null,
  about: null, topProducts: null, brandNotes: null, liMembers: null, salesCents: null, fundingCents: null, lastRoundAt: null,
  sponsorsCollege: null, sponsorNote: null, usStatus: null, fit: 55, overview: null, overviewBy: null, overviewAt: null,
  idea: null, ideaBy: null, ideaAt: null, why: 'call', since: at(-5), addedBy: null, stopped: null, archived: false,
  nextCall: null, lastCall: null, people: [], invited: [], others: 0, notes: [], deal: null,
  board: { code: null, opens: 0, lastAt: null }, journey: journey(2), lastAt: at(-1), stage: null, stageDates: {},
}, o);
const STAGE_LABEL = { replied: 'Replied', call_booked: 'Call booked', call_done: 'Call done', proposal: 'Proposal sent', negotiating: 'Negotiating',
  verbal: 'Verbal yes', contract: 'Contract signed', won: 'Won', lost: 'Lost', quiet: 'Gone quiet' };
const stg = (key, d, hand, why) => ({ key, label: STAGE_LABEL[key], at: at(d), hand: !!hand, by: hand ? 'Leo' : null, why: why || null });

let BRANDS = [
  base({
    id: 'b1', name: 'Electrolit', category: 'electrolytes', website: 'https://electrolit.com',
    instagramUrl: 'https://www.instagram.com/electrolit/', tiktokUrl: 'https://www.tiktok.com/@electrolitusa',
    linkedinUrl: 'https://www.linkedin.com/company/electrolit/', liMembers: 1240, fit: 72, sponsorsCollege: true, sponsorNote: 'Coachella, EDC',
    overview: 'Electrolit is a rehydration drink from Mexico. It sponsors Coachella.', overviewBy: 'Claude', overviewAt: at(0),
    idea: 'Encore Stations\n\nChilled stations at every show hand out bottles.\nA 5K on show day.\n\nMeasured on bottles handed out.', ideaBy: 'Claude', ideaAt: at(0),
    nextCall: { at: at(3), name: 'Jason Robinson' }, journey: journey(4),
    stage: stg('call_booked', -2, false, 'call booked'), stageDates: { replied: at(-10), call_booked: at(-2) },
    people: [{ targetId: 't1', contactId: 'c1', name: 'Jason Robinson', title: 'VP Marketing', email: 'jason@electrolit.com', phone: '+1 (555) 010-2000',
      linkedinUrl: 'https://www.linkedin.com/in/jasonr/', stage: 'call', label: 'call booked', invitedAt: at(-30), acceptedAt: at(-25),
      repliedAt: at(-10), repliedBy: 'email', callAt: at(3), callBookedAt: at(-2), emailedAt: null }],
    invited: [{ contactId: 'c2', name: 'Ana Ortiz', title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/anao/', invitedAt: at(-20) }],
    others: 4, brandNotes: 'Met at a trade show.',
    notes: [{ id: 'n1', text: 'Jason wants Texas schools first.', by: 'Leo', at: at(-2), editedAt: null }],
    board: { code: 'ELEC-42', opens: 3, lastAt: at(-1) },
  }),
  base({ id: 'b2', name: 'Garage Beer', category: 'rtd', lastCall: { at: at(-2), name: 'Lizzy Prater' }, lastAt: at(-2),
    people: [{ targetId: 't3', contactId: 'c3', name: 'Lizzy Prater', title: 'Director of Brand Marketing', email: null, phone: null,
      linkedinUrl: 'https://www.linkedin.com/in/lizzy/', stage: 'call', label: 'had a call', invitedAt: at(-40), acceptedAt: at(-35),
      repliedAt: null, repliedBy: null, callAt: at(-2), callBookedAt: at(-9), emailedAt: null }],
    deal: { id: 'd1', name: 'Garage Beer — fall', stage: 'proposal', valueCents: 1500000, nextStep: 'Send the deck', followUpAt: at(2) },
    stage: stg('proposal', -1, true), stageDates: { replied: at(-20), call_booked: at(-9), call_done: at(-2), proposal: at(-1) } }),
  base({ id: 'b3', name: 'Dr. Squatch', category: 'beauty', why: 'hand', addedBy: 'Leo', lastAt: at(-4) }),
  base({ id: 'b4', name: 'Gone Soda', stopped: at(-1), lastAt: at(-1), stage: stg('lost', -1, false, 'said they don’t want to continue'), stageDates: { replied: at(-6), lost: at(-1) } }),
];
const LOGS = {
  b2: [
    { id: 'e1', at: at(-1), kind: 'stage', stage: 'proposal', label: 'Moved to Proposal sent', text: 'Deck went with it', hand: true, by: 'Leo', editedAt: null },
    { at: at(-2), kind: 'auto', label: 'Call', text: 'Call day with Lizzy Prater', hand: false },
    { at: at(-9), kind: 'auto', label: 'Zach’s list', text: 'Lizzy Prater — call booked (2026-10-16)', hand: false },
  ],
};
let EV = 10;
let SUGGEST = [
  { id: 'b5', name: 'SpikedAde', category: 'rtd', repliedAt: at(-3), who: 'Zach Fagin — Associate Trade Marketing Manager' },
  { id: 'b6', name: 'Neutonic', category: 'energy', repliedAt: at(-6), who: 'Kerry Szostak' },
  { id: 'b7', name: 'Arizona Beverages', category: 'beverage', repliedAt: at(-30), who: 'Thomas Reed' },
  { id: 'b8', name: 'Update', category: 'energy', repliedAt: at(-31), who: 'Nicole Arnold' },
];
const byId = (id) => BRANDS.find((b) => b.id === id);
const clean = (kind, v) => {
  v = String(v || '').trim();
  if (!v) return null;
  if (v === 'none') return '';
  const h = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\/@?/, '').replace(/\/.*$/, '');
  return kind === 'instagramUrl' ? 'https://www.instagram.com/' + h + '/' : kind === 'tiktokUrl' ? 'https://www.tiktok.com/@' + h : (/^https?:/.test(v) ? v : 'https://' + v);
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  zachTodo: () => ({ brands: [], people: 0, done: [], calls: [], held: [] }),
  brandPlanLine: () => ({}), acceptedPeople: () => ({ people: [], total: 0, brands: 0 }),
  listTalks: () => ({ talks: [] }),
  listInTalks: (a) => {
    const s = a.preview && !byId(a.preview) ? SUGGEST.find((x) => x.id === a.preview) : null;
    return {
      brands: JSON.parse(JSON.stringify(BRANDS)), sponsorUrl: 'https://shows.example.com', today: '2026-10-18',
      logKinds: [{ key: 'call', label: 'Call' }, { key: 'email_out', label: 'Email sent' }, { key: 'proposal', label: 'Deck / proposal sent' }, { key: 'other', label: 'Other' }],
      preview: s ? base({ id: s.id, name: s.name, category: s.category, why: 'reply', since: s.repliedAt, preview: true, repliedAt: s.repliedAt, journey: journey(3),
        people: [{ targetId: 't_' + s.id, contactId: 'c_' + s.id, name: s.who, title: 'Brand Manager', email: null, phone: null, linkedinUrl: null,
          stage: 'replied', label: 'replied', invitedAt: at(-40), acceptedAt: at(-35), repliedAt: s.repliedAt, repliedBy: 'linkedin', callAt: null, callBookedAt: null, emailedAt: null }] }) : null,
    };
  },
  setTalksStage: (a) => {
    let b = byId(a.brandId);
    const s = SUGGEST.find((x) => x.id === a.brandId);
    const added = !b && !['lost', 'quiet'].includes(a.stage);
    if (!b && added) { SUGGEST = SUGGEST.filter((x) => x.id !== a.brandId); b = base({ id: a.brandId, name: s.name, why: 'hand', addedBy: 'Leo', since: at(0), lastAt: at(0) }); BRANDS.push(b); }
    const name = b ? b.name : s.name;
    let deal = null;
    if (b) {
      const map = { proposal: 'proposal', negotiating: 'proposal', verbal: 'verbal', contract: 'verbal', won: 'closed', lost: 'lost' };
      if (map[a.stage] && (!b.deal || b.deal.stage !== map[a.stage])) { deal = { id: 'd_' + b.id, from: b.deal ? b.deal.stage : '', to: map[a.stage], created: !b.deal }; b.deal = Object.assign(b.deal || { id: 'd_' + b.id, name: b.name, valueCents: 0 }, { stage: map[a.stage] }); }
      b.prevStage = b.stage;
      b.stage = stg(a.stage, 0, true);
      b.stageDates = Object.assign({}, b.stageDates, { [a.stage]: at(0) });
    }
    const ev = { id: 'e' + (++EV), at: at(0), kind: 'stage', stage: a.stage, label: 'Moved to ' + STAGE_LABEL[a.stage], text: '', hand: true, by: 'Leo', editedAt: null };
    (LOGS[a.brandId] = LOGS[a.brandId] || []).unshift(ev);
    return { brandId: a.brandId, brandName: name, stage: a.stage, label: STAGE_LABEL[a.stage], at: ev.at, event: ev, deal, dealSkipped: null, addedToTalks: added };
  },
  talksLog: (a) => ({ brandId: a.brandId, items: JSON.parse(JSON.stringify(LOGS[a.brandId] || [])) }),
  addTalksEvent: (a) => {
    const ev = { id: 'e' + (++EV), at: a.day ? new Date(a.day + 'T16:30:00Z').toISOString() : at(0), kind: a.kind, label: { call: 'Call', email_out: 'Email sent', proposal: 'Deck / proposal sent', other: 'Other' }[a.kind], text: a.text, hand: true, by: 'Leo', editedAt: null };
    (LOGS[a.brandId] = LOGS[a.brandId] || []).unshift(ev);
    return { brandId: a.brandId, brandName: byId(a.brandId).name, event: ev };
  },
  editTalksEvent: (a) => {
    for (const k of Object.keys(LOGS)) for (const e of LOGS[k]) if (e.id === a.id) {
      if (a.text !== undefined) e.text = a.text;
      if (a.day) e.at = new Date(a.day + 'T16:30:00Z').toISOString();
      e.editedAt = at(0);
      return { brandId: k, brandName: byId(k).name, event: e };
    }
    throw new Error('That line is gone');
  },
  deleteTalksEvent: (a) => {
    for (const k of Object.keys(LOGS)) {
      const e = LOGS[k].find((x) => x.id === a.id);
      if (!e) continue;
      const b = byId(k);
      const dealBack = e.kind === 'stage' && b && b.deal && e.stage === 'verbal' ? { id: b.deal.id, from: 'verbal', to: 'proposal' } : null;
      if (!a.confirm) return { deleted: false, brandId: k, brandName: b.name, event: e, dealBack, dealStays: null };
      LOGS[k] = LOGS[k].filter((x) => x.id !== a.id);
      if (e.kind === 'stage' && b && b.prevStage !== undefined) { b.stage = b.prevStage; delete b.prevStage; if (dealBack) b.deal.stage = 'proposal'; }
      return { deleted: true, brandId: k, brandName: b.name, event: e, dealBack, dealStays: null };
    }
    throw new Error('That line is gone');
  },
  brandLookup: (a) => ({ brands: [{ id: 'b9', name: 'Olipop', category: 'beverage', archived: false }, { id: 'b1', name: 'Electrolit', category: 'electrolytes', archived: false }]
    .filter((x) => x.name.toLowerCase().includes(String(a.q).toLowerCase())), exact: false }),
  setTalksDeal: (a) => {
    let b = byId(a.brandId);
    const s = SUGGEST.find((x) => x.id === a.brandId);
    const from = b && b.deal ? b.deal.stage : null;
    const created = !(b && b.deal);
    if (!b && a.stage === 'lost') { SUGGEST = SUGGEST.filter((x) => x.id !== a.brandId); return { brandId: a.brandId, brandName: s.name, stage: 'lost', from, created, addedToTalks: false, dismissed: true }; }
    const added = !b;
    if (!b) { SUGGEST = SUGGEST.filter((x) => x.id !== a.brandId); b = base({ id: a.brandId, name: s.name, why: 'hand', addedBy: 'Leo', since: at(0), lastAt: at(0) }); BRANDS.push(b); }
    b.deal = Object.assign(b.deal || { id: 'd_' + b.id, name: b.name, valueCents: 0, nextStep: null, followUpAt: null, source: 'manual' }, { stage: a.stage });
    return { brandId: b.id, brandName: b.name, stage: a.stage, from, created, addedToTalks: added, dismissed: false };
  },
  setInTalks: (a) => {
    if (a.on) {
      const s = SUGGEST.find((x) => x.id === a.brandId);
      SUGGEST = SUGGEST.filter((x) => x.id !== a.brandId);
      if (!byId(a.brandId)) BRANDS.push(base({ id: a.brandId, name: s ? s.name : 'Olipop', why: 'hand', addedBy: 'Leo', since: at(0), lastAt: at(0) }));
      return { brandId: a.brandId, brandName: (byId(a.brandId) || {}).name, on: true };
    }
    const b = byId(a.brandId);
    const s = SUGGEST.find((x) => x.id === a.brandId);
    BRANDS = BRANDS.filter((x) => x.id !== a.brandId);
    SUGGEST = SUGGEST.filter((x) => x.id !== a.brandId);
    return { brandId: a.brandId, brandName: (b || s || {}).name, on: false };
  },
  saveTalksProfile: (a) => {
    const b = byId(a.brandId);
    const saved = [];
    if (a.overview !== undefined) { b.overview = a.overview.trim() || null; b.overviewBy = 'Leo'; saved.push('overview'); }
    if (a.activationIdea !== undefined) { b.idea = a.activationIdea.trim() || null; b.ideaBy = 'Leo'; b.ideaAt = at(0); saved.push('activation idea'); }
    ['website', 'instagramUrl', 'tiktokUrl'].forEach((k) => { if (a[k] !== undefined) { b[k] = clean(k, a[k]); saved.push(k); } });
    return { brandId: b.id, brandName: b.name, saved, kept: [], profile: { overview: b.overview, overviewBy: b.overviewBy, overviewAt: b.overviewAt,
      activationIdea: b.idea, activationIdeaBy: b.ideaBy, activationIdeaAt: b.ideaAt, website: b.website, instagramUrl: b.instagramUrl, tiktokUrl: b.tiktokUrl } };
  },
  addBrandNote: (a) => {
    const note = { id: 'n' + Date.now(), text: a.text, by: 'Leo', at: at(0), editedAt: null };
    byId(a.brandId).notes.unshift(note);
    return { brandId: a.brandId, brandName: byId(a.brandId).name, note };
  },
  editBrandNote: (a) => {
    for (const b of BRANDS) for (const n of b.notes) if (n.id === a.id) { n.text = a.text; n.editedAt = at(0); return { brandName: b.name, note: n }; }
    throw new Error('That note is gone');
  },
  deleteBrandNote: (a) => {
    if (!a.confirm) return { deleted: false };
    for (const b of BRANDS) b.notes = b.notes.filter((n) => n.id !== a.id);
    return { deleted: true };
  },
  getBrand: (a) => ({
    brand: {
      id: a.brandId, name: a.brandId === 'b9' ? 'Olipop' : (byId(a.brandId) || {}).name || 'Olipop', category: 'beverage', tier: 'growth', aka: '',
      about: 'Makes drinks', topProducts: '', website: '', goals: '', notes: '', owner: null, linkedinUrl: '', externalId: null, boardCode: null,
      doNotEmail: false, passedAt: null, workPeople: null, partner: null, kind: null, contacts: [], targets: [], shows: [], deals: [], documents: [],
    },
    events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [], boardViews: { count: 0, last: null, recent: [] }, fit: null, samePeople: [],
    talks: byId(a.brandId) ? { on: true, why: 'call', since: at(-5) } : { on: false, why: null, since: null },
  }),
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base0 = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
  });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base0 + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      calls.push({ fn, args: args || {} });
      let body;
      try { body = { ok: true, data: H[fn] ? H[fn](args || {}) : {} }; }
      catch (e) { body = { ok: false, error: e.message }; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (!url.startsWith(base0)) return route.abort();
    return route.continue();
  });
  const text = (sel) => page.textContent(sel);
  const last = (fn) => [...calls].reverse().find((c) => c.fn === fn);

  await page.goto(base0 + '/app.html');
  await page.waitForSelector('.tabs .nav-item[data-view="tracker"]');

  // 1. The tab
  const tabs = await page.$$eval('.tabs.cc-only:not(#sub-tabs) .nav-item', (els) => els.map((e) => e.textContent));
  // Elizabeth's outreach tab sits next to Outreach (Oct 21 2026).
  // Zach's tab right after Home (Nov 8 2026).
  assert.deepEqual(tabs.slice(0, 7), ['Home', 'Zach', 'Brands', 'Outreach', 'Elizabeth', 'In talks', 'Show Board'], tabs.join(' | '));
  await page.click('.tabs .nav-item[data-view="board"]');
  await page.waitForSelector('#sub-tabs .nav-item[data-view="talks"]');
  assert.equal(await text('#sub-tabs .nav-item[data-view="talks"]'), 'Board codes');
  // Nov 6 2026: the tab opens Every brand reached; In talks is its second sub-tab.
  await page.click('.tabs .nav-item[data-view="tracker"]');
  await page.waitForSelector('#sub-tabs .nav-item[data-view="intalks"]');
  assert.deepEqual(await page.$$eval('#sub-tabs .nav-item', (els) => els.map((e) => e.textContent)), ['Every brand reached', 'In talks']);
  assert.equal(await page.evaluate(() => document.querySelector('.view.active').id), 'tracker');
  await page.click('#sub-tabs .nav-item[data-view="intalks"]');
  await page.waitForSelector('#it-list .it-item');
  assert.equal(await page.evaluate(() => document.querySelector('.view.active').id), 'intalks');
  assert.equal(await page.$eval('.tabs.cc-only:not(#sub-tabs) .nav-item.active', (e) => e.textContent), 'In talks', 'the top tab stays lit');
  console.log('✓ its own tab between Outreach and Show Board (Every brand reached, then In talks); Show Board’s sub-tab reads Board codes');

  // 2. The list
  const groups = await page.$$eval('#it-list .it-glabel', (els) => els.map((e) => e.firstChild.textContent));
  assert.deepEqual(groups, ['Calls coming up', 'Proposal sent', 'No stage yet', 'Lost']);
  const names = await page.$$eval('#it-list .it-item b', (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ['Electrolit', 'Garage Beer', 'Dr. Squatch', 'Gone Soda']);
  assert.ok(/Call booked/.test(await text('#it-list [data-it-sel="b1"] .it-spill')) && /Call /.test(await text('#it-list [data-it-sel="b1"]')));
  assert.ok(/Proposal sent/.test(await text('#it-list [data-it-sel="b2"]')) && /since/.test(await text('#it-list [data-it-sel="b2"]')));
  assert.ok(/No stage yet/.test(await text('#it-list [data-it-sel="b3"]')) && /Added .* by Leo/.test(await text('#it-list [data-it-sel="b3"]')));
  assert.ok(/Lost/.test(await text('#it-list [data-it-sel="b4"]')));
  // The stage strip: a tile per stage, a click shows only it, again = all.
  const tiles = await page.$$eval('#it-stages .it-stile', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tiles, ['4All brands', '0Replied', '1Call booked', '0Call done', '1Proposal sent', '0Negotiating', '0Verbal yes', '0Contract signed', '0Won', '1Lost', '0Gone quiet', '1No stage yet'], tiles.join(' | '));
  await page.click('#it-stages [data-it-sf="proposal"]');
  assert.deepEqual(await page.$$eval('#it-list .it-item b', (els) => els.map((e) => e.textContent)), ['Garage Beer']);
  await page.click('#it-stages [data-it-sf="proposal"]');
  assert.equal(await page.$$eval('#it-list .it-item', (els) => els.length), 4);
  await page.fill('#it-find', 'lizzy');
  assert.deepEqual(await page.$$eval('#it-list .it-item b', (els) => els.map((e) => e.textContent)), ['Garage Beer'], 'find matches people too');
  await page.fill('#it-find', '');
  assert.ok(/4 brands · 1 call coming up/.test(await text('#it-sub')));
  console.log('✓ the list: calls coming up, then a group per stage; the stage strip filters it; the find box matches people');

  // 3. The profile
  assert.equal(await text('.it-name'), 'Electrolit');
  const hero = await text('.it-hero');
  assert.ok(/Call booked/.test(hero) && /in 3 days · with Jason Robinson/.test(hero), hero);
  const chips = await page.$$eval('.it-links a.it-chip', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('href'), e.getAttribute('target')]));
  assert.deepEqual(chips.map((c) => c[0]), ['electrolit.com', 'Instagram @electrolit', 'TikTok @electrolitusa', 'LinkedIn']);
  assert.ok(chips.every((c) => c[2] === '_blank'));
  // The stage bar: where it is now, the days each stage was reached.
  assert.ok(/Call booked/.test(await text('.it-stagenow')) && /call booked on Zach’s list/.test(await text('.it-stagewhy')));
  assert.equal(await page.$$eval('.it-stagerow .it-sbtn.done', (e) => e.length), 2);
  assert.equal(await page.getAttribute('.it-stagerow .it-sbtn.cur', 'data-it-sset'), 'call_booked');
  assert.ok(/Before: Invited .* · Accepted/.test(await text('.it-stagecard')));
  // What happened: loads into the profile (nothing logged yet here).
  await page.waitForFunction(() => /Nothing yet/.test(document.querySelector('#it-loglist').textContent));
  const facts = await text('.it-facts');
  assert.ok(/72/.test(facts) && /1.2K/.test(facts) && /College \/ music/.test(facts) && /3opens/.test(facts.replace(/\s+/g, '')), facts);
  assert.ok(/rehydration drink/.test(await text('.it-overview')));
  assert.equal(await text('.it-idea-title'), 'Encore Stations');
  assert.equal(await page.$$eval('.it-idea-body p', (e) => e.length), 2);
  const person = await text('.it-person');
  assert.ok(/Jason Robinson/.test(person) && /VP Marketing/.test(person) && /call booked/.test(person) && /replied .* by email/.test(person), person);
  const li = await page.getAttribute('.it-person a.it-chip[href*="linkedin.com/in/"]', 'href');
  assert.equal(li, 'https://www.linkedin.com/in/jasonr/');
  const gm = await page.getAttribute('.it-person a.it-chip[href*="mail.google.com"]', 'href');
  assert.ok(/to=jason%40electrolit\.com/.test(gm) && /authuser=leo%40example\.com/.test(gm), gm);
  assert.ok(/Invited, no answer yet · 1/.test(await text('.it-fold summary')));
  assert.ok(/4 more people on file/.test(await text('.it-more')));
  assert.ok(/Texas schools/.test(await text('.it-notes')) && /Met at a trade show/.test(await text('.it-oldnote')));
  await page.click('.it-person [data-it-copytext]');
  assert.equal(await page.evaluate(() => window.__copied), 'jason@electrolit.com');
  await page.click('[data-it-board]');
  assert.equal(await page.evaluate(() => window.__copied), 'https://shows.example.com?code=ELEC-42');
  console.log('✓ a profile: call, links, stage bar, facts, overview, idea, people (LinkedIn, Gmail, email), notes, board link');

  // 4. Another brand is a page of its own
  await page.click('#it-list [data-it-sel="b2"]');
  await page.waitForFunction(() => document.querySelector('.it-name').textContent === 'Garage Beer');
  assert.ok(/Last call/.test(await text('.it-hero')));
  assert.ok(/proposal/.test(await text('.it-cols')) && /\$15,000 sponsorship/.test(await text('.it-cols')));
  assert.equal(await page.getAttribute('.it-sbtn.cur', 'data-it-sset'), 'proposal', 'its stage shows lit');
  assert.ok(/set by Leo/.test(await text('.it-stagewhy')));
  await page.waitForSelector('#it-loglist .it-logi');
  assert.deepEqual(await page.$$eval('#it-loglist .it-logi .l', (els) => els.map((e) => e.textContent)), ['Moved to Proposal sent', 'Call', 'Zach’s list']);
  assert.equal(await page.$$eval('#it-loglist .it-logi.auto [data-it-ledit]', (e) => e.length), 0, 'what the site saw is read-only');
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'in-talks.png'), fullPage: true });
  assert.ok(/no email on file/.test(await text('.it-person')));
  assert.ok(/\+ website, Instagram, TikTok/.test(await text('[data-it-links]')), 'missing links offered');
  await page.click('#nav-back');
  await page.waitForFunction(() => document.querySelector('.it-name') && document.querySelector('.it-name').textContent === 'Electrolit');
  await page.click('#nav-fwd');
  await page.waitForFunction(() => document.querySelector('.it-name').textContent === 'Garage Beer');
  console.log('✓ another brand is a page of its own: ‹ back, › forward');

  // 5. Edits
  await page.click('[data-it-edit="idea"]');
  await page.fill('[data-it-field="idea"]', 'Open the Garage\n\nA garage pop-up at 21+ shows.');
  await page.click('[data-it-save="idea"]');
  await page.waitForFunction(() => document.querySelector('.it-idea-title') && document.querySelector('.it-idea-title').textContent === 'Open the Garage');
  assert.equal(last('saveTalksProfile').args.activationIdea, 'Open the Garage\n\nA garage pop-up at 21+ shows.');
  assert.ok(/Leo/.test(await text('.it-idea .it-by')));
  await page.click('[data-it-edit="overview"]');
  await page.fill('[data-it-field="overview"]', 'Kelce-owned light lager.');
  // a draft survives switching brands and back
  await page.click('#it-list [data-it-sel="b3"]');
  await page.click('#it-list [data-it-sel="b2"]');
  await page.click('[data-it-edit="overview"]');
  assert.equal(await page.inputValue('[data-it-field="overview"]'), 'Kelce-owned light lager.');
  await page.click('[data-it-save="overview"]');
  await page.waitForFunction(() => document.querySelector('.it-overview') && /Kelce/.test(document.querySelector('.it-overview').textContent));
  await page.click('[data-it-links]');
  await page.fill('[data-it-link="instagramUrl"]', '@drinkgaragebeer');
  await page.fill('[data-it-link="tiktokUrl"]', 'none');
  await page.fill('[data-it-link="website"]', 'drinkgaragebeer.com');
  await page.click('[data-it-links-save]');
  await page.waitForSelector('.it-links a[href="https://www.instagram.com/drinkgaragebeer/"]');
  const la = last('saveTalksProfile').args;
  assert.deepEqual([la.website, la.instagramUrl, la.tiktokUrl], ['drinkgaragebeer.com', '@drinkgaragebeer', 'none']);
  assert.equal(await page.$('.it-links a[href*="tiktok"]'), null, '"none" = no TikTok chip');
  assert.ok(/Edit links/.test(await text('[data-it-links]')), 'nothing missing any more');
  // notes
  await page.fill('[data-it-field="note:new"]', 'Lizzy says budget lands in January.');
  await page.press('[data-it-field="note:new"]', 'Control+Enter');
  await page.waitForFunction(() => /January/.test((document.querySelector('.it-notes') || {}).textContent || ''));
  assert.equal(last('addBrandNote').args.brandId, 'b2');
  assert.equal(await page.inputValue('[data-it-field="note:new"]'), '', 'the box empties');
  const nid = last('addBrandNote') && (await page.getAttribute('[data-it-note-edit]', 'data-it-note-edit'));
  await page.click('[data-it-note-edit="' + nid + '"]');
  await page.fill('[data-it-field="note:' + nid + '"]', 'Lizzy says budget lands in February.');
  await page.click('[data-it-note-save="' + nid + '"]');
  await page.waitForFunction(() => /February/.test(document.querySelector('.it-notes').textContent));
  assert.ok(/edited/.test(await text('.it-notes')));
  await page.click('[data-it-note-del="' + nid + '"]');
  await page.waitForFunction(() => !document.querySelector('.it-notes'));
  assert.ok(/Delete this note/.test(dialogs[dialogs.length - 1]) && /February/.test(dialogs[dialogs.length - 1]), 'the confirm names the note');
  assert.equal(last('deleteBrandNote').args.confirm, true);
  console.log('✓ the idea, overview and links save (a draft survives switching brands); notes add with ⌘↵, edit and delete');

  // 6. Copy for a new chat
  await page.click('[data-it-copy]');
  const prompt = await page.evaluate(() => window.__copied);
  for (const bit of ['Help me brainstorm and build a brand activation for Garage Beer', 'ABOUT SB AGENCY', '500+ shows a year', 'an alcohol brand: 21+ only',
    'We had a call on', 'Lizzy Prater, Director of Brand Marketing — had a call', 'Deal: Garage Beer — fall — proposal (next: Send the deck)',
    'CURRENT ACTIVATION IDEA', 'Open the Garage', 'HOW TO BRAINSTORM', 'Give 5 different ideas', 'never add them to the sponsorship fee',
    'totals only', 'Activation idea box', 'https://shows.example.com', 'Instagram https://www.instagram.com/drinkgaragebeer/']) {
    assert.ok(prompt.includes(bit), 'prompt has: ' + bit);
  }
  await page.click('#it-list [data-it-sel="b1"]');
  await page.click('[data-it-copy]');
  const p1 = await page.evaluate(() => window.__copied);
  assert.ok(p1.includes('OUR NOTES') && p1.includes('Jason wants Texas schools first') && p1.includes('Call booked for') && !p1.includes('21+ only'), 'Electrolit prompt');
  console.log('✓ Copy for a new chat: brand, people, deal, notes, idea and the brainstorm steps');

  // Notes to the right of the activation idea (Leo, Oct 18 2026).
  const box = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).closest('.it-card').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top }; }, sel);
  const ideaBox = await box('[data-it-copy]'), notesBox = await box('[data-it-note-add]');
  assert.ok(notesBox.l >= ideaBox.r && Math.abs(notesBox.t - ideaBox.t) < 2, 'notes beside the idea: ' + JSON.stringify([ideaBox, notesBox]));
  console.log('✓ notes sit to the right of the activation idea');

  // 7a. The stage bar: a click sets the stage today (and moves the deal); Undo takes it back.
  await page.click('#it-list [data-it-sel="b2"]');
  await page.waitForSelector('#it-loglist .it-logi');
  await page.click('[data-it-sset="verbal"]');
  await page.waitForFunction(() => document.querySelector('.it-sbtn.cur') && document.querySelector('.it-sbtn.cur').getAttribute('data-it-sset') === 'verbal');
  assert.deepEqual(last('setTalksStage').args, { brandId: 'b2', stage: 'verbal' });
  assert.ok(/Moved to Verbal yes/.test(await text('.it-undo')));
  await page.waitForFunction(() => /Moved to Verbal yes/.test(document.querySelector('#it-loglist').textContent));
  assert.ok(/Verbal yes/.test(await text('#it-list [data-it-sel="b2"]')), 'the list moves it too');
  await page.click('[data-it-sundo]');
  await page.waitForFunction(() => document.querySelector('.it-sbtn.cur') && document.querySelector('.it-sbtn.cur').getAttribute('data-it-sset') === 'proposal');
  assert.equal(last('deleteTalksEvent').args.confirm, true);
  assert.ok(!(await page.$('.it-undo')));
  console.log('✓ the stage bar: a click sets it (deal follows), Undo takes it back');

  // 7b. The log: add a line with its day (↵), edit it, delete it (the confirm names it).
  await page.selectOption('[data-it-field="log:kind"]', 'email_out');
  const past = await page.evaluate(() => { const d = new Date(Date.now() - 3 * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); });
  await page.fill('[data-it-field="log:day"]', past);
  await page.fill('[data-it-field="log:text"]', 'Sent Lizzy the fall deck');
  await page.press('[data-it-field="log:text"]', 'Enter');
  await page.waitForFunction(() => /Sent Lizzy the fall deck/.test(document.querySelector('#it-loglist').textContent));
  assert.deepEqual(last('addTalksEvent').args, { brandId: 'b2', kind: 'email_out', day: past, text: 'Sent Lizzy the fall deck' });
  assert.equal(await page.inputValue('[data-it-field="log:text"]'), '', 'the box empties');
  const eid = await page.$eval('#it-loglist .it-logi:has-text("fall deck") [data-it-ledit]', (e) => e.getAttribute('data-it-ledit'));
  await page.click('[data-it-ledit="' + eid + '"]');
  await page.fill('[data-it-lrow] [data-it-ef="text"]', 'Sent Lizzy the fall deck + pricing');
  await page.click('[data-it-lsave="' + eid + '"]');
  await page.waitForFunction(() => /pricing/.test(document.querySelector('#it-loglist').textContent) && !document.querySelector('[data-it-lrow]'));
  assert.equal(last('editTalksEvent').args.id, eid);
  assert.equal(last('editTalksEvent').args.text, 'Sent Lizzy the fall deck + pricing');
  await page.click('[data-it-ldel="' + eid + '"]');
  await page.waitForFunction(() => !/pricing/.test(document.querySelector('#it-loglist').textContent));
  assert.ok(/Delete this line/.test(dialogs[dialogs.length - 1]) && /pricing/.test(dialogs[dialogs.length - 1]), 'the confirm names the line');
  console.log('✓ the log: a line with its day (↵), edited, deleted after a confirm that names it');

  // 7c. A brand not in talks opened for a look: a stage puts it in.
  await page.evaluate(() => itPreview('b7'));
  await page.waitForFunction(() => document.querySelector('.it-name') && document.querySelector('.it-name').textContent === 'Arizona Beverages');
  assert.ok(/Not in talks yet/.test(await text('.it-pvbar')) && /not in talks yet/.test(await text('.it-hero')));
  assert.ok(await page.isVisible('.it-hero [data-it-add="b7"]') && !(await page.$('.it-hero [data-it-remove]')), 'a look, not on the list: + Add, no Take off');
  await page.click('[data-it-sset="replied"]');
  await page.waitForSelector('#it-list [data-it-sel="b7"].on');
  assert.deepEqual(last('setTalksStage').args, { brandId: 'b7', stage: 'replied' });
  assert.ok(!(await page.$('.it-pvbar')), 'in talks now');
  console.log('✓ a brand opened for a look goes in when a stage is set');

  // 7d. + Add a brand: search any brand, + Add puts it in talks; one already in opens.
  await page.click('[data-it-addopen]');
  await page.fill('#it-addq', 'electro');
  await page.waitForSelector('#it-addres [data-it-sel="b1"]');
  assert.ok(/In talks · open/.test(await text('#it-addres')));
  await page.fill('#it-addq', 'oli');
  await page.waitForSelector('#it-addres [data-it-add="b9"]');
  await page.click('#it-addres [data-it-add="b9"]');
  await page.waitForFunction(() => document.querySelector('.it-name') && document.querySelector('.it-name').textContent === 'Olipop');
  assert.deepEqual(last('setInTalks').args, { brandId: 'b9', on: true });
  await page.waitForSelector('#it-addres [data-it-sel="b9"]');
  await page.click('[data-it-addopen]');
  assert.equal(await page.isVisible('#it-addbox'), false);
  console.log('✓ + Add a brand: any brand, into talks; one already in says so');

  // 7e. Take off asks first.
  await page.click('#it-list [data-it-sel="b9"]');
  await page.click('[data-it-remove]');
  await page.waitForFunction(() => !document.querySelector('#it-list [data-it-sel="b9"]'));
  assert.ok(/Take Olipop off In talks/.test(dialogs[dialogs.length - 1]) && /new reply/.test(dialogs[dialogs.length - 1]));
  console.log('✓ Take off In talks asks first');

  // 8. The brand page
  await page.click('[data-it-sel="b1"]');
  await page.click('.it-hero [data-it-brand]');
  await page.waitForSelector('#b-talks-open');
  await page.click('#b-talks-open');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'intalks' && document.querySelector('.it-name').textContent === 'Electrolit');
  await page.evaluate(() => loadBrand('b9'));
  await page.waitForSelector('#b-talks-add');
  await page.click('#b-talks-add');
  await page.waitForFunction(() => document.querySelector('.view.active').id === 'intalks' && document.querySelector('.it-name') && document.querySelector('.it-name').textContent === 'Olipop');
  assert.deepEqual(last('setInTalks').args, { brandId: 'b9', on: true });
  console.log('✓ the brand page: Open its In talks profile, or + Add to In talks');

  // 9. A phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.tabs .nav-item[data-view="dashboard"]');
  await page.click('.tabs .nav-item[data-view="tracker"]');
  await page.click('#sub-tabs .nav-item[data-view="intalks"]');
  await page.evaluate(() => { IT.mobile = false; renderInTalks(); });
  assert.equal(await page.isVisible('#it-list'), true);
  assert.equal(await page.isVisible('#it-main'), false, 'the list first');
  await page.click('#it-list [data-it-sel="b2"]');
  await page.waitForSelector('#it-main .it-back', { state: 'visible' });
  assert.equal(await page.isVisible('#it-list'), false);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll (' + wide + 'px)');
  await page.click('.it-back');
  assert.equal(await page.isVisible('#it-list'), true);
  console.log('✓ a phone: the list, a tap opens the profile with ‹ All brands, no sideways scroll');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('\nin-talks page: all 14 passed');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
