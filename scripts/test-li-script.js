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

function page(people) {
  return '<!doctype html><html><head><title>(3) Liquid Death: People | LinkedIn</title></head><body style="margin:0">' +
    '<header id="global-nav" style="height:50px"><a href="https://www.linkedin.com/in/leo-self/">Me</a></header>' +
    '<main><h1 class="org-top-card-summary__title"> Liquid Death </h1>' +
    (people
      ? '<div style="height:1400px">associated members</div><ul id="grid">' + FIRST + '</ul>' +
        '<button id="more" onclick="document.getElementById(\'grid\').insertAdjacentHTML(\'beforeend\', window.__MORE); this.remove()">Show more results</button>' +
        '<script>window.__MORE = ' + JSON.stringify(MORE) + '</script>'
      : '<p>About the company</p>') +
    '</main></body></html>';
}

const sent = [];
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (/^\/company\/liquid-death\/people\/?/.test(req.url)) return res.end(page(true));
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
    var store = { sbIngestToken: 'test-token' };
    window.GM_getValue = function (k, d) { return k in store ? store[k] : d; };
    window.GM_setValue = function (k, v) { store[k] = v; };
    window.GM_deleteValue = function (k) { delete store[k]; };
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
    await load('/company/liquid-death/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    ok('pill shows on a company page');

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

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
