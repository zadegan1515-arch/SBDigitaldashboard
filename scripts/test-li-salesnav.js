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
const SCRIPT = fs.readFileSync(path.join(__dirname, 'linkedin-capture.user.js'), 'utf8')
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'http://127.0.0.1:" + PORT + "/api/ingest'")
  .replace(/function rand\(a, b\) \{[^}]*\}/, 'function rand() { return 30; }');

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
  return '<!doctype html><html><body><main><div>' + total + ' results</div>' +
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

const COMPANY_IDS = { 'liquid-death': '1234', 'big-co': '5678', 'wrong-id': '7777', 'no-sn': '9999', 'tiny-co': '4321', 'tiny-two': '4322' };
const salesQueries = [];

const sent = [];
let fillItems = [];
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/api/ingest') {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (body.action === 'liVersion' || body.action === 'liRun') return res.end('{"ok":true}');
      sent.push(body);
      if (body.action === 'liList') {
        return res.end(JSON.stringify({ ok: true, items: fillItems, cap: 25, noPage: 0, resting: 0, research: 0, planned: 0, noBuyer: 0,
          hiddenRetry: fillItems.filter(i => i.hiddenRetry).length }));
      }
      if (body.action === 'liCapture') {
        return res.end(JSON.stringify({ ok: true, brand: { id: body.brandId, name: body.companyName }, added: (body.rows || []).length, have: 5, cap: 25 }));
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
    // A brand with nobody in marketing: Sales Navigator's own empty page,
    // no results count on it (Leo's first run, Oct 12 2026).
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
  if (url.pathname === '/company/big-co/people/') {
    return res.end(peoplePage('Big Co', peopleCard('bob-b', 'Bob B', 'Engineer'), '<h2>12,345 associated members</h2>'));
  }
  for (const slug of ['no-id', 'wrong-id', 'no-sn', 'after-no-sn', 'tiny-co', 'tiny-two']) {
    if (url.pathname === '/company/' + slug + '/people/') {
      const kw = url.searchParams.get('keywords') || '';
      return res.end(peoplePage(slug, peopleCard(slug + '-' + (kw || 'all'), 'Person ' + slug + ' ' + (kw || 'all'), 'Brand Manager at ' + slug)));
    }
  }
  res.end('<!doctype html><html><body><main><h1>Feed</h1></main></body></html>');
});

const GM_SHIM = `
  (function () {
    var seed = { sbIngestToken: 'test-token' };
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
      assert.match(snLine, /from Sales Navigator/);
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

    // 3 + 4. No company id; an id that shows another company's people.
    {
      const r = await run([item('b-noid', 'No Id', 'no-id'), item('b-wrong', 'Wrong Id', 'wrong-id')]);
      assert.deepEqual(r.calls.filter(b => /^li(Capture|Swept)$/.test(b.action)).map(where), [
        'liCapture:b-noid:/company/no-id/people/', 'liCapture:b-noid:/company/no-id/people/?keywords=marketing', 'liCapture:b-noid:/company/no-id/people/?keywords=partnerships', 'liSwept:b-noid',
        'liCapture:b-wrong:/company/wrong-id/people/', 'liCapture:b-wrong:/company/wrong-id/people/?keywords=marketing', 'liCapture:b-wrong:/company/wrong-id/people/?keywords=partnerships', 'liSwept:b-wrong',
      ], 'both get the People tab views; nobody saved from the wrong company');
      const sw = r.calls.filter(b => b.action === 'liSwept');
      assert.match(sw[0].via, /Sales Navigator: could not find its LinkedIn company id/);
      assert.match(sw[1].via, /Sales Navigator: Sales Navigator showed another company's people \(Totally Other Inc\)/);
      assert.ok(sw.every(s => s.salesNav === false));
      assert.match(r.panel, /from Sales Navigator|Run finished/);
      ok('no company id, or another company\'s people: nobody saved from it, the People tab views instead');
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

    // 5. No Sales Navigator on the account: off for the rest of the run.
    {
      const r = await run([item('b-nosn', 'No SN', 'no-sn'), item('b-after', 'After', 'after-no-sn')]);
      assert.deepEqual(r.calls.filter(b => /^li(Capture|Swept)$/.test(b.action)).map(where), [
        'liCapture:b-nosn:/company/no-sn/people/', 'liCapture:b-nosn:/company/no-sn/people/?keywords=marketing', 'liCapture:b-nosn:/company/no-sn/people/?keywords=partnerships', 'liSwept:b-nosn',
        'liCapture:b-after:/company/after-no-sn/people/', 'liCapture:b-after:/company/after-no-sn/people/?keywords=marketing', 'liCapture:b-after:/company/after-no-sn/people/?keywords=partnerships', 'liSwept:b-after',
      ]);
      assert.equal(r.queries.length, 1, 'Sales Navigator tried once, never again that run');
      assert.match(r.calls.filter(b => b.action === 'liSwept')[0].via, /isn't open on this LinkedIn account/);
      ok('an account without Sales Navigator: the run uses the People tab from then on');
    }

    // 6. Off by hand: remembered, sent, and the run never goes there.
    {
      const r = await run([item('b-noid2', 'No Id', 'no-id')], { setup: async (pg) => { await pg.uncheck('#sblisalesnav'); } });
      assert.equal(r.calls.find(b => b.action === 'liList').salesNav, false);
      assert.equal(r.queries.length, 0);
      assert.ok(!/Sales Navigator/.test(r.calls.find(b => b.action === 'liSwept').via || ''));
      ok('switched off: the worklist knows, and the run never opens Sales Navigator');
    }

    // The brands back for Sales Navigator are named on the setup panel.
    {
      fillItems = [item('b-ld', 'Liquid Death', 'liquid-death', { hiddenRetry: true })];
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:' + PORT + '/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblisnretry');
      assert.match(await pg.innerText('#sblisnretry'), /^1 read before had buyers LinkedIn hid from you/);
      await ctx.close();
      ok('the setup panel names the brands back on the list for Sales Navigator');
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
