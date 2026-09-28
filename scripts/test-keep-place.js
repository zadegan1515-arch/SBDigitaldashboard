// scripts/test-keep-place.js
//
// Keep my place. Leo (Sep 2026): "a lot of items when i click a button on
// the site and it does an action it reloads the page". Nothing reloaded
// the browser page — the button's screen threw its content away, jumped
// to the top, showed "Loading…" and drew itself again with every section
// shut. Now a button that ends by running its screen's loader again
// refreshes that screen in place (showView → keepPlace in app.html).
// This drives public/app.html in Chromium against a fake /api/data:
//
//   1. Brand page: a button low on the page ("Emails on") refreshes it —
//      no "Loading…", the button stays where it was on screen, Details &
//      notes and Activity stay open, and so does the Edit form. Another
//      brand still opens at the top, with "Loading…".
//   2. Typing in a box when a refresh lands: it keeps the cursor and the
//      text, and leaving it still fires the change that saves it — once,
//      also when more was typed after the refresh.
//   3. Email tab: an open draft stays open when its To changes, and Skip
//      closes the list up under the cursor instead of jumping.
//   4. LinkedIn queue and Brands list: a refresh keeps the rows on screen
//      where they were, even when rows above them went. Another category
//      and a nav tab still start at the top. The LinkedIn tab's "Fill to
//      30" and "of 30 sent today" are the server's number, not a literal.
//   5. Deals board: it keeps its sideways scroll when a deal moves, and
//      an open deal room refreshes where it is.
//   6. Out of order: a slow refresh that answers after a newer one never
//      draws over it.
//   7. Activations budget: a cost edit redraws the sheet (it used to jump
//      to the top every time) — the next cell keeps the cursor and what
//      was typed in it, and the row stays put.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-keep-place.js   (~15s)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('Needs playwright: NODE_PATH=$(npm root -g) node scripts/test-keep-place.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'public');
const NOW = new Date().toISOString();

// --- fake data ----------------------------------------------------

const S = {
  brands: {},            // id -> getBrand payload
  dne: {},               // brand id -> doNotEmail
  drafts: [],            // email queue
  queue: [],             // LinkedIn queue targets
  list: [],              // Brands list rows
  deals: [],
  finals: {},            // budget line id -> final cents
  notes: {},             // budget line id -> notes
  saves: [],             // upsertBudgetLine calls
  dayCap: 30,            // the server's DAILY_SEND_LIMIT (LinkedIn people a day)
  calls: [],             // every fn called, in order
  delay: {},             // fn -> ms before answering
  hold: {},              // fn -> [ms, ms, …] per call (overrides delay)
  brandNote: {},         // brand id -> notes as saved
};

function brand(id, name) {
  const contacts = Array.from({ length: 16 }, (_, i) => ({
    id: id + '-c' + i, name: name + ' Person ' + i, title: i % 3 ? 'Brand Manager' : 'VP Marketing',
    email: i % 2 ? 'p' + i + '@' + id + '.com' : null, linkedinUrl: 'https://www.linkedin.com/in/' + id + i,
    isDecisionMaker: i < 3, region: null, notes: null, location: null, phone: null, source: 'sponsorunited',
  }));
  const targets = contacts.slice(0, 5).map((c, i) => ({
    id: id + '-t' + i, contactId: c.id, brandId: id, status: i < 2 ? 'sent' : 'queued', sentAt: i < 2 ? NOW : null,
    shelved: false, fitScore: 50, drafts: [], emails: [], updatedAt: NOW,
    contact: { id: c.id, name: c.name, title: c.title, linkedinUrl: c.linkedinUrl },
  }));
  return {
    brand: {
      id, name, category: 'energy', tier: 'growth', aka: '', about: name + ' makes energy drinks',
      topProducts: 'Cans', website: 'example.com', goals: '', notes: S.brandNote[id] || '', owner: null, linkedinUrl: '',
      externalId: null, boardCode: null, doNotEmail: !!S.dne[id], passedAt: null, workPeople: null, partner: null,
      contacts, targets, shows: [], deals: [],
      documents: [{ id: id + '-d1', title: 'Call prep', kind: 'callprep', createdAt: NOW, url: 'https://example.com/doc', body: '' }],
    },
    events: Array.from({ length: 12 }, (_, i) => ({
      id: id + '-e' + i, kind: 'sent', note: null, createdAt: NOW, target: { contact: { name: name + ' Person ' + i } },
    })),
    money: { confirmedCents: 0, proposedCents: 0 },
    accessRequests: [],
    boardViews: { count: 0, last: null, recent: [] },
  };
}

function draft(i) {
  const bid = 'eb' + i;
  return {
    id: 'dr' + i, kind: 'intro', status: 'draft', subject: 'Subject ' + i, body: 'Hi there,\n\nBody ' + i + '\n\nBest,',
    toEmail: 'a' + i + '@x.com', ccEmails: null, suggestion: null,
    target: {
      id: 'et' + i, brand: { id: bid, name: 'Email Brand ' + i, contacts: [
        { id: bid + 'a', name: 'Ann ' + i, title: 'CMO', email: 'a' + i + '@x.com' },
        { id: bid + 'b', name: 'Bob ' + i, title: 'Brand Lead', email: 'b' + i + '@x.com' },
      ] },
      contact: { id: bid + 'a', name: 'Ann ' + i },
    },
  };
}

function qTarget(i) {
  const b = Math.floor(i / 2);
  return {
    id: 'q' + i, brandId: 'qb' + b, status: 'queued', sentAt: null, updatedAt: NOW, drafts: [],
    followUpAt: null, nextStep: null, dmSentAt: null,
    brand: { id: 'qb' + b, name: 'Queue Brand ' + b, category: 'energy', workPeople: null },
    contact: { id: 'qc' + i, name: 'Queue Person ' + i, title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/q' + i },
  };
}

function listRow(i) {
  return {
    id: 'lb' + i, name: 'List Brand ' + String(i).padStart(3, '0'), tier: 'growth', passedAt: null, category: 'energy',
    about: 'About brand ' + i, contacts: [], _count: { contacts: i % 7 }, outreach: {}, source: null, createdAt: NOW, notes: null,
  };
}

function deal(i) {
  const stages = ['conversation', 'proposal', 'verbal', 'closed', 'lost'];
  return {
    id: 'dl' + i, stage: stages[i % 5], valueCents: 100000 * (i + 1), brandId: 'db' + i, brand: { name: 'Deal Brand ' + i },
    eventRef: null, name: 'Deal Brand ' + i, owner: 'Leo', source: 'manual', followUpAt: null,
  };
}

function activation() {
  const secs = ['venue', 'production', 'print', 'staff', 'talent'];
  const lines = Array.from({ length: 30 }, (_, i) => ({
    id: 'ln' + i, section: secs[i % 5], sortOrder: i, item: 'Item ' + i, description: '', qty: 1, unitCents: null,
    estimateCents: 10000 + i * 100, finalCents: S.finals['ln' + i] == null ? null : S.finals['ln' + i],
    notes: S.notes['ln' + i] || '', ordered: false,
  }));
  return {
    id: 'a1', name: 'Campus Tour', status: 'planning', owner: 'Leo', sheetUrl: null, docUrl: null, dealId: null, deal: null,
    brand: { id: 'b1', name: 'Alpha', category: 'energy' },
    events: [{ id: 'ae1', name: 'Show night', eventDate: NOW, venue: 'Hall', budgetCents: 500000, platformCampaignId: null,
      notes: null, lines, staff: [], tasks: [] }],
  };
}

function reset() {
  S.brands = { b1: null, b2: null };
  S.dne = {};
  S.brandNote = {};
  S.drafts = Array.from({ length: 12 }, (_, i) => draft(i));
  S.queue = Array.from({ length: 20 }, (_, i) => qTarget(i));
  S.list = Array.from({ length: 80 }, (_, i) => listRow(i));
  S.deals = Array.from({ length: 10 }, (_, i) => deal(i));
}
reset();

const H = {
  getMe: () => ({ email: 'leo@example.com', name: 'Leo', owner: 'Leo', role: 'admin' }),
  listOwners: () => [],
  listActivations: () => [],
  getRateCard: () => ({}),
  zachTodo: () => ({ rows: [], people: [] }),
  getActionQueue: () => ({ count: 0, items: [] }),
  getDashboard: () => ({}),
  appVersion: () => ({ sha: 'test' }),
  getBrand: ({ brandId }) => brand(brandId, brandId === 'b1' ? 'Alpha' : 'Bravo'),
  updateBrand: (a) => {
    if ('doNotEmail' in a) S.dne[a.brandId] = a.doNotEmail;
    if ('notes' in a) S.brandNote[a.brandId] = a.notes;
    return { ok: true };
  },
  getEmailStatus: () => ({
    configured: true, address: 'zach@example.com', sentToday: 0, cap: 5, totalSent: 3, totalOpened: 1,
    totalReplies: 0, approved: 0, paused: false, via: 'gmail', google: { connected: true, email: 'zach@example.com' },
  }),
  listEmailQueue: () => ({ drafts: S.drafts, exhausted: [], replies: [], recent: [] }),
  setDraftRecipients: ({ id, toEmail }) => {
    const d = S.drafts.find((x) => x.id === id);
    if (d && toEmail) d.toEmail = toEmail;
    return { ok: true };
  },
  deleteEmailDraft: ({ id }) => { S.drafts = S.drafts.filter((x) => x.id !== id); return { ok: true }; },
  getTodayQueue: () => ({
    targets: S.queue, sentList: [], more: [], theme: 'energy', labels: {}, sendingDay: true, sentToday: 0, cap: S.dayCap,
  }),
  listTargets: () => [],
  listBrands: () => S.list,
  categoryReach: () => ({ categories: {}, newFromLinkedIn: 0 }),
  listDeals: () => ({ deals: S.deals, openCents: 0, wonCents: 0 }),
  setDealStage: ({ id, stage }) => { const d = S.deals.find((x) => x.id === id); if (d) d.stage = stage; return { ok: true }; },
  getDealRoom: ({ dealId }) => {
    const d = S.deals.find((x) => x.id === dealId);
    return {
      deal: { ...d, followUpAt: null, notes: S.roomNote || '', showSponsor: null,
        brand: { id: d.brandId, name: d.brand.name, contacts: Array.from({ length: 12 }, (_, i) => ({ id: 'rc' + i, name: 'Room Person ' + i, title: 'CMO', email: 'r' + i + '@x.com', linkedinUrl: null })) } },
      boardViews14d: 0, lastBoardVisit: null,
    };
  },
  listActivations: () => [{ id: 'a1', name: 'Campus Tour', status: 'planning', brand: { name: 'Alpha' }, budgetCents: 500000, currentCents: 0, daysOut: 10 }],
  getActivation: () => activation(),
  getRosterStatus: () => ({ configured: false }),
  getDriveStatus: () => ({ connected: false }),
  upsertBudgetLine: (a) => {
    S.saves.push(a);
    if ('finalCents' in a) S.finals[a.id] = a.finalCents;
    if ('notes' in a) S.notes[a.id] = a.notes;
    return { ok: true };
  },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/api/data')) {
      const { fn, args } = JSON.parse(route.request().postData() || '{}');
      S.calls.push(fn);
      const hold = S.hold[fn] && S.hold[fn].length ? S.hold[fn].shift() : (S.delay[fn] || 0);
      if (hold) await new Promise((r) => setTimeout(r, hold));
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

  // Watch a box for "Loading…" and the page for a trip to the top.
  const watch = (sel) => page.evaluate((s) => {
    window.__sawLoading = false;
    window.__minY = window.scrollY;
    const box = document.querySelector(s);
    if (window.__lw) window.__lw.disconnect();
    window.__lw = new MutationObserver(() => {
      if (/Loading…/.test(box.textContent)) window.__sawLoading = true;
      window.__minY = Math.min(window.__minY, window.scrollY);
    });
    window.__lw.observe(box, { childList: true, subtree: true, characterData: true });
    window.onscroll = () => { window.__minY = Math.min(window.__minY, window.scrollY); };
  }, sel);
  const watched = () => page.evaluate(() => ({ loading: window.__sawLoading, minY: window.__minY, y: window.scrollY }));
  const topOf = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top : null; }, sel);
  // Wait until `fn` has been answered `n` more times, then a beat for the draw.
  const answered = async (fn, before) => {
    for (let i = 0; i < 100; i++) {
      if (S.calls.filter((c) => c === fn).length > before) break;
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout((S.delay[fn] || 0) + 120);
  };
  const count = (fn) => S.calls.filter((c) => c === fn).length;

  // 1. Brand page ---------------------------------------------------
  let n = count('getBrand');
  await page.evaluate(() => loadBrand('b1'));
  await answered('getBrand', n);
  await page.waitForSelector('#b-dne', { state: 'attached' });
  // Open the sections and the edit form, then put "Emails on" mid-screen.
  await page.evaluate(() => {
    document.querySelectorAll('#brand-body details.fold').forEach((d) => { d.open = true; });
    document.getElementById('b-edit-toggle').click();
  });
  await page.evaluate(() => {
    const b = document.getElementById('b-dne');
    window.scrollTo(0, window.scrollY + b.getBoundingClientRect().top - 420);
  });
  const y0 = await page.evaluate(() => window.scrollY);
  assert.ok(y0 > 300, 'the brand page is long enough to scroll (' + y0 + ')');
  const btnTop = await topOf('#b-dne');
  S.delay.getBrand = 250;
  await watch('#brand-body');
  n = count('getBrand');
  await page.click('#b-dne');
  await answered('getBrand', n);
  let w = await watched();
  assert.equal(w.loading, false, 'brand refresh: no "Loading…"');
  assert.ok(w.minY > 300, 'brand refresh: never went to the top (lowest ' + w.minY + ')');
  assert.equal(await page.textContent('#b-dne'), 'Do not email', 'the button did its job');
  const btnTop2 = await topOf('#b-dne');
  assert.ok(Math.abs(btnTop2 - btnTop) <= 2, 'brand refresh: the clicked button stayed put (' + btnTop + ' → ' + btnTop2 + ')');
  const open = await page.evaluate(() => [].map.call(document.querySelectorAll('#brand-body details.fold'), (d) => d.open));
  assert.ok(open.length >= 2 && open.every(Boolean), 'brand refresh: open sections stay open ' + JSON.stringify(open));
  assert.equal(await page.evaluate(() => document.getElementById('b-edit').hidden), false, 'brand refresh: the edit form stays open');
  console.log('✓ 1a brand page refreshes in place');

  // Another brand: top of the page, with "Loading…".
  await watch('#brand-body');
  n = count('getBrand');
  await page.evaluate(() => loadBrand('b2'));
  await answered('getBrand', n);
  w = await watched();
  assert.equal(w.loading, true, 'another brand shows "Loading…"');
  assert.equal(w.y, 0, 'another brand opens at the top');
  assert.equal(await page.evaluate(() => document.getElementById('b-edit').hidden), true, 'another brand opens its edit form shut');
  assert.ok((await page.textContent('#brand-body h1')).includes('Bravo'));
  console.log('✓ 1b another brand opens at the top');

  // 2. Typing when a refresh lands -----------------------------------
  await page.evaluate(() => {
    document.querySelectorAll('#brand-body details.fold')[0].open = true;
    document.getElementById('b-edit-toggle').click();
    window.__changes = [];
    document.addEventListener('change', (e) => {
      const f = e.target.getAttribute && e.target.getAttribute('data-bfield');
      if (f) window.__changes.push(f + '=' + e.target.value);
    }, true);
  });
  await page.click('[data-bfield="notes"]');
  await page.keyboard.type('hello there');
  n = count('getBrand');
  await page.evaluate(() => loadBrand('b2'));   // a refresh from something else lands mid-typing
  await answered('getBrand', n);
  let f = await page.evaluate(() => {
    const a = document.activeElement;
    return { field: a && a.getAttribute('data-bfield'), value: a && a.value, caret: a && a.selectionStart, fresh: a && a.defaultValue === '' };
  });
  assert.equal(f.field, 'notes', 'typing: the box keeps the cursor');
  assert.equal(f.value, 'hello there', 'typing: the box keeps its text');
  assert.equal(f.caret, 'hello there'.length, 'typing: the cursor stays at the end');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  let ch = await page.evaluate(() => window.__changes);
  // Chrome fires it as the redraw removes the old box; elsewhere the new
  // box fires it on leaving. Either way: once.
  assert.deepEqual(ch, ['notes=hello there'], 'typing: the text still goes through its change, once ' + JSON.stringify(ch));
  // More typed after the refresh: the browser's own change fires — once.
  await page.evaluate(() => { window.__changes = []; });
  await page.click('[data-bfield="goals"]');
  await page.keyboard.type('more');
  n = count('getBrand');
  await page.evaluate(() => loadBrand('b2'));
  await answered('getBrand', n);
  await page.keyboard.type(' again');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  ch = await page.evaluate(() => window.__changes);
  assert.equal(ch[ch.length - 1], 'goals=more again', 'typing more after the refresh: the whole text goes through ' + JSON.stringify(ch));
  assert.equal(new Set(ch).size, ch.length, 'typing more after the refresh: nothing handed over twice ' + JSON.stringify(ch));
  console.log('✓ 2 the box being typed in keeps its cursor and text, and still saves');

  // 6. Out of order: the refresh started last wins -------------------
  S.delay.getBrand = 0;
  S.hold.getBrand = [500, 50];
  S.dne.b2 = false;
  n = count('getBrand');
  await page.evaluate(() => { loadBrand('b2'); });                          // slow, old answer
  await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
  S.dne.b2 = true;
  await page.evaluate(() => { loadBrand('b2'); });                          // fast, new answer
  await page.waitForTimeout(800);
  assert.equal(await page.textContent('#b-dne'), 'Do not email', 'the slow old answer did not draw over the new one');
  console.log('✓ 6 a slow refresh never draws over a newer one');

  // 3. Email tab -----------------------------------------------------
  await page.evaluate(() => gotoView('email-out'));
  await page.waitForSelector('[data-em="dr6"]');
  await page.click('[data-em="dr6"] [data-emtoggle]');
  await page.evaluate(() => {
    const c = document.querySelector('[data-em="dr6"]');
    window.scrollTo(0, window.scrollY + c.getBoundingClientRect().top - 300);
  });
  const selTop = await topOf('[data-em="dr6"] [data-emrec="to"]');
  S.delay.listEmailQueue = 200;
  await watch('#email-box');
  n = count('listEmailQueue');
  await page.selectOption('[data-em="dr6"] [data-emrec="to"]', 'b6@x.com');
  await answered('listEmailQueue', n);
  w = await watched();
  assert.equal(w.loading, false, 'email refresh: no "Loading…"');
  assert.ok(w.minY > 200, 'email refresh: never went to the top');
  assert.equal(await page.evaluate(() => document.querySelector('[data-em="dr6"] [data-embody]').style.display), 'block', 'email: the draft stays open');
  assert.equal(await page.inputValue('[data-em="dr6"] [data-emrec="to"]'), 'b6@x.com');
  const selTop2 = await topOf('[data-em="dr6"] [data-emrec="to"]');
  assert.ok(Math.abs(selTop2 - selTop) <= 2, 'email: the To box stayed put (' + selTop + ' → ' + selTop2 + ')');
  // Skip: the draft goes, the next one takes its place on screen.
  const cardTop = await topOf('[data-em="dr6"]');
  page.once('dialog', (d) => d.accept());
  n = count('listEmailQueue');
  await page.click('[data-em="dr6"] [data-emact="del"]');
  await answered('listEmailQueue', n);
  assert.equal(await page.$('[data-em="dr6"]'), null, 'the skipped draft is gone');
  const nextTop = await topOf('[data-em="dr7"]');
  assert.ok(Math.abs(nextTop - cardTop) <= 2, 'email: Skip closes the list up under the cursor (' + cardTop + ' → ' + nextTop + ')');
  console.log('✓ 3 Email tab keeps open drafts open and its place');

  // 4. LinkedIn queue + Brands list ------------------------------------
  await page.evaluate(() => gotoView('outreach'));
  await page.waitForSelector('#targets .target[data-id="q14"]');
  await page.evaluate(() => {
    const r = document.querySelector('#targets .target[data-id="q14"]');
    window.scrollTo(0, window.scrollY + r.getBoundingClientRect().top - 400);
  });
  const rowTop = await topOf('#targets .target[data-id="q14"]');
  S.delay.getTodayQueue = 200;
  S.queue = S.queue.filter((t) => !['q2', 'q3'].includes(t.id));   // a brand above went out of the queue
  await watch('#targets');
  n = count('getTodayQueue');
  await page.evaluate(() => { window.PLACE_HIT = null; loadOutreach(); });
  await answered('getTodayQueue', n);
  w = await watched();
  assert.equal(w.loading, false, 'LinkedIn refresh: no "Loading…"');
  const rowTop2 = await topOf('#targets .target[data-id="q14"]');
  assert.ok(Math.abs(rowTop2 - rowTop) <= 2, 'LinkedIn refresh: the rows on screen stay put (' + rowTop + ' → ' + rowTop2 + ')');
  console.log('✓ 4a LinkedIn queue refreshes in place');

  // The day's number is the server's, never a literal 20 on the page.
  assert.equal(await page.textContent('#fill20'), 'Fill to 30', 'the Fill button says the server\'s 30');
  assert.match(await page.textContent('#sent-today-chip'), /of 30 sent today/, 'the sent chip counts of 30');
  S.dayCap = 25;
  n = count('getTodayQueue');
  await page.evaluate(() => loadOutreach());
  await answered('getTodayQueue', n);
  assert.equal(await page.textContent('#fill20'), 'Fill to 25', 'another server number shows as it is');
  S.dayCap = 30;
  console.log('✓ 4c the LinkedIn tab shows the server\'s people-a-day number');

  await page.evaluate(() => gotoView('brands'));
  await page.waitForSelector('#brands-list [data-brand="lb50"]');
  await page.evaluate(() => {
    const r = document.querySelector('#brands-list [data-brand="lb50"]');
    window.scrollTo(0, window.scrollY + r.getBoundingClientRect().top - 400);
  });
  const lTop = await topOf('#brands-list [data-brand="lb50"]');
  S.delay.listBrands = 200;
  S.list = S.list.filter((b) => !['lb10', 'lb11', 'lb12'].includes(b.id));
  await watch('#brands-list');
  n = count('listBrands');
  await page.evaluate(() => { window.PLACE_HIT = null; loadBrands('all'); });
  await answered('listBrands', n);
  w = await watched();
  assert.equal(w.loading, false, 'Brands refresh: the list never emptied');
  const lTop2 = await topOf('#brands-list [data-brand="lb50"]');
  assert.ok(Math.abs(lTop2 - lTop) <= 2, 'Brands refresh: the rows on screen stay put (' + lTop + ' → ' + lTop2 + ')');
  // Another category: the top.
  n = count('listBrands');
  await page.evaluate(() => loadBrands('energy'));
  await answered('listBrands', n);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'another category opens at the top');
  // A nav tab on the screen already showing: the top too.
  await page.evaluate(() => window.scrollTo(0, 900));
  n = count('listBrands');
  await page.click('.tabs .nav-item[data-view="brands"]');
  await answered('listBrands', n);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'a nav tab opens at the top');
  console.log('✓ 4b Brands list refreshes in place; a category or tab starts at the top');

  // 5. Deals board -----------------------------------------------------
  await page.setViewportSize({ width: 900, height: 800 });
  await page.evaluate(() => gotoView('pipeline'));
  await page.waitForSelector('[data-scroll="deals"] [data-deal="dl1"]');
  const sw = await page.evaluate(() => {
    const k = document.querySelector('[data-scroll="deals"]');
    k.scrollLeft = 260;
    return { left: k.scrollLeft, over: k.scrollWidth > k.clientWidth };
  });
  assert.ok(sw.over && sw.left > 0, 'the board scrolls sideways at this width');
  S.delay.listDeals = 150;
  n = count('listDeals');
  await page.click('[data-deal="dl1"] [data-dact="move"][data-to="verbal"]');
  await answered('listDeals', n);
  const left2 = await page.evaluate(() => document.querySelector('[data-scroll="deals"]').scrollLeft);
  assert.equal(left2, sw.left, 'Deals: the board keeps its sideways scroll');
  assert.ok(await page.$('[data-deal="dl1"]'), 'the deal moved and is still on the board');
  console.log('✓ 5 Deals board keeps its sideways scroll');

  // The deal room, open and scrolled into: a refresh keeps it there.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('[data-deal="dl2"] [data-dact="room"]');
  await page.waitForSelector('#deal-room-slot .panel');
  await page.waitForTimeout(200);
  const roomY = await page.evaluate(() => {
    const s = document.getElementById('deal-room-slot');
    window.scrollTo(0, window.scrollY + s.getBoundingClientRect().bottom - 500);
    return window.scrollY;
  });
  assert.ok(roomY > 50, 'the deal room is scrolled into (' + roomY + ')');
  await watch('#deal-room-slot');
  n = count('getDealRoom');
  await page.evaluate(() => openDealRoom('dl2'));
  await answered('getDealRoom', n);
  w = await watched();
  assert.equal(w.loading, false, 'deal room refresh: no "Loading…"');
  assert.ok(w.minY > 50, 'deal room refresh: never went to the top');
  console.log('✓ 5b an open deal room refreshes where it is');

  // 7. Activations budget ----------------------------------------------
  await page.evaluate(() => gotoView('activations'));
  n = count('getActivation');
  await page.evaluate(() => openActivation('a1', 'budget'));
  await answered('getActivation', n);
  await page.waitForSelector('[data-line="ln22"] [data-lf="finalCents"]');
  await page.evaluate(() => {
    const r = document.querySelector('[data-line="ln22"]');
    window.scrollTo(0, window.scrollY + r.getBoundingClientRect().top - 400);
  });
  const aY = await page.evaluate(() => window.scrollY);
  assert.ok(aY > 300, 'the budget sheet is long enough to scroll (' + aY + ')');
  const lnTop = await topOf('[data-line="ln22"]');
  S.delay.getActivation = 300;
  await watch('#act-body');
  n = count('getActivation');
  await page.click('[data-line="ln22"] [data-lf="finalCents"]');
  await page.keyboard.type('123');
  await page.keyboard.press('Tab');                  // saves the cost → the sheet redraws
  await page.keyboard.type('paid');                  // …while the next cell is being typed in
  await answered('getActivation', n);
  w = await watched();
  assert.ok(w.minY > 300, 'budget: a cost edit never jumps to the top (lowest ' + w.minY + ')');
  const cell = await page.evaluate(() => {
    const a = document.activeElement;
    return { lf: a.getAttribute('data-lf'), line: a.closest('[data-line]') && a.closest('[data-line]').getAttribute('data-line'), value: a.value };
  });
  assert.deepEqual(cell, { lf: 'notes', line: 'ln22', value: 'paid' }, 'budget: the next cell keeps the cursor and its text ' + JSON.stringify(cell));
  assert.equal(await page.inputValue('[data-line="ln22"] [data-lf="finalCents"]'), '$123', 'budget: the cost shows as saved');
  const lnTop2 = await topOf('[data-line="ln22"]');
  assert.ok(Math.abs(lnTop2 - lnTop) <= 2, 'budget: the row stayed put (' + lnTop + ' → ' + lnTop2 + ')');
  await page.keyboard.type(' in full');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  const notesSaves = S.saves.filter((x) => 'notes' in x).map((x) => x.notes);
  assert.equal(notesSaves[notesSaves.length - 1], 'paid in full', 'budget: the note saves whole ' + JSON.stringify(notesSaves));
  assert.equal(new Set(notesSaves).size, notesSaves.length, 'budget: no note saved twice ' + JSON.stringify(notesSaves));
  console.log('✓ 7 Activations budget: a cost edit keeps the place and the next cell');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log('All keep-my-place checks passed.');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
