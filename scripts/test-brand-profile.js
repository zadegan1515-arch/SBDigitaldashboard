// scripts/test-brand-profile.js — the brand page's profile on top (Leo, Nov 10
// 2026: "redo this page to be more complex, put the company's socials,
// wesbote, notes (editable), activation idea, and make it easier to read").
// Drives public/app.html in Chromium against a fake /api/data:
//
//   1. The hero: name, category · tier, what they do, a chip per link
//      (website, Instagram, LinkedIn) and "+ TikTok" for the one missing;
//      Where it stands = the furthest step anyone here got to, the four
//      steps in a line, + Add to In talks.
//   2. The numbers in one strip (confirmed and proposed money apart); a
//      tile jumps to its part of the page. Brand Fit = the score and every
//      reason with its points, most points first.
//   3. Links: the boxes save through saveTalksProfile; the chip shows, the
//      fact sheet under Details follows, the People list isn't redrawn.
//   4. Overview and Activation idea: edit in place; text typed but not saved
//      survives a refresh of the page; Copy for a new chat = the In talks
//      profile's brief.
//   5. Notes: add (⌘↵), edit, delete (asks first, quoting the note); the
//      older note on file is edited through updateBrand, notes only.
//   6. A person's page: no links / stand / Brand Fit / idea, the notes stay.
//      Phone width; no page errors.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-brand-profile.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-brand-profile.js'); process.exit(1); }

const ROOT = path.join(__dirname, '..', 'public');
const calls = [];
const all = (fn) => calls.filter((c) => c.fn === fn);
const last = (fn) => all(fn).pop();
async function until(ok, what) {
  for (let i = 0; i < 100; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for ' + what);
}
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const contacts = [
  { id: 'c1', name: 'Marcos Vela', title: 'Head of Brand Partnerships', isDecisionMaker: true, source: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/marcos', email: 'marcos@besamivino.com' },
  { id: 'c2', name: 'Daniela Reyes', title: 'Co-Founder & CEO', isDecisionMaker: true, source: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/daniela' },
  { id: 'c3', name: 'Jenna Ortiz', title: 'Director of Marketing', isDecisionMaker: false, source: 'linkedin' },
];
const target = (id, ci, status, extra) => Object.assign({
  id, contactId: contacts[ci].id, status, sentAt: null, emails: [], drafts: [], shelved: false,
  contact: { id: contacts[ci].id, name: contacts[ci].name, title: contacts[ci].title },
}, extra || {});

let NOTE_N = 10;
const D = {
  brand: {
    id: 'b1', name: 'Besa mi Vino', category: 'rtd', tier: 'emerging', aka: 'Besa Spritz', kind: null,
    about: 'Low-sugar canned organic-wine spritzes', topProducts: 'Rosé Spritz',
    website: 'https://www.besamivino.com/', linkedinUrl: 'https://www.linkedin.com/company/besa-mi-vino',
    instagramUrl: 'https://www.instagram.com/besamivino', tiktokUrl: null,
    goals: '', notes: 'Added from the Add a brand chat.', owner: null, externalId: null, boardCode: 'BESA-4821',
    doNotEmail: false, passedAt: null, stoppedAt: null, workPeople: null, partner: null,
    salesCents: 1234567800, fundingCents: null, usStatus: 'yes', sponsorsCollege: true, sponsorNote: 'ACL Festival', liMembers: 23,
    overview: null, overviewBy: null, overviewAt: null,
    activationIdea: 'Golden Hour at the Tailgate\n\nA 21+ spritz bar at pre-show tailgates.', activationIdeaBy: 'Claude', activationIdeaAt: ago(2),
    contacts,
    targets: [target('t1', 0, 'accepted', { sentAt: ago(6) }), target('t2', 1, 'sent', { sentAt: ago(6) }), target('t3', 2, 'queued')],
    shows: [], deals: [], documents: [],
  },
  events: [{ id: 'e1', targetId: 't1', createdAt: ago(1), fromStatus: 'sent', toStatus: 'accepted', kind: 'status', target: { id: 't1', contact: { name: 'Marcos Vela' } } }],
  money: { confirmedCents: 500000, proposedCents: 250000 }, accessRequests: [],
  boardViews: { count: 2, last: { createdAt: ago(2), email: null }, recent: [] },
  fit: {
    score: 89, ruledOut: null, bizNote: null, tooSmall: false, usUnknown: false,
    reasons: [
      { good: true, text: 'sales $12.3M a year', points: 40 },
      { good: true, text: 'already sponsors college / music', points: 15 },
      { good: true, text: 'Top priority category', points: 30 },
      { good: null, text: 'no student use named', points: 0 },
      { good: null, text: 'only 2 of 4 people we can reach', points: 5 },
      { good: null, text: 'the score stops at 100', points: -1 },
    ],
  },
  notes: [
    { id: 'n1', text: 'Marcos accepted — wants a deck.', by: 'Leo', at: ago(1), editedAt: null },
    { id: 'n2', text: 'Found them on Instagram.', by: 'Leo', at: ago(8), editedAt: null },
  ],
  liHidden: null, samePeople: [], peopleMergeUndo: null, talks: { on: false, why: null, since: null }, big: false, top: true,
  sponsorUrl: 'https://shows.example.com',
};
const PERSON = {
  brand: {
    id: 'p1', name: 'Miles Carter', kind: 'person', category: null, tier: null, aka: '', about: '', topProducts: '', website: '', linkedinUrl: '',
    goals: '', notes: 'Friend of Zach', owner: null, externalId: null, boardCode: 'MILES-1', doNotEmail: true, passedAt: ago(1), workPeople: null, partner: null,
    contacts: [{ id: 'pc1', name: 'Miles Carter', title: '', isDecisionMaker: false, email: 'miles@example.com' }], targets: [], shows: [], deals: [], documents: [],
  },
  events: [], money: { confirmedCents: 0, proposedCents: 0 }, accessRequests: [], boardViews: { count: 0, last: null, recent: [] }, fit: null,
  notes: [], samePeople: [], talks: { on: false }, sponsorUrl: 'https://shows.example.com',
};

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [], listActivations: () => [], getRateCard: () => ({}),
  getActionQueue: () => ({ count: 0, items: [] }), appVersion: () => ({ sha: 'test' }), getDashboard: () => ({}),
  listBrands: () => [], categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  reachedBrands: () => ({ brands: {}, el: {} }),
  zachTodo: () => ({ template: { subject: '', body: '' }, dmTemplate: { subject: '', body: 'Hey (NAME)' }, finalTemplate: { subject: '', body: '' }, brands: [], people: 0, noAddress: 0, held: [], done: [], doneDays: 30, dmAfterDays: 2, nudgeAfterDays: 10, quietAfterDays: 7, calls: [] }),
  planDayChoices: () => ({ today: '2026-11-10', days: [], offDay: null, brand: { id: 'b1', name: 'Besa mi Vino', pinnedOn: null } }),
  brandTimeline: () => ({ items: [] }),
  getBrand: (a) => JSON.parse(JSON.stringify(a.brandId === 'p1' ? PERSON : D)),
  // The real one cleans a handle into the account's link; the fake does the same for TikTok.
  saveTalksProfile: (a) => {
    const b = D.brand, saved = [];
    if (a.overview !== undefined) { b.overview = a.overview.trim() || null; b.overviewBy = b.overview ? 'Leo' : null; b.overviewAt = b.overview ? new Date().toISOString() : null; saved.push('overview'); }
    if (a.activationIdea !== undefined) { b.activationIdea = a.activationIdea.trim() || null; b.activationIdeaBy = 'Leo'; b.activationIdeaAt = new Date().toISOString(); saved.push('activation idea'); }
    if (a.tiktokUrl !== undefined) {
      const v = String(a.tiktokUrl).trim();
      const nu = !v ? null : v === 'none' ? '' : 'https://www.tiktok.com/@' + v.replace(/^@/, '');
      if (nu !== b.tiktokUrl) { b.tiktokUrl = nu; saved.push('TikTok'); }
    }
    return { brandId: 'b1', brandName: b.name, saved, kept: [], profile: {
      overview: b.overview, overviewBy: b.overviewBy, overviewAt: b.overviewAt, activationIdea: b.activationIdea, activationIdeaBy: b.activationIdeaBy,
      activationIdeaAt: b.activationIdeaAt, website: b.website, instagramUrl: b.instagramUrl, tiktokUrl: b.tiktokUrl } };
  },
  addBrandNote: (a) => {
    const note = { id: 'n' + (++NOTE_N), text: a.text, by: 'Leo', at: new Date().toISOString(), editedAt: null };
    if (a.brandId === 'b1') D.notes.unshift(note); else PERSON.notes.unshift(note);
    return { brandId: a.brandId, brandName: 'x', note };
  },
  editBrandNote: (a) => {
    const n = D.notes.find((x) => x.id === a.id);
    n.text = a.text; n.editedAt = new Date().toISOString();
    return { brandId: 'b1', brandName: 'Besa mi Vino', note: n };
  },
  deleteBrandNote: (a) => {
    const n = D.notes.find((x) => x.id === a.id);
    if (!a.confirm) return { deleted: false, note: n };
    D.notes = D.notes.filter((x) => x.id !== a.id);
    return { deleted: true, brandId: 'b1', note: n };
  },
  updateBrand: (a) => { if (a.notes !== undefined) D.brand.notes = a.notes || null; return { id: 'b1' }; },
  listInTalks: (a) => ({
    brands: [], stages: [], ends: [], logKinds: [], sponsorUrl: 'https://shows.example.com',
    preview: a.preview === 'b1' ? {
      id: 'b1', name: 'Besa mi Vino', category: 'rtd', website: D.brand.website, instagramUrl: D.brand.instagramUrl, tiktokUrl: D.brand.tiktokUrl,
      linkedinUrl: D.brand.linkedinUrl, overview: D.brand.overview, about: D.brand.about, idea: D.brand.activationIdea, preview: true,
      people: [{ name: 'Marcos Vela', title: 'Head of Brand Partnerships', label: 'accepted' }], invited: [], notes: D.notes, board: { opens: 2 }, deal: null, stage: null,
    } : null,
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
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
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
  await page.waitForFunction(() => typeof window.loadBrand === 'function');
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());

  // 1 ---------------------------------------------------------------
  await page.evaluate(() => loadBrand('b1'));
  await page.waitForSelector('#bx-hero h1');
  assert.equal(await text('#bx-hero h1'), 'Besa mi Vino');
  assert.match(await text('#bx-hero .sub'), /Beer, Seltzers & Canned Cocktails · emerging/);
  assert.match(await text('#bx-hero .bx-sum'), /Low-sugar canned organic-wine spritzes\. Known for Rosé Spritz\./);
  const chips = await page.$$eval('#bx-hero .it-links .it-chip', (els) => els.map((e) => [e.textContent.replace(/\s+/g, ' ').trim(), e.getAttribute('href')]));
  assert.deepEqual(chips, [
    ['besamivino.com', 'https://www.besamivino.com/'],
    ['Instagram @besamivino', 'https://www.instagram.com/besamivino'],
    ['LinkedIn', 'https://www.linkedin.com/company/besa-mi-vino'],
    ['+ TikTok', null],
  ], 'a chip per link, and the missing one to add');
  assert.match(await text('#bx-stand'), /Where it stands ?Accepted on LinkedIn ?Marcos Vela · [A-Z][a-z]{2} \d+/);
  const steps = await page.$$eval('#bx-stand .bx-steps li', (els) => els.map((e) => [e.querySelector('b').textContent, e.classList.contains('done'), e.querySelector('span').textContent.split(' ')[0]]));
  assert.deepEqual(steps, [['Reached', true, '2'], ['Accepted', true, '1'], ['Replied', false, '—'], ['Call', false, '—']]);
  assert.ok(await page.isVisible('#b-talks-add'), '+ Add to In talks sits in the card');
  console.log('✓ 1. the hero: name, what they do, a chip per link, where it stands with its steps');

  // 2 ---------------------------------------------------------------
  const tiles = await page.$$eval('#bx-facts .bx-fact', (els) => els.map((e) => e.querySelector('.k').textContent.replace(' ↓', '') + '=' + e.querySelector('.v').textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(tiles, ['Brand Fit=89/ 100', 'People=3', 'Outreach=2reached', 'Show Board=2opens', 'Confirmed=$5,000', 'Proposed=$2,500', 'Shows=0', 'On LinkedIn=23people', 'Sales=$12.3Ma year'],
    'confirmed and proposed stay two numbers');
  assert.match(await text('#bx-facts .bx-fact:nth-child(2)'), /2 decision makers ?2 we can reach/);
  assert.match(await text('#bx-facts .bx-fact:nth-child(3)'), /1 accepted · 0 replied/);
  await page.click('#bx-facts [data-bx-jump="people"]');
  await page.waitForFunction(() => { const r = document.getElementById('b-sec-people').getBoundingClientRect(); return r.top > 0 && r.top < 320; });
  await page.evaluate(() => window.scrollTo(0, 0));
  const fit = await page.$$eval('#b-fit .bx-why li', (els) => els.map((e) => e.className + '|' + e.querySelector('.t').textContent + '|' + e.querySelector('.p').textContent));
  assert.deepEqual(fit, [
    'y|sales $12.3M a year|+40', 'y|Top priority category|+30', 'y|already sponsors college / music|+15',
    'q|only 2 of 4 people we can reach|+5', 'q|no student use named|0', 'q|the score stops at 100|−1',
  ], 'every reason with its points, most first');
  assert.match(await text('#b-fit'), /Fit 89/);
  assert.equal(await text('.bx-bar #b-plan .b-plan-k'), 'Schedule', 'the Schedule line sits in its bar');
  console.log('✓ 2. the numbers strip (a tile jumps to its part), Brand Fit reason by reason');

  // 3 ---------------------------------------------------------------
  // The People list must not be redrawn by a save up top: mark a row.
  await page.evaluate(() => { document.querySelector('#brand-body [data-pcid="c1"]').__mine = true; });
  const kept = () => page.evaluate(() => document.querySelector('#brand-body [data-pcid="c1"]').__mine === true);
  await page.click('#bx-hero [data-bx-links]');
  await page.waitForSelector('#bx-linkedit');
  assert.equal(await page.inputValue('[data-bx-link="website"]'), 'https://www.besamivino.com/');
  assert.equal(await page.inputValue('[data-bx-link="tiktokUrl"]'), '');
  await page.fill('[data-bx-link="tiktokUrl"]', '@besamivino');
  await page.press('[data-bx-link="tiktokUrl"]', 'Enter');
  await until(() => last('saveTalksProfile'), 'the links save');
  assert.deepEqual(last('saveTalksProfile').args, { website: 'https://www.besamivino.com/', instagramUrl: 'https://www.instagram.com/besamivino', tiktokUrl: '@besamivino', brandId: 'b1' });
  await page.waitForFunction(() => /TikTok @besamivino/.test(document.querySelector('#bx-hero .it-links').textContent));
  assert.equal(await page.$('#bx-linkedit'), null, 'the boxes close');
  assert.match(await text('#bx-hero [data-bx-links]'), /Edit links/);
  assert.match(await page.$eval('#b-factlist', (el) => el.textContent), /TikTok@besamivino/, 'the fact sheet under Details follows');
  assert.ok(await kept(), 'the People list was left alone');
  console.log('✓ 3. links save through saveTalksProfile; the chip shows; nothing else is redrawn');

  // 4 ---------------------------------------------------------------
  assert.match(await text('#bx-overview'), /No overview yet\./);
  await page.click('#bx-overview [data-bx-edit="overview"]');
  await page.fill('[data-bx-field="overview"]', 'Canned wine spritzes for 21–30s. Sold at Whole Foods.');
  await page.click('[data-bx-save="overview"]');
  await page.waitForFunction(() => /Canned wine spritzes for 21–30s\. Sold at Whole Foods\./.test((document.querySelector('#bx-overview .it-overview') || {}).textContent || ''));
  assert.deepEqual(last('saveTalksProfile').args, { overview: 'Canned wine spritzes for 21–30s. Sold at Whole Foods.', brandId: 'b1' });
  assert.match(await text('#bx-overview .it-by'), /^Leo · /);
  assert.match(await text('#bx-overview .bx-dl'), /Best sellers ?Rosé Spritz ?Also called ?Besa Spritz ?Already sponsors ?ACL Festival ?Sold in the US ?Yes/);

  assert.equal(await text('#bx-idea .it-idea-title'), 'Golden Hour at the Tailgate');
  await page.click('#bx-idea [data-bx-edit="idea"]');
  await page.fill('[data-bx-field="idea"]', 'Spritz Garden\n\nA 21+ garden bar by the stage.');
  // A refresh of the whole page (any button that reloads it) keeps what's typed.
  const n = all('getBrand').length;
  await page.evaluate(() => loadBrand('b1'));
  await until(() => all('getBrand').length > n, 'the refresh');
  await page.waitForFunction(() => (document.querySelector('[data-bx-field="idea"]') || {}).value === 'Spritz Garden\n\nA 21+ garden bar by the stage.');
  // (that refresh drew the page again: mark the row afresh for the saves below)
  await page.evaluate(() => { document.querySelector('#brand-body [data-pcid="c1"]').__mine = true; });
  await page.click('[data-bx-save="idea"]');
  await page.waitForFunction(() => (document.querySelector('#bx-idea .it-idea-title') || {}).textContent === 'Spritz Garden');
  assert.deepEqual(last('saveTalksProfile').args, { activationIdea: 'Spritz Garden\n\nA 21+ garden bar by the stage.', brandId: 'b1' });
  await page.click('#bx-idea [data-bx-copy]');
  await until(() => last('listInTalks'), 'the brief’s read');
  assert.deepEqual(last('listInTalks').args, { preview: 'b1' });
  await page.waitForFunction(() => /Copied/.test(document.getElementById('toast').textContent));
  const brief = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(brief, /Help me brainstorm and build a brand activation for Besa mi Vino/);
  assert.match(brief, /CURRENT ACTIVATION IDEA\nSpritz Garden/);
  assert.match(brief, /alcohol brand: 21\+ only/);
  console.log('✓ 4. overview and idea edit in place; typed text survives a refresh; Copy for a new chat');

  // 5 ---------------------------------------------------------------
  assert.equal(await text('#bx-notes .it-count'), '2');
  await page.fill('[data-bx-field="note:new"]', 'Sent the deck.');
  await page.press('[data-bx-field="note:new"]', 'Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('#bx-notes .it-note').length === 3);
  assert.deepEqual(last('addBrandNote').args, { brandId: 'b1', text: 'Sent the deck.' });
  assert.match(await text('#bx-notes .it-note:first-child'), /Leo.*Sent the deck\./);
  assert.equal(await page.inputValue('[data-bx-field="note:new"]'), '', 'the box is empty again');
  await page.click('#bx-notes [data-bx-edit="note:n1"]');
  await page.fill('[data-bx-field="note:n1"]', 'Marcos accepted — wants a deck by Friday.');
  await page.click('[data-bx-note-save="n1"]');
  await page.waitForFunction(() => /wants a deck by Friday\./.test(document.querySelector('#bx-notes').textContent) && !document.querySelector('[data-bx-field="note:n1"]'));
  assert.deepEqual(last('editBrandNote').args, { id: 'n1', text: 'Marcos accepted — wants a deck by Friday.' });
  await page.click('#bx-notes [data-bx-note-del="n2"]');
  await page.waitForFunction(() => document.querySelectorAll('#bx-notes .it-note').length === 2);
  assert.match(dialogs[dialogs.length - 1], /Delete this note from [A-Z][a-z]{2} \d+\?\n\n“Found them on Instagram\.”/, 'it shows what goes before it goes');
  assert.deepEqual(last('deleteBrandNote').args, { id: 'n2', confirm: true });
  // The older note on file.
  assert.match(await text('#bx-notes .it-oldnote'), /On file ?Added from the Add a brand chat\./);
  await page.click('#bx-notes [data-bx-edit="brandnote"]');
  await page.fill('[data-bx-field="brandnote"]', 'Added from the Add a brand chat. Met at BevNET.');
  await page.click('[data-bx-bnsave]');
  await page.waitForFunction(() => /Met at BevNET\./.test((document.querySelector('#bx-notes .it-oldnote') || {}).textContent || '') && !document.querySelector('[data-bx-field="brandnote"]'));
  assert.deepEqual(last('updateBrand').args, { brandId: 'b1', notes: 'Added from the Add a brand chat. Met at BevNET.' }, 'the note alone — nothing else on the brand is sent');
  assert.equal(await page.$eval('[data-bfield="notes"]', (el) => el.value), 'Added from the Add a brand chat. Met at BevNET.', 'the edit form under Details has it too');
  assert.ok(await kept(), 'the People list was never redrawn by a save (idea, notes, the older note)');
  console.log('✓ 5. notes: add (⌘↵), edit, delete asks first; the older note saves alone');

  // 6 ---------------------------------------------------------------
  await page.evaluate(() => loadBrand('p1'));
  await page.waitForFunction(() => (document.querySelector('#bx-hero h1') || {}).textContent === 'Miles Carter');
  assert.match(await text('#bx-hero .sub'), /Person · gets the Show Board/);
  for (const sel of ['#bx-stand', '#b-fit', '#bx-idea', '#bx-overview', '#bx-hero [data-bx-links]', '.bx-bar']) assert.equal(await page.$(sel), null, sel + ' is not on a person’s page');
  assert.match(await text('#bx-hero .bx-sum'), /Friend of Zach/);
  assert.ok(await page.isVisible('#bx-notes [data-bx-note-add]'), 'a person keeps the notes');
  await page.fill('[data-bx-field="note:new"]', 'Sent him the board.');
  await page.click('[data-bx-note-add]');
  await page.waitForFunction(() => document.querySelectorAll('#bx-notes .it-note').length === 1);
  assert.deepEqual(last('addBrandNote').args, { brandId: 'p1', text: 'Sent him the board.' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => loadBrand('b1'));
  await page.waitForFunction(() => (document.querySelector('#bx-hero h1') || {}).textContent === 'Besa mi Vino');
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, 'no sideways scroll on a phone (' + wide + 'px)');
  assert.ok(await page.isVisible('#bx-stand'), 'where it stands is on the phone too');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('✓ 6. a person’s page keeps the notes only; phone width; no errors');

  await browser.close();
  server.close();
  console.log('brand profile: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
