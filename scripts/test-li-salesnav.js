// scripts/test-li-salesnav.js
//
// The LinkedIn fill with Sales Navigator (script 1.31, Leo, Oct 12 2026:
// "build out the fill for a Sales Navigator page on my own account").
// Fake LinkedIn + fake Sales Navigator + a fake dashboard:
//
//   1. A brand's People tab is read whole first; then, instead of its
//      marketing / partnerships views, Sales Navigator's lead search by
//      the brand's company id: function Marketing + Business Development
//      (the next page when one is full), then "partnership(s) OR
//      sponsorship(s)". Results draw as they scroll into view, as Sales
//      Navigator's do. People are saved with linkedin.com/in/<member id>
//      links and "Title at Company" headlines; someone at another company
//      is left out. The visit says it went through Sales Navigator, and
//      the hidden people it sends are only the ones Sales Navigator still
//      couldn't name, as the People tab's views Zach can open.
//   2. A big company (100+ on LinkedIn) skips the People tab's searches:
//      Sales Navigator straight away, its page checked on the first save.
//   3. No company id: the brand gets the People tab views, as before.
//   4. A company id that turns up another company's people: nobody saved
//      from it, the People tab views instead.
//   5. An account without Sales Navigator (LinkedIn sends it to the
//      upsell page): the rest of the run uses the People tab, and the
//      panel says so.
//   6. The setup panel's switch is on by default, remembered, and sent
//      with the worklist; the brands back for Sales Navigator are named.
//
// Run: NODE_PATH=$(npm root -g) node scripts/test-li-salesnav.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) {
  console.error('This test needs playwright. Run:  npm i --no-save playwright');
  process.exit(1);
}

const PORT = 4623;
const RAW = fs.readFileSync(path.join(__dirname, 'linkedin-capture.user.js'), 'utf8');
// Each wait the test shortens must still be in the script, or the test
// would quietly run with LinkedIn's real waits.
for (const lit of ['document.hidden ? 60000 : 30000', 'var DASH_RETRY_MS = [5000, 15000, 30000, 60000, 60000, 60000];']) {
  assert.ok(RAW.includes(lit), 'the script still has: ' + lit);
}
const SCRIPT = RAW
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'http://127.0.0.1:" + PORT + "/api/ingest'")
  .replace(/function rand\(a, b\) \{[^}]*\}/, 'function rand() { return 30; }')
  // Sales Navigator's results wait: seconds on LinkedIn, too long for a test.
  .replace('document.hidden ? 60000 : 30000', '2500')
  // The dashboard retry: minutes in real life.
  .replace('var DASH_RETRY_MS = [5000, 15000, 30000, 60000, 60000, 60000];', 'var DASH_RETRY_MS = [100, 100, 100];');

// ---- fake LinkedIn ------------------------------------------------
function peopleCard(slug, name, headline) {
  return '<li><section><a href="https://www.linkedin.com/in/' + slug + '/">' + name + '</a> <span>· 2nd</span><div>' + headline + '</div></section></li>';
}
const HIDDEN_CARD = '<li><section><div>LinkedIn Member</div><div>Marketing at Liquid Death</div></section></li>';
function peoplePage(title, people, extra) {
  return '<!doctype html><html><body><main><h1 class="org-top-card-summary__title">' + title + '</h1>' +
    '<div class="org-top-card-summary-info-list"><div class="org-top-card-summary-info-list__info-item">Beverage Manufacturing</div></div>' +
    (extra || '') + '<ul>' + people + '</ul></main></body></html>';
}

// A Sales Navigator result, in its own markup (data-anonymize marks).
function lead(id, name, title, company) {
  return '<li class="artdeco-list__item"><div class="artdeco-entity-lockup">' +
    '<a href="/sales/lead/' + id + ',NAME_SEARCH,xY1z?_ntb=abc" data-control-name="view_lead_panel_via_search_lead_name">' +
      '<span data-anonymize="person-name">' + name + '</span></a>' +
    '<span class="artdeco-entity-lockup__degree">· 3rd</span>' +
    '<div class="artdeco-entity-lockup__subtitle"><span data-anonymize="title">' + title + '</span>' +
      '<span class="separator">·</span><a href="/sales/company/1234" data-anonymize="company-name">' + company + '</a></div>' +
    '<div data-anonymize="location">Austin, Texas</div></div><button>Save</button></li>';
}
const mid = (n) => 'ACwAAA' + String(n).padStart(4, '0') + 'BbCcDdEeFfGgHhIiJjKk';
// Results draw only once they're scrolled into view.
function salesPage(items, total) {
  return '<!doctype html><html><body><main>' + (total == null ? '' : '<div>' + total + ' results</div>') +
    '<div id="search-results-container" style="height:400px;overflow-y:auto"><ol>' +
    items.map((html, i) => '<li class="sn-slot" style="min-height:120px" data-i="' + i + '"></li>').join('') +
    '</ol></div></main><script>' +
    'var ITEMS = ' + JSON.stringify(items) + ';' +
    'var io = new IntersectionObserver(function (es) { es.forEach(function (e) {' +
    '  if (!e.isIntersecting || e.target.dataset.done) return; e.target.dataset.done = 1;' +
    '  var t = document.createElement("template"); t.innerHTML = ITEMS[+e.target.dataset.i];' +
    '  e.target.replaceWith(t.content.firstChild); }); }, { root: document.getElementById("search-results-container") });' +
    'document.querySelectorAll(".sn-slot").forEach(function (s) { io.observe(s); });' +
    '</script></body></html>';
}

const COMPANY_IDS = { 'liquid-death': '1234', 'big-co': '5678', 'wrong-id': '7777', 'no-sn': '9999', 'tiny-co': '4321', 'tiny-two': '4322', 'stuck-one': '4401', 'stuck-two': '4402', 'small-sn': '4501',
  'part-co': '4601', 'big-parent': '4701', 'huge-ok': '4801', 'flaky-dash': '4901', 'empty-tab': '4999',
  'hidden-co': '5101', 'no-count': '5201', 'part-co-p': '4601' };
const salesQueries = [];

const sent = [];
let fillItems = [];
// The dashboard misbehaving: the next N calls of an action drop the
// connection (or answer 502 with a page).
const dashFail = { action: null, n: 0, how: 'drop' };
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/api/ingest') {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (dashFail.n > 0 && body.action === dashFail.action) {
        dashFail.n--;
        if (dashFail.how === 'drop') return req.socket.destroy();
        if (dashFail.how === '500') {
          res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, cors));
          return res.end('{"ok":false,"error":"Could not save the visit: database error"}');
        }
        res.writeHead(502, Object.assign({ 'Content-Type': 'text/html' }, cors));
        return res.end('<html><body>Bad gateway</body></html>');
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (body.action === 'liVersion' || body.action === 'liRun') return res.end('{"ok":true}');
      sent.push(body);
      if (body.action === 'liList') {
        return res.end(JSON.stringify({ ok: true, items: fillItems, cap: 25, noPage: 0, resting: 0, research: 0, planned: 0, noBuyer: 0,
          retry: fillItems.filter(i => i.retry).length, hiddenRetry: fillItems.filter(i => i.retry).length }));
      }
      if (body.action === 'liCapture') {
        // b-nonew: everyone already on file (a second try).
        return res.end(JSON.stringify({ ok: true, brand: { id: body.brandId, name: body.companyName }, added: body.brandId === 'b-nonew' ? 0 : (body.rows || []).length, have: 5, cap: 25 }));
      }
      res.end('{"ok":true}');
    });
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/voyager/api/organization/companies') {
    const id = COMPANY_IDS[url.searchParams.get('universalName')];
    if (!id || !req.headers['csrf-token']) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ elements: [{ entityUrn: 'urn:li:fs_normalized_company:' + id, name: 'x' }] }));
  }
  // An account without Sales Navigator: LinkedIn sends it to the upsell.
  if (url.pathname === '/sales/search/people' && /organization%3A9999|organization:9999/.test(req.url)) {
    salesQueries.push({ co: '9999', kind: 'redirect', page: 1, q: '' });
    res.writeHead(302, { Location: '/premium/products/?family=SALES' });
    return res.end();
  }
  // No such page 2: Sales Navigator drops the page number.
  if (url.pathname === '/sales/search/people' && /organization%3A5201|organization:5201/.test(req.url) && url.searchParams.get('page') === '2') {
    salesQueries.push({ co: '5201', kind: 'clamped', page: 2, q: '' });
    url.searchParams.delete('page');
    res.writeHead(302, { Location: url.pathname + '?' + url.searchParams.toString() });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.pathname === '/sales/search/people') {
    const q = decodeURIComponent(url.searchParams.get('query') || '');
    const page = Number(url.searchParams.get('page') || 1);
    const co = (q.match(/urn:li:organization:(\d+)/) || [])[1];
    const kind = /type:FUNCTION/.test(q) ? 'fn' : /keywords:/.test(q) ? 'kw' : '?';
    salesQueries.push({ co, kind, page, q });
    if (co === '7777') {
      return res.end(salesPage([1, 2, 3, 4].map(n => lead(mid(700 + n), 'Other ' + n, 'Brand Manager', 'Totally Other Inc')), 4));
    }
    if (co === '1234' && kind === 'fn' && page === 1) {
      const items = [];
      for (let n = 1; n <= 25; n++) items.push(lead(mid(n), 'Person ' + n, n % 2 ? 'Brand Manager' : 'Field Marketing Lead', 'Liquid Death'));
      return res.end(salesPage(items, 28));
    }
    if (co === '1234' && kind === 'fn' && page === 2) {
      return res.end(salesPage([
        lead(mid(26), 'Person 26', 'Head of Partnerships', 'Liquid Death'),
        // Two jobs; the one shown is elsewhere — left out.
        lead(mid(27), 'Moonlighter', 'Marketing Consultant', 'Some Agency LLC'),
        lead(mid(28), 'LinkedIn Member', 'Director of Brand Marketing', 'Liquid Death'),
      ], 28));
    }
    if (co === '1234' && kind === 'kw') {
      return res.end(salesPage([lead(mid(40), 'Sam Sponsor', 'Sponsorship Manager', 'Liquid Death, Inc.')], 1));
    }
    if (co === '5678') return res.end(salesPage([lead(mid(50), 'Bea Big', 'VP Marketing', 'Big Co')], 1));
    if (co === '4801') return res.end(salesPage([lead(mid(80), 'Hu Ok', 'VP Marketing', 'huge-ok')], 1));
    if (co === '4901') return res.end(salesPage([lead(mid(90), 'Fay Flaky', 'Brand Manager', 'flaky-dash')], 1));
    // Says 40, draws 20 on its first page however often it's loaded; page 2
    // has the 15 it should.
    if (co === '4601' && kind === 'fn' && page === 1) {
      const items = [];
      for (let k = 1; k <= 20; k++) items.push(lead(mid(600 + k), 'Part ' + k, 'Brand Manager', 'part-co'));
      return res.end(salesPage(items, 40));
    }
    if (co === '4601' && kind === 'fn' && page === 2) {
      const items = [];
      for (let k = 26; k <= 40; k++) items.push(lead(mid(600 + k), 'Part ' + k, 'Brand Manager', 'part-co'));
      return res.end(salesPage(items, 40));
    }
    // Only "LinkedIn Member" results (all with lead links): read fine, nobody to name.
    if (co === '5101') return res.end(salesPage([1, 2, 3, 4].map(n => lead(mid(510 + n), 'LinkedIn Member', 'Marketing Manager', 'hidden-co')), 4));
    // No results count on the page and a full first page.
    if (co === '5201' && kind === 'fn') {
      const items = [];
      for (let k = 1; k <= 25; k++) items.push(lead(mid(520 + k), 'Count ' + k, 'Brand Manager', 'no-count'));
      return res.end(salesPage(items, null));
    }
    // A brand under its parent: the parent's people who name it.
    if (co === '4701') return res.end(salesPage([lead(mid(70), 'Kim Kid', 'Brand Manager, Kid Brand', 'Big Parent')], 1));
    // A brand with nobody in marketing: Sales Navigator's own empty page,
    // no results count on it (Leo's first run, Oct 12 2026).
    // A results page that never draws (a slow or hidden window).
    if (co === '4501') return res.end(salesPage([lead(mid(60), 'Sue Small', 'Head of Marketing', 'small-sn')], 1));
    if (co === '4401' || co === '4402') return res.end('<!doctype html><html><body><main><div class="spinner"></div></main></body></html>');
    if (co === '4321' || co === '4322') {
      return res.end('<!doctype html><html><body><main><h2>No matches found</h2><p>Remove the Function filter to show leads matching your other filters.</p></main></body></html>');
    }
    return res.end(salesPage([], 0) + '<div>No leads match your search</div>');
  }
  if (url.pathname === '/premium/products/') return res.end('<!doctype html><html><body><main><h1>Start your free trial of Sales Navigator</h1></main></body></html>');
  if (url.pathname === '/company/liquid-death/people/') {
    if (url.searchParams.get('keywords')) return res.end(peoplePage('Liquid Death', peopleCard('kw-person', 'Kay Word', 'Marketing Manager')));
    return res.end(peoplePage('Liquid Death', peopleCard('jane-doe', 'Jane Doe', 'Brand Manager at Liquid Death') + HIDDEN_CARD,
      '<aside><section><h2>Pages people also viewed</h2><ul><li><a href="https://www.linkedin.com/company/jose-cuervo/"><span>Jose Cuervo</span></a><div>Beverage Manufacturing</div><div>250K followers</div></li></ul></section></aside>'));
  }
  // A brand with 30 people on LinkedIn: the marketing search is enough.
  if (url.pathname === '/company/small-sn/people/') {
    return res.end(peoplePage('small-sn', peopleCard('ss-1', 'Sam Small', 'Founder at small-sn'), '<h2>30 associated members</h2>'));
  }
  if (url.pathname === '/company/big-co/people/') {
    return res.end(peoplePage('Big Co', peopleCard('bob-b', 'Bob B', 'Engineer'), '<h2>12,345 associated members</h2>'));
  }
  for (const slug of ['huge-co', 'huge-ok']) {
    if (url.pathname === '/company/' + slug + '/people/') return res.end(peoplePage(slug, peopleCard(slug + '-1', 'Hu Ge', 'Engineer'), '<h2>2,400 associated members</h2>'));
  }
  if (url.pathname === '/company/big-parent/people/') {
    return res.end(peoplePage('Big Parent', url.searchParams.get('keywords') ? '' : peopleCard('bp-1', 'Pat Parent', 'CEO at Big Parent')));
  }
  // A People tab with nobody on it: still Sales Navigator (1.38).
  if (url.pathname === '/company/empty-tab/people/') return res.end(peoplePage('Empty Tab', ''));
  for (const slug of ['no-id', 'wrong-id', 'no-sn', 'after-no-sn', 'tiny-co', 'tiny-two', 'stuck-one', 'stuck-two', 'part-co', 'flaky-dash', 'hidden-co', 'no-count', 'part-co-p']) {
    if (url.pathname === '/company/' + slug + '/people/') {
      const kw = url.searchParams.get('keywords') || '';
      return res.end(peoplePage(slug, peopleCard(slug + '-' + (kw || 'all'), 'Person ' + slug + ' ' + (kw || 'all'), 'Brand Manager at ' + slug)));
    }
  }
  res.end('<!doctype html><html><body><main><h1>Feed</h1></main></body></html>');
});

const GM_SHIM = `
  (function () {
    var seed = { sbIngestToken: 'test-token', sbLiMinFit: 0, sbLiSkipBig: false };
    var P = '__gm:';
    try {
      if (!sessionStorage.getItem('__gm_seeded')) {
        Object.keys(seed).forEach(function (k) { sessionStorage.setItem(P + k, JSON.stringify(seed[k])); });
        sessionStorage.setItem('__gm_seeded', '1');
      }
    } catch (e) {}
    window.GM_getValue = function (k, d) { var v = sessionStorage.getItem(P + k); return v == null ? d : JSON.parse(v); };
    window.GM_setValue = function (k, v) { sessionStorage.setItem(P + k, JSON.stringify(v)); };
    window.GM_deleteValue = function (k) { sessionStorage.removeItem(P + k); };
    window.GM_registerMenuCommand = function () {};
    window.GM_setClipboard = function (t) { window.__sbClip = t; };
    window.GM_xmlhttpRequest = function (o) {
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
        .then(function (r) { return r.text().then(function (t) { o.onload({ status: r.status, responseText: t }); }); })
        .catch(function () { o.onerror(); });
    };
  })();
`;

const item = (id, name, slug, extra) => Object.assign({ brandId: id, name, aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/' + slug + '/', contacts: 2, focus: false }, extra || {});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };
  const run = async (items, opts) => {
    opts = opts || {};
    fillItems = items;
    const before = sent.length, beforeQ = salesQueries.length;
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'JSESSIONID', value: '"ajax:123"', domain: '127.0.0.1', path: '/' }]);
    const pg = await ctx.newPage();
    await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
    await pg.goto('http://127.0.0.1:' + PORT + '/feed/');
    await pg.click('#sblipill');
    await pg.click('#sblifillopen');
    if (opts.setup) await opts.setup(pg);
    await pg.uncheck('#sbliresearch');
    if (!opts.lookalikes) await pg.uncheck('#sblilook');
    await pg.fill('#sblifocus', '');
    await pg.click('#sblifilllook');
    await pg.waitForSelector('#sblifillstart');
    if (opts.beforeStart) await opts.beforeStart(pg);
    await pg.click('#sblifillstart');
    if (opts.during) await opts.during(pg);
    await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run (finished|stopped)/.test(p.innerText); }, null, { timeout: 120000 });
    const calls = sent.slice(before);
    const queries = salesQueries.slice(beforeQ);
    const panel = await pg.innerText('#sbli-panel');
    await ctx.close();
    return { calls, queries, panel };
  };
  const where = (b) => b.action + ':' + b.brandId + (b.action === 'liCapture' ? ':' + b.companyUrl.replace('https://www.linkedin.com', '').replace('http://127.0.0.1:' + PORT, '') : '');

  try {
    // 6. The switch: on by default, sent with the worklist.
    // 1. A small brand: People tab, then Sales Navigator.
    {
      let snLine = '';
      const r = await run([item('b-ld', 'Liquid Death', 'liquid-death')], {
        lookalikes: true,
        beforeStart: async (pg) => {
          assert.equal(await pg.isChecked('#sblisalesnav'), true, 'Sales Navigator on by default');
        },
        during: async (pg) => {
          await pg.waitForFunction(() => /Sales Navigator/.test((document.getElementById('sblisnline') || {}).textContent || ''), null, { timeout: 15000 });
          snLine = await pg.innerText('#sblisnline');
        },
      });
      assert.equal(r.calls.find(b => b.action === 'liList').salesNav, true, 'the worklist is asked for with Sales Navigator on');
      assert.match(snLine, /Every brand through Sales Navigator/);
      assert.deepEqual(r.calls.filter(b => /^li(Capture|Swept|Discover)$/.test(b.action)).map(where), [
        'liCapture:b-ld:/company/liquid-death/people/',
        'liCapture:b-ld:/company/liquid-death/',
        'liCapture:b-ld:/company/liquid-death/',
        'liCapture:b-ld:/company/liquid-death/',
        'liDiscover:undefined',
        'liSwept:b-ld',
      ], 'People tab, then Sales Navigator (two pages of the first search, one of the second), saved under the brand\'s own page');
      assert.deepEqual(r.queries.map(q => q.kind + q.page + ':' + q.co), ['fn1:1234', 'fn2:1234', 'kw1:1234']);
      assert.match(r.queries[0].q, /type:CURRENT_COMPANY,values:List\(\(id:urn:li:organization:1234,text:Liquid Death,selectionType:INCLUDED\)\)/);
      assert.match(r.queries[0].q, /type:FUNCTION,values:List\(\(id:15,text:Marketing,selectionType:INCLUDED\),\(id:4,text:Business Development,selectionType:INCLUDED\)\)/);
      assert.match(r.queries[2].q, /keywords:partnership OR partnerships OR sponsorship OR sponsorships/);
      ok('a brand\'s People tab first, then Sales Navigator\'s lead searches by company id, the next page when one is full');

      const caps = r.calls.filter(b => b.action === 'liCapture');
      assert.equal(caps[1].rows.length, 25, 'every result read, though they draw only as they scroll into view');
      assert.deepEqual(caps[1].rows[0], { name: 'Person 1', headline: 'Brand Manager at Liquid Death', linkedinUrl: 'https://www.linkedin.com/in/' + mid(1) + '/' });
      assert.ok(caps.slice(1).every(c => c.checkPage === false && c.companyName === 'Liquid Death'));
      assert.deepEqual(caps[2].rows.map(x => x.name), ['Person 26'], 'someone shown at another company and the hidden one are left out');
      assert.deepEqual(caps[3].rows, [{ name: 'Sam Sponsor', headline: 'Sponsorship Manager at Liquid Death, Inc.', linkedinUrl: 'https://www.linkedin.com/in/' + mid(40) + '/' }]);
      ok('Sales Navigator people go to the dashboard as linkedin.com/in/<member id> with "Title at Company"; another company\'s are left out');

      const swept = r.calls.find(b => b.action === 'liSwept');
      assert.equal(swept.salesNav, true);
      assert.equal(swept.done, true, 'read in full: the dashboard won\'t bring it back by itself');
      assert.equal(swept.issue, null);
      assert.deepEqual([swept.shown, swept.read], [25 + 3 + 1, 25 + 3 + 1], 'every result Sales Navigator counted was on screen');
      assert.equal(swept.via, 'Sales Navigator');
      assert.equal(swept.added, 1 + 25 + 1 + 1);
      assert.deepEqual(swept.hidden, [{ q: 'marketing', url: 'http://127.0.0.1:' + PORT + '/company/liquid-death/people/?keywords=marketing', heads: ['Director of Brand Marketing'] }],
        'only who Sales Navigator still couldn\'t name, as the People tab view Zach can open');
      const disc = r.calls.find(b => b.action === 'liDiscover');
      assert.deepEqual(disc.companies.map(c => c.name), ['Jose Cuervo'], 'lookalikes read on the People tab before leaving it');
      assert.match(r.panel, /28 people added across 1 brands/);
      ok('the visit says Sales Navigator; the hidden people sent are the ones it still couldn\'t name; lookalikes still read');
    }

    // 2. A big company: straight to Sales Navigator, page checked once.
    {
      const r = await run([item('b-big', 'Big Co', 'big-co')]);
      assert.deepEqual(r.calls.filter(b => /^li(Capture|Swept)$/.test(b.action)).map(where), [
        'liCapture:b-big:/company/big-co/', 'liCapture:b-big:/company/big-co/', 'liSwept:b-big',
      ], 'no People tab saves for a big company');
      const caps = r.calls.filter(b => b.action === 'liCapture');
      assert.equal(caps[0].checkPage, true);
      assert.equal(caps[0].companyIndustry, 'Beverage Manufacturing');
      assert.equal(caps[1].checkPage, false, 'checked once');
      const swept = r.calls.find(b => b.action === 'liSwept');
      assert.equal(swept.via, 'Sales Navigator, big company (12,345 people)');
      assert.equal(swept.members, 12345);
      ok('a big company goes straight to Sales Navigator; its page is checked on the first save');
    }

    // 3 + 4. No company id (its page loaded twice for it); an id that shows
    // another company's people. Never the People tab's views (1.38): each is
    // an issue, left for the next run — never a second go in this one (1.40).
    {
      const r = await run([item('b-noid', 'No Id', 'no-id'), item('b-wrong', 'Wrong Id', 'wrong-id')]);
      assert.deepEqual(r.calls.filter(b => /^li(Capture|Swept)$/.test(b.action)).map(where), [
        'liCapture:b-noid:/company/no-id/people/', 'liSwept:b-noid',
        'liCapture:b-wrong:/company/wrong-id/people/', 'liSwept:b-wrong',
      ], 'no keyword views; nobody saved from the wrong company; each read once');
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.deepEqual(sw.map(x => x.issue), ['snNoId', 'snOtherCompany']);
      assert.deepEqual(sw.map(x => x.again), [false, false]);
      assert.ok(sw.every(x => x.salesNav === false && x.done === false));
      assert.match(sw[1].note, /another company's people \(Totally Other Inc\)/);
      assert.equal(r.queries.filter(q => q.co === '7777').length, 1);
      assert.match(r.panel, /Went wrong — first on the next run \(2\)/);
      ok('no company id, or another company\'s people: an issue for the next run, never the People tab, never twice in a run');
    }

    // An empty People tab still goes to Sales Navigator (it used to stop).
    {
      const r = await run([item('b-empty', 'Empty Tab', 'empty-tab')]);
      assert.deepEqual(r.queries.map(q => q.co), ['4999', '4999']);
      const sw = r.calls.find(b => b.action === 'liSwept');
      assert.equal(sw.salesNav, true); assert.equal(sw.done, true);
      ok('a People tab with nobody on it goes on to Sales Navigator');
    }

    // Brands with nobody in marketing ("No matches found") are empty
    // searches, not Sales Navigator failing: two in a row keep it on.
    {
      const r = await run([item('b-tiny', 'Tiny Co', 'tiny-co'), item('b-tiny2', 'Tiny Two', 'tiny-two'), item('b-ld', 'Liquid Death', 'liquid-death')]);
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.deepEqual(sw.map(s => s.salesNav), [true, true, true], 'every brand read through Sales Navigator');
      assert.deepEqual(r.queries.filter(q => q.co === '4321').map(q => q.kind), ['fn', 'kw']);
      ok('"No matches found" is an empty search: Sales Navigator stays on for the run');
    }

    // Results that never load: loaded once more, then an issue — the brand
    // waits for the next run (1.40: no second go at the end of this one);
    // Sales Navigator stays on.
    {
      const r = await run([item('b-st1', 'Stuck One', 'stuck-one'), item('b-st2', 'Stuck Two', 'stuck-two'), item('b-ld', 'Liquid Death', 'liquid-death')]);
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.deepEqual(sw.map(x => x.brandId), ['b-st1', 'b-st2', 'b-ld'], 'each brand once');
      assert.deepEqual(sw.map(x => x.salesNav), [false, false, true]);
      assert.deepEqual(sw.map(x => x.issue), ['snNoLoad', 'snNoLoad', null]);
      assert.deepEqual(sw.map(x => x.again), [false, false, false]);
      assert.equal(r.queries.filter(q => q.co === '4401').length, 2, 'loaded twice on its one try');
      assert.ok(!r.calls.some(b => b.action === 'liCapture' && /keywords=/.test(b.companyUrl)), 'never the People tab views');
      assert.match(r.panel, /Run finished/);
      assert.match(r.panel, /Went wrong — first on the next run \(2\)/);
      assert.ok(!/\(twice\)/.test(r.panel));
      ok('a Sales Navigator page that doesn\'t load: once more, then the brand waits for the next run');
    }

    // One read per brand per run (Leo, Oct 20 2026: "i think there are
    // repeats"): a brand listed twice is read once.
    {
      const r = await run([item('b-ld', 'Liquid Death', 'liquid-death'), item('b-tiny', 'Tiny Co', 'tiny-co'), item('b-ld', 'Liquid Death', 'liquid-death')]);
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.deepEqual(sw.map(x => x.brandId), ['b-ld', 'b-tiny'], 'the second Liquid Death is passed over');
      assert.deepEqual(r.queries.filter(q => q.co === '1234').map(q => q.kind + q.page), ['fn1', 'fn2', 'kw1'], 'its searches once');
      assert.match(r.panel, /Run finished/);
      ok('a brand on the list twice is read once');
    }

    // A run an older copy (1.38) left with a second try queued at its end:
    // the new copy drops it — the brand goes first on the next run instead.
    {
      const job = {
        id: 'fold1', owner: 'tOLDTAB', runner: 'pOLD', focus: '', at: 1, step: null, added: 0,
        items: [item('b-ld', 'Liquid Death', 'liquid-death'), Object.assign(item('b-st1', 'Stuck One', 'stuck-one'), { again: 1, againWhy: 'Sales Navigator\u2019s results did not load' })],
        results: [{ name: 'Liquid Death', added: 0, note: null, via: 'Sales Navigator', hidden: 0, issue: false, again: false }],
        day: 'x', doneToday: 1, nextAt: 0, pausedUntil: 0, paused: null, lookalikes: false, newBrands: [], reviewSent: 0,
        skipBig: false, salesNav: true, snWanted: true, midFirst: false, searches: [], outbox: [], touchedAt: Date.now(),
      };
      const before = sent.length, beforeQ = salesQueries.length;
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'JSESSIONID', value: '"ajax:123"', domain: '127.0.0.1', path: '/' }]);
      const pg = await ctx.newPage();
      await pg.addInitScript('(function(){ try { if (!sessionStorage.getItem("__old_seeded")) { sessionStorage.setItem("sbLiTab", "tOLDTAB"); sessionStorage.setItem("__gm:sbLiFill", ' + JSON.stringify(JSON.stringify(job)) + '); sessionStorage.setItem("__old_seeded", "1"); } } catch (e) {} })();');
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:' + PORT + '/feed/');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run (finished|stopped)/.test(p.innerText); }, null, { timeout: 60000 });
      const calls = sent.slice(before);
      assert.ok(!calls.some(b => b.action === 'liSwept' || b.action === 'liCapture'), 'the queued second try is not read');
      assert.equal(salesQueries.slice(beforeQ).length, 0, 'no Sales Navigator search');
      assert.match(await pg.innerText('#sbli-panel'), /Run finished/);
      await ctx.close();
      ok('a second try an older copy queued is dropped; the run finishes');
    }

    // A page that draws only part of what Sales Navigator says it has: loaded
    // once more, the rest still read, and the brand is an issue (read again).
    {
      const r = await run([item('b-part', 'Part Co', 'part-co')]);
      assert.deepEqual(r.queries.map(q => q.kind + q.page), ['fn1', 'fn1', 'fn2', 'kw1'], 'page 1 twice, page 2 because the count says 40; the brand once');
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.deepEqual(sw.map(x => x.issue), ['partial']);
      assert.match(sw[0].issueNote, /read 20 of 25 on Sales Navigator’s marketing & business development/);
      assert.equal(sw[0].added, 1 + 20 + 15, 'what it did read is saved');
      assert.deepEqual([sw[0].shown, sw[0].read], [25 + 15, 20 + 15]);
      ok('a page that draws 20 of 25: loaded again, the rest read, the brand comes back on the next run');
    }

    // A brand under its parent: the parent's company in Sales Navigator,
    // searched for the brand's name.
    {
      const r = await run([{ brandId: 'b-kid', name: 'Kid Brand', aka: null, category: 'spirits', linkedinUrl: null, noPage: true, contacts: 0,
        parent: { name: 'Big Parent', search: 'Big Parent', slug: 'big-parent' } }]);
      assert.deepEqual(r.queries.map(q => q.co + ':' + q.kind), ['4701:fn', '4701:kw']);
      assert.match(r.queries[0].q, /keywords:"Kid Brand",filters:List\(\(type:CURRENT_COMPANY,values:List\(\(id:urn:li:organization:4701,text:Big Parent/);
      assert.match(r.queries[0].q, /type:FUNCTION/);
      assert.match(r.queries[1].q, /keywords:"Kid Brand" AND \(partnership OR partnerships OR sponsorship OR sponsorships\)/);
      const caps = r.calls.filter(b => b.action === 'liCapture');
      assert.ok(caps.every(c => c.viaParent === true), 'saved as the brand\'s people, never the parent\'s page');
      assert.deepEqual(caps[1].rows.map(x => x.name), ['Kim Kid']);
      const sw = r.calls.find(b => b.action === 'liSwept');
      assert.equal(sw.via, 'Sales Navigator via Big Parent');
      assert.equal(sw.done, true); assert.equal(sw.parentTried, true);
      ok('a brand under its parent: Sales Navigator on the parent\'s company, searched for its name');
    }

    // Review fixes. A page of only "LinkedIn Member" results isn't a misread;
    // a page 2 Sales Navigator doesn't have moves on (no pause); a brand whose
    // own read came out short still comes back after its parent's read.
    {
      const r = await run([item('b-hid', 'Hidden Co', 'hidden-co'), item('b-cnt', 'No Count', 'no-count'),
        item('b-nonew', 'Part Parent', 'part-co-p', { parent: { name: 'Big Parent', search: 'Big Parent', slug: 'big-parent' } })]);
      const sw = r.calls.filter(b => b.action === 'liSwept');
      const hid = sw.find(x => x.brandId === 'b-hid');
      assert.deepEqual([hid.problem, hid.issue, hid.done], [null, null, true], 'all hidden: read fine');
      assert.equal(hid.hidden[0].heads.length, 4);
      const cnt = sw.find(x => x.brandId === 'b-cnt');
      assert.deepEqual([cnt.done, cnt.issue], [true, null]);
      assert.deepEqual(r.queries.filter(q => q.co === '5201').map(q => q.kind + q.page), ['fn1', 'clamped2', 'fn1', 'kw1'], 'page 2 dropped → the next search');
      const pp = sw.filter(x => x.brandId === 'b-nonew');
      assert.deepEqual(pp.map(x => x.issue), ['partial'], 'the parent\'s clean read doesn\'t wash out its own short page (read once a run)');
      assert.deepEqual(pp.map(x => x.via), ['Sales Navigator via Big Parent']);
      assert.ok(pp.every(x => x.parentTried === true));
      assert.match(r.panel, /Run finished/);
      ok('review fixes: hidden-only pages read fine, a missing page 2 moves on, a short own page survives the parent\'s read');
    }

    // Skip very big brands: 1,500+ on the People tab ends the brand there —
    // unless the dashboard says it may be read (bigOk).
    {
      const r = await run([item('b-huge', 'Huge Co', 'huge-co', { bigOk: false }), item('b-hok', 'Huge OK', 'huge-ok', { bigOk: true })],
        { setup: async (pg) => { await pg.check('#sbliskipbig'); } });
      assert.equal(r.calls.find(b => b.action === 'liList').skipGiants, true);
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.equal(sw[0].skipped, 'veryBig'); assert.equal(sw[0].members, 2400); assert.equal(sw[0].done, false);
      assert.match(sw[0].note, /very big — 2,400 on LinkedIn, skipped/);
      assert.ok(!r.calls.some(b => b.action === 'liCapture' && b.brandId === 'b-huge'), 'nothing read');
      assert.deepEqual(r.queries.map(q => q.co), ['4801', '4801'], 'only the OK\'d one goes to Sales Navigator');
      assert.equal(sw[1].salesNav, true);
      ok('1,500+ on LinkedIn: skipped at its People tab, headcount saved; an OK\'d one is read');
    }

    // The dashboard drops two saves: the run waits and tries again — no
    // pause, each save lands once. A 502 page is tried again the same way.
    {
      dashFail.action = 'liCapture'; dashFail.n = 2; dashFail.how = 'drop';
      const r = await run([item('b-flaky', 'Flaky Dash', 'flaky-dash')]);
      assert.equal(dashFail.n, 0);
      assert.equal(r.calls.filter(b => b.action === 'liCapture').length, 3, 'People tab + two Sales Navigator searches, each once');
      assert.equal(r.calls.find(b => b.action === 'liSwept').done, true);
      assert.match(r.panel, /Run finished/);
      dashFail.action = 'liSwept'; dashFail.n = 1; dashFail.how = '502';
      const r2 = await run([item('b-flaky', 'Flaky Dash', 'flaky-dash')]);
      assert.equal(dashFail.n, 0);
      assert.equal(r2.calls.filter(b => b.action === 'liSwept').length, 1);
      ok('a dashboard that drops a call or answers 502 is tried again; the run carries on');
    }
    // Down past the retries: the run pauses, as before.
    {
      dashFail.action = 'liCapture'; dashFail.n = 99; dashFail.how = 'drop';
      let paused = '';
      const r = await run([item('b-flaky', 'Flaky Dash', 'flaky-dash')], {
        during: async (pg) => {
          await pg.waitForFunction(() => /Paused: Could not reach the dashboard/.test((document.getElementById('sbli-panel') || {}).innerText || ''), null, { timeout: 30000 });
          paused = await pg.innerText('#sbli-panel');
          await pg.click('#sblifillstop');
        },
      });
      dashFail.n = 0; dashFail.action = null;
      assert.match(paused, /Paused: Could not reach the dashboard/);
      assert.equal(r.calls.filter(b => b.action === 'liCapture').length, 0);
      // The visit itself not saved (the dashboard's error, past the retries):
      // kept, and the run pauses rather than losing it.
      dashFail.action = 'liSwept'; dashFail.n = 99; dashFail.how = '500';
      let paused2 = '';
      await run([item('b-flaky', 'Flaky Dash', 'flaky-dash')], {
        during: async (pg) => {
          await pg.waitForFunction(() => /Paused: The dashboard didn't save Flaky Dash's visit/.test((document.getElementById('sbli-panel') || {}).innerText || ''), null, { timeout: 30000 });
          paused2 = await pg.innerText('#sbli-panel');
          await pg.click('#sblifillstop');
        },
      });
      dashFail.n = 0; dashFail.action = null;
      assert.match(paused2, /database error/);
      ok('a dashboard down past the retries pauses the run; so does a visit it couldn\'t save');
    }

    // Under 50 on LinkedIn: only the marketing search (the partnerships one
    // finds nobody new at a company that size).
    {
      const r = await run([item('b-small', 'Small SN', 'small-sn')]);
      assert.deepEqual(r.queries.map(q => q.kind), ['fn'], 'one Sales Navigator search for a 30-person brand');
      assert.equal(r.calls.find(b => b.action === 'liSwept').salesNav, true);
      ok('a brand under 50 on LinkedIn gets only the marketing search');
    }

    // The start panel's defaults: Brand Fit 50+, very big brands skipped —
    // sent with the worklist; with a floor the panel says mid-size first.
    {
      fillItems = [item('b-ld', 'Liquid Death', 'liquid-death', { size: 'target' })];
      const before = sent.length;
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.addInitScript(GM_SHIM.replace("sbLiMinFit: 0, sbLiSkipBig: false", "") + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:' + PORT + '/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      assert.equal(await pg.inputValue('#sbliminfit'), '50');
      assert.equal(await pg.isChecked('#sbliskipbig'), true);
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblifillstart');
      const list = sent.slice(before).find(b => b.action === 'liList');
      assert.equal(list.minFit, 50);
      assert.equal(list.skipGiants, true);
      await ctx.close();
      ok('the start panel asks for Brand Fit 50+ and skips very big brands by default');
    }

    // 5. No Sales Navigator on the account: the run pauses (every brand goes
    // through it now) — never the People tab's views.
    {
      let paused = '';
      const r = await run([item('b-nosn', 'No SN', 'no-sn'), item('b-after', 'After', 'after-no-sn')], {
        during: async (pg) => {
          await pg.waitForFunction(() => /Paused: Sales Navigator isn't open on this LinkedIn account/.test((document.getElementById('sbli-panel') || {}).innerText || ''), null, { timeout: 30000 });
          paused = await pg.innerText('#sbli-panel');
          await pg.click('#sblifillstop');
        },
      });
      assert.match(paused, /Open Sales Navigator in this window once/);
      assert.equal(r.queries.length, 1);
      assert.ok(!r.calls.some(b => b.action === 'liCapture' && /keywords=/.test(b.companyUrl)));
      assert.ok(!r.calls.some(b => b.brandId === 'b-after'), 'nothing more until Leo carries on');
      ok('an account without Sales Navigator: the run pauses and says so');
    }

    // 6. Off by hand: remembered, sent, and the run never goes there.
    {
      const r = await run([item('b-noid2', 'No Id', 'no-id')], { setup: async (pg) => { await pg.uncheck('#sblisalesnav'); } });
      assert.equal(r.calls.find(b => b.action === 'liList').salesNav, false);
      assert.equal(r.queries.length, 0);
      assert.ok(!/Sales Navigator/.test(r.calls.find(b => b.action === 'liSwept').via || ''));
      ok('switched off: the worklist knows, and the run never opens Sales Navigator');
    }

    // The brands back because their last read went wrong are named on the
    // setup panel, and the run says why it reads one.
    {
      fillItems = [item('b-ld', 'Liquid Death', 'liquid-death', { retry: true, hiddenRetry: true, issue: 'snNoLoad', issueText: 'Sales Navigator’s results didn’t load', tries: 1 })];
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:' + PORT + '/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblisnretry');
      assert.match(await pg.innerText('#sblisnretry'), /^1 brand whose last read went wrong .* go first/);
      await pg.uncheck('#sblilook');
      await pg.click('#sblifillstart');
      await pg.waitForSelector('#sblinow');
      assert.match(await pg.innerText('#sblinow'), /read again first — Sales Navigator’s results didn’t load/);
      await ctx.close();
      ok('the setup panel names the brands whose last read went wrong; the run says why');
    }

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
