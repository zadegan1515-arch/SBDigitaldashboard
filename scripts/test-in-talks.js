// scripts/test-in-talks.js — the In talks tab (Leo, Oct 18 2026) in Chromium
// against a fake /api/data:
//
//   1. Its own top tab between Outreach and Show Board; Show Board's old
//      "In talks" sub-tab reads "Board codes".
//   2. The list: calls coming up first, then talking, then stopped; a find box
//      that also matches people.
//   3. A profile: call card, links (website / Instagram / TikTok / LinkedIn),
//      the journey, facts, overview, the activation idea, people with LinkedIn,
//      Gmail and the email, invited-no-answer, notes and the brand page's note.
//   4. Another brand is a page of its own: ‹ goes back to the one before.
//   5. Editing the idea, the overview and the links saves through
//      saveTalksProfile; notes add (⌘↵), edit and delete (the confirm names it).
//   6. Copy for a new chat: the brand, our notes, the idea and the brainstorm
//      steps (21+ for an alcohol brand), money lines kept apart.
//   7. Replied brands: + Add puts one in talks and opens it; × hides it;
//      Take off In talks asks first.
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
  board: { code: null, opens: 0, lastAt: null }, journey: journey(2), lastAt: at(-1),
}, o);

let BRANDS = [
  base({
    id: 'b1', name: 'Electrolit', category: 'electrolytes', website: 'https://electrolit.com',
    instagramUrl: 'https://www.instagram.com/electrolit/', tiktokUrl: 'https://www.tiktok.com/@electrolitusa',
    linkedinUrl: 'https://www.linkedin.com/company/electrolit/', liMembers: 1240, fit: 72, sponsorsCollege: true, sponsorNote: 'Coachella, EDC',
    overview: 'Electrolit is a rehydration drink from Mexico. It sponsors Coachella.', overviewBy: 'Claude', overviewAt: at(0),
    idea: 'Encore Stations\n\nChilled stations at every show hand out bottles.\nA 5K on show day.\n\nMeasured on bottles handed out.', ideaBy: 'Claude', ideaAt: at(0),
    nextCall: { at: at(3), name: 'Jason Robinson' }, journey: journey(4),
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
    deal: { id: 'd1', name: 'Garage Beer — fall', stage: 'proposal', valueCents: 1500000, nextStep: 'Send the deck', followUpAt: at(2) } }),
  base({ id: 'b3', name: 'Dr. Squatch', category: 'beauty', why: 'hand', addedBy: 'Leo', lastAt: at(-4) }),
  base({ id: 'b4', name: 'Gone Soda', stopped: at(-1), lastAt: at(-1) }),
];
let SUGGEST = [
  { id: 'b5', name: 'SpikedAde', category: 'rtd', repliedAt: at(-3), who: 'Zach Fagin — Associate Trade Marketing Manager' },
  { id: 'b6', name: 'Neutonic', category: 'energy', repliedAt: at(-6), who: 'Kerry Szostak' },
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
  listInTalks: () => ({ brands: JSON.parse(JSON.stringify(BRANDS)), suggestions: SUGGEST, sponsorUrl: 'https://shows.example.com', today: '2026-10-18' }),
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
  await page.waitForSelector('.tabs .nav-item[data-view="intalks"]');

  // 1. The tab
  const tabs = await page.$$eval('.tabs.cc-only:not(#sub-tabs) .nav-item', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tabs.slice(0, 5), ['Home', 'Brands', 'Outreach', 'In talks', 'Show Board'], tabs.join(' | '));
  await page.click('.tabs .nav-item[data-view="board"]');
  await page.waitForSelector('#sub-tabs .nav-item[data-view="talks"]');
  assert.equal(await text('#sub-tabs .nav-item[data-view="talks"]'), 'Board codes');
  await page.click('.tabs .nav-item[data-view="intalks"]');
  await page.waitForSelector('#it-list .it-item');
  assert.equal(await page.evaluate(() => document.querySelector('.view.active').id), 'intalks');
  assert.equal(await page.isVisible('#sub-tabs'), false, 'no sub-tabs on In talks');
  console.log('✓ its own tab between Outreach and Show Board; Show Board’s sub-tab reads Board codes');

  // 2. The list
  const groups = await page.$$eval('#it-list .it-glabel', (els) => els.map((e) => e.firstChild.textContent));
  assert.deepEqual(groups, ['Calls coming up', 'Talking', 'Said they’re out']);
  const names = await page.$$eval('#it-list .it-item b', (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ['Electrolit', 'Garage Beer', 'Dr. Squatch', 'Gone Soda']);
  assert.ok(/Had a call/.test(await text('#it-list [data-it-sel="b2"]')));
  assert.ok(/Added .* by Leo/.test(await text('#it-list [data-it-sel="b3"]')));
  assert.ok(/don’t want to continue/.test(await text('#it-list [data-it-sel="b4"]')));
  await page.fill('#it-find', 'lizzy');
  assert.deepEqual(await page.$$eval('#it-list .it-item b', (els) => els.map((e) => e.textContent)), ['Garage Beer'], 'find matches people too');
  await page.fill('#it-find', '');
  assert.ok(/4 brands · 1 call coming up/.test(await text('#it-sub')));
  console.log('✓ the list: calls coming up, talking, stopped; the find box matches people');

  // 3. The profile
  assert.equal(await text('.it-name'), 'Electrolit');
  const hero = await text('.it-hero');
  assert.ok(/Call booked/.test(hero) && /in 3 days · with Jason Robinson/.test(hero), hero);
  const chips = await page.$$eval('.it-links a.it-chip', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('href'), e.getAttribute('target')]));
  assert.deepEqual(chips.map((c) => c[0]), ['electrolit.com', 'Instagram @electrolit', 'TikTok @electrolitusa', 'LinkedIn']);
  assert.ok(chips.every((c) => c[2] === '_blank'));
  assert.equal(await page.$$eval('.it-journey li.done', (e) => e.length), 4);
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
  console.log('✓ a profile: call, links, journey, facts, overview, idea, people (LinkedIn, Gmail, email), notes, board link');

  // 4. Another brand is a page of its own
  await page.click('#it-list [data-it-sel="b2"]');
  await page.waitForFunction(() => document.querySelector('.it-name').textContent === 'Garage Beer');
  assert.ok(/Last call/.test(await text('.it-hero')));
  assert.ok(/proposal/.test(await text('.it-col:nth-child(2)')) && /\$15,000 sponsorship/.test(await text('.it-col:nth-child(2)')));
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

  // 7. Replied brands; Take off
  assert.ok(/Replied, not in talks/.test(await text('.it-sug summary')));
  await page.click('.it-sug summary');
  await page.click('[data-it-add="b5"]');
  await page.waitForFunction(() => document.querySelector('.it-name') && document.querySelector('.it-name').textContent === 'SpikedAde');
  assert.deepEqual(last('setInTalks').args, { brandId: 'b5', on: true });
  assert.ok(/Write it/.test(await text('[data-it-edit="overview"]')) && /daily check/.test(await text('.it-card')), 'empty overview says Claude writes it');
  await page.click('[data-it-notnow="b6"]');
  await page.waitForFunction(() => !document.querySelector('[data-it-notnow]'));
  assert.deepEqual(last('setInTalks').args, { brandId: 'b6', on: false });
  await page.click('[data-it-remove]');
  await page.waitForFunction(() => !document.querySelector('#it-list [data-it-sel="b5"]'));
  assert.ok(/Take SpikedAde off In talks/.test(dialogs[dialogs.length - 1]));
  console.log('✓ + Add puts a replied brand in talks and opens it; × hides it; Take off asks first');

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
  await page.click('.tabs .nav-item[data-view="intalks"]');
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
  console.log('\nin-talks page: all 9 passed');
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
