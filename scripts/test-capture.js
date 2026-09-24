// scripts/test-capture.js
//
// The capture userscript drives Leo's real, logged-in SponsorUnited tab
// and navigates it on its own. That is the riskiest thing in this repo,
// so it gets a test: a fake SponsorUnited (a banner search box whose
// placeholder never says "search", plus a contacts tab with its own
// filter box) and a fake dashboard, and then three questions.
//
//   1. Does it leave a tab alone while someone is using it?
//   2. Left alone, does it run the whole fill by itself — look up the
//      profile ids we are missing, then capture the people behind them?
//   3. Does it find their banner search box at all? (It didn't: the old
//      code looked for the word "search" in the placeholder, which their
//      wording does not contain, and that is why nothing worked.)
//
// Run: node scripts/test-capture.js     (needs playwright; ~60s)

// A fake SponsorUnited, to prove three things about the userscript
// before it drives Leo's real logged-in tab:
//   1. it finds their banner search box (the bug he hit),
//   2. the by-itself fill starts on an idle tab and walks the worklist,
//   3. a human touching the tab stops it from navigating.
const http = require('http');
const fs = require('fs');
const path = require('path');
// Playwright is not a dependency of this app — it is a testing tool, and
// adding it to package.json would put it in every Vercel build for
// nothing. Install it when you want to run this: npm i --no-save playwright
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('This test needs playwright. Run:  npm i --no-save playwright');
  process.exit(1);
}

const SCRIPT = fs.readFileSync(path.join(__dirname, 'sponsorunited-capture.user.js'), 'utf8')
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'http://127.0.0.1:4611/api/ingest'")
  .replace("'PASTE_INGEST_TOKEN_HERE'", "'test-token'")
  .replace(/'https:\/\/pro\.sponsorunited\.com\/profile\/'/g, "'http://127.0.0.1:4612/profile/'");

const calls = [];
// Flipped on for the resting case; see below.
let ALL_RESTING = false;
// Set for the dropdown case: the brands the lookup is asked to find.
let NEED_ITEMS = null;

// --- the fake dashboard -------------------------------------------------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};
const api = http.createServer((req, res) => {
  // The real endpoint answers the preflight; without it every POST from
  // the page is blocked and the script looks dead for no reason.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    calls.push(j);
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    if (j.action === 'needProfile') {
      return res.end(JSON.stringify({ ok: true, items: NEED_ITEMS || [{ brandId: 'b1', name: 'Yerba Madre', aka: null, contacts: 2 }] }));
    }
    if (j.action === 'matched') return res.end(JSON.stringify({ ok: true, outcome: 'attached' }));
    if (j.action === 'list') {
      // Everything rests until the override asks for them anyway. This
      // is the state Leo hit: a worklist of almost nothing. Only the
      // resting case turns it on, so the earlier cases still capture.
      if (ALL_RESTING && !j.ignoreRest) {
        return res.end(JSON.stringify({ ok: true, scope: j.scope, noProfile: 220, resting: 16,
          underCap: 17, eligible: 0, cap: 25, brands: [] }));
      }
      return res.end(JSON.stringify({ ok: true, scope: j.scope, noProfile: 220, resting: 16,
        underCap: 17, eligible: 17, ignoredRest: true, cap: 25,
        brands: [{ id: 'b1', name: 'Yerba Madre', externalId: 'ULID1', suName: 'Yerba Madre', contacts: 2 }] }));
    }
    if (j.action === 'searchJob') return res.end(JSON.stringify({ ok: true, job: null }));
    res.end(JSON.stringify({ ok: true, contactsCreated: 2, skipped: 0, capped: 0, brandsMissing: [], brandsCreated: [] }));
  });
});

// --- the fake SponsorUnited --------------------------------------------
// A banner box whose placeholder never says "search" (their real one),
// plus the contacts tab's own filter box, which must NOT be picked.
const page = (title, extra) => `<!doctype html><html><body style="margin:0">
<header style="height:56px;display:flex;align-items:center;padding:0 16px;background:#111">
  <input style="width:420px;height:32px" placeholder="SUrface deals, contacts, profiles and more" id="banner">
</header>
<main style="padding:20px"><h1>${title}</h1>
<input style="width:200px;height:28px" placeholder="Search contacts">
${extra || ''}</main></body></html>`;

// Their search is an icon on some pages and a live box on others. The
// icon version is what "No search box here" was really reporting.
const hiddenSearchPage = () => `<!doctype html><html><body style="margin:0">
<header style="height:56px;display:flex;align-items:center;padding:0 16px;background:#111">
  <button aria-label="Search" id="searchbtn" style="width:32px;height:32px">S</button>
  <div id="searchslot"></div>
</header>
<main style="padding:20px"><h1>Discovery</h1></main>
<script>
  document.getElementById('searchbtn').addEventListener('click', function () {
    document.getElementById('searchslot').innerHTML =
      '<input id="banner" style="width:420px;height:32px" placeholder="SUrface deals, contacts, profiles and more">';
  });
</script>
</body></html>`;

// Their dashboard as Leo's screenshots show it: eight brand cards of its
// own (name over category), and a search whose dropdown is drawn after
// them — each result a link holding the name, the category and a Brand /
// Property tag. The list re-uses its rows between searches and only hides
// itself when the box is cleared, the way a React list does. Reading the
// cards as results is what gave every brand the same eight "matches".
const DASH_CARDS = [
  ['ESKA1', 'ESKA Water', 'Beverage - Non-Alcoholic Water & Specialty Water'],
  ['APO1', 'Apothekary', 'Healthcare Pharma & Over the Counter'],
  ['HALF1', 'Halfday Iced Tea', 'Beverage - Non-Alcoholic Tea'],
  ['HIMS1', 'Hims', 'Healthcare Pharma & Over the Counter'],
  ['SIP1', 'Sip Elixirs', 'Healthcare Cannabis (CBD, Hemp, THC)'],
  ['SALT1', 'Salt Air and Electric', 'Construction & Industrial Electrical'],
  ['BLOOM1', 'Bloom', 'Technology Web / App (Visual, Social & Collaboration)'],
  ['GATO1', 'Gatorade', 'Beverage - Non-Alcoholic Sports Drink'],
];
const DASH_RESULTS = {
  'velo': [['VELO1', 'Velo', 'Tobacco & Nicotine', 'Brand'],
    ['VELOC', 'Velo Charities', "Other Charities, PBC's & Non-Profits", 'Brand'],
    ['VARENA', 'Velo Arena', 'Venues', 'Property']],
  'good culture': [['GC1', 'Good Culture', 'Food - Dairy', 'Brand'], ['GCCLUB', 'Good Culture Club', 'Clubs', 'Property']],
};
const dashPage = () => `<!doctype html><html><body style="margin:0">
<header style="height:56px;background:#111"></header>
<main style="padding:20px">
  <textarea id="banner" style="width:860px;height:60px" placeholder="SUrface deals, contacts, profiles and more"></textarea>
  <div>${DASH_CARDS.map(c => `<a href="/profile/${c[0]}" style="display:block;padding:8px;color:#111">
    <div>${c[1]}</div><div style="color:#888">${c[2]}</div></a>`).join('')}</div>
</main>
<script>
  var RESULTS = ${JSON.stringify(DASH_RESULTS)};
  var dd = document.createElement('div');
  dd.style.cssText = 'position:absolute;top:150px;left:20px;width:700px;background:#fff;border:1px solid #ccc;display:none';
  document.body.appendChild(dd);
  var t = null;
  document.getElementById('banner').addEventListener('input', function (e) {
    var q = e.target.value.trim().toLowerCase();
    clearTimeout(t);
    if (!q) { dd.style.display = 'none'; return; }
    t = setTimeout(function () {
      var rows = RESULTS[q] || [];
      while (dd.children.length > rows.length) dd.removeChild(dd.lastChild);
      rows.forEach(function (r, i) {
        var a = dd.children[i] || dd.appendChild(document.createElement('a'));
        a.setAttribute('href', '/profile/' + r[0]);
        a.style.cssText = 'display:flex;justify-content:space-between;padding:10px;color:#111';
        a.innerHTML = '<div><div>' + r[1] + '</div><div style="color:#888">' + r[2] + '</div></div><span>' + r[3] + '</span>';
      });
      dd.style.display = rows.length ? 'block' : 'none';
    }, 300);
  });
</script></body></html>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/dash')) return res.end(dashPage());
  if (req.url.startsWith('/profile/')) {
    // Two people, laid out the way their contacts tab lays them out:
    // a card with the name, title and a LinkedIn link.
    const card = (n, t) => `<div style="border:1px solid #ddd;padding:10px;margin:8px 0">
      <div>${n}</div><div>${t}</div><div>Austin, TX</div>
      <a href="https://www.linkedin.com/in/${n.toLowerCase().replace(/ /g, '-')}">LinkedIn</a>
      <a href="mailto:${n.split(' ')[0].toLowerCase()}@yerba.test">email</a></div>`;
    return res.end(page('Yerba Madre',
      card('Dana Reyes', 'Director, Campus Marketing') + card('Sam Okafor', 'Partnerships Manager')));
  }
  if (req.url.startsWith('/hidden')) return res.end(hiddenSearchPage());
  // No banner box and nothing that looks like search: the case where
  // the lookup genuinely cannot run here.
  if (req.url.startsWith('/textarea')) {
    return res.end(`<!doctype html><html><body style="margin:0">
      <header style="height:56px;background:#111"></header>
      <main style="padding:40px;text-align:center">
        <h1>Surface quick insights now.</h1>
        <textarea id="banner" style="width:860px;height:145px"
          placeholder="SUrface deals, contacts, profiles and more"></textarea>
        <input type="file" style="width:0">
        ${[1, 2, 3, 4, 5].map(() => '<input type="checkbox">').join('')}
      </main></body></html>`);
  }
  if (req.url.startsWith('/nobox')) {
    return res.end(`<!doctype html><html><body style="margin:0">
      <header style="height:56px;background:#111"></header>
      <main style="padding:20px"><h1>A profile page</h1></main></body></html>`);
  }
  res.end(page('Home'));
});

const fail = m => { console.error('SU SMOKE FAIL: ' + m); process.exit(1); };

function chromeAt() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { return null; }
  for (const d of dirs.filter(d => /^chromium-/.test(d))) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  await new Promise(r => api.listen(4611, r));
  await new Promise(r => site.listen(4612, r));
  // Use whatever chromium is on this machine; the pinned path differs
  // between the sandbox and a laptop.
  const browser = await chromium.launch(chromeAt() ? { executablePath: chromeAt() } : {});
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('page error: ' + e.message));

  // A userscript runs again on every page load — the sweep navigates, so
  // injecting once would only ever test the first page.
  await p.addInitScript({ content: SCRIPT });
  await p.goto('http://127.0.0.1:4612/');
  // Someone is using this tab right now.
  await p.evaluate(() => { localStorage.setItem('sbActivityAt', String(Date.now())); });

  // 1. a tab in use is left alone
  await p.waitForTimeout(25000);
  const early = calls.filter(c => c.action === 'needProfile' || c.action === 'list');
  if (early.length) fail('it started a run while the tab was being used');
  console.log('held off while the tab was in use');

  // 2. left alone, it starts and walks both halves by itself
  await p.evaluate(() => { localStorage.setItem('sbActivityAt', String(Date.now() - 3600000)); });
  const started = Date.now();
  let sawRows = false;
  while (Date.now() - started < 120000) {
    sawRows = calls.some(c => Array.isArray(c.rows));
    if (sawRows) break;
    await p.waitForTimeout(1000);
  }
  if (!calls.some(c => c.action === 'needProfile')) fail('the fill never asked which brands need a profile id');
  const matched = calls.find(c => c.action === 'matched');
  if (!matched) fail('it never searched — the banner search box was not found');
  if (!matched.candidates) fail('matched call carried no candidates field');
  if (!calls.some(c => c.action === 'list' && c.scope === 'thin')) fail('it looked up ids but never went on to capture contacts');
  if (!sawRows) fail('it opened the profile but never sent any contacts');
  console.log('auto-fill ran on its own: needProfile -> matched -> list(thin) -> contacts posted');

  // 3. an install with no token saved asks for one and stays silent —
  //    it must not sit there firing rejected writes at the dashboard.
  // The first tab is still mid-sweep; close it or its calls get counted
  // against the silent one.
  await ctx.close();
  const bare = await browser.newContext();
  const q = await bare.newPage();
  q.on('pageerror', e => fail('page error (no token): ' + e.message));
  await q.addInitScript({ content: SCRIPT.replace("'test-token'", "'PASTE_INGEST_TOKEN_HERE'") });
  await q.goto('http://127.0.0.1:4612/');
  await q.evaluate(() => { localStorage.setItem('sbActivityAt', String(Date.now() - 3600000)); });
  const quietFrom = calls.length;
  await q.waitForTimeout(25000);
  if (calls.length !== quietFrom) fail('it called the dashboard with no token saved');
  await q.click('button');  // the SB pill
  const asks = await q.evaluate(() => !!document.querySelector('#sbtok'));
  if (!asks) fail('with no token saved, the pill did not ask for one');
  await bare.close();
  console.log('with no token: silent, and asks for one when opened');

  // 4. a page whose search is behind an icon. This is what Leo hit:
  //    the script said "No search box here" because there was no box on
  //    the page yet. It must open the search and use it.
  const iconCtx = await browser.newContext();
  const ic = await iconCtx.newPage();
  ic.on('pageerror', e => fail('page error (icon search): ' + e.message));
  // "Test the search on this page" asks for a name with prompt().
  ic.on('dialog', d => d.accept('Red Bull'));
  await ic.addInitScript({ content: SCRIPT });
  await ic.goto('http://127.0.0.1:4612/hidden');
  await ic.waitForTimeout(1200);
  if (await ic.locator('#banner').count()) fail('fixture wrong: the box should start hidden');

  // Open the SB menu and run the search test.
  await ic.click('#sbpill');
  await ic.waitForTimeout(300);
  await ic.click('#sbtest');
  await ic.waitForTimeout(4000);

  if (!(await ic.locator('#banner').count())) fail('the script did not open the search behind the icon');
  const typed = await ic.inputValue('#banner').catch(() => '');
  if (typed !== 'Red Bull') fail('the search box was opened but nothing was typed into it: ' + JSON.stringify(typed));
  await iconCtx.close();
  console.log('search behind an icon: opened and used');

  // 5. everything resting: the panel says so AND offers to go through
  //    them anyway, which is the only way Leo gets those brands walked
  //    before the fortnight is up.
  ALL_RESTING = true;
  const restCtx = await browser.newContext();
  const rc = await restCtx.newPage();
  rc.on('pageerror', e => fail('page error (resting): ' + e.message));
  await rc.addInitScript({ content: SCRIPT });
  await rc.goto('http://127.0.0.1:4612/');
  await rc.waitForTimeout(1200);
  await rc.click('#sbpill');
  await rc.waitForTimeout(300);
  await rc.click('#sbmissing');
  await rc.waitForTimeout(1500);
  const restText = await rc.evaluate(() => document.body.innerText);
  if (restText.indexOf('resting') === -1) fail('the panel did not say why there was nothing to sweep');
  if (!(await rc.locator('#sbwake').count())) fail('no way to override the rest period');
  if (restText.indexOf('220') === -1) fail('the panel did not say how many brands have no profile saved');
  // 193 unreachable beats 18 resting: the lookup must be the primary
  // button here, not an afterthought behind the resting override.
  if (!(await rc.locator('#sbfindnow').count())) fail('nothing-to-sweep offers no way to start the lookup');
  const before = calls.filter(c => c.action === 'list' && c.ignoreRest).length;
  await rc.click('#sbwake');
  await rc.waitForTimeout(1500);
  if (calls.filter(c => c.action === 'list' && c.ignoreRest).length <= before) fail('the override did not reach the dashboard');
  await restCtx.close();
  console.log('resting brands: explained, and overridable');

  // 6. a sweep that finishes with nothing to show must not dead-end:
  //    193 brands with no profile is the actual job, so the panel says
  //    so and starts it.
  ALL_RESTING = false;
  const doneCtx = await browser.newContext();
  const dc = await doneCtx.newPage();
  dc.on('pageerror', e => fail('page error (done panel): ' + e.message));
  await dc.addInitScript({ content: SCRIPT });
  await dc.goto('http://127.0.0.1:4612/');
  await dc.waitForTimeout(1200);
  await dc.click('#sbpill');
  await dc.waitForTimeout(300);
  await dc.click('#sbmissing');
  // One brand, then the profile page, then finished.
  await dc.waitForTimeout(9000);
  const doneText = await dc.evaluate(() => document.body.innerText);
  if (doneText.indexOf('Sweep finished') === -1) fail('the sweep did not finish: ' + doneText.slice(0, 200));
  if (doneText.indexOf('220') === -1) fail('the finish panel does not say how many brands have no profile');
  if (!(await dc.locator('#sbnext').count())) fail('the finish panel offers no next step');
  const beforeNeed = calls.filter(c => c.action === 'needProfile').length;
  await dc.click('#sbnext');
  await dc.waitForTimeout(1500);
  if (calls.filter(c => c.action === 'needProfile').length <= beforeNeed) fail('the next step did not start the lookup');
  await doneCtx.close();
  console.log('a finished sweep points at the real blocker');

  // 7. "Fill every brand to 25" on a page with no search box must NOT
  //    quietly become a capture run. That silent fall-through is why
  //    Leo kept pressing it and getting "nothing to sweep".
  ALL_RESTING = true;
  const fallCtx = await browser.newContext();
  const fc = await fallCtx.newPage();
  fc.on('pageerror', e => fail('page error (fallthrough): ' + e.message));
  await fc.addInitScript({ content: SCRIPT });
  await fc.goto('http://127.0.0.1:4612/nobox');
  await fc.waitForTimeout(1200);
  const listsBefore = calls.filter(c => c.action === 'list').length;
  await fc.click('#sbpill');
  await fc.waitForTimeout(300);
  await fc.click('#sbfill');
  await fc.waitForTimeout(4000);
  if (calls.filter(c => c.action === 'list').length > listsBefore) {
    fail('the lookup silently fell through to a capture sweep');
  }
  await fallCtx.close();
  console.log('no search box: the lookup does not silently become a capture');

  // 8. their real dashboard: the search is a TEXTAREA, well below the
  //    banner, surrounded by checkboxes and a file input. Every
  //    selector list that only named <input> walked straight past it,
  //    which is what "Could not reach the search" was reporting.
  ALL_RESTING = false;
  const taCtx = await browser.newContext();
  const ta = await taCtx.newPage();
  ta.on('pageerror', e => fail('page error (textarea search): ' + e.message));
  ta.on('dialog', d => d.accept('Red Bull'));
  await ta.addInitScript({ content: SCRIPT });
  await ta.goto('http://127.0.0.1:4612/textarea');
  await ta.waitForTimeout(1200);
  await ta.click('#sbpill');
  await ta.waitForTimeout(300);
  await ta.click('#sbtest');
  await ta.waitForTimeout(3000);
  const typedTa = await ta.inputValue('#banner').catch(() => '');
  if (typedTa !== 'Red Bull') {
    fail('the textarea search box was not found or not typed into: ' + JSON.stringify(typedTa));
  }
  await taCtx.close();
  console.log('a textarea search box is found and used');

  // 9. the dropdown, not the page: a search reads only what came up
  //    under the box — name without its category, brands only — and
  //    never the dashboard's own eight cards.
  const ddCtx = await browser.newContext();
  const dp = await ddCtx.newPage();
  dp.on('pageerror', e => fail('page error (dropdown): ' + e.message));
  dp.on('dialog', d => d.accept('Velo'));
  await dp.addInitScript({ content: SCRIPT });
  await dp.goto('http://127.0.0.1:4612/dash');
  await dp.waitForTimeout(1200);
  await dp.click('#sbpill');
  await dp.waitForTimeout(300);
  await dp.click('#sbtest');
  await dp.waitForTimeout(4000);
  // The SB panel only — the page itself shows the cards and the dropdown.
  const testText = await dp.evaluate(() => {
    const el = [].slice.call(document.body.children).reverse().find(d => /Search test/.test(d.innerText || ''));
    return el ? el.innerText : '';
  });
  if (testText.indexOf('Found 2: Velo · Velo Charities') === -1) {
    fail('the search test did not read the dropdown: ' + (testText.match(/Found[^\n]*|no brand results[^\n]*/) || ['(nothing)'])[0]);
  }
  if (/ESKA|Arena|Tobacco/.test(testText)) fail('the search test read page cards, a Property or a category as results');
  await ddCtx.close();
  console.log('search test reads the dropdown: names only, brands only, no page cards');

  // 10. the batch lookup across three brands, one of which SponsorUnited
  //     has nothing for: each gets its own results, and the empty one
  //     gets none — not the page's cards, not the last brand's leftovers.
  NEED_ITEMS = [
    { brandId: 'bv', name: 'Velo', aka: null, contacts: 0 },
    { brandId: 'bh', name: 'Henkel Consumer Goods', aka: null, contacts: 0 },
    { brandId: 'bg', name: 'Good Culture', aka: null, contacts: 0 },
  ];
  const batchCtx = await browser.newContext();
  const bp = await batchCtx.newPage();
  bp.on('pageerror', e => fail('page error (batch lookup): ' + e.message));
  await bp.addInitScript({ content: SCRIPT });
  await bp.goto('http://127.0.0.1:4612/dash');
  await bp.waitForTimeout(1200);
  const fromCall = calls.length;
  await bp.click('#sbpill');
  await bp.waitForTimeout(300);
  await bp.click('#sbfind');
  const got = () => calls.slice(fromCall).filter(c => c.action === 'matched');
  const t0 = Date.now();
  while (got().length < 3 && Date.now() - t0 < 60000) await bp.waitForTimeout(1000);
  const ids = id => ((got().find(c => c.brandId === id) || {}).candidates || []).map(c => c.externalId + ':' + c.name).join(', ');
  if (got().length < 3) fail('the lookup searched ' + got().length + ' of 3 brands');
  if (ids('bv') !== 'VELO1:Velo, VELOC:Velo Charities') fail('Velo got: ' + ids('bv'));
  if (ids('bh') !== '') fail('Henkel (no results) got: ' + ids('bh'));
  if (ids('bg') !== 'GC1:Good Culture') fail('Good Culture got: ' + ids('bg'));
  await batchCtx.close();
  NEED_ITEMS = null;
  console.log('batch lookup: each brand gets its own results, an empty search gets none');

  console.log('SU SMOKE OK');
  await browser.close();
  api.close(); site.close();
  process.exit(0);
})().catch(e => fail(e.message));
