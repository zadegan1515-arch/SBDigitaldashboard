// scripts/test-li-script.js
//
// The LinkedIn capture script runs inside Leo's logged-in LinkedIn tab,
// so it gets a test before it gets there: a fake People page built from
// LinkedIn's own card markup, and a fake dashboard that records what the
// script sends.
//
//   1. The pill shows on every LinkedIn page, so a working install is
//      visible at once; off a company page it only says where to go.
//   2. One press scrolls that page, clicks "Show more results", and
//      reads every person — without the header's own "Me" link, without
//      "LinkedIn Member" cards, and without LinkedIn's furniture ("View
//      Jane's profile", "· 2nd") in the names.
//   3. Nothing is saved until "Add" is pressed, and it never navigates
//      on its own.
//   4. The token goes in the request body and never into LinkedIn's
//      localStorage.
//   5. It still opens on a page that enforces Trusted Types, where a
//      plain innerHTML write throws and the click would do nothing.
//   7. It still works where the page allows only its OWN Trusted Types
//      policy and that policy scrubs inserted HTML — what LinkedIn did to
//      the first real run: our policy was refused, the page's scrubber
//      stripped the panel's buttons and ids, and the click failed with
//      "Cannot set properties of null (setting 'onclick')".
//   8. A brand the dashboard doesn't have (Casamigos) can be added from
//      the panel.
//   9. "Fill brands by itself": finds a missing company page by search,
//      reads each brand's People tab, saves by brandId, logs each visit,
//      and finishes; a click in the tab pauses it and Continue resumes;
//      LinkedIn's limit page pauses it before anything is saved.
//  10. Finding new brands: a keyword search adds Liquid I.V. to the front
//      of the line, Clase Azul's lookalikes (on its home page) add Jose
//      Cuervo at the end, and each new brand's people are read in the
//      same run.
//   6. The pill sits bottom-left, clear of LinkedIn's Messaging bar; the
//      Tampermonkey menu opens the same panel; and a copy running without
//      its @grant lines (pasted under Tampermonkey's sample) says so.
//
// Run: node scripts/test-li-script.js   (needs playwright; ~10s)
// If playwright is only installed globally:
//   NODE_PATH=$(npm root -g) node scripts/test-li-script.js

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

const SCRIPT = fs.readFileSync(path.join(__dirname, 'linkedin-capture.user.js'), 'utf8')
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'http://127.0.0.1:4622/api/ingest'")
  // The pauses are for LinkedIn, not for a test.
  .replace(/function rand\(a, b\) \{[^}]*\}/, 'function rand() { return 30; }');

// ---- fake LinkedIn ------------------------------------------------
function card(slug, name, headline, degree) {
  return '<li class="org-people-profile-card__profile-card-spacing"><section class="artdeco-card">' +
    '<div class="artdeco-entity-lockup">' +
      '<div class="artdeco-entity-lockup__image"><a href="https://www.linkedin.com/in/' + slug + '?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AAC"><img alt=""></a></div>' +
      '<div class="artdeco-entity-lockup__content">' +
        '<div class="artdeco-entity-lockup__title"><a href="https://www.linkedin.com/in/' + slug + '?miniProfileUrn=x">' +
          '<div class="lt-line-clamp">' + name + '</div>' +
          '<span class="visually-hidden" style="position:absolute;clip:rect(1px,1px,1px,1px)">View ' + name + '’s profile</span></a></div>' +
        '<div class="artdeco-entity-lockup__badge"><span class="a11y-text">' + degree + ' degree connection</span><span aria-hidden="true">· ' + degree + '</span></div>' +
        '<div class="artdeco-entity-lockup__subtitle"><div class="lt-line-clamp">' + headline + '</div></div>' +
      '</div></div>' +
    '<footer><span>3 mutual connections</span><button>Connect</button></footer>' +
  '</section></li>';
}
const MEMBER = '<li class="org-people-profile-card__profile-card-spacing"><section class="artdeco-card">' +
  '<div class="artdeco-entity-lockup__title"><div>LinkedIn Member</div></div>' +
  '<div class="artdeco-entity-lockup__subtitle"><div>Marketing at Liquid Death</div></div></section></li>';

const FIRST = [
  card('jane-doe-12ab', 'Jane Doe', 'Senior Brand Manager at Liquid Death | ex-Red Bull', '2nd'),
  card('sam-lee', 'Sam Lee', 'Head of Partnerships @ Liquid Death', '3rd'),
  MEMBER,
  card('pat-kim', 'Pat Kim', 'Software Engineer at Liquid Death', '3rd'),
  card('ali-r', 'Ali Rahman 🚀', 'Brand Ambassador', '2nd'),
].join('');
const MORE = [
  card('max-v', 'Max Vogel', 'Director of Field Marketing at Liquid Death', '2nd'),
  card('dee-o', 'Dee Okafor', 'Experiential Marketing Lead', '3rd'),
  card('kim-t', 'Kim Tran', 'Co-Founder & CEO', '1st'),
].join('');

function page(people, title, extra) {
  title = title || 'Liquid Death';
  return '<!doctype html><html><head><title>(3) ' + title + ': People | LinkedIn</title></head><body style="margin:0">' +
    '<header id="global-nav" style="height:50px"><a href="https://www.linkedin.com/in/leo-self/">Me</a></header>' +
    '<main><h1 class="org-top-card-summary__title"> ' + title + ' </h1>' +
    '<div class="org-top-card-summary-info-list"><div class="org-top-card-summary-info-list__info-item">Beverage Manufacturing</div></div>' +
    (extra || '') +
    (people
      ? '<div style="height:1400px">associated members</div><ul id="grid">' + FIRST + '</ul>' +
        '<button id="more" onclick="document.getElementById(\'grid\').insertAdjacentHTML(\'beforeend\', window.__MORE); this.remove()">Show more results</button>' +
        '<script>window.__MORE = ' + JSON.stringify(MORE) + '</script>'
      : '<p>About the company</p>') +
    '</main></body></html>';
}

const sent = [];
// What liList hands the fill; each scenario sets its own.
let fillItems = [];
const discovered = new Set();

// LinkedIn's "Pages people also viewed" rail.
function rail(cos) {
  return '<aside><section class="artdeco-card"><h2><span>Pages people also viewed</span></h2><ul>' +
    cos.map(([slug, name, industry, followers]) =>
      '<li><a href="https://www.linkedin.com/company/' + slug + '/"><img alt=""></a>' +
      '<a href="https://www.linkedin.com/company/' + slug + '/"><span>' + name + '</span></a>' +
      '<div>' + industry + '</div><div>' + followers + ' followers</div><button>Follow</button></li>').join('') +
    '</ul></section></aside>';
}
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/api/ingest') {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      sent.push(body);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (body.token !== 'test-token') { res.writeHead(401); return res.end('{}'); }
      if (body.action === 'liPreview' && /casamigos/.test(body.companyUrl || '')) {
        return res.end(JSON.stringify({
          ok: true, brand: null, matchedBy: null, notFound: body.brandName || null, suggestions: [], createName: body.brandName || body.companyName,
          cap: 25, have: 0, room: 25,
          rows: body.rows.map(r => ({ name: r.name, role: r.headline, linkedinUrl: r.linkedinUrl, verdict: 'noBrand' })),
        }));
      }
      if (body.action === 'liCapture' && body.createIfMissing) {
        return res.end(JSON.stringify({ ok: true, brand: { id: 'bnew', name: body.companyName }, brandCreated: true, added: 3, have: 3, cap: 25, targetsShelved: 0 }));
      }
      if (body.action === 'liDiscover') {
        const make = { 'Liquid I.V.': 'b-liv', 'Jose Cuervo': 'b-jc' };
        const created = (body.companies || [])
          .filter(c => make[c.name] && !discovered.has(c.name))
          .map(c => { discovered.add(c.name); return { brandId: make[c.name], name: c.name, category: 'beverage', linkedinUrl: c.url }; });
        return res.end(JSON.stringify({ ok: true, created, known: 0, small: 0, industry: 0, capped: 0 }));
      }
      if (body.action === 'liList') {
        return res.end(JSON.stringify({ ok: true, items: fillItems, cap: 25, noPage: fillItems.filter(i => !i.linkedinUrl).length, resting: 0 }));
      }
      if (body.action === 'liMatched') {
        const hit = (body.candidates || []).find(c => c.name === 'LMNT');
        return res.end(JSON.stringify(hit
          ? { ok: true, outcome: 'attached', how: 'exact', name: 'LMNT', linkedinUrl: 'https://www.linkedin.com/company/drinklmnt/' }
          : { ok: true, outcome: 'unclear' }));
      }
      if (body.action === 'liCapture' && body.brandId) {
        return res.end(JSON.stringify({ ok: true, brand: { id: body.brandId, name: body.companyName }, added: 2, have: 12, cap: 25, targetsShelved: 0 }));
      }
      if (body.action === 'liPreview') {
        return res.end(JSON.stringify({
          ok: true, brand: { id: 'b1', name: 'Liquid Death' }, matchedBy: 'name', cap: 25, have: 20, room: 5,
          rows: body.rows.map((r, i) => ({ name: r.name, role: r.headline, linkedinUrl: r.linkedinUrl, verdict: i < 2 ? 'add' : 'notBuyer' })),
        }));
      }
      if (body.action === 'liCapture') {
        return res.end(JSON.stringify({ ok: true, brand: { id: 'b1', name: 'Liquid Death' }, added: 2, have: 22, cap: 25, targetsShelved: 0, savedPage: true }));
      }
      res.end('{"ok":true}');
    });
    return;
  }
  // A page that enforces Trusted Types, as LinkedIn may.
  if (/^\/company\/tt-brand\/people\/?/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "require-trusted-types-for 'script'" });
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">TT Brand</h1><ul>' + FIRST + '</ul></main></body></html>');
  }
  // The page only permits its own "default" policy, and that policy
  // scrubs: ids and buttons come out of anything inserted as HTML.
  if (/^\/company\/scrub-brand\/people\/?/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types default" });
    return res.end('<!doctype html><html><head><script>' +
      'trustedTypes.createPolicy("default", { createHTML: function (s) {' +
      '  return s.replace(/\\sid="[^"]*"/g, "").replace(/<button[^>]*>[\\s\\S]*?<\\/button>/g, "").replace(/<input[^>]*>/g, "");' +
      '} });' +
      '</script></head><body><main><h1 class="org-top-card-summary__title">Scrub Brand</h1><ul>' + FIRST + '</ul></main></body></html>');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (/^\/company\/liquid-death\/people\/?/.test(req.url)) return res.end(page(true));
  if (/^\/company\/casamigos-tequila\/people\/?/.test(req.url)) return res.end(page(true, 'Casamigos Tequila'));
  if (/^\/company\/drinklmnt\/people\/?/.test(req.url)) return res.end(page(true, 'LMNT'));
  // The discovery story's pages.
  if (/^\/search\/results\/companies\/\?keywords=electrolyte/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/liquid-i-v/"><span>Liquid I.V.</span></a><div>Food and Beverage Manufacturing • Los Angeles</div><div>90K followers</div></li>' +
      '<li><a href="https://www.linkedin.com/company/tiny-hydrate/"><span>Tiny Hydrate</span></a><div>Beverage Manufacturing • Austin</div><div>812 followers</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/company\/liquid-i-v\/people\/?/.test(req.url)) return res.end(page(true, 'Liquid I.V.', rail([['drinklmnt', 'LMNT', 'Food and Beverage Services', '40K']])));
  if (/^\/company\/claseazul\/people\/?/.test(req.url)) return res.end(page(true, 'Clase Azul'));
  if (/^\/company\/claseazul\/?$/.test(req.url)) return res.end(page(false, 'Clase Azul', rail([['jose-cuervo', 'Jose Cuervo', 'Beverage Manufacturing', '250,512'], ['patron', 'Tequila Patrón', 'Beverage Manufacturing', '33,483']])));
  if (/^\/company\/jose-cuervo\/people\/?/.test(req.url)) return res.end(page(true, 'Jose Cuervo'));
  if (/^\/company\/jose-cuervo\/?$/.test(req.url)) return res.end(page(false, 'Jose Cuervo', rail([['claseazul', 'Clase Azul México', 'Beverage Manufacturing', '64K']])));
  // LinkedIn telling a free account it has searched enough.
  if (/^\/company\/limit-brand\/people\/?/.test(req.url)) {
    return res.end(page(true, 'Limit Brand', '<div>You\'ve reached the commercial use limit on search.</div>'));
  }
  // People that take three seconds to appear — long enough to click.
  if (/^\/company\/slow-brand\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Slow Brand</h1><ul id="g"></ul></main>' +
      '<script>setTimeout(function () { document.getElementById("g").insertAdjacentHTML("beforeend", ' + JSON.stringify(FIRST) + '); }, 3000)</script></body></html>');
  }
  // A company search, the way LinkedIn lays out results.
  if (/^\/search\/results\/companies\/\?keywords=LMNT/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/drinklmnt/"><img alt=""></a>' +
        '<a href="https://www.linkedin.com/company/drinklmnt/"><span>LMNT</span></a>' +
        '<div>Food and Beverage Services • Austin, TX</div><div>40K followers</div><button>Follow</button></li>' +
      '<li><a href="https://www.linkedin.com/company/lmnt-labs/">LMNT Labs</a><div>Software Development • Oslo</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/company\/liquid-death\/?$/.test(req.url)) return res.end(page(false));
  // LinkedIn after a redesign: no class names left to lean on.
  if (/^\/company\/olipop\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1>Olipop</h1><ul>' +
      '<li><div><a href="/in/rita-m/"><span>Rita Moreno</span></a></div><div><span>· 2nd</span></div>' +
        '<div>VP, Marketing @ Olipop</div><div>5 mutual connections</div><button>Message</button></li>' +
      '<li><div><a href="/in/omar-b/"><img alt=""></a><a href="/in/omar-b/">Omar Bell</a></div>' +
        '<div>3rd+ degree connection</div><div>Campus Partnerships Lead</div><button>Connect</button></li>' +
      '</ul></main></body></html>');
  }
  res.end('<!doctype html><html><body><main><h1>Feed</h1></main></body></html>');
});

// Tampermonkey's API, as far as the script uses it.
const GM_SHIM = `
  (function () {
    // Backed by this tab's sessionStorage so it survives the fill's page
    // loads, as Tampermonkey's own storage does. Seeded once per tab.
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
    window.__sbMenu = [];
    window.GM_registerMenuCommand = function (name, fn) { window.__sbMenu.push({ name: name, fn: fn }); };
    window.GM_xmlhttpRequest = function (o) {
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
        .then(function (r) { return r.text().then(function (t) { o.onload({ status: r.status, responseText: t }); }); })
        .catch(function () { o.onerror(); });
    };
  })();
`;

(async () => {
  await new Promise(r => server.listen(4622, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const pageObj = await browser.newPage();
  await pageObj.addInitScript(GM_SHIM);
  const load = async (url) => {
    await pageObj.goto('http://127.0.0.1:4622' + url);
    await pageObj.addScriptTag({ content: SCRIPT });
  };
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };

  try {
    // 1. Pill on every page; off a company page it only explains.
    await load('/feed/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    await pageObj.click('#sblipill');
    await pageObj.waitForFunction(() => /company page/.test(document.getElementById('sbli-panel').innerText));
    assert.match(await pageObj.getAttribute('#sbli-panel a[href*="#people"]', 'href'), /app\.html#people$/);
    assert.equal(sent.length, 0);
    assert.match(pageObj.url(), /\/feed\/$/);
    ok('pill shows on the feed too, and there it only says where to go');
    const box = await pageObj.locator('#sblipill').boundingBox();
    const vw = pageObj.viewportSize().width;
    assert.ok(box.x < vw / 2, 'pill is on the left, clear of Messaging (x=' + box.x + ')');
    ok('pill sits bottom-left, clear of LinkedIn\'s Messaging bar');
    await load('/company/liquid-death/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    ok('pill shows on a company page');

    // The Tampermonkey menu entry opens the same panel.
    const menu = await pageObj.evaluate(() => window.__sbMenu.map(m => m.name));
    assert.deepEqual(menu, ['Open the SB capture panel', 'Fill brands by itself']);
    await pageObj.evaluate(() => window.__sbMenu[0].fn());
    await pageObj.waitForSelector('#sblipeople');
    await pageObj.evaluate(() => document.getElementById('sbli-panel').remove());
    ok('the Tampermonkey menu opens the panel too');

    // Off the People tab it offers to open it and does nothing else.
    await pageObj.click('#sblipill');
    await pageObj.waitForSelector('#sblipeople');
    assert.equal(sent.length, 0);
    ok('off the People tab it only offers to open it');

    // 2. On the People page: one press reads everything.
    await load('/company/liquid-death/people/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    await pageObj.click('#sblipill');
    await pageObj.waitForSelector('#sbliadd', { timeout: 20000 });
    const previews = sent.filter(b => b.action === 'liPreview');
    assert.equal(previews.length, 1);
    const rows = previews[0].rows;
    const names = rows.map(r => r.name).sort();
    assert.deepEqual(names, ['Ali Rahman 🚀', 'Dee Okafor', 'Jane Doe', 'Kim Tran', 'Max Vogel', 'Pat Kim', 'Sam Lee'].sort());
    ok('reads the first screen and the "Show more results" batch: ' + rows.length + ' people');
    assert.ok(!rows.some(r => /leo-self/.test(r.linkedinUrl)), 'header link is not an employee');
    assert.ok(!rows.some(r => /member/i.test(r.name)), 'LinkedIn Member is skipped');
    ok('skips the header\'s own profile link and "LinkedIn Member"');
    const jane = rows.find(r => r.name === 'Jane Doe');
    assert.equal(jane.headline, 'Senior Brand Manager at Liquid Death | ex-Red Bull');
    assert.equal(jane.linkedinUrl, 'https://www.linkedin.com/in/jane-doe-12ab/');
    ok('name, headline and a clean profile link per card');
    assert.equal(previews[0].companyName, 'Liquid Death');
    assert.match(previews[0].companyUrl, /\/company\/liquid-death\/people\//);
    ok('sends the company name and page');

    // 3. Nothing saved until Add; no navigation of its own.
    assert.equal(sent.filter(b => b.action === 'liCapture').length, 0);
    assert.match(pageObj.url(), /\/company\/liquid-death\/people\/$/);
    const addText = await pageObj.textContent('#sbliadd');
    assert.match(addText, /Add 2 to Liquid Death/);
    await pageObj.click('#sbliadd');
    await pageObj.waitForFunction(() => /Saved/.test(document.getElementById('sbli-panel').innerText));
    assert.equal(sent.filter(b => b.action === 'liCapture').length, 1);
    assert.match(pageObj.url(), /\/company\/liquid-death\/people\/$/);
    ok('saves only on "Add", and never navigated by itself');

    // A layout with no LinkedIn class names still reads.
    await load('/company/olipop/people/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    await pageObj.click('#sblipill');
    await pageObj.waitForSelector('#sbliadd', { timeout: 20000 });
    const plain = sent.filter(b => b.action === 'liPreview').pop().rows;
    assert.deepEqual(plain.map(r => [r.name, r.headline]), [
      ['Rita Moreno', 'VP, Marketing @ Olipop'],
      ['Omar Bell', 'Campus Partnerships Lead'],
    ]);
    ok('still reads cards when LinkedIn\'s class names are gone');

    // 4. Token handling.
    assert.ok(sent.every(b => b.token === 'test-token'));
    const ls = await pageObj.evaluate(() => JSON.stringify(localStorage));
    assert.ok(!/test-token/.test(ls), 'token must not be in LinkedIn localStorage');
    ok('token travels in the request and stays out of LinkedIn\'s storage');

    // 5. Trusted Types enforced. addInitScript runs outside the page's
    // CSP, the way Tampermonkey injects.
    const tt = await browser.newPage();
    const ttErrors = [];
    tt.on('pageerror', e => ttErrors.push(e.message));
    await tt.addInitScript(GM_SHIM + '\n' + SCRIPT);
    await tt.goto('http://127.0.0.1:4622/company/tt-brand/people/');
    const enforced = await tt.evaluate(() => { try { document.createElement('div').innerHTML = '<b>x</b>'; return false; } catch (e) { return true; } });
    assert.equal(enforced, true, 'the test page must really enforce Trusted Types');
    await tt.waitForSelector('#sblipill', { state: 'visible' });
    await tt.click('#sblipill');
    await tt.waitForSelector('#sbliadd', { timeout: 20000 });
    assert.deepEqual(ttErrors, []);
    ok('opens and reads on a page that enforces Trusted Types');

    // 7. A page whose own policy scrubs inserted HTML. First the setup
    // panel (no token yet), then a full read with a token.
    for (const withToken of [false, true]) {
      const sc = await browser.newPage();
      const scErrors = [];
      sc.on('pageerror', e => scErrors.push(e.message));
      sc.on('dialog', d => { scErrors.push('alert: ' + d.message()); d.dismiss(); });
      await sc.addInitScript((withToken ? GM_SHIM : GM_SHIM.replace("{ sbIngestToken: 'test-token' }", '{}')) + '\n' + SCRIPT);
      await sc.goto('http://127.0.0.1:4622/company/scrub-brand/people/');
      const scrubs = await sc.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<button id="x">b</button>'; return !d.querySelector('#x'); });
      assert.equal(scrubs, true, 'the test page must really scrub inserted HTML');
      await sc.waitForSelector('#sblipill', { state: 'visible' });
      await sc.click('#sblipill');
      if (!withToken) {
        await sc.waitForSelector('#sbli-panel input[type="password"]', { timeout: 5000 });
        await sc.fill('#sbli-panel input[type="password"]', 'test-token');
        await sc.click('#sbli-panel button');
        // Saved, checked against the dashboard, and on to reading the page.
        await sc.waitForSelector('#sbliadd', { timeout: 20000 });
      } else {
        await sc.waitForSelector('#sbliadd', { timeout: 20000 });
        await sc.click('#sbliadd');
        await sc.waitForFunction(() => /Saved/.test(document.getElementById('sbli-panel').innerText));
      }
      assert.deepEqual(scErrors, []);
      assert.ok(!/Something went wrong/.test(await sc.evaluate(() => document.getElementById('sbli-panel').innerText)));
      await sc.close();
    }
    ok('works where the page scrubs inserted HTML (setup, read and save)');

    // 8. Add a brand the dashboard doesn't have.
    {
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/company/casamigos-tequila/people/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.click('#sblipill');
      await pg.waitForSelector('#sblicreate', { timeout: 20000 });
      assert.match(await pg.textContent('#sblicreate'), /Add “Casamigos Tequila” as a new brand \+ 7 people/);
      await pg.click('#sblicreate');
      await pg.waitForFunction(() => /is now a brand in the dashboard/.test(document.getElementById('sbli-panel').innerText));
      const made = sent.filter(b => b.action === 'liCapture' && b.createIfMissing).pop();
      assert.equal(made.companyName, 'Casamigos Tequila');
      assert.equal(made.companyIndustry, 'Beverage Manufacturing');
      await pg.close();
    }
    ok('adds a brand the dashboard doesn\'t have (Casamigos), with LinkedIn\'s industry as a hint');

    // 9a. A whole run: LMNT has no page (found by search), Liquid Death has one.
    {
      fillItems = [
        { brandId: 'b-lmnt', name: 'LMNT', aka: null, category: 'beverage', linkedinUrl: null, contacts: 0, focus: true },
        { brandId: 'b-ld', name: 'Liquid Death', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death/', contacts: 3, focus: false },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      assert.equal(await pg.inputValue('#sblifocus'), 'electrolyte');
      await pg.uncheck('#sblilook');
      await pg.fill('#sbliwords', '');
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblifillstart');
      assert.match(await pg.textContent('#sbli-panel'), /First the 1 matching “electrolyte”: LMNT/);
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      const run = sent.slice(before).map(b => b.action + (b.brandId ? ':' + b.brandId : ''));
      assert.deepEqual(run, ['liList', 'liMatched:b-lmnt', 'liCapture:b-lmnt', 'liSwept:b-lmnt', 'liCapture:b-ld', 'liSwept:b-ld']);
      const matched = sent.slice(before).find(b => b.action === 'liMatched');
      assert.deepEqual(matched.candidates.map(c => c.name), ['LMNT', 'LMNT Labs']);
      assert.match(matched.candidates[0].subtitle, /Food and Beverage Services/);
      const caps = sent.slice(before).filter(b => b.action === 'liCapture');
      assert.ok(caps.every(c => c.rows.length === 7), 'each brand read whole, including "Show more results"');
      assert.match(await pg.textContent('#sbli-panel'), /4 people added across 2 brands/);
      await pg.close();
    }
    ok('a run finds a missing page by search, reads each brand, saves by brandId and finishes');

    // 9b. A click in the tab pauses it; Continue picks it back up.
    {
      fillItems = [{ brandId: 'b-slow', name: 'Slow Brand', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/slow-brand/', contacts: 0, focus: false }];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.fill('#sblifocus', '');
      await pg.uncheck('#sblilook');
      await pg.fill('#sbliwords', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForURL(/slow-brand\/people/);
      await pg.waitForFunction(() => /Reading Slow Brand/.test((document.getElementById('sbli-panel') || {}).innerText || ''));
      await pg.mouse.click(700, 300);
      await pg.waitForFunction(() => /Paused: you clicked/.test(document.getElementById('sbli-panel').innerText));
      await pg.waitForTimeout(4000);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 0, 'nothing saved while paused');
      assert.match(pg.url(), /slow-brand\/people/);
      await pg.click('#sblifillgo');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 1);
      await pg.close();
    }
    ok('a click in the run\'s tab pauses it; Continue carries on');

    // 9c. LinkedIn's limit page: paused, nothing saved.
    {
      fillItems = [{ brandId: 'b-limit', name: 'Limit Brand', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/limit-brand/', contacts: 0, focus: false }];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sblilook');
      await pg.fill('#sbliwords', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => /LinkedIn showed “.*commercial use limit/.test(((document.getElementById('sbli-panel') || {}).innerText) || ''), null, { timeout: 30000 });
      await pg.waitForTimeout(1500);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 0);
      await pg.close();
    }
    ok('LinkedIn\'s limit page pauses the run before anything is saved');

    // 10. Finding new brands.
    {
      fillItems = [{ brandId: 'b-ca', name: 'Clase Azul', aka: null, category: 'alcohol', linkedinUrl: 'https://www.linkedin.com/company/claseazul/', contacts: 2, focus: false }];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      assert.equal(await pg.isChecked('#sblilook'), true, 'lookalikes on by default');
      assert.equal(await pg.inputValue('#sbliwords'), 'electrolyte');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      const run = sent.slice(before).map(b => b.action + (b.brandId ? ':' + b.brandId : '') + (b.action === 'liDiscover' ? ':' + b.source + ':' + b.from : ''));
      assert.deepEqual(run, [
        'liList',
        'liDiscover:search:electrolyte',
        'liCapture:b-liv', 'liDiscover:lookalike:Liquid I.V.', 'liSwept:b-liv',
        'liCapture:b-ca', 'liDiscover:lookalike:Clase Azul', 'liSwept:b-ca',
        'liCapture:b-jc', 'liDiscover:lookalike:Jose Cuervo', 'liSwept:b-jc',
      ]);
      const search = sent.slice(before).find(b => b.action === 'liDiscover' && b.source === 'search');
      assert.deepEqual(search.companies.map(c => [c.name, c.subtitle]), [
        ['Liquid I.V.', 'Food and Beverage Manufacturing • Los Angeles • 90K followers'],
        ['Tiny Hydrate', 'Beverage Manufacturing • Austin • 812 followers'],
      ]);
      const ca = sent.slice(before).find(b => b.action === 'liDiscover' && b.from === 'Clase Azul');
      assert.equal(ca.fromBrandId, 'b-ca');
      assert.deepEqual(ca.companies.map(c => [c.name, c.subtitle]), [
        ['Jose Cuervo', 'Beverage Manufacturing • 250,512 followers'],
        ['Tequila Patrón', 'Beverage Manufacturing • 33,483 followers'],
      ]);
      const caPeople = sent.slice(before).find(b => b.action === 'liCapture' && b.brandId === 'b-ca');
      assert.ok(!caPeople.rows.some(r => /company/.test(r.linkedinUrl)), 'the rail never reaches the people rows');
      assert.match(await pg.textContent('#sbli-panel'), /2 new brands added/);
      await pg.close();
    }
    ok('finds new brands by search and by lookalikes, and reads their people in the same run');

    // 6. No @grant lines: runs, shows the pill, says to reinstall.
    const bare = await browser.newPage();
    await bare.goto('http://127.0.0.1:4622/company/liquid-death/people/');
    await bare.addScriptTag({ content: SCRIPT });
    await bare.waitForSelector('#sblipill', { state: 'visible' });
    await bare.click('#sblipill');
    await bare.waitForFunction(() => /Reinstall/.test(document.getElementById('sbli-panel').innerText));
    ok('a copy without its @grant lines says to reinstall');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
