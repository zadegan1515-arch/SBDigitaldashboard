// scripts/test-li-log-script.js
//
// The logging-only script for Zach's LinkedIn (linkedin-log.user.js) runs
// in a browser signed in to Zach's account, so it gets a test before it
// gets there: fake LinkedIn profiles and a fake dashboard that records
// what the script sends.
//
//   1. One version: @version = VERSION.
//   2. Nothing by itself: off a profile the pill only says where to go;
//      a company's People page is read only when Zach presses "Read this
//      page" (1.1, Leo Oct 6 2026 — his network shows people Leo's hides):
//      it scrolls that page, previews (liPreview), and saves on Add
//      (liCapture); the dashboard's #sb-fill link starts nothing.
//   3. On a profile it reads the name (<h1>), the headline (pronouns and
//      "· 2nd" skipped) and the current company (LinkedIn's "Current
//      company" line, else the first job's logo), asks the dashboard who
//      they are, and logs "They accepted" / "Invite sent" in one click,
//      with any edits to the title; Undo takes it back.
//   4. Someone on file gets only what's left (a logged invite → They
//      accepted, by contactId); a brand the dashboard doesn't have is
//      added only from its own button.
//   5. A profile's subpage points back to the profile; the Tampermonkey
//      menu logs and copies a sample of the top card for Claude.
//   6. The token: asked for once, checked with the dashboard, kept out
//      of LinkedIn's storage.
//   7. It works where the page allows only its own Trusted Types policy
//      and that policy scrubs inserted HTML (as LinkedIn does).
//   8. Next to the People capture script its pill sits above that one's;
//      a copy without its @grant lines says to reinstall.
//
// Run: node scripts/test-li-log-script.js   (needs playwright; ~10s)
// If playwright is only installed globally:
//   NODE_PATH=$(npm root -g) node scripts/test-li-log-script.js

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
const RAW = fs.readFileSync(path.join(__dirname, 'linkedin-log.user.js'), 'utf8');
const SCRIPT = RAW.replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'http://127.0.0.1:" + PORT + "/api/ingest'");
assert.ok(SCRIPT.includes('127.0.0.1:' + PORT + '/api/ingest'), 'ingest address swapped in');

// ---- fake LinkedIn ------------------------------------------------
// A profile: the name in an <h1>, pronouns and the badge on their own
// line, the headline, "Current company" (when LinkedIn shows it), and
// the first job with its company logo.
function profile(slug, o) {
  return '<!doctype html><html><head><title>(2) ' + o.name + ' | LinkedIn</title></head><body style="margin:0">' +
    '<header id="global-nav" style="height:50px"><a href="https://www.linkedin.com/in/leo-self/">Me</a><h1>Global nav</h1></header>' +
    '<iframe src="/in/frame-probe/" style="width:10px;height:10px;border:0"></iframe>' +
    '<main><section class="artdeco-card"><div class="ph5">' +
      '<div><a href="/in/' + slug + '/overlay/about-this-profile/"><h1 class="text-heading-xlarge">' + o.name + '</h1></a></div>' +
      '<span class="text-body-small">She/Her</span><span>· 2nd</span>' +
      '<div class="text-body-medium break-words">' + o.headline + '</div>' +
      (o.current ? '<ul><li><button aria-label="Current company: ' + o.current + '. Click to skip to experience card"><img alt=""><span>' + o.current + '</span></button></li></ul>' : '') +
      '<span>Los Angeles, California, United States</span><a href="#">Contact info</a>' +
      '<span>500+ connections</span><button>Connect</button><button>Message</button><button>More</button>' +
    '</div></section>' +
    '<section><div id="experience" class="pv-profile-card__anchor"></div><h2>Experience</h2><ul><li>' +
      '<a href="https://www.linkedin.com/company/' + o.coSlug + '/"><img alt="' + o.co + ' logo"></a>' +
      '<div><span>' + o.role + '</span><span>' + o.co + ' · Full-time</span><span>Jan 2024 - Present</span></div>' +
    '</li></ul></section></main>' +
    '<aside><h2>People also viewed</h2><a href="https://www.linkedin.com/in/someone-else/">Someone Else</a></aside>' +
    '</body></html>';
}
const PROFILES = {
  'jane-doe-4b21a': { name: 'Jane Doe', headline: 'Senior Brand Manager at Liquid Death | ex-Red Bull', current: 'Liquid Death', co: 'Liquid Death', coSlug: '12345', role: 'Senior Brand Manager' },
  'sam-lee-7': { name: 'Sam Lee', headline: 'Partnerships Lead', current: null, co: 'Olipop', coSlug: 'olipop', role: 'Partnerships Lead' },
  'nia-cole-9': { name: 'Nia Cole', headline: 'Head of Marketing', current: 'Casamigos', co: 'Casamigos', coSlug: 'casamigos-tequila', role: 'Head of Marketing' },
  'tt-person': { name: 'Tia Tran', headline: 'Brand Director', current: 'Liquid Death', co: 'Liquid Death', coSlug: 'liquid-death', role: 'Brand Director' },
};
// A People page with cards and "Show more results": this script must
// leave it alone.
const PEOPLE = '<!doctype html><html><head><title>Liquid Death: People | LinkedIn</title></head><body style="margin:0"><main>' +
  '<h1 class="org-top-card-summary__title">Liquid Death</h1><div style="height:1600px">associated members</div><ul>' +
  ['a', 'b', 'c'].map(x => '<li><a href="https://www.linkedin.com/in/p-' + x + '/">Person ' + x.toUpperCase() + '</a><div>Brand Manager</div><button>Connect</button></li>').join('') +
  '</ul><button id="more" onclick="window.__moreClicked = true">Show more results</button></main></body></html>';

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
      if (body.token !== 'test-token') { res.writeHead(401, cors); return res.end('{}'); }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (body.action === 'liVersion') return res.end(JSON.stringify({ ok: true, latest: '1.15' }));
      if (body.action === 'liPerson') {
        if (/sam-lee-7/.test(body.url)) {
          return res.end(JSON.stringify({ ok: true, url: body.url, nameGuess: 'Sam Lee', titleGuess: 'Partnerships Lead',
            person: { contactId: 'c-sam', name: 'Sam Lee', title: 'Partnerships Lead', brand: { id: 'b-ol', name: 'Olipop', archived: false }, status: 'sent', sentAt: '2026-09-20T15:00:00Z', choices: ['accepted'], by: 'link' },
            brand: { id: 'b-ol', name: 'Olipop' } }));
        }
        if (/casamigos/i.test(body.companyName || '') && !body.brandName) {
          return res.end(JSON.stringify({ ok: true, url: body.url, person: null, brand: null, suggestions: ['Casa Azul'], createName: body.companyName, nameGuess: body.name, titleGuess: body.headline }));
        }
        return res.end(JSON.stringify({ ok: true, url: body.url, person: null, brand: { id: 'b1', name: 'Liquid Death', archived: false }, matchedBy: 'name', nameGuess: body.name, titleGuess: 'Senior Brand Manager' }));
      }
      if (body.action === 'liPersonLog') {
        const brand = body.contactId ? { id: 'b-ol', name: 'Olipop' } : body.createIfMissing ? { id: 'b-new', name: body.companyName } : { id: 'b1', name: 'Liquid Death' };
        return res.end(JSON.stringify({ ok: true, contactId: body.contactId || 'c-new', targetId: 't-1', name: body.name || 'Sam Lee', brand, status: body.stage, noop: null, madeContact: !body.contactId, brandCreated: !!body.createIfMissing,
          undo: { targetId: 't-1', stage: body.stage, before: null, madeContact: !body.contactId } }));
      }
      // Hiyo: everyone readable is already on file (1.2: Nobody new still
      // answers, so the brand leaves "Read on Zach's LinkedIn").
      const hiyo = /\/company\/hiyo\//.test(body.companyUrl || '');
      if (body.action === 'liPreview') {
        return res.end(JSON.stringify({ ok: true, brand: hiyo ? { id: 'b-hi', name: 'Hiyo' } : { id: 'b1', name: 'Liquid Death' }, have: 2, cap: 25, room: 23,
          rows: body.rows.map((r, i) => ({ name: r.name, role: r.headline, verdict: hiyo || i === 2 ? 'dupe' : 'add' })) }));
      }
      if (body.action === 'liCapture') {
        return res.end(JSON.stringify(hiyo ? { ok: true, added: 0, have: 3, cap: 25, brand: { id: 'b-hi', name: 'Hiyo' }, zachMarked: true } : { ok: true, added: 2, have: 4, cap: 25, brand: { id: 'b1', name: 'Liquid Death' } }));
      }
      if (body.action === 'liPersonUndo') return res.end(JSON.stringify({ ok: true, undone: true, name: 'Jane Doe', removed: true }));
      res.end(JSON.stringify({ ok: false, error: 'not expected from the log script: ' + body.action }));
    });
    return;
  }
  const pm = req.url.match(/^\/in\/([^\/?#]+)\/(.*)$/);
  if (pm && pm[1] === 'tt-person') {
    // Only the page's own Trusted Types policy is allowed, and it scrubs
    // inserted HTML — LinkedIn did this to the People script's first run.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types default" });
    return res.end(profile('tt-person', PROFILES['tt-person']).replace('<head>', '<head><script>' +
      'trustedTypes.createPolicy("default", { createHTML: function (s) {' +
      '  return s.replace(/\\sid="[^"]*"/g, "").replace(/<button[^>]*>[\\s\\S]*?<\\/button>/g, "").replace(/<input[^>]*>/g, "");' +
      '} });</script>'));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (pm && PROFILES[pm[1]]) {
    if (pm[2]) return res.end('<!doctype html><html><head><title>Experience | LinkedIn</title></head><body><main><h1>Experience</h1></main></body></html>');
    return res.end(profile(pm[1], PROFILES[pm[1]]));
  }
  if (/^\/in\/frame-probe/.test(req.url)) return res.end('<html><body>frame</body></html>');
  if (/^\/company\/liquid-death\/people\/?/.test(req.url)) return res.end(PEOPLE);
  if (/^\/company\/hiyo\/people\/?/.test(req.url)) return res.end(PEOPLE.replace(/Liquid Death/g, 'Hiyo'));
  if (/^\/company\/blank-hiyo\/people\/?/.test(req.url)) return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Hiyo</h1><ul></ul></main></body></html>');
  // The feed tidies its own address as it loads, the way LinkedIn does.
  res.end('<!doctype html><html><head><script>history.replaceState(null, "", location.pathname)</script></head><body><main><h1>Feed</h1></main></body></html>');
});

// Tampermonkey's API, as far as the script uses it; storage lives in the
// tab's sessionStorage the way Tampermonkey keeps its own.
const shim = (seedToken) => `
  (function () {
    var P = '__gm:';
    try {
      if (!sessionStorage.getItem('__gm_seeded')) {
        ${seedToken ? "sessionStorage.setItem(P + 'sbIngestToken', JSON.stringify('test-token'));" : ''}
        sessionStorage.setItem('__gm_seeded', '1');
      }
    } catch (e) {}
    window.GM_getValue = function (k, d) { var v = sessionStorage.getItem(P + k); return v == null ? d : JSON.parse(v); };
    window.GM_setValue = function (k, v) { sessionStorage.setItem(P + k, JSON.stringify(v)); };
    window.GM_deleteValue = function (k) { sessionStorage.removeItem(P + k); };
    window.__sbMenu = [];
    window.GM_registerMenuCommand = function (name, fn) { window.__sbMenu.push({ name: name, fn: fn }); };
    window.GM_setClipboard = function (t) { window.__sbClip = t; };
    window.GM_xmlhttpRequest = function (o) {
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
        .then(function (r) { return r.text().then(function (t) { o.onload({ status: r.status, responseText: t }); }); })
        .catch(function () { o.onerror(); });
    };
  })();
`;

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const BASE = 'http://127.0.0.1:' + PORT;
  const panelText = (pg) => pg.evaluate(() => (document.getElementById('sblog-panel') || {}).innerText || '');
  let n = 0;
  const ok = (name) => { n++; console.log('  ok — ' + name); };
  const errors = [];
  const open = async (url, seedToken = true) => {
    const pg = await browser.newPage();
    pg.on('pageerror', e => errors.push(String(e)));
    await pg.addInitScript(shim(seedToken) + '\n' + SCRIPT);
    await pg.goto(BASE + url);
    await pg.waitForSelector('#sblogpill', { state: 'visible' });
    return pg;
  };

  try {
    // 1. One version.
    const header = RAW.match(/@version\s+(\S+)/)[1];
    assert.equal(RAW.match(/var VERSION = '([^']+)'/)[1], header, '@version = VERSION — bump both');
    ok('one version: @version = VERSION (' + header + ')');

    // 2. It logs and does nothing else.
    let pg = await open('/feed/');
    assert.equal(await pg.textContent('#sblogpill'), 'SB · Log');
    const box = await pg.locator('#sblogpill').boundingBox();
    assert.ok(box.x < pg.viewportSize().width / 2, 'bottom-left, clear of Messaging');
    await pg.click('#sblogpill');
    await pg.waitForFunction(() => /Open the person's profile/.test((document.getElementById('sblog-panel') || {}).innerText || ''));
    assert.match(await pg.getAttribute('#sblog-panel a[href*="app.html"]', 'href'), /app\.html#zach$/);
    assert.equal(sent.length, 0, 'nothing sent off a profile');
    await pg.close();
    ok('off a profile the pill only says where to go; nothing sent');

    pg = await open('/company/liquid-death/people/');
    await pg.waitForFunction(() => (document.getElementById('sblogpill') || {}).textContent === 'SB · Read people');
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogread');
    await pg.waitForTimeout(600);
    assert.equal(await pg.evaluate(() => window.scrollY), 0, 'opening the panel never scrolls');
    assert.equal(await pg.evaluate(() => !!window.__moreClicked), false, 'opening the panel never clicks Show more');
    assert.equal(sent.length, 0, 'nothing is read until Read this page');
    await pg.click('#sblogread');
    await pg.waitForSelector('#sblogadd', { timeout: 20000 });
    const pv = sent.find(x => x.action === 'liPreview');
    assert.deepEqual(pv.rows.map(r => r.name), ['Person A', 'Person B', 'Person C']);
    assert.equal(pv.rows[0].headline, 'Brand Manager');
    assert.equal(pv.companyName, 'Liquid Death');
    assert.equal(await pg.evaluate(() => !!window.__moreClicked), true, 'it presses Show more like a person would');
    assert.equal(sent.filter(x => x.action === 'liCapture').length, 0, 'nothing saved before Add');
    assert.match(await pg.textContent('#sblogadd'), /Add 2 to Liquid Death/);
    await pg.click('#sblogadd');
    await pg.waitForFunction(() => /Saved/.test((document.getElementById('sblog-panel') || {}).innerText || ''));
    const cap = sent.find(x => x.action === 'liCapture');
    assert.equal(cap.rows.length, 3);
    assert.equal(cap.via, 'log');
    assert.ok(!sent.some(x => /^li(List|Run|Swept|Matched|Discover|Research)$/.test(x.action)), 'no run actions, ever');
    await pg.close();
    ok('a company\'s People page: read only on Read this page, previewed, saved only on Add; no run');

    // Nobody new (a link off "Read on Zach's LinkedIn", keyword view): the
    // button still answers the dashboard, which marks the brand read.
    sent.length = 0;
    pg = await open('/company/hiyo/people/?keywords=marketing');
    await pg.waitForFunction(() => (document.getElementById('sblogpill') || {}).textContent === 'SB · Read people');
    await pg.click('#sblogpill');
    await pg.click('#sblogread');
    await pg.waitForSelector('#sblogadd', { timeout: 20000 });
    assert.match(await pg.textContent('#sblogadd'), /Nobody new — mark Hiyo read/);
    assert.equal(await pg.$eval('#sblogadd', b => b.disabled), false);
    assert.match(sent.find(x => x.action === 'liPreview').companyUrl, /\/company\/hiyo\/people\/\?keywords=marketing/);
    await pg.click('#sblogadd');
    await pg.waitForFunction(() => /marked read/.test((document.getElementById('sblog-panel') || {}).innerText || ''));
    const done = sent.filter(x => x.action === 'liCapture');
    assert.equal(done.length, 1);
    assert.equal(done[0].via, 'log');
    assert.equal(done[0].members, null, 'a keyword view says nothing about the headcount');
    sent.length = 0;
    await pg.close();
    ok('nobody new: the button marks the brand read (liCapture via log), the keyword view\'s headcount is never sent');

    // A read that made out nobody can't mark anything read.
    pg = await open('/company/blank-hiyo/people/');
    await pg.waitForFunction(() => (document.getElementById('sblogpill') || {}).textContent === 'SB · Read people');
    await pg.click('#sblogpill');
    await pg.click('#sblogread');
    await pg.waitForSelector('#sblogadd', { timeout: 20000 });
    assert.match(await pg.textContent('#sblogadd'), /Nobody read on this page/);
    assert.equal(await pg.$eval('#sblogadd', b => b.disabled), true);
    assert.equal(sent.filter(x => x.action === 'liCapture').length, 0);
    sent.length = 0;
    await pg.close();
    ok('a read that made out nobody can\'t mark the brand read');

    pg = await open('/feed/#sb-fill');
    await pg.waitForTimeout(1500);
    assert.equal(await pg.$('#sblog-panel'), null, 'no panel opens by itself');
    assert.equal(sent.length, 0, 'the dashboard\'s fill link starts nothing here');
    await pg.close();
    ok('the dashboard\'s "Start the LinkedIn fill" link starts nothing here');

    // 3. A profile: read, log, undo.
    pg = await open('/in/jane-doe-4b21a/');
    await pg.waitForFunction(() => document.getElementById('sblogpill').textContent === 'SB · Log them');
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogacc', { timeout: 20000 });
    const ask = sent.filter(b => b.action === 'liPerson').pop();
    assert.equal(ask.url, 'https://www.linkedin.com/in/jane-doe-4b21a/');
    assert.equal(ask.name, 'Jane Doe');
    assert.equal(ask.headline, 'Senior Brand Manager at Liquid Death | ex-Red Bull');
    assert.equal(ask.companyName, 'Liquid Death');
    assert.equal(ask.reader, 2, 'sends the reader number the dashboard lets through');
    assert.match(await panelText(pg), /Goes under Liquid Death/);
    assert.equal(await pg.inputValue('#sblogname'), 'Jane Doe');
    assert.equal(await pg.inputValue('#sblogtitle'), 'Senior Brand Manager');
    assert.ok(await pg.$('#sblogsent'), 'someone new can be logged as invite sent too');
    assert.equal(sent.filter(b => b.action === 'liPersonLog').length, 0, 'nothing saved before a click');
    ok('a profile: name, headline and current company read; nothing saved yet');

    await pg.fill('#sblogtitle', 'Sr. Brand Manager');
    await pg.click('#sblogacc');
    await pg.waitForFunction(() => /Logged/.test(document.getElementById('sblog-panel').innerText));
    const log = sent.filter(b => b.action === 'liPersonLog').pop();
    assert.deepEqual([log.stage, log.brandId, log.name, log.title, log.url, !!log.createIfMissing],
      ['accepted', 'b1', 'Jane Doe', 'Sr. Brand Manager', 'https://www.linkedin.com/in/jane-doe-4b21a/', false]);
    assert.match(await panelText(pg), /on Zach's list/);
    assert.match(await pg.getAttribute('#sblog-panel a[href*="app.html"]', 'href'), /app\.html#zach$/);
    assert.match(pg.url(), /\/in\/jane-doe-4b21a\/$/);
    ok('They accepted: one click, with the edited title, and it never navigated');

    await pg.click('#sblogundo');
    await pg.waitForFunction(() => /Undone/.test(document.getElementById('sblog-panel').innerText));
    assert.deepEqual(sent.filter(b => b.action === 'liPersonUndo').pop().undo, { targetId: 't-1', stage: 'accepted', before: null, madeContact: true });
    ok('Undo right after takes it back');

    // 4. On file with a logged invite; a brand the dashboard doesn't have.
    await pg.goto(BASE + '/in/sam-lee-7/');
    await pg.waitForSelector('#sblogpill', { state: 'visible' });
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogacc', { timeout: 20000 });
    const ask2 = sent.filter(b => b.action === 'liPerson').pop();
    assert.equal(ask2.companyName, 'Olipop', 'no Current company line: the first job\'s logo names it');
    assert.match(ask2.companyUrl, /\/company\/olipop\/$/);
    assert.match(await panelText(pg), /On file at Olipop · invite sent/);
    assert.equal(await pg.$('#sblogsent'), null, 'a logged invite is not offered again');
    await pg.click('#sblogacc');
    await pg.waitForFunction(() => /Logged/.test(document.getElementById('sblog-panel').innerText));
    assert.deepEqual((({ contactId, stage }) => [contactId, stage])(sent.filter(b => b.action === 'liPersonLog').pop()), ['c-sam', 'accepted']);
    ok('on file with a logged invite: They accepted only, by contactId');

    await pg.goto(BASE + '/in/nia-cole-9/');
    await pg.waitForSelector('#sblogpill', { state: 'visible' });
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogsent', { timeout: 20000 });
    assert.match(await pg.textContent('#sblogsent'), /New brand \+ Invite sent/);
    await pg.click('#sblogsent');
    await pg.waitForFunction(() => /is now a brand in the dashboard/.test(document.getElementById('sblog-panel').innerText));
    const log3 = sent.filter(b => b.action === 'liPersonLog').pop();
    assert.deepEqual([log3.stage, log3.createIfMissing, log3.companyName], ['sent', true, 'Casamigos']);
    ok('a brand the dashboard doesn\'t have is added only from its own button');

    // 5. Subpage; the Tampermonkey menu.
    await pg.goto(BASE + '/in/jane-doe-4b21a/details/experience/');
    await pg.waitForSelector('#sblogpill', { state: 'visible' });
    await pg.click('#sblogpill');
    await pg.waitForFunction(() => /open their main profile/.test(document.getElementById('sblog-panel').innerText));
    await pg.goto(BASE + '/in/jane-doe-4b21a/');
    await pg.waitForSelector('#sblogpill', { state: 'visible' });
    assert.deepEqual(await pg.evaluate(() => window.__sbMenu.map(m => m.name)), ['Log this person (SB)', 'Copy a sample of this profile for Claude']);
    await pg.evaluate(() => window.__sbMenu[1].fn());
    await pg.waitForFunction(() => /Copied/.test(document.getElementById('sblog-panel').innerText));
    const clip = await pg.evaluate(() => window.__sbClip);
    assert.match(clip, /SB LinkedIn profile sample · log script/);
    assert.match(clip, /"name":"Jane Doe"/);
    await pg.evaluate(() => window.__sbMenu[0].fn());
    await pg.waitForSelector('#sblogacc', { timeout: 20000 });
    await pg.close();
    ok('a subpage points to the profile; the menu logs and copies a sample for Claude');

    // 6. The token.
    const before = sent.length;
    pg = await open('/in/jane-doe-4b21a/', false);
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogtok');
    await pg.fill('#sblogtok', 'wrong-token');
    await pg.click('#sblogtoksave');
    await pg.waitForFunction(() => /did not accept the token/.test(document.getElementById('sblog-panel').innerText));
    await pg.fill('#sblogtok', 'test-token');
    await pg.click('#sblogtoksave');
    await pg.waitForSelector('#sblogacc', { timeout: 20000 });
    assert.deepEqual(sent.slice(before).map(b => b.action), ['liVersion', 'liVersion', 'liPerson'], 'checked, then straight to the profile');
    assert.ok(!/test-token/.test(await pg.evaluate(() => JSON.stringify(localStorage))), 'token kept out of LinkedIn\'s storage');
    await pg.close();
    ok('the token is asked for once, checked, and kept out of LinkedIn\'s storage');

    // 7. Trusted Types, scrubbing policy.
    const ttErr = errors.length;
    pg = await open('/in/tt-person/');
    const enforced = await pg.evaluate(() => { try { const d = document.createElement('div'); d.innerHTML = '<button id="x">x</button>'; return d.innerHTML === ''; } catch (e) { return true; } });
    assert.ok(enforced, 'the page really enforces Trusted Types');
    await pg.click('#sblogpill');
    await pg.waitForSelector('#sblogacc', { timeout: 20000 });
    await pg.click('#sblogacc');
    await pg.waitForFunction(() => /Logged/.test(document.getElementById('sblog-panel').innerText));
    assert.deepEqual(errors.slice(ttErr), []);
    await pg.close();
    ok('works where LinkedIn allows only its own Trusted Types policy');

    // 8. Next to the People script; no @grant lines.
    pg = await open('/feed/');
    await pg.evaluate(() => { const o = document.createElement('button'); o.id = 'sblipill'; o.textContent = 'SB ⬇ People'; document.documentElement.appendChild(o); });
    await pg.waitForFunction(() => document.getElementById('sblogpill').style.bottom === '66px');
    await pg.close();
    ok('next to the People script\'s pill it sits just above it');

    const bare = await browser.newPage();
    await bare.goto(BASE + '/in/jane-doe-4b21a/');
    await bare.addScriptTag({ content: SCRIPT });
    await bare.waitForSelector('#sblogpill', { state: 'visible' });
    await bare.click('#sblogpill');
    await bare.waitForFunction(() => /Reinstall/.test(document.getElementById('sblog-panel').innerText));
    await bare.close();
    ok('a copy without its @grant lines says to reinstall');

    assert.deepEqual(errors, [], 'no page errors');
    assert.ok(sent.every(b => ['liVersion', 'liPerson', 'liPersonLog', 'liPersonUndo'].includes(b.action)), 'only the logging calls, ever');
    ok('no page errors; only the four logging calls were ever sent');
    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
