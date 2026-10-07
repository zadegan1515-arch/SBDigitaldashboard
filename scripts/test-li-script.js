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
//      and finishes; a click in the tab no longer pauses it (Leo, Sep 30:
//      "it keeps stopping every time I click"), its Pause button does, and
//      Continue resumes; if Leo takes the window to another page it waits
//      until he's left it alone, then goes back; LinkedIn's limit page
//      pauses it before anything is saved.
//  10. Finding new brands: a keyword search adds Liquid I.V. to the front
//      of the line, Clase Azul's lookalikes (on its People page) add Jose
//      Cuervo at the end, and each new brand's people are read in the
//      same run. A brand whose People page shows no lookalikes costs no
//      extra page (the home-page stop is gone).
//  11. The research list: Powerade is found on LinkedIn, becomes a brand
//      and gets its people read; "NOS Energy" (and then "NOS") only turns
//      up a telecom, so it's left with a note after both spellings.
//  12. LinkedIn's real People cards (Supergoop, Sep 2026): the badge is a
//      bullet ("• 3rd+") — on the name's line, on its own line, or inside
//      the name link — and there's no subtitle class. Names come out clean
//      and every headline is read, so the founder is a buyer. The copied
//      sample for Claude says what the reader made of each card.
//  13. The dashboard's "Start the LinkedIn fill" opens LinkedIn at
//      #sb-fill: the run starts and finishes with no click at all, with
//      the defaults (electrolyte first, research list on) — even though
//      the feed wipes the mark from the address as it loads. A run left
//      behind by a closed tab doesn't block it; a live run in another
//      tab is shown instead of doubled.
//  14. Updates: the script's version is the one the dashboard expects;
//      when the dashboard names a newer one, the pill turns orange and the
//      panel links to Tampermonkey's update page; asked at most every 6 h.
//  15. The run's report: start and finish go to the dashboard, every
//      brand's visit carries the run, and a page whose cards the reader
//      gets wrong sends the problem with a sample of the cards.
//  16. A window of its own: time with the window hidden (Chrome slows it)
//      is counted into the brand's report, and #sb-fill arriving on a page
//      that's already loaded (the dashboard's button on a window already
//      at the feed) still starts the run.
//  17. Leo's LinkedIn only: every call says who's signed in (asked of
//      LinkedIn's /voyager/api/me), and the dashboard turning an account
//      away stops the run before it starts.
//  18. A saved page that's another company's (Native had a home-care
//      agency's): nobody saved, the brand is looked up again with
//      recheck, and it's left for Leo's list; the end of the run lists
//      every brand and what happened.
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
  .replace(/function rand\(a, b\) \{[^}]*\}/, 'function rand() { return 30; }')
  // A minute's quiet after Leo is too long for a test.
  .replace('var IDLE_MS = 60000;', 'var IDLE_MS = 3000;');

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
    // LinkedIn pages carry same-origin frames; the script must act only
    // in the top page, or a second copy runs the same brand.
    '<iframe src="/company/frame-probe/" style="width:10px;height:10px;border:0"></iframe>' +
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
// Who the fake LinkedIn says is signed in (null: nobody it will say).
let signedIn = null;
const versionAsks = [];
const runEvents = [];
// What the fake dashboard says the current script is.
let latestVersion = null;
// What liList hands the fill; each scenario sets its own.
let fillItems = [];
const discovered = new Set();
const homeVisits = [];

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
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      // The version check and the run's report aren't captures; they're
      // kept apart so "nothing was sent" still means nothing was saved.
      if (body.action === 'liVersion') { versionAsks.push(body); return res.end(JSON.stringify({ ok: true, latest: latestVersion })); }
      if (body.action === 'liRun') { runEvents.push(body); return res.end(JSON.stringify({ ok: true, latest: latestVersion })); }
      sent.push(body);
      if (body.token !== 'test-token') { res.writeHead(401); return res.end('{}'); }
      // Like the dashboard: another LinkedIn account is refused before anything.
      if (body.me && body.me.slug === 'zach-q' && /^li(List|Capture|Preview|Matched|Swept|Discover|Research)$/.test(body.action)) {
        return res.end(JSON.stringify({ ok: false, notOwner: true, error: 'This isn\'t the LinkedIn account the fill runs on — it runs only on Leo Z\'s, and this is Zach Q\'s. Nothing was read or saved.' }));
      }
      if (body.action === 'liPreview' && /casamigos/.test(body.companyUrl || '')) {
        return res.end(JSON.stringify({
          ok: true, brand: null, matchedBy: null, notFound: body.brandName || null, suggestions: [], createName: body.brandName || body.companyName,
          cap: 25, have: 0, room: 25,
          rows: body.rows.map(r => ({ name: r.name, role: r.headline, linkedinUrl: r.linkedinUrl, verdict: 'noBrand' })),
        }));
      }
      if (body.action === 'liCapture' && body.handPicked) {
        return res.end(JSON.stringify({ ok: true, brand: { id: 'bsnag', name: body.brandName }, brandCreated: true, added: 1, have: 1, cap: 25, verdicts: [{ name: 'Mason Cohen', verdict: 'add' }] }));
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
      if (body.action === 'liResearch' && body.name === 'Ketel One') {
        return res.end(JSON.stringify(body.final
          ? { ok: true, outcome: 'parent', brandId: 'b-ko', name: 'Ketel One', parent: { name: 'Diageo', search: 'Diageo', slug: null } }
          : { ok: true, outcome: 'unclear' }));
      }
      if (body.action === 'liParent') {
        const hit = (body.candidates || []).find(c => c.name === 'Diageo');
        return res.end(JSON.stringify(hit ? { ok: true, slug: 'diageo', name: 'Diageo' } : { ok: true, slug: null, shown: (body.candidates || []).slice(0, 3).map(c => c.name) }));
      }
      if (body.action === 'liCapture' && /^b-(cm|rg)$/.test(body.brandId) && /empty-co/.test(body.companyUrl || '')) {
        return res.end(JSON.stringify({ ok: true, brand: { id: body.brandId, name: 'Captain Morgan' }, added: 0, have: 0, cap: 25 }));
      }
      if (body.action === 'liResearch') {
        const hit = (body.candidates || []).find(c => c.name === body.name && /Beverage/.test(c.subtitle));
        return res.end(JSON.stringify(hit
          ? { ok: true, outcome: 'added', brandId: 'b-pow', name: body.name, linkedinUrl: 'https://www.linkedin.com/company/powerade/' }
          : { ok: true, outcome: 'unclear' }));
      }
      if (body.action === 'liList') {
        return res.end(JSON.stringify({
          ok: true, items: fillItems, cap: 25, noPage: fillItems.filter(i => !i.linkedinUrl && !i.research).length, resting: 0, research: fillItems.filter(i => i.research).length,
          planned: fillItems.filter(i => i.planned).length,
          noBuyer: fillItems.filter(i => i.noBuyer && !i.research && !i.planned).length,
        }));
      }
      if (body.action === 'liMatched' && body.recheck) {
        return res.end(JSON.stringify({ ok: true, outcome: 'review', suggested: 'Native', candidates: 2 }));
      }
      if (body.action === 'liMatched' && body.brandId === 'b-mn') {
        // Leo pressed "None of these" after this run fetched its list.
        return res.end(JSON.stringify({ ok: true, outcome: 'markedNone' }));
      }
      if (body.action === 'liMatched') {
        const hit = (body.candidates || []).find(c => c.name === 'LMNT');
        return res.end(JSON.stringify(hit
          ? { ok: true, outcome: 'attached', how: 'exact', name: 'LMNT', linkedinUrl: 'https://www.linkedin.com/company/drinklmnt/' }
          : { ok: true, outcome: 'unclear' }));
      }
      if (body.action === 'liCapture' && body.brandId === 'b-nat' && body.checkPage) {
        return res.end(JSON.stringify({ ok: true, pageMismatch: true, industry: body.companyIndustry, added: 0, have: 0, cap: 25 }));
      }
      if (body.action === 'liCapture' && body.brandId) {
        // The whole list adds two; the marketing / partnerships views find
        // the same people again (nobody new), so totals stay readable.
        const view = /[?&]keywords=(marketing|partnerships)$/.test(body.companyUrl || '') && body.brandId !== 'b-big';
        return res.end(JSON.stringify({ ok: true, brand: { id: body.brandId, name: body.companyName }, added: view ? 0 : 2, have: 12, cap: 25, targetsShelved: 0 }));
      }
      if (body.action === 'liPreview' && /all-known/.test(body.companyUrl || '')) {
        return res.end(JSON.stringify({ ok: true, brand: { id: 'b-ak', name: 'All Known' }, matchedBy: 'name', cap: 25, have: 6, room: 19,
          rows: body.rows.map((r) => ({ name: r.name, role: r.headline, linkedinUrl: r.linkedinUrl, verdict: 'dupe' })) }));
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
  // LinkedIn's own "who am I" call, answered for whoever the test signs in.
  // Someone's own profile (Mason at Snag, Oct 2026).
  if (/^\/in\/mason-cohen\/?$/.test(req.url)) {
    return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Mason Cohen | LinkedIn</title></head><body>' +
      '<header id="global-nav"><a href="https://www.linkedin.com/in/leo-self/">Me</a></header><main><section>' +
      '<h1>Mason Cohen</h1><div>· 3rd</div><div>Cofounder at Snag</div><div>Austin, Texas, United States</div><div>Contact info</div>' +
      '<a aria-label="Current company: Snag. Click to skip to experience card" href="https://www.linkedin.com/company/snag-sampling/"><span>Snag</span></a>' +
      '<div>500+ connections</div><button>Message</button></section></main></body></html>');
  }
  if (req.url === '/voyager/api/me') {
    if (!signedIn || !/JSESSIONID/.test(req.headers.cookie || '') || !req.headers['csrf-token']) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ plainId: 1, miniProfile: { firstName: signedIn.first, lastName: signedIn.last, publicIdentifier: signedIn.slug } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (/^\/company\/native-co\.\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Native</h1>' +
      '<div class="org-top-card-summary-info-list"><div class="org-top-card-summary-info-list__info-item">Individual and Family Services</div></div><ul>' +
      '<li><section><a href="https://www.linkedin.com/in/cg-1/">Carla Gray</a> <span>• 3rd+</span><div>Caregiver</div></section></li>' +
      // Someone hidden on the wrong company's page: never sent for Zach.
      '<li><section><div>LinkedIn Member</div><div>Marketing</div></section></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/search\/results\/companies\/\?keywords=Native(&|$)/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/native-co./"><span>Native</span></a><div>Individual and Family Services • Phoenix</div><div>1K followers</div></li>' +
      '<li><a href="https://www.linkedin.com/company/native-cos/"><span>Native</span></a><div>Personal Care Product Manufacturing • San Francisco</div><div>60K followers</div></li>' +
      '</ul></main></body></html>');
  }
  // Its marketing view turns up someone the whole list didn't show.
  if (/^\/company\/liquid-death\/people\/\?keywords=marketing$/.test(req.url)) {
    return res.end(page(true, 'Liquid Death', '<ul>' + card('quinn-r', 'Quinn Ray', 'Partnerships Manager at Liquid Death', '3rd') + '</ul>'));
  }
  if (/^\/company\/liquid-death\/people\/?/.test(req.url)) return res.end(page(true));
  if (/^\/company\/casamigos-tequila\/people\/?/.test(req.url)) return res.end(page(true, 'Casamigos Tequila'));
  if (/^\/company\/drinklmnt\/people\/?/.test(req.url)) return res.end(page(true, 'LMNT'));
  // LinkedIn's real People cards, as they came through for Supergoop.
  // Everyone readable already on file, one hidden marketer.
  if (/^\/company\/all-known\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">All Known</h1><ul>' +
      '<li><section><a href="https://www.linkedin.com/in/ak-1/">Ana Known</a> <span>· 2nd</span><div>Brand Manager</div></section></li>' +
      '<li><section><div>LinkedIn Member</div><div>Head of Events</div></section></li>' +
      '</ul></main></body></html>');
  }
  // A People tab with nobody on it at all: no views worth opening.
  if (/^\/company\/nobody-co\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Nobody Co</h1><h2>0 associated members</h2><ul></ul></main></body></html>');
  }
  if (/^\/company\/supergoop\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Supergoop!</h1><ul>' +
      '<li><section><a href="https://www.linkedin.com/in/holly-t/"><img alt=""></a>' +
        '<div class="artdeco-entity-lockup__title"><a href="https://www.linkedin.com/in/holly-t/">Holly Thaggard</a> <span>• 3rd+</span></div>' +
        '<div>Founder and Chief Executive Officer at Supergoop!</div><button>Follow</button></section></li>' +
      '<li><section><a href="https://www.linkedin.com/in/caitlin-f/"><div>Caitlin Feroleto</div></a>' +
        '<div><span>• 2nd</span></div><div>Senior Director, Brand Marketing</div><div>12 mutual connections</div><button>Connect</button></section></li>' +
      '<li><section><a href="https://www.linkedin.com/in/judy-l/"><span>Judy Lee</span><span> • 3rd+</span></a>' +
        '<div>Software Engineer at Supergoop!</div><button>Connect</button></section></li>' +
      // Hidden people in real shapes: the badge on the "LinkedIn Member"
      // line, and one with no headline at all.
      '<li><section><span>LinkedIn Member</span> <span>• 3rd+</span><div>Head of Partnerships at Supergoop!</div><button>Connect</button></section></li>' +
      '<li><section><div>LinkedIn Member</div><button>Connect</button></section></li>' +
      '</ul></main></body></html>');
  }
  // Leo (Sep 2026): only companies with under 100 people on LinkedIn.
  if (/^\/search\/results\/companies\/\?keywords=(Ketel%20One|Diageo)(&|$)/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' + (/Diageo/.test(req.url)
      ? '<li><a href="https://www.linkedin.com/company/diageo/"><span>Diageo</span></a><div>Beverage Manufacturing • London</div><div>2M followers</div></li>'
      : '<li>No results found</li>') + '</ul></main></body></html>');
  }
  // A parent whose LinkedIn page goes by another name (Monster Beverage = "Monster Energy").
  if (/^\/search\/results\/companies\/\?keywords=Monster%20Beverage/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/monster-energy/"><span>Monster Energy</span></a><div>Food and Beverage Services • Corona</div><div>1M followers</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/company\/diageo\/people\/\?keywords=/.test(req.url)) return res.end(page(true, 'Diageo', '<h2>31,000 associated members</h2>'));
  if (/^\/company\/empty-co\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Captain Morgan</h1><h2>12 associated members</h2><ul>' +
      '<li><section><div>LinkedIn Member</div><div>Marketing</div></section></li></ul></main></body></html>');
  }
  if (/^\/company\/big-co\/people\/?/.test(req.url)) return res.end(page(true, 'Big Co', '<h2>12,345 associated members</h2>'));
  if (/^\/company\/small-co\/people\/?/.test(req.url)) return res.end(page(true, 'Small Co', '<h2>48 associated members</h2>'));
  // Cards the reader gets wrong: the profile link holds only a photo, so
  // each "name" is the title and every title comes out blank.
  if (/^\/company\/blank-cards\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Blank Cards</h1><ul>' +
      ['q1', 'q2', 'q3'].map(q => '<li><section><a href="https://www.linkedin.com/in/' + q + '/"><img alt=""></a><div>Brand Manager</div><button>Connect</button></section></li>').join('') +
      '</ul></main></body></html>');
  }
  // The research list's searches.
  if (/^\/search\/results\/companies\/\?keywords=Powerade/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/powerade/"><span>Powerade</span></a><div>Beverage Manufacturing • Atlanta</div><div>150K followers</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/search\/results\/companies\/\?keywords=NOS(%20Energy)?(&|$)/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/nos-sgps/"><span>NOS</span></a><div>Telecommunications • Lisbon</div><div>300K followers</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/company\/powerade\/people\/?/.test(req.url)) return res.end(page(true, 'Powerade'));
  // The discovery story's pages.
  if (/^\/search\/results\/companies\/\?keywords=electrolyte/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/liquid-i-v/"><span>Liquid I.V.</span></a><div>Food and Beverage Manufacturing • Los Angeles</div><div>90K followers</div></li>' +
      '<li><a href="https://www.linkedin.com/company/tiny-hydrate/"><span>Tiny Hydrate</span></a><div>Beverage Manufacturing • Austin</div><div>812 followers</div></li>' +
      '</ul></main></body></html>');
  }
  if (/^\/company\/liquid-i-v\/people\/?/.test(req.url)) return res.end(page(true, 'Liquid I.V.', rail([['drinklmnt', 'LMNT', 'Food and Beverage Services', '40K']])));
  if (/^\/company\/claseazul\/people\/?/.test(req.url)) return res.end(page(true, 'Clase Azul', rail([['jose-cuervo', 'Jose Cuervo', 'Beverage Manufacturing', '250,512'], ['patron', 'Tequila Patrón', 'Beverage Manufacturing', '33,483']])));
  if (/^\/company\/jose-cuervo\/people\/?/.test(req.url)) return res.end(page(true, 'Jose Cuervo'));
  // A company home page: the run must never need one now.
  if (/^\/company\/(claseazul|jose-cuervo|liquid-i-v)\/?$/.test(req.url)) { homeVisits.push(req.url); return res.end(page(false, 'Home')); }
  // LinkedIn telling a free account it has searched enough.
  if (/^\/company\/limit-brand\/people\/?/.test(req.url)) {
    return res.end(page(true, 'Limit Brand', '<div>You\'ve reached the commercial use limit on search.</div>'));
  }
  // People that take three seconds to appear — long enough to click.
  if (/^\/company\/slow-brand\/people\/?/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Slow Brand</h1><ul id="g"></ul></main>' +
      '<script>setTimeout(function () { document.getElementById("g").insertAdjacentHTML("beforeend", ' + JSON.stringify(FIRST) + '); }, 3000)</script></body></html>');
  }
  // Only other companies called ALP (staffing, aviation).
  if (/^\/search\/results\/companies\/\?keywords=ALP(%20Pouches)?(&|$)/.test(req.url)) {
    return res.end('<!doctype html><html><body><main><ul>' +
      '<li><a href="https://www.linkedin.com/company/alp-consulting/">Alp Consulting Ltd.</a><div>Staffing and Recruiting • Bangalore</div></li>' +
      '</ul></main></body></html>');
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
  // The feed tidies its own address as it loads, the way LinkedIn does —
  // which is what hid #sb-fill from a page-ready script.
  res.end('<!doctype html><html><head><script>history.replaceState(null, "", location.pathname)</script></head><body><main><h1>Feed</h1></main></body></html>');
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
    window.GM_setClipboard = function (t) { window.__sbClip = t; };
    window.GM_xmlhttpRequest = function (o) {
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
        .then(function (r) { return r.text().then(function (t) { o.onload({ status: r.status, responseText: t }); }); })
        .catch(function () { o.onerror(); });
    };
  })();
`;

(async () => {
  // 14a. One version everywhere: the header, the script's own VERSION and
  // what the dashboard tells older copies (li-sweep.ts).
  {
    const raw = fs.readFileSync(path.join(__dirname, 'linkedin-capture.user.js'), 'utf8');
    const header = raw.match(/@version\s+(\S+)/)[1];
    const inner = raw.match(/var VERSION = '([^']+)'/)[1];
    const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'li-sweep.ts'), 'utf8').match(/LI_SCRIPT_VERSION = '([^']+)'/)[1];
    assert.equal(inner, header, '@version and VERSION match');
    assert.equal(server, header, 'LI_SCRIPT_VERSION in li-sweep.ts matches @version — bump both');
    const dl = raw.match(/@downloadURL\s+(\S+)/)[1];
    assert.ok(raw.includes("var DOWNLOAD_URL = '" + dl + "'"), 'the update link is the @downloadURL');
    console.log('  ok — one version: @version = VERSION = LI_SCRIPT_VERSION (' + header + ')');
  }
  await new Promise(r => server.listen(4622, '127.0.0.1', r));
  // Claude's cloud sessions keep Chromium in /opt/pw-browsers; CI installs its own.
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const pageObj = await browser.newPage();
  // On every page load, the way Tampermonkey injects — a hand scan opens
  // its marketing / partnerships views itself.
  await pageObj.addInitScript(GM_SHIM + '\n' + SCRIPT);
  const load = async (url) => {
    await pageObj.goto('http://127.0.0.1:4622' + url);
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
    // On someone's profile: one button sends that person to their
    // company's brand (made if missing). It logs no invite — that's the
    // SB · Log script (linkedin-log.user.js, Zach's browser).
    await load('/in/mason-cohen/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    await pageObj.click('#sblipill');
    await pageObj.waitForSelector('#sblisend');
    assert.equal(sent.length, 0, 'nothing sent before the button');
    assert.equal(await pageObj.inputValue('#sbliprofbrand'), 'Snag');
    assert.match(await pageObj.innerText('#sbli-panel'), /Cofounder at Snag/);
    await pageObj.click('#sblisend');
    await pageObj.waitForFunction(() => /Sent/.test(document.getElementById('sbli-panel').innerText));
    const cap1 = sent.filter(b => b.action === 'liCapture');
    assert.equal(cap1.length, 1);
    assert.equal(cap1[0].handPicked, true);
    assert.equal(cap1[0].createIfMissing, true);
    assert.equal(cap1[0].brandName, 'Snag');
    assert.match(cap1[0].companyUrl, /\/company\/snag-sampling\/$/);
    assert.deepEqual(cap1[0].rows, [{ name: 'Mason Cohen', headline: 'Cofounder at Snag', linkedinUrl: 'https://www.linkedin.com/in/mason-cohen/' }]);
    assert.ok(!sent.some(b => /^liPerson/.test(b.action)), 'logs no invite');
    sent.length = 0;
    ok('on a profile, "Send to dashboard" adds that one person under their company');
    await load('/company/liquid-death/');
    await pageObj.waitForSelector('#sblipill', { state: 'visible' });
    ok('pill shows on a company page');

    // The Tampermonkey menu entry opens the same panel.
    const menu = await pageObj.evaluate(() => window.__sbMenu.map(m => m.name));
    assert.deepEqual(menu, ['Open the SB capture panel', 'Fill brands by itself', 'Copy a sample of this page for Claude']);
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
    assert.deepEqual(names, ['Ali Rahman 🚀', 'Dee Okafor', 'Jane Doe', 'Kim Tran', 'Max Vogel', 'Pat Kim', 'Quinn Ray', 'Sam Lee'].sort());
    ok('reads the first screen and the "Show more results" batch, then the marketing and partnerships views (one copy each): ' + rows.length + ' people');
    assert.match(pageObj.url(), /\/company\/liquid-death\/people\/\?keywords=partnerships$/);
    assert.match(await pageObj.innerText('#sbli-panel'), /whole list \+ the marketing and partnerships views/);
    ok('the scan opens the marketing and partnerships views by itself and previews once at the end');
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

    // 3. Nothing saved until Add; after the views, no navigation of its own.
    assert.equal(sent.filter(b => b.action === 'liCapture').length, 0);
    assert.match(await pageObj.innerText('#sbli-panel'), /1 more show as "LinkedIn Member"/);
    ok('says how many "LinkedIn Member" cards LinkedIn hid');
    // Their headlines, view by view, go with the preview: likely buyers
    // land on "Read on Zach's LinkedIn" (1.30, Leo Oct 7 2026).
    assert.deepEqual(previews[0].hidden.map(v => v.q), ['', 'marketing', 'partnerships']);
    assert.ok(previews[0].hidden.every(v => v.heads.length === 1 && v.heads[0] === 'Marketing at Liquid Death'), JSON.stringify(previews[0].hidden));
    assert.match(previews[0].hidden[1].url, /\/company\/liquid-death\/people\/\?keywords=marketing$/);
    ok('hand scan: each view\'s "LinkedIn Member" headline goes with the preview');
    const addText = await pageObj.textContent('#sbliadd');
    assert.match(addText, /Add 2 to Liquid Death/);
    await pageObj.click('#sbliadd');
    await pageObj.waitForFunction(() => /Saved/.test(document.getElementById('sbli-panel').innerText));
    assert.equal(sent.filter(b => b.action === 'liCapture').length, 1);
    assert.deepEqual(sent.filter(b => b.action === 'liCapture')[0].hidden, previews[0].hidden, 'Add carries the same hidden views');
    assert.match(pageObj.url(), /\/company\/liquid-death\/people\/\?keywords=partnerships$/);
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
      // Each brand: the whole list, then its marketing and partnerships views.
      assert.deepEqual(run, ['liList', 'liMatched:b-lmnt', 'liCapture:b-lmnt', 'liCapture:b-lmnt', 'liCapture:b-lmnt', 'liSwept:b-lmnt', 'liCapture:b-ld', 'liCapture:b-ld', 'liCapture:b-ld', 'liSwept:b-ld']);
      const matched = sent.slice(before).find(b => b.action === 'liMatched');
      assert.deepEqual(matched.candidates.map(c => c.name), ['LMNT', 'LMNT Labs']);
      assert.match(matched.candidates[0].subtitle, /Food and Beverage Services/);
      const caps = sent.slice(before).filter(b => b.action === 'liCapture');
      assert.ok(caps.filter(c => !/keywords=/.test(c.companyUrl)).every(c => c.rows.length === 7), 'each brand read whole, including "Show more results"');
      assert.match(await pg.textContent('#sbli-panel'), /4 people added across 2 brands/);
      // The hidden people ride on the brand's visit, never on a view's save
      // (the server would take a view's for a hand read).
      assert.ok(caps.every(c => !('hidden' in c)), 'no liCapture carries hidden views');
      const sweptLd = sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-ld');
      assert.deepEqual(sweptLd.hidden.map(v => v.q), ['', 'marketing', 'partnerships']);
      assert.ok(sweptLd.hidden.every(v => v.heads[0] === 'Marketing at Liquid Death' && /\/company\/liquid-death\/people\//.test(v.url)));
      assert.match(await pg.innerText('#sblihiddenppl'), /2 brands had people LinkedIn hid/);
      assert.match(await pg.innerText('#sblidid'), /· 1 hidden/);
      await pg.close();
    }
    ok('a run finds a missing page by search, reads each brand, saves by brandId and finishes');
    ok('the run sends each brand\'s "LinkedIn Member" headlines with its visit and says so at the end');

    // 9b. Brands with no marketing / partnerships person on file go first
    // (the dashboard's liList puts them right after the Schedule's): the
    // setup panel says so, and the run says why the brand is next.
    {
      fillItems = [
        { brandId: 'b-ld', name: 'Liquid Death', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death/', contacts: 3, focus: false, noBuyer: true },
      ];
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblifillstart');
      assert.match(await pg.textContent('#sbligapnote'), /^First the 1 brand with no marketing \/ partnerships person on file yet — so every brand gets one\./);
      assert.match(await pg.textContent('#sbli-panel'), /None match “electrolyte”/);
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => /Liquid Death — no marketing \/ partnerships person on file yet/.test((document.getElementById('sblinow') || {}).textContent || ''), null, { timeout: 15000 });
      assert.match(await pg.textContent('#sbligap'), /^First, brands with no marketing \/ partnerships person yet: [01] of 1 done/);
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      await pg.close();
    }
    ok('brands with no marketing / partnerships person go first; the panel says so and why each is next');

    // 9b. Clicks don't stop it; the Pause button does; leaving the page waits.
    {
      fillItems = [{ brandId: 'b-slow', name: 'Slow Brand', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/slow-brand/', contacts: 0, focus: false }];
      const startRun = async (pg) => {
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
      };
      const finished = (pg) => pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });

      // A click (and a scroll) on the page: it just carries on.
      let before = sent.length;
      let pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await startRun(pg);
      await pg.mouse.click(700, 300);
      await pg.mouse.wheel(0, 200);
      await finished(pg);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 3, 'a click didn\'t stop it');
      assert.match(await pg.textContent('#sbli-panel'), /What it did/);
      assert.match(await pg.textContent('#sblidid'), /Slow Brand — 2 added/);
      await pg.close();

      // Its Pause button pauses it; Continue carries on.
      before = sent.length;
      pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await startRun(pg);
      await pg.click('#sblifillpause');
      await pg.waitForFunction(() => /Paused: you paused it/.test(document.getElementById('sbli-panel').innerText));
      await pg.waitForTimeout(4000);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 0, 'nothing saved while paused');
      await pg.click('#sblifillgo');
      await finished(pg);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 3);
      await pg.close();

      // Leo takes the window to another page mid-read: that read is
      // dropped, the run waits while he's busy there, then goes back.
      before = sent.length;
      pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await startRun(pg);
      await pg.mouse.click(700, 300);
      await pg.goto('http://127.0.0.1:4622/company/liquid-death/');
      await pg.waitForFunction(() => /You.re using this window/.test((document.getElementById('sbli-panel') || {}).innerText || ''), null, { timeout: 15000 });
      assert.match(pg.url(), /liquid-death\/$/, 'it left Leo where he was');
      await pg.waitForURL(/slow-brand\/people/, { timeout: 20000 });
      await finished(pg);
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 3, 'read once, on the right page');
      assert.ok(sent.slice(before).filter(b => b.action === 'liCapture').every(b => /slow-brand/.test(b.companyUrl)));
      await pg.close();
    }
    ok('clicks don\'t stop the run; Pause does; if Leo takes the window elsewhere it waits, then goes back');

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
      assert.equal(await pg.inputValue('#sbliwords'), '', 'keyword search off by default');
      await pg.fill('#sbliwords', 'electrolyte');
      await pg.uncheck('#sbliresearch');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      const run = sent.slice(before).map(b => b.action + (b.brandId ? ':' + b.brandId : '') + (b.action === 'liDiscover' ? ':' + b.source + ':' + b.from : ''));
      assert.deepEqual(run, [
        'liList',
        'liDiscover:search:electrolyte',
        'liCapture:b-liv', 'liCapture:b-liv', 'liCapture:b-liv', 'liDiscover:lookalike:Liquid I.V.', 'liSwept:b-liv',
        'liCapture:b-ca', 'liCapture:b-ca', 'liCapture:b-ca', 'liDiscover:lookalike:Clase Azul', 'liSwept:b-ca',
        'liCapture:b-jc', 'liCapture:b-jc', 'liCapture:b-jc', 'liSwept:b-jc',
      ]);
      assert.deepEqual(homeVisits, [], 'no stop at a company home page');
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
      // A brand whose page showed lookalikes still logs what it added
      // (the end-to-end run found it logging 0 and the total short).
      const swept = sent.slice(before).filter(b => b.action === 'liSwept').map(b => [b.brandId, b.added]);
      assert.deepEqual(swept, [['b-liv', 2], ['b-ca', 2], ['b-jc', 2]]);
      assert.match(await pg.textContent('#sbli-panel'), /6 people added across 3 brands/);
      await pg.close();
    }
    ok('finds new brands by search and by lookalikes, and reads their people in the same run');

    // 11. The research list.
    {
      fillItems = [
        { research: true, name: 'Powerade', aka: null, category: 'beverage', lane: 'Electrolytes & hydration', linkedinUrl: null, contacts: 0, focus: true },
        { research: true, name: 'NOS Energy', aka: 'NOS', category: 'beverage', lane: 'Energy drinks', linkedinUrl: null, contacts: 0, focus: false },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      assert.equal(await pg.isChecked('#sbliresearch'), true, 'research list on by default');
      await pg.uncheck('#sblilook');
      await pg.click('#sblifilllook');
      await pg.waitForSelector('#sblifillstart');
      assert.match(await pg.textContent('#sbli-panel'), /2 names from the research list/);
      const listCall = sent.slice(before).find(b => b.action === 'liList');
      assert.equal(listCall.research, true);
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      const run = sent.slice(before).map(b => b.action + (b.brandId ? ':' + b.brandId : '') + (b.action === 'liResearch' ? ':' + b.name + (b.final ? ':final' : '') : ''));
      assert.deepEqual(run, [
        'liList',
        'liResearch:Powerade:final', 'liCapture:b-pow', 'liCapture:b-pow', 'liCapture:b-pow', 'liSwept:b-pow',
        // A name that never became a brand still goes in the run's report
        // (no brandId, so it rests nothing).
        'liResearch:NOS Energy', 'liResearch:NOS Energy:final', 'liSwept',
      ]);
      const nos = sent.slice(before).filter(b => b.action === 'liSwept').pop();
      assert.equal(nos.brandId, null); assert.equal(nos.name, 'NOS Energy'); assert.match(nos.note, /no clear LinkedIn page/);
      // A name that became a brand keeps its clock (1.21 sent none, so the
      // report's minutes-a-brand were blank for every research brand).
      const pow = sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-pow');
      assert.equal(typeof pow.ms, 'number'); assert.ok(pow.ms > 0, 'Powerade took some time');
      const text = await pg.textContent('#sbli-panel');
      assert.match(text, /1 new brand added/);
      assert.match(text, /NOS Energy — research list: no clear LinkedIn page/);
      await pg.close();
    }
    ok('the research list: a clear match becomes a brand and gets its people; a telecom called NOS doesn\'t');

    // 12. The real card shapes.
    {
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/company/supergoop/people/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.click('#sblipill');
      await pg.waitForSelector('#sbliadd', { timeout: 20000 });
      const rows = sent.slice(before).find(b => b.action === 'liPreview').rows;
      assert.deepEqual(rows.map(r => [r.name, r.headline]), [
        ['Holly Thaggard', 'Founder and Chief Executive Officer at Supergoop!'],
        ['Caitlin Feroleto', 'Senior Director, Brand Marketing'],
        ['Judy Lee', 'Software Engineer at Supergoop!'],
      ]);
      assert.ok(sent.slice(before).every(b => b.reader === 2), 'every call names its reader');
      const hv = sent.slice(before).find(b => b.action === 'liPreview').hidden;
      assert.ok(hv.length >= 1);
      assert.deepEqual(hv[0].heads, ['Head of Partnerships at Supergoop!', ''], 'a badge on the hidden name line is not the headline');
      await pg.click('text=Copy a sample for Claude');
      await pg.waitForFunction(() => /Copied/.test(document.getElementById('sbli-panel').innerText));
      const clip = await pg.evaluate(() => window.__sbClip);
      assert.match(clip, /card 1 read as \{"name":"Holly Thaggard","headline":"Founder and Chief Executive Officer at Supergoop!"\}/);
      assert.ok(!/<img [^>]/.test(clip), 'images stripped from the sample');
      await pg.close();
    }
    ok('LinkedIn\'s real cards: bullet badges stripped, every headline read (hidden ones too); the sample copies for Claude');

    // 12b. Nobody new by hand, but LinkedIn hid someone: the button still
    // saves, so the hidden people reach Zach's list under the brand Leo saw.
    {
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/company/all-known/people/?keywords=marketing');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.click('#sblipill');
      await pg.waitForSelector('#sbliadd', { timeout: 20000 });
      assert.match(await pg.textContent('#sbliadd'), /Nobody new — save the 1 hidden for Zach/);
      await pg.click('#sbliadd');
      await pg.waitForFunction(() => /Saved/.test(document.getElementById('sbli-panel').innerText));
      const cap = sent.slice(before).find(b => b.action === 'liCapture');
      assert.deepEqual(cap.hidden.map(v => [v.q, v.heads]), [['marketing', ['Head of Events']]]);
      await pg.close();
    }
    ok('nobody new by hand: the button still sends the hidden people for Zach\'s list');

    // 13. One click from the dashboard.
    {
      fillItems = [{ brandId: 'b-ld', name: 'Liquid Death', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death/', contacts: 3, focus: false }];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/#sb-fill');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      const list = sent.slice(before).find(b => b.action === 'liList');
      assert.equal(list.research, true); assert.equal(list.focus, 'electrolyte');
      assert.ok(sent.slice(before).some(b => b.action === 'liCapture' && b.brandId === 'b-ld'));
      await pg.close();
    }
    ok('#sb-fill from the dashboard starts the run by itself, though the feed wipes the mark');

    // A run left behind by a closed tab (no heartbeat) is replaced.
    const seedJob = (touchedAt) => `
      if (!sessionStorage.getItem('__seededJob')) {
        sessionStorage.setItem('__seededJob', '1');
        sessionStorage.setItem('__gm:sbLiFill', JSON.stringify({ id: 'old', owner: 'some-other-tab', items: [{ brandId: 'x', name: 'Old Brand' }], at: 0, results: [], added: 0, doneToday: 0, touchedAt: ${touchedAt} }));
      }`;
    {
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + seedJob('null') + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/#sb-fill');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      assert.ok(sent.slice(before).some(b => b.action === 'liList'), 'a fresh run started');
      await pg.close();
    }
    ok('a run left behind by a closed tab doesn\'t block the button');

    // A live run in another tab is shown, not doubled.
    {
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + seedJob('Date.now()') + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/#sb-fill');
      await pg.waitForFunction(() => /A run is going in another tab/.test(((document.getElementById('sbli-panel') || {}).innerText) || ''), null, { timeout: 20000 });
      await pg.waitForTimeout(1500);
      assert.equal(sent.slice(before).filter(b => b.action === 'liList').length, 0, 'no second run');
      await pg.close();
    }
    ok('a live run in another tab is shown, not doubled');

    // 14. The dashboard names a newer version.
    {
      latestVersion = '99.0';
      const asks = versionAsks.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.waitForFunction(() => /update/.test((document.getElementById('sblipill') || {}).textContent || ''), null, { timeout: 10000 });
      assert.equal(versionAsks.length, asks + 1, 'asked the dashboard once');
      assert.match(await pg.getAttribute('#sblipill', 'title'), /99\.0 is out/);
      await pg.click('#sblipill');
      await pg.waitForSelector('#sbliupdate');
      assert.match(await pg.getAttribute('#sbliupdate a', 'href'), /raw\.githubusercontent\.com\/.+\/linkedin-capture\.user\.js$/);
      await pg.goto('http://127.0.0.1:4622/company/liquid-death/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      await pg.waitForTimeout(500);
      assert.equal(versionAsks.length, asks + 1, 'not asked again within 6 hours');
      await pg.close();
      // The dashboard naming this same version: nothing changes.
      latestVersion = SCRIPT.match(/@version\s+(\S+)/)[1];
      const pg2 = await browser.newPage();
      await pg2.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg2.goto('http://127.0.0.1:4622/feed/');
      await pg2.waitForSelector('#sblipill', { state: 'visible' });
      await pg2.waitForFunction(n => window.sessionStorage.getItem('__gm:sbLiLatest'), null, { timeout: 5000 });
      assert.equal(await pg2.textContent('#sblipill'), 'SB ⬇ People');
      await pg2.close();
      latestVersion = null;
    }
    ok('a newer version turns the pill orange and links to the update; asked at most every 6 h');

    // 15. The run's report.
    {
      fillItems = [{ brandId: 'b-blank', name: 'Blank Cards', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/blank-cards/', contacts: 0, focus: false }];
      const before = sent.length, ev0 = runEvents.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      await pg.waitForTimeout(300);
      const evs = runEvents.slice(ev0);
      assert.deepEqual(evs.map(e => e.kind), ['start', 'finish']);
      assert.equal(evs[0].items, 1); assert.equal(evs[0].script, evs[1].script);
      assert.equal(evs[1].stopped, false);
      const swept = sent.slice(before).find(b => b.action === 'liSwept');
      assert.equal(swept.run, evs[0].run, 'the visit names its run');
      assert.equal(swept.brandId, 'b-blank'); assert.equal(swept.name, 'Blank Cards');
      assert.match(swept.problem, /every title came out blank \(3 people\)/);
      assert.match(swept.sample, /card 1 read as \{"name":"Brand Manager","headline":""\}/);
      assert.match(swept.sample, /\/in\/q1\//);
      assert.ok(swept.sample.length < 6500, 'the sample stays small');
      await pg.close();
    }
    ok('the run reports its start, end and every brand; unreadable cards come with a sample');

    // 16. The run's own window, hidden for a while, then back.
    {
      fillItems = [{ brandId: 'b-slow', name: 'Slow Brand', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/slow-brand/', contacts: 0, focus: false }];
      const before = sent.length, ev0 = runEvents.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.waitForSelector('#sblipill', { state: 'visible' });
      // The dashboard's button again, on a window already at the feed.
      await pg.evaluate(() => { location.hash = '#sb-fill'; });
      await pg.waitForURL(/\/company\/slow-brand\/people\//, { timeout: 20000 });
      const setHidden = (v) => pg.evaluate((hidden) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, v);
      await setHidden(true);
      await pg.waitForTimeout(1300);
      await setHidden(false);
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      await pg.waitForTimeout(300);
      assert.ok(sent.slice(before).some(b => b.action === 'liList'), 'the #mark on a loaded page started the run');
      const swept = sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-slow');
      assert.ok(swept.hiddenMs >= 1200 && swept.hiddenMs < 5000, 'hidden time counted: ' + swept.hiddenMs);
      assert.ok(swept.ms >= swept.hiddenMs, 'the brand\'s time includes it');
      const fin = runEvents.slice(ev0).find(e => e.kind === 'finish');
      assert.ok(fin.hiddenMs >= 1200, 'the run\'s end carries it too');
      await pg.close();
    }
    ok('hidden time goes into the report; #sb-fill on a loaded page starts the run');

    // 17. Leo's LinkedIn only.
    {
      fillItems = [{ brandId: 'b-ld', name: 'Liquid Death', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death/', contacts: 3, focus: false }];
      const cookie = 'document.cookie = "JSESSIONID=\\"ajax:123\\"; path=/";';
      signedIn = { first: 'Leo', last: 'Z', slug: 'leo-z' };
      let before = sent.length;
      let pg = await browser.newPage();
      await pg.addInitScript(cookie + '\n' + GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/#sb-fill');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      const calls = sent.slice(before);
      assert.ok(calls.length && calls.every(b => b.me && b.me.slug === 'leo-z' && b.me.name === 'Leo Z'), 'every call says who\'s signed in');
      await pg.close();

      signedIn = { first: 'Zach', last: 'Q', slug: 'zach-q' };
      before = sent.length;
      pg = await browser.newPage();
      await pg.addInitScript(cookie + '\n' + GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/#sb-fill');
      await pg.waitForFunction(() => /isn.t the LinkedIn account the fill runs on/.test((document.getElementById('sbli-panel') || {}).innerText || ''), null, { timeout: 20000 });
      assert.equal(sent.slice(before).filter(b => b.action === 'liCapture').length, 0);
      assert.match(pg.url(), /\/feed\//, 'went nowhere');
      await pg.close();
      signedIn = null;
    }
    ok('every call says whose LinkedIn it is; another account is turned away before anything runs');

    // 18. A saved page that's another company's.
    {
      fillItems = [{ brandId: 'b-nat', name: 'Native', aka: null, category: 'beauty', linkedinUrl: 'https://www.linkedin.com/company/native-co./', contacts: 0, focus: false, planned: '2026-09-30' }];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => /Native — on the Schedule for/.test((document.getElementById('sblinow') || {}).textContent || ''), null, { timeout: 15000 });
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 60000 });
      const run = sent.slice(before).filter(b => /^li(Capture|Matched|Swept)$/.test(b.action)).map(b => b.action + (b.checkPage ? ':checkPage' : '') + (b.recheck ? ':recheck' : ''));
      assert.deepEqual(run, ['liCapture:checkPage', 'liMatched:recheck', 'liSwept']);
      const cap = sent.slice(before).find(b => b.action === 'liCapture');
      assert.equal(cap.companyIndustry, 'Individual and Family Services');
      const swept = sent.slice(before).find(b => b.action === 'liSwept');
      assert.match(swept.note, /looks like another company — pick the right one on Outreach → People/);
      assert.ok(!('hidden' in swept), 'hidden people on another company\'s page are never sent');
      assert.match(await pg.textContent('#sblidid'), /Native — its saved LinkedIn page looks like another company/);
      await pg.close();
    }
    ok('a saved page that\'s another company\'s saves nobody and goes on Leo\'s list; the panel says why a brand is next');

    // 19. Big companies (100+ on the People tab): not skipped any more —
    // searched instead (Leo, Sep 30: the skip lost Bang, Tito's, Nike).
    {
      fillItems = [
        { brandId: 'b-big', name: 'Big Co', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/big-co/', contacts: 0, focus: false },
        { brandId: 'b-small', name: 'Small Co', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/small-co/', contacts: 0, focus: false },
        { brandId: 'b-none', name: 'Nobody Co', aka: null, category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/nobody-co/', contacts: 0, focus: false },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      await pg.waitForTimeout(300);
      const run = sent.slice(before).filter(b => /^li(Capture|Swept)$/.test(b.action)).map(b => b.action + ':' + b.brandId + (b.action === 'liCapture' ? ':' + (new URL(b.companyUrl).searchParams.get('keywords') || 'all') : ''));
      // Three targeted views; "marketing" only if those found fewer than three (they found 6).
      assert.deepEqual(run.filter(r => /b-(big|small)/.test(r)), [
        'liCapture:b-big:partnerships', 'liCapture:b-big:sponsorship', 'liCapture:b-big:brand manager', 'liSwept:b-big',
        'liCapture:b-small:all', 'liCapture:b-small:marketing', 'liCapture:b-small:partnerships', 'liSwept:b-small',
      ]);
      // Nobody on the page, hidden or not: its marketing / partnerships views
      // aren't opened (two page loads saved on Leo's free LinkedIn).
      assert.deepEqual(run.filter(r => /b-none/.test(r)), ['liCapture:b-none:all', 'liSwept:b-none']);
      assert.deepEqual(sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-none').hidden, [], 'read, nobody hidden');
      const big = sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-big');
      assert.equal(big.note, '');
      assert.equal(big.members, 12345);
      assert.equal(big.via, 'big company, 12,345 people: searched partnerships, sponsorship, brand manager');
      assert.equal(big.added, 6);
      assert.match(await pg.textContent('#sblidid'), /Big Co — 6 added \(big company, 12,345 people: searched partnerships, sponsorship, brand manager\)/);
      // The whole tab is never read at a big company, so its hidden people
      // come from the three searches only.
      assert.deepEqual(big.hidden.map(v => v.q), ['partnerships', 'sponsorship', 'brand manager']);
      await pg.close();
    }
    ok('a company with 100+ people on LinkedIn gets targeted searches — partnerships, sponsorship, brand manager — not the whole tab');
    ok('a People tab with nobody on it opens no more views, and says nobody was hidden');

    // 20. People under a parent company: a research name with no page of
    // its own becomes a brand and is read on the parent's People tab
    // searched for its name; the parent's page is found once, and the
    // parent's page is never saved on the brand.
    {
      fillItems = [
        { research: true, name: 'Ketel One', aka: null, category: 'spirits', lane: 'Spirits', linkedinUrl: null, contacts: 0, focus: false, parent: { name: 'Diageo', search: 'Diageo', slug: null } },
        { brandId: 'b-cm', name: 'Captain Morgan', aka: null, category: 'spirits', linkedinUrl: 'https://www.linkedin.com/company/empty-co/', contacts: 0, focus: false, parent: { name: 'Diageo', search: 'Diageo', slug: null } },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sblilook');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      await pg.waitForTimeout(300);
      const calls = sent.slice(before).filter(b => /^li(Research|Parent|Capture|Swept)$/.test(b.action));
      const run = calls.map(b => b.action + (b.brandId ? ':' + b.brandId : '') + (b.action === 'liCapture' ? ':' + new URL(b.companyUrl).pathname + '?' + (new URL(b.companyUrl).searchParams.get('keywords') || '') : ''));
      assert.deepEqual(run, [
        'liResearch', 'liParent', 'liCapture:b-ko:/company/diageo/people/?Ketel One', 'liSwept:b-ko',
        // Its own page shows only a "LinkedIn Member" card, so its marketing
        // and partnerships views are read too (their headlines go to Zach).
        'liCapture:b-cm:/company/empty-co/people/?', 'liCapture:b-cm:/company/empty-co/people/?marketing', 'liCapture:b-cm:/company/empty-co/people/?partnerships',
        'liCapture:b-cm:/company/diageo/people/?Captain Morgan', 'liSwept:b-cm',
      ], 'Diageo is found once; Captain Morgan\'s own page (hidden people only), then Diageo');
      const viaParent = calls.filter(b => b.action === 'liCapture' && /diageo/.test(b.companyUrl));
      assert.ok(viaParent.every(b => b.viaParent === true && b.checkPage === false), 'read as the brand\'s people, page not checked or saved');
      assert.deepEqual(viaParent.map(b => b.companyName), ['Ketel One', 'Captain Morgan']);
      const ko = calls.find(b => b.action === 'liSwept' && b.brandId === 'b-ko');
      assert.equal(ko.via, 'via Diageo'); assert.equal(ko.parentTried, true); assert.equal(ko.added, 2);
      // The hidden people on its own page survive the move to Diageo's tab.
      const cmSwept = calls.find(b => b.action === 'liSwept' && b.brandId === 'b-cm');
      assert.deepEqual(cmSwept.hidden.map(v => v.q), ['', 'marketing', 'partnerships', 'Captain Morgan']);
      assert.deepEqual(cmSwept.hidden[0].heads, ['Marketing']);
      assert.match(cmSwept.hidden[3].url, /\/company\/diageo\/people\/\?keywords=Captain(%20|\+)Morgan$/);
      const text = await pg.textContent('#sblidid');
      assert.match(text, /Ketel One — 2 added \(via Diageo\)/);
      assert.match(text, /Captain Morgan — 2 added \(via Diageo\)/);
      await pg.close();
    }
    ok('brands under a parent company are read on the parent\'s People tab, searched for their name');

    // 21. A parent the search can't place: the note names what LinkedIn
    // showed, and the brand isn't marked as tried, so the next run retries.
    {
      fillItems = [
        { brandId: 'b-rg', name: 'Reign', aka: null, category: 'energy', linkedinUrl: 'https://www.linkedin.com/company/empty-co/', contacts: 0, focus: false, parent: { name: 'Monster Beverage', search: 'Monster Beverage Corporation', slug: null } },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      await pg.waitForTimeout(300);
      const sw = sent.slice(before).find(b => b.action === 'liSwept' && b.brandId === 'b-rg');
      assert.match(sw.note, /could not find Monster Beverage on LinkedIn \(LinkedIn showed: Monster Energy\)/);
      assert.equal(sw.parentTried, false, 'not tried: the next run looks again');
      await pg.close();
    }
    ok('a parent page the search can\'t place names what LinkedIn showed and is retried');

    // 22. Brands Leo marked "None of these" (no LinkedIn page): never
    // searched under their own name again — one with a parent goes
    // straight to the parent's People tab, one without is done at once;
    // one marked after the run fetched its list is searched once, and the
    // run moves on without trying its other name.
    {
      fillItems = [
        { brandId: 'b-np', name: 'Bulleit', aka: null, category: 'spirits', linkedinUrl: null, noPage: true, contacts: 0, focus: false, parent: { name: 'Diageo', search: 'Diageo', slug: 'diageo' } },
        { brandId: 'b-nn', name: 'Arnold Palmer Spiked', aka: null, category: 'rtd', linkedinUrl: null, noPage: true, contacts: 0, focus: false, parent: null },
        { brandId: 'b-mn', name: 'ALP', aka: 'ALP Pouches', category: 'nicotine', linkedinUrl: null, contacts: 0, focus: false, parent: null },
      ];
      const before = sent.length;
      const pg = await browser.newPage();
      await pg.addInitScript(GM_SHIM + '\n' + SCRIPT);
      await pg.goto('http://127.0.0.1:4622/feed/');
      await pg.click('#sblipill');
      await pg.click('#sblifillopen');
      await pg.uncheck('#sbliresearch');
      await pg.uncheck('#sblilook');
      await pg.fill('#sblifocus', '');
      await pg.click('#sblifilllook');
      await pg.click('#sblifillstart');
      await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished/.test(p.innerText); }, null, { timeout: 90000 });
      await pg.waitForTimeout(300);
      const calls = sent.slice(before).filter(b => /^li(Matched|Capture|Swept)$/.test(b.action));
      const run = calls.map(b => b.action + ':' + b.brandId + (b.action === 'liCapture' ? ':' + new URL(b.companyUrl).pathname : ''));
      assert.deepEqual(run, [
        'liCapture:b-np:/company/diageo/people/', 'liSwept:b-np',
        'liSwept:b-nn',
        'liMatched:b-mn', 'liSwept:b-mn',
      ], 'no own-name search for the marked brands; the late one searched once, its other name never');
      const nn = calls.find(b => b.action === 'liSwept' && b.brandId === 'b-nn');
      assert.ok(!('hidden' in nn), 'no page read: nothing said about hidden people');
      assert.match(nn.note, /marked it as having no LinkedIn page/);
      const mn = calls.find(b => b.action === 'liSwept' && b.brandId === 'b-mn');
      assert.match(mn.note, /marked it as having no LinkedIn page/);
      await pg.close();
    }
    ok('brands marked "None of these" aren\'t searched again: parent\'s page only, or skipped');

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
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
