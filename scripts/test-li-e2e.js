// scripts/test-li-e2e.js — the LinkedIn fill for real, minus LinkedIn.
//
// The real userscript in Chromium, talking to the real /api/ingest on a
// local `next dev`, backed by a real (throwaway) Postgres; only LinkedIn
// is fake, built the way its pages looked in Sep 2026 (bullet badges, no
// subtitle class, same-origin frames, a feed that wipes #sb-fill).
// test-li-script.js checks the script against a fake dashboard; this
// checks that what the script sends is what the dashboard saves. It found
// two bugs the other tests couldn't (Sep 2026): a lookalike called
// "Waterloo Sparkling Water" came back as a new brand though the roster
// had Waterloo, and a brand with lookalikes logged 0 people added.
//
// Started from the dashboard's button (#sb-fill), with its defaults
// (electrolyte first, research list and lookalikes on), the run must:
//   · research Huel (asked for by name) and Powerade: create each, filed
//     under its lane, and read its people;
//   · read Liquid Death's people, and send Hoplark from its lookalikes to
//     Discover for review (1.38: never a brand by itself, never read) —
//     not Waterloo Sparkling Water (Waterloo is on the roster, archived),
//     not an 812-follower seltzer, not an ad agency;
//   · find Olipop's page by search and save it;
//   · save buyers only, with clean names and titles, each in the queue;
//   · report the run — and Blank Cards, whose cards the reader gets
//     wrong, with a sample — readable at /api/reports/linkedin;
//   · leave a second run only Blank Cards (a misread page is an issue —
//     read again first); everything else rests.
//
// Then the logging-only script for Zach's LinkedIn (linkedin-log.user.js)
// on someone's profile: "They accepted" for someone new lands them under
// their brand, accepted with no invite date and out of every queue; Undo
// takes them off again; "Invite sent" for someone the run just queued
// dates it now.
//
// Needs a throwaway LOCAL Postgres — it is wiped:
//   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-li-e2e.js
// (If playwright is only installed globally: NODE_PATH=$(npm root -g) …)
// ~1–2 min, most of it `next dev` compiling the route.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-li-e2e.js');
  process.exit(1);
}
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.error('This test needs playwright. Run:  npm i --no-save playwright'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3457);
const LI_PORT = 4641;
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'e2e-ingest-token';
const REPORT_TOKEN = 'e2e-report-token-0123456789abcdef';
// Lets the test call the dashboard's own handlers (/api/data) like the page does.
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

const SCRIPT = fs.readFileSync(path.join(__dirname, 'linkedin-capture.user.js'), 'utf8')
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'" + BASE + "/api/ingest'")
  .replace(/function rand\(a, b\) \{[^}]*\}/, 'function rand() { return 30; }');
assert.ok(SCRIPT.includes(BASE + '/api/ingest'), 'ingest address swapped in');
const VERSION = SCRIPT.match(/@version\s+(\S+)/)[1];
const LOG_SCRIPT = fs.readFileSync(path.join(__dirname, 'linkedin-log.user.js'), 'utf8')
  .replace("'https://sb-digitaldashboard.vercel.app/api/ingest'", "'" + BASE + "/api/ingest'");
assert.ok(LOG_SCRIPT.includes(BASE + '/api/ingest'), 'ingest address swapped into the log script');

// ---- fake LinkedIn -------------------------------------------------
const person = (slug, name, badge, headline) =>
  '<li><section><a href="https://www.linkedin.com/in/' + slug + '/"><img alt=""></a>' +
  '<div class="artdeco-entity-lockup__title"><a href="https://www.linkedin.com/in/' + slug + '/">' + name + '</a> <span>' + badge + '</span></div>' +
  '<div>' + headline + '</div><div>4 mutual connections</div><button>Connect</button></section></li>';
const MEMBER = '<li><section><div>LinkedIn Member</div><div>Marketing</div></section></li>';
const STAFF = {
  huel: [['jf-huel', 'Julian Hearn', 'Founder at Huel'], ['am-huel', 'Amy Marsh 🌱', 'Head of Brand Partnerships, US'], ['dk-huel', 'Dev Kapoor', 'Senior Software Engineer'], ['sr-huel', 'Sara Ruiz', 'Field Marketing Manager'], ['tb-huel', 'Tom Bell', 'Financial Accountant']],
  powerade: [['kc-pow', 'Kara Cole', 'Brand Director, Powerade'], ['lm-pow', 'Luis Mora', 'Sports Marketing Manager'], ['jn-pow', 'Jen Ng', 'Supply Chain Analyst'], ['rb-pow', 'Rob Baines', 'Warehouse Associate']],
  'liquid-death': [['mc-ld', 'Mike Cessario', 'Co-Founder & CEO at Liquid Death'], ['ea-ld', 'Erin Alvarez', 'Director of Experiential Marketing'], ['pk-ld', 'Pat Kim', 'Software Engineer at Liquid Death'], ['hs-ld', 'Hana Sato', 'Senior Manager, Partnerships'], ['bw-ld', 'Ben Wu', 'Brand Ambassador']],
  drinkolipop: [['bg-oli', 'Ben Goodwin', 'Co-Founder and CEO'], ['ml-oli', 'Mia Lopez', 'Associate Brand Manager'], ['cd-oli', 'Chris Dunn', 'Data Analyst']],
  hoplark: [['dt-hop', 'Dean Thomas', 'Founder & CEO, Hoplark'], ['ar-hop', 'Ana Reyes', 'Marketing Coordinator'], ['jj-hop', 'Jo Jones', 'Brewer']],
};
const TITLE = { huel: 'Huel', powerade: 'Powerade', 'liquid-death': 'Liquid Death', drinkolipop: 'OLIPOP', hoplark: 'Hoplark' };
const rail = (cos) => '<aside><section><h2><span>Pages people also viewed</span></h2><ul>' +
  cos.map(([slug, name, ind, fol]) => '<li><a href="https://www.linkedin.com/company/' + slug + '/"><img alt=""></a>' +
    '<a href="https://www.linkedin.com/company/' + slug + '/"><span>' + name + '</span></a><div>' + ind + '</div><div>' + fol + ' followers</div><button>Follow</button></li>').join('') +
  '</ul></section></aside>';
function peoplePage(slug) {
  const ppl = STAFF[slug].map((p, i) => person(p[0], p[1], i % 2 ? '• 3rd+' : '· 2nd', p[2]));
  const first = ppl.slice(0, 3).concat([MEMBER]).join(''), more = ppl.slice(3).join('');
  const extra = slug === 'liquid-death' ? rail([
    ['hoplark', 'Hoplark', 'Beverage Manufacturing', '12,408'],
    ['tiny-seltzer', 'Tiny Seltzer', 'Beverage Manufacturing', '812'],
    ['loud-agency', 'Loud Agency', 'Advertising Services', '40K'],
    ['waterloo-sparkling-water', 'Waterloo Sparkling Water', 'Beverage Manufacturing', '30K'],
  ]) : '';
  return '<!doctype html><html><head><title>' + TITLE[slug] + ': People | LinkedIn</title></head><body>' +
    '<header><a href="https://www.linkedin.com/in/leo-self/">Me</a></header>' +
    '<iframe src="/company/frame-probe/" style="width:10px;height:10px;border:0"></iframe>' +
    '<main><h1 class="org-top-card-summary__title">' + TITLE[slug] + '</h1>' + extra +
    '<div style="height:1200px">associated members</div><ul id="grid">' + first + '</ul>' +
    (more ? '<button onclick="document.getElementById(\'grid\').insertAdjacentHTML(\'beforeend\', window.__M); this.remove()">Show more results</button><script>window.__M=' + JSON.stringify(more) + '</script>' : '') +
    '</main></body></html>';
}
const SEARCH = {
  Huel: [['huel', 'Huel', 'Food and Beverage Manufacturing • London', '250K']],
  Powerade: [['powerade', 'Powerade', 'Beverage Manufacturing • Atlanta, GA', '150K'], ['powerade-events', 'Powerade Events Co', 'Events Services', '300']],
  Olipop: [['drinkolipop', 'OLIPOP', 'Beverage Manufacturing • Oakland, CA', '180K'], ['olipop-studio', 'Olipop Studio', 'Design Services', '90']],
  Native: [['native-co.', 'Native', 'Individual and Family Services • Phoenix, AZ', '1K'], ['native-cos', 'Native', 'Personal Care Product Manufacturing • San Francisco', '60K']],
  // Tanqueray has no page of its own; its people are at Diageo.
  Diageo: [['diageo-bar-academy', 'Diageo Bar Academy', 'Education', '20K'], ['diageo', 'Diageo', 'Beverage Manufacturing • London', '2M']],
};
// A profile: name in the <h1>, pronouns and badge on their own line,
// the headline, LinkedIn's "Current company" button, the first job.
const PROFILES = {
  'jane-doe-4b21a': ['Jane Doe', 'Head of Partnerships at Liquid Death', 'Liquid Death'],
  'ea-ld': ['Erin Alvarez', 'Director of Experiential Marketing', 'Liquid Death'],
};
function profilePage(slug) {
  const [name, headline, co] = PROFILES[slug];
  return '<!doctype html><html><head><title>(2) ' + name + ' | LinkedIn</title></head><body>' +
    '<header><a href="https://www.linkedin.com/in/leo-self/">Me</a></header>' +
    '<main><section><div><a href="#"><h1>' + name + '</h1></a></div><span>She/Her</span><span> · 2nd</span>' +
    '<div>' + headline + '</div>' +
    '<ul><li><button aria-label="Current company: ' + co + '. Click to skip to experience card"><span>' + co + '</span></button></li></ul>' +
    '<span>Los Angeles, California</span><button>Message</button><button>More</button></section>' +
    '<section><div id="experience"></div><ul><li><a href="https://www.linkedin.com/company/12345/"><img alt="' + co + ' logo"></a>' +
    '<span>' + headline.split(' at ')[0] + '</span><span>' + co + ' · Full-time</span></li></ul></section></main></body></html>';
}
const visits = [];
const linkedin = http.createServer((req, res) => {
  if (!/favicon|frame-probe/.test(req.url)) visits.push(req.url);
  // LinkedIn's own "who am I": Leo is signed in.
  if (req.url === '/voyager/api/me') {
    if (!/JSESSIONID/.test(req.headers.cookie || '') || !req.headers['csrf-token']) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ plainId: 7, miniProfile: { firstName: 'Leo', lastName: 'Z', publicIdentifier: 'leo-z' } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const m = req.url.match(/^\/company\/([^/?]+)\/people\/?/);
  if (m && STAFF[m[1]]) return res.end(peoplePage(m[1]));
  const pm = req.url.match(/^\/in\/([^/?]+)\/?$/);
  if (pm && PROFILES[pm[1]]) return res.end(profilePage(pm[1]));
  // Cards the reader gets wrong: the profile link holds only a photo.
  if (m && m[1] === 'blank-cards') {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Blank Cards</h1><ul>' +
      ['q1', 'q2', 'q3'].map(q => '<li><section><a href="https://www.linkedin.com/in/' + q + '/"><img alt=""></a><div>Brand Manager</div><button>Connect</button></section></li>').join('') +
      '</ul></main></body></html>');
  }
  // Native the deodorant brand, saved with a home-care agency's page.
  if (m && m[1] === 'native-co.') {
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Native</h1>' +
      '<div class="org-top-card-summary-info-list"><div class="org-top-card-summary-info-list__info-item">Individual and Family Services</div></div><ul>' +
      person('cg-1', 'Carla Gray', '• 3rd+', 'Director of Marketing') + '</ul></main></body></html>');
  }
  // A big brand: 423 on its People tab, so only its targeted views are read.
  if (m && m[1] === 'big-bev') {
    const kw = new URL(req.url, 'http://x').searchParams.get('keywords');
    const who = { partnerships: [['np-bb', 'Nina Park', 'Head of Partnerships']], sponsorship: [['od-bb', 'Omar Diaz', 'Sponsorship Manager']],
      'brand manager': [['lc-bb', 'Lia Chen', 'Senior Brand Manager'], ['sr-bb', 'Sam Roe', 'Software Engineer'], ['mm-bb', 'Max Moss', 'Marketing Major at UCLA']] }[kw] || [['xx-bb', 'Xavi Xu', 'Accountant']];
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Big Bev</h1><h2>423 associated members</h2><ul>' +
      who.map((w, i) => person(w[0], w[1], i % 2 ? '• 3rd+' : '· 2nd', w[2])).join('') + '</ul></main></body></html>');
  }
  // Diageo's People tab searched for a brand of theirs.
  if (m && m[1] === 'diageo') {
    const kw = new URL(req.url, 'http://x').searchParams.get('keywords');
    // Cara works on a sister brand: LinkedIn's keyword search matched her
    // profile, but she isn't Tanqueray's.
    const who = kw === 'Tanqueray' ? [['gl-dg', 'Grace Lin', 'Brand Manager, Tanqueray'], ['ta-dg', 'Tom Ade', 'Data Engineer'], ['cr-dg', 'Cara Reed', 'Senior Brand Manager, Crown Royal']] : [];
    return res.end('<!doctype html><html><body><main><h1 class="org-top-card-summary__title">Diageo</h1><h2>31,402 associated members</h2><ul>' +
      who.map((w, i) => person(w[0], w[1], i % 2 ? '• 3rd+' : '· 2nd', w[2])).join('') + '</ul></main></body></html>');
  }
  const s = req.url.match(/^\/search\/results\/companies\/\?keywords=([^&]+)/);
  if (s) {
    const rows = SEARCH[decodeURIComponent(s[1])] || [];
    return res.end('<!doctype html><html><body><main><ul>' + rows.map(([slug, name, sub, fol]) =>
      '<li><a href="https://www.linkedin.com/company/' + slug + '/"><img alt=""></a><a href="https://www.linkedin.com/company/' + slug + '/"><span>' + name + '</span></a><div>' + sub + '</div><div>' + fol + ' followers</div><button>Follow</button></li>').join('') +
      (rows.length ? '' : '<li>No results found</li>') + '</ul></main></body></html>');
  }
  if (/^\/company\/frame-probe/.test(req.url)) return res.end('<html><body>frame</body></html>');
  res.end('<!doctype html><html><head><script>history.replaceState(null, "", location.pathname)</script></head><body><main><h1>Feed</h1></main></body></html>');
});

const GM_SHIM = `(function () {
  var P = '__gm:';
  if (!sessionStorage.getItem('__gm_seeded')) { sessionStorage.setItem(P + 'sbIngestToken', JSON.stringify(${JSON.stringify(TOKEN)})); sessionStorage.setItem(P + 'sbLiSalesNav', 'false'); sessionStorage.setItem(P + 'sbLiMinFit', '0'); sessionStorage.setItem(P + 'sbLiSkipBig', 'false'); sessionStorage.setItem('__gm_seeded', '1'); }
  window.GM_getValue = function (k, d) { var v = sessionStorage.getItem(P + k); return v == null ? d : JSON.parse(v); };
  window.GM_setValue = function (k, v) { sessionStorage.setItem(P + k, JSON.stringify(v)); };
  window.GM_deleteValue = function (k) { sessionStorage.removeItem(P + k); };
  window.GM_registerMenuCommand = function () {};
  window.GM_setClipboard = function (t) { window.__sbClip = t; };
  // keepalive: like Tampermonkey's own requests (sent by the extension),
  // a call still finishes when the page moves on — the run's sped-up clock
  // navigates 30 ms after a fire-and-forget report, and a cold dev server
  // lost those calls (Huel's visit mark, the run's start).
  window.GM_xmlhttpRequest = function (o) {
    fetch(o.url, { method: o.method, headers: o.headers, body: o.data, keepalive: true })
      .then(function (r) { return r.text().then(function (t) { o.onload({ status: r.status, responseText: t }); }); })
      .catch(function () { o.onerror(); });
  };
})();`;

const ingest = async (body) => {
  const r = await fetch(BASE + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, reader: 2, ...body }) });
  return { status: r.status, j: await r.json().catch(() => null) };
};

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };

(async () => {
  let server = null, browser = null, prisma = null;
  try {
    // A clean database with the dashboard's schema.
    const env = { ...process.env, DATABASE_URL: DB };
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { cwd: ROOT, env, stdio: 'pipe' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });

    // The dashboard, for real.
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, INGEST_TOKEN: TOKEN, REPORT_TOKEN, DASHBOARD_TOKEN, NEXTAUTH_SECRET: 'e2e-only', NEXT_TELEMETRY_DISABLED: '1' },
    });
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    const t0 = Date.now();
    for (;;) {
      try { if ((await ingest({ action: 'liVersion' })).status === 200) break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // The roster: three live brands, Waterloo (archived), and every
    // research-list name except Huel and Powerade already on it.
    await prisma.brand.create({ data: { id: 'b_ld', name: 'Liquid Death', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death/' } });
    await prisma.brand.create({ data: { id: 'b_oli', name: 'Olipop', category: 'beverage' } });
    await prisma.brand.create({ data: { id: 'b_blank', name: 'Blank Cards', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/blank-cards/' } });
    await prisma.brand.create({ data: { name: 'Waterloo', category: 'beverage', passedAt: new Date() } });
    await prisma.brand.create({ data: { id: 'b_nat', name: 'Native', category: 'beauty', linkedinUrl: 'https://www.linkedin.com/company/native-co./' } });
    await prisma.brand.create({ data: { id: 'b_big', name: 'Big Bev', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/big-bev/' } });
    const before = (await ingest({ action: 'liList', focus: 'electrolyte', research: true })).j;
    const onRoster = before.items.filter(i => i.research && !['Huel', 'Powerade', 'Tanqueray'].includes(i.name)).map(i => i.name);
    assert.ok(onRoster.length > 20, 'the research list is long');
    await prisma.brand.createMany({ data: onRoster.map(name => ({ name, category: 'unresolved', passedAt: new Date() })), skipDuplicates: true });
    const list = (await ingest({ action: 'liList', focus: 'electrolyte', research: true })).j;
    // Asked-for names first, then the brands with nobody in marketing /
    // partnerships (all five here — nobody on file yet), then the focus
    // lane's research names, then the rest.
    assert.equal(list.items[0].name, 'Huel', 'asked-for names first');
    assert.deepEqual(list.items.slice(1, 6).map(i => i.name).sort(), ['Big Bev', 'Blank Cards', 'Liquid Death', 'Native', 'Olipop'], 'then the brands with no buyer');
    assert.ok(list.items.slice(1, 6).every(i => i.noBuyer), 'each marked');
    assert.equal(list.noBuyer, 5);
    assert.deepEqual(list.items.slice(6).map(i => i.name), ['Powerade', 'Tanqueray'], 'then the focus lane, then the rest');
    assert.deepEqual(list.items.find(i => i.name === 'Tanqueray').parent, { name: 'Diageo', search: 'Diageo', slug: null }, 'the worklist knows whose page its people are under');
    assert.equal(list.latest, VERSION, 'the dashboard expects this script version');

    // The run, started the way the dashboard's button starts it.
    await new Promise(r => linkedin.listen(LI_PORT, '127.0.0.1', r));
    browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync('/opt/pw-browsers/chromium') ? {} : { executablePath: '/opt/pw-browsers/chromium' });
    const pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', e => errors.push(String(e)));
    await pg.addInitScript('document.cookie = "JSESSIONID=\\"ajax:77\\"; path=/";\n' + GM_SHIM + '\n' + SCRIPT);
    await pg.goto('http://127.0.0.1:' + LI_PORT + '/feed/#sb-fill');
    await pg.waitForFunction(() => { const p = document.getElementById('sbli-panel'); return p && /Run finished|Paused/.test(p.innerText); }, null, { timeout: 240000 });
    const panel = await pg.evaluate(() => document.getElementById('sbli-panel').innerText);
    assert.match(panel, /Run finished/, panel);
    assert.match(panel, /14 people added across 8 brands/);
    assert.match(panel, /Big Bev — 3 added \(big company, 423 people: searched partnerships, sponsorship, brand manager\)/);
    assert.match(panel, /Tanqueray — 1 added \(via Diageo\)/);
    assert.match(panel, /What it did/);
    assert.match(panel, /Native — its saved LinkedIn page looks like another company/);
    assert.match(panel, /3 new brands added/);
    assert.match(panel, /1 similar page sent to Brands → Discover/);
    assert.deepEqual(errors, [], 'no page errors');
    assert.ok(!visits.some(v => /waterloo|tiny-seltzer|loud-agency|hoplark/.test(v)), 'no visits to lookalikes');
    ok('the run started from #sb-fill and finished by itself: 14 people, 8 brands, 3 new, a lookalike for Discover, and a list of what it did');

    // A big brand: its targeted views, not the whole tab (Leo, Sep 30).
    const bigPeople = await prisma.contact.findMany({ where: { brandId: 'b_big' }, select: { name: true, title: true } });
    assert.deepEqual(bigPeople.map(p => p.name + ' — ' + p.title).sort(), ['Lia Chen — Senior Brand Manager', 'Nina Park — Head of Partnerships', 'Omar Diaz — Sponsorship Manager']);
    assert.ok(visits.some(v => /big-bev\/people\/\?keywords=partnerships/.test(v)) && !visits.some(v => /big-bev\/people\/\?keywords=marketing/.test(v)), 'three views; marketing not needed');
    ok('a big brand is searched — partnerships, sponsorship, brand manager — and its buyers saved (not the marketing major)');

    // Tanqueray: no page of its own — a brand now, its people read at Diageo.
    const tq = await prisma.brand.findFirst({ where: { name: 'Tanqueray' }, include: { contacts: true } });
    assert.equal(tq.source, 'research'); assert.equal(tq.category, 'spirits');
    assert.equal(tq.linkedinUrl, null, 'Diageo\'s page is never saved on the brand');
    assert.deepEqual(tq.contacts.map(c => c.name + ' — ' + c.title), ['Grace Lin — Brand Manager']);
    const parentPages = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liParentPages' } })).value);
    assert.equal(parentPages.Diageo, 'diageo', 'the real Diageo page, not the bar academy — and remembered');
    ok('a brand under a parent company: made a brand, its people found on Diageo\'s People tab by its name (not Crown Royal\'s)');

    const brands = await prisma.brand.findMany({ where: { passedAt: null }, include: { contacts: true } });
    const by = Object.fromEntries(brands.map(b => [b.name, b]));
    const people = (name) => by[name].contacts.map(c => c.name + ' — ' + c.title).sort();
    assert.equal(by.Huel.source, 'research'); assert.equal(by.Huel.category, 'wellness');
    assert.equal(by.Huel.linkedinUrl, 'https://www.linkedin.com/company/huel/');
    assert.deepEqual(people('Huel'), ['Amy Marsh — Head of Brand Partnerships, US', 'Julian Hearn — Founder', 'Sara Ruiz — Field Marketing Manager']);
    assert.equal(by.Powerade.source, 'research'); assert.equal(by.Powerade.category, 'electrolytes');
    assert.deepEqual(people('Powerade'), ['Kara Cole — Brand Director', 'Luis Mora — Sports Marketing Manager']);
    ok('research list: Huel and Powerade created under their lanes, buyers read');

    assert.deepEqual(people('Liquid Death'), ['Erin Alvarez — Director of Experiential Marketing', 'Hana Sato — Senior Manager, Partnerships', 'Mike Cessario — Co-Founder & CEO']);
    assert.equal(by.Hoplark, undefined, 'a lookalike is never a brand by itself');
    const hop = await prisma.discoveredBrand.findMany({ where: { name: 'Hoplark' } });
    assert.equal(hop.length, 1);
    assert.deepEqual([hop[0].status, hop[0].query, hop[0].category, hop[0].brandId, hop[0].linkedinUrl],
      ['new', 'LinkedIn: similar to Liquid Death', 'beverage', null, 'https://www.linkedin.com/company/hoplark/']);
    assert.match(hop[0].reason, /Beverage Manufacturing · 12,408 followers/);
    const all = await prisma.brand.findMany({ select: { name: true } });
    for (const bad of ['Waterloo Sparkling Water', 'Tiny Seltzer', 'Loud Agency']) assert.ok(!all.some(b => b.name === bad), bad + ' not added');
    assert.equal(await prisma.discoveredBrand.count({ where: { name: { in: ['Waterloo Sparkling Water', 'Tiny Seltzer', 'Loud Agency'] } } }), 0, 'nor sent to Discover');
    // The same lookalike next to another brand, or once dismissed: no second row.
    const twice = (await ingest({ action: 'liDiscover', source: 'lookalike', from: 'Olipop', fromBrandId: 'b_oli',
      companies: [{ url: 'https://www.linkedin.com/company/hoplark/', name: 'Hoplark', subtitle: 'Beverage Manufacturing • 12,408 followers' }] })).j;
    assert.deepEqual([twice.review.length, twice.waiting, twice.created.length], [0, 1, 0]);
    await prisma.discoveredBrand.update({ where: { id: hop[0].id }, data: { status: 'dismissed' } });
    const dis = (await ingest({ action: 'liDiscover', source: 'lookalike', from: 'Olipop', fromBrandId: 'b_oli',
      companies: [{ url: 'https://www.linkedin.com/company/hoplark/', name: 'Hoplark', subtitle: 'Beverage Manufacturing • 12,408 followers' }] })).j;
    assert.equal(dis.dismissed, 1);
    await prisma.discoveredBrand.update({ where: { id: hop[0].id }, data: { status: 'new' } });
    ok('lookalikes: Hoplark to Discover for review (once); Waterloo Sparkling Water (= Waterloo), a small page and an agency left out');

    assert.equal(by.Olipop.linkedinUrl, 'https://www.linkedin.com/company/drinkolipop/');
    assert.deepEqual(people('Olipop'), ['Ben Goodwin — Co-Founder and CEO', 'Mia Lopez — Associate Brand Manager']);
    ok('Olipop\'s page found by search and saved');

    const contacts = await prisma.contact.findMany({ include: { targets: true } });
    assert.equal(contacts.length, 14);
    assert.ok(contacts.every(c => c.source === 'linkedin' && c.linkedinUrl && c.targets.length === 1), 'each from LinkedIn, with a profile and a place in the queue');
    assert.ok(!contacts.some(c => /[·•🌱]|3rd|2nd/.test(c.name)), 'names clean');
    ok('buyers only, clean names, each one queued');

    const sweep = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value);
    assert.equal(sweep.b_ld.added, 3, 'a brand with lookalikes logs what it added');
    assert.equal(sweep.b_blank.seen, 3); assert.equal(sweep.b_blank.added, 0);
    const research = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liResearchLog' } })).value);
    assert.equal(research.huel.outcome, 'added'); assert.equal(research.powerade.outcome, 'added');
    const next = (await ingest({ action: 'liList', focus: 'electrolyte', research: true })).j;
    assert.deepEqual(next.items.map(i => [i.name, i.retry, i.issue]), [['Blank Cards', true, 'reading']],
      'a second run has only Blank Cards — its cards were misread, so it goes again first');
    assert.equal(sweep.b_blank.issue, 'reading'); assert.equal(sweep.b_blank.tries, 1);
    assert.equal(sweep.b_ld.clean, false, 'a People-tab read (Sales Navigator off) rests a month, never "clean"');
    ok('visit and research logs written; a second run has only the brand that went wrong');

    // People LinkedIn hid from Leo's account (1.30, Leo Oct 7 2026: "i dont
    // want to miss out on people if i do it from my own account"): each
    // brand whose pages showed a "LinkedIn Member" marketer waits on
    // "Read on Zach's LinkedIn", linked to the view to read.
    const hiddenLog = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    const withHidden = { b_ld: 'liquid-death', [by.Huel.id]: 'huel', [by.Powerade.id]: 'powerade', b_oli: 'drinkolipop' };
    assert.deepEqual(Object.keys(hiddenLog).sort(), Object.keys(withHidden).sort(), 'only the brands whose pages showed someone hidden');
    for (const [id, slug] of Object.entries(withHidden)) {
      const e = hiddenLog[id];
      assert.deepEqual({ n: e.n, likely: e.likely, titles: e.titles, by: e.by, q: e.q, url: e.url },
        { n: 1, likely: 1, titles: ['Marketing'], by: 'fill', q: 'marketing', url: 'https://www.linkedin.com/company/' + slug + '/people/?keywords=marketing' }, slug);
    }
    ok('the run counted the "LinkedIn Member" marketer on each brand\'s pages: on Zach\'s list, with the view to read');

    // The report, as the morning check reads it.
    const denied = await fetch(BASE + '/api/reports/linkedin');
    assert.equal(denied.status, 401, 'no token, no report');
    const rep = await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json();
    assert.equal(rep.latest, VERSION);
    const run = rep.runs[0];
    assert.equal(run.status, 'finished'); assert.equal(run.script, VERSION); assert.equal(run.focus, 'electrolyte');
    assert.equal(run.added, 14); assert.equal(run.newBrands, 3); assert.equal(run.review, 1);
    assert.deepEqual(run.brands.map(b => b.name).sort(), ['Big Bev', 'Blank Cards', 'Huel', 'Liquid Death', 'Native', 'Olipop', 'Powerade', 'Tanqueray']);
    assert.deepEqual(rep.issues.map(i => [i.brand, i.issue, i.tries, i.stuck]), [['Blank Cards', 'reading', 1, false]], 'the morning check sees what went wrong');
    assert.equal(run.brands.find(b => b.name === 'Tanqueray').via, 'via Diageo');
    assert.equal(run.brands.find(b => b.name === 'Big Bev').members, 423);
    const ldRun = run.brands.find(b => b.name === 'Liquid Death'), natRun = run.brands.find(b => b.name === 'Native');
    assert.deepEqual([ldRun.hiddenPeople, ldRun.hiddenLikely], [1, 1]);
    assert.deepEqual([run.brands.find(b => b.name === 'Big Bev').hiddenPeople, natRun.hiddenPeople], [0, null], 'Big Bev: read, nobody hidden; Native: its page was another company\'s');
    // The headcount is saved on the brand: 423 is a target (mid-size) brand.
    const bigBev = await prisma.brand.findUnique({ where: { id: 'b_big' } });
    assert.equal(bigBev.liMembers, 423);
    assert.ok(bigBev.liMembersAt instanceof Date);
    ok('the People tab\'s headcount is saved on the brand');
    {
      // The fill's order: best Brand Fit first (Leo, Oct 19 2026) — Brand Fit
      // already gives a mid-size brand more than a big one; size only breaks a tie.
      await prisma.brand.createMany({ data: [
        { id: 'sz_big', name: 'Size Big', category: 'beverage', liMembers: 900 },
        { id: 'sz_small', name: 'Size Small', category: 'beverage', liMembers: 7 },
        { id: 'sz_none', name: 'Size None', category: 'beverage' },
        { id: 'sz_mid', name: 'Size Mid', category: 'beverage', liMembers: 120 },
        { id: 'sz_tier', name: 'Size Tier', category: 'beverage', tier: 'growth' },
      ] });
      const l = (await ingest({ action: 'liList' })).j;
      const sz = l.items.filter(i => /^Size /.test(i.name));
      assert.deepEqual(sz.map(i => i.fit), sz.map(i => i.fit).sort((a, b) => b - a), 'highest score first');
      assert.equal(sz[0].name, 'Size Mid', 'the measured mid-size brand scores best');
      assert.equal(sz[sz.length - 1].name, 'Size Small', 'the small one scores lowest');
      assert.deepEqual(sz.map(i => i.name + ':' + i.size).sort(), ['Size Big:big', 'Size Mid:target', 'Size None:unknown', 'Size Small:small', 'Size Tier:target']);
      assert.equal(l.sizes.target, 2);
      await prisma.brand.deleteMany({ where: { id: { startsWith: 'sz_' } } });
    }
    ok('the fill goes best Brand Fit first; each brand still carries its size');
    {
      // Best Brand Fit first; at the same score a brand with no marketing /
      // partnerships person goes first (other titles don't count).
      await prisma.brand.createMany({ data: [
        { id: 'gp_mid', name: 'Gap Mid', category: 'beverage', liMembers: 120 },
        { id: 'gp_big', name: 'Gap Big', category: 'beverage', liMembers: 900 }, // big, under 1,500 (held back like a giant past it)
        { id: 'gp_has', name: 'Has Buyer Mid', category: 'beverage', liMembers: 120 },
        { id: 'gp_other', name: 'Gap Other Titles', category: 'beverage', liMembers: 120 },
      ] })
      await prisma.contact.createMany({ data: [
        { brandId: 'gp_has', name: 'Bea Buyer', title: 'Brand Manager' },
        { brandId: 'gp_other', name: 'Sam Sales', title: 'Regional Sales Director' },
      ] })
      const l = (await ingest({ action: 'liList' })).j;
      const order = l.items.filter(i => /^(Gap|Has Buyer) /.test(i.name)).map(i => i.name);
      assert.deepEqual(order, ['Gap Mid', 'Gap Other Titles', 'Has Buyer Mid', 'Gap Big'], 'the mid-size three tie on score: no buyer first; the big one scores lower');
      const fitOf = (n) => l.items.find(i => i.name === n).fit;
      assert.ok(fitOf('Gap Mid') === fitOf('Has Buyer Mid') && fitOf('Gap Big') < fitOf('Gap Mid'));
      assert.equal(l.items.find(i => i.name === 'Has Buyer Mid').noBuyer, false);
      assert.equal(l.items.find(i => i.name === 'Gap Other Titles').noBuyer, true);
      await prisma.contact.deleteMany({ where: { brandId: { startsWith: 'gp_' } } });
      await prisma.brand.deleteMany({ where: { id: { startsWith: 'gp_' } } });
    }
    ok('best fit first; at the same score, brands with no marketing / partnerships person go first');
    assert.equal(run.problems, 1);
    assert.equal(run.samples[0].name, 'Blank Cards');
    assert.match(run.samples[0].problem, /every title came out blank/);
    assert.match(run.samples[0].sample, /\/in\/q1\//);
    ok('the run\'s report — Blank Cards\' unreadable cards with a sample — reads back through /api/reports/linkedin');

    // Native: its saved page was a home-care agency's. Nobody saved; it's
    // on "Which LinkedIn page is theirs?" with the right page first.
    const data = async (fn, args) => {
      const r = await fetch(BASE + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN }, body: JSON.stringify({ fn, args: args || {} }) });
      const j = await r.json();
      if (!j.ok) throw new Error(fn + ': ' + (j.error || r.status));
      return j.data;
    };
    assert.equal(await prisma.contact.count({ where: { brandId: 'b_nat' } }), 0, 'nobody from the care agency');
    assert.ok(visits.some(v => /keywords=Native/.test(v)), 'looked Native up again');
    const lp = await data('linkedinPeople');
    const nat = lp.pageReview.find(e => e.brandId === 'b_nat');
    assert.equal(nat.why, 'wrong'); assert.equal(nat.pageIndustry, 'Individual and Family Services');
    assert.equal(nat.saved, 'https://www.linkedin.com/company/native-co./');
    assert.equal(nat.candidates[0].slug, 'native-cos', 'the page that fits first');
    const repNat = (await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json()).pageReview.find(e => e.brand === 'Native');
    assert.equal(repNat.why, 'wrong'); assert.equal(repNat.results[0].name.length > 0, true, 'the report shows the results it saw');
    assert.ok(!JSON.stringify(repNat).includes('slug'), 'company names and industries only');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nat' } })).linkedinUrl, 'https://www.linkedin.com/company/native-co./', 'the run never swaps a saved page itself');
    const picked = await data('liPagePick', { brandId: 'b_nat', url: 'https://www.linkedin.com/company/native-cos/' });
    assert.equal(picked.linkedinUrl, 'https://www.linkedin.com/company/native-cos/');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nat' } })).linkedinUrl, 'https://www.linkedin.com/company/native-cos/');
    assert.ok(!(await data('linkedinPeople')).pageReview.some(e => e.brandId === 'b_nat'), 'off the list');
    const again = (await ingest({ action: 'liList', focus: 'electrolyte', research: true, me: { slug: 'leo-z', name: 'Leo Z' } })).j;
    assert.deepEqual(again.items.map(i => [i.name, i.linkedinUrl]), [['Blank Cards', 'https://www.linkedin.com/company/blank-cards/'], ['Native', 'https://www.linkedin.com/company/native-cos/']],
      'the next run reads it (after Blank Cards, which went wrong and goes first)');
    ok('Native\'s wrong page: nobody saved, on Leo\'s list with the right page first; picking it sends it to the next run');

    // "None of these" (Leo, Oct 2026: a brand marked as having no LinkedIn
    // page is never searched again): off the worklist, or — with a parent
    // company — on it only for the parent's page; a run that fetched its
    // list earlier is told so, and nothing goes back on Leo's list.
    await prisma.brand.create({ data: { id: 'b_alp', name: 'Pouchly', category: 'nicotine' } });
    // A Diageo brand (on the roster already if the research list made it).
    const cptId = (await prisma.brand.upsert({ where: { name: 'Smirnoff Ice' }, update: { linkedinUrl: null, passedAt: null }, create: { name: 'Smirnoff Ice', category: 'spirits' } })).id;
    for (const id of ['b_alp', cptId]) await data('liPageNone', { brandId: id });
    const after = (await ingest({ action: 'liList', ignoreRest: true, me: { slug: 'leo-z', name: 'Leo Z' } })).j;
    assert.ok(!after.items.some(i => i.brandId === 'b_alp'), 'Pouchly off the worklist');
    const cpt = after.items.find(i => i.brandId === cptId);
    assert.ok(cpt && cpt.noPage === true && cpt.parent && cpt.parent.name === 'Diageo', 'Smirnoff Ice only for Diageo\'s page');
    const late = (await ingest({ action: 'liMatched', brandId: 'b_alp', candidates: [{ url: 'https://www.linkedin.com/company/alp-consulting/', name: 'Alp Consulting Ltd.', subtitle: 'Staffing and Recruiting' }], me: { slug: 'leo-z', name: 'Leo Z' } })).j;
    assert.equal(late.outcome, 'markedNone');
    assert.ok(!(await data('linkedinPeople')).pageReview.some(e => e.brandId === 'b_alp'), 'not back on Leo\'s list');
    ok('"None of these" sticks: off the worklist (a parent brand only for the parent\'s page), never back on Leo\'s list');

    // Oct 18 2026: brands came back after "None of these". Each answer read
    // the whole list, cleared one brand and wrote it all back, so answers
    // close together undid each other. Six at once now all stick, the
    // fill can't put one back, and a leftover from before never shows.
    {
      const ids = ['b_nn1', 'b_nn2', 'b_nn3', 'b_nn4', 'b_nn5', 'b_nn6'];
      for (const id of ids) await prisma.brand.create({ data: { id, name: 'Nonesuch ' + id, category: 'energy' } });
      for (const id of ids) await ingest({ action: 'liMatched', brandId: id, candidates: [{ url: 'https://www.linkedin.com/company/' + id + '-a/', name: 'Other ' + id, subtitle: 'Software Development' }], me: { slug: 'leo-z', name: 'Leo Z' } });
      assert.equal((await data('linkedinPeople')).pageReview.filter(e => ids.includes(e.brandId)).length, 6, 'all six on the list');
      await Promise.all(ids.map(id => data('liPageNone', { brandId: id })));
      assert.ok(!(await data('linkedinPeople')).pageReview.some(e => ids.includes(e.brandId)), 'all six off the list');
      const conf = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liPageConfirmed' } })).value);
      assert.deepEqual(ids.map(id => conf[id]), ids.map(() => 'none'), 'every answer kept');
      const rawRev = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liPageReview' } })).value);
      assert.ok(!ids.some(id => rawRev[id]), 'gone from the stored list too');
      // The run reads a page saved on one since (a hand scan) and it looks wrong: not back.
      await prisma.brand.update({ where: { id: 'b_nn1' }, data: { linkedinUrl: 'https://www.linkedin.com/company/b_nn1-a/' } });
      await ingest({ action: 'liCapture', brandId: 'b_nn1', checkPage: true, companyUrl: 'https://www.linkedin.com/company/b_nn1-a/', companyIndustry: 'Software Development', people: [], me: { slug: 'leo-z', name: 'Leo Z' } });
      await ingest({ action: 'liMatched', brandId: 'b_nn1', recheck: true, candidates: [{ url: 'https://www.linkedin.com/company/b_nn1-b/', name: 'Other', subtitle: 'Software Development' }], me: { slug: 'leo-z', name: 'Leo Z' } });
      assert.ok(!(await data('linkedinPeople')).pageReview.some(e => e.brandId === 'b_nn1'), 'the fill never puts it back');
      // A leftover from before the fix: stored, but never shown or counted.
      const rv = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liPageReview' } })).value);
      rv.b_nn2 = { at: new Date().toISOString(), why: 'unclear', saved: null, pageIndustry: null, candidates: [] };
      await prisma.setting.update({ where: { key: 'liPageReview' }, data: { value: JSON.stringify(rv) } });
      assert.ok(!(await data('linkedinPeople')).pageReview.some(e => e.brandId === 'b_nn2'), 'a leftover never shows');
      await prisma.brand.deleteMany({ where: { id: { in: ids } } });
    }
    ok('Six "None of these" at once all stick; the fill and old leftovers never bring one back');

    // Read before the Oct 13 2026 match fix and parked on Leo's list: due again
    // when the saved results now resolve; still unclear → keeps resting.
    {
      const old = '2026-10-12T15:00:00.000Z';
      await prisma.brand.create({ data: { id: 'b_snb', name: 'Sierra Nevada Test', aka: 'Sierra Nevada', category: 'rtd' } });
      // (Not Zone: it's Imperial Brands' now — a brand with a parent is due for the parent's page.)
      await prisma.brand.create({ data: { id: 'b_zon', name: 'Zestie Test', aka: 'Zestie', category: 'energy' } });
      const sweep = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value);
      for (const id of ['b_snb', 'b_zon']) sweep[id] = { at: old, added: 0, v: 2, note: 'no clear LinkedIn page' };
      await prisma.setting.update({ where: { key: 'liSweepLog' }, data: { value: JSON.stringify(sweep) } });
      const rev = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liPageReview' } }))?.value || '{}');
      rev.b_snb = { at: old, why: 'unclear', saved: null, pageIndustry: null, candidates: [
        { slug: 'sierra-nevada-corporation', name: 'Sierra Nevada Corporation', subtitle: 'Defense and Space Manufacturing • 200K followers' },
        { slug: 'sierra-nevada-brewing-co', name: 'Sierra Nevada Brewing Co.', subtitle: 'Food and Beverage Manufacturing • 60K followers' }] };
      rev.b_zon = { at: old, why: 'unclear', saved: null, pageIndustry: null, candidates: [
        { slug: 'zestie-a', name: 'Zestie', subtitle: 'Manufacturing' }, { slug: 'zestie-b', name: 'Zestie', subtitle: 'Manufacturing • 2K followers' }] };
      await prisma.setting.upsert({ where: { key: 'liPageReview' }, update: { value: JSON.stringify(rev) }, create: { key: 'liPageReview', value: JSON.stringify(rev) } });
      const l = (await ingest({ action: 'liList', focus: '', me: { slug: 'leo-z', name: 'Leo Z' } })).j;
      assert.ok(l.items.some(i => i.brandId === 'b_snb'), 'Sierra Nevada back on the worklist');
      assert.ok(!l.items.some(i => i.brandId === 'b_zon'), 'Zestie still resting');
      const m = (await ingest({ action: 'liMatched', brandId: 'b_snb', candidates: rev.b_snb.candidates.map(c => ({ url: 'https://www.linkedin.com/company/' + c.slug + '/', name: c.name, subtitle: c.subtitle })), me: { slug: 'leo-z', name: 'Leo Z' } })).j;
      assert.equal((await prisma.brand.findUnique({ where: { id: 'b_snb' } })).linkedinUrl, 'https://www.linkedin.com/company/sierra-nevada-brewing-co/', JSON.stringify(m));
      await prisma.brand.deleteMany({ where: { id: { in: ['b_snb', 'b_zon'] } } });
    }
    ok('a brand parked before the match fix whose results now resolve is read again (Sierra Nevada Brewing, not the defense firm)');

    // Everything the run did, with the people's names.
    const detail = await data('liRunDetail', { id: run.id });
    const ld = detail.brands.find(b => b.name === 'Liquid Death');
    assert.deepEqual(ld.people.map(p => p.name).sort(), ['Erin Alvarez', 'Hana Sato', 'Mike Cessario']);
    assert.match(detail.brands.find(b => b.name === 'Native').note, /looks like another company/);
    assert.deepEqual(detail.newBrands.map(b => b.name).sort(), ['Huel', 'Powerade', 'Tanqueray']);
    assert.deepEqual(detail.toReview.map(b => [b.name, b.from]), [['Hoplark', 'Liquid Death']], 'lookalikes it sent to Discover');
    assert.equal(detail.brands.find(b => b.name === 'Tanqueray').via, 'via Diageo');
    ok('the full list of what the run did: every brand, the people it added, what it skipped and why');

    // Leo's LinkedIn only: the run remembered his account; Zach's is refused.
    const owner = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liOwner' } })).value);
    assert.deepEqual([owner.slug, owner.name], ['leo-z', 'Leo Z']);
    const zach = await ingest({ action: 'liList', focus: '', me: { slug: 'zach-q', name: 'Zach Q' } });
    assert.equal(zach.status, 403); assert.equal(zach.j.notOwner, true);
    assert.match(zach.j.error, /runs only on Leo Z's/);
    assert.equal((await data('linkedinPeople')).liOwner.slug, 'leo-z');
    ok('the fill runs on Leo\'s LinkedIn only: the first run remembered it, another account is refused');

    // Zach's logging-only script on a profile: They accepted, for someone new.
    const pp = await browser.newPage();
    pp.on('pageerror', e => errors.push(String(e)));
    await pp.addInitScript(GM_SHIM + '\n' + LOG_SCRIPT);
    await pp.goto('http://127.0.0.1:' + LI_PORT + '/in/jane-doe-4b21a/');
    await pp.waitForFunction(() => /Log them/.test((document.getElementById('sblogpill') || {}).textContent || ''));
    await pp.click('#sblogpill');
    await pp.waitForSelector('#sblogacc', { timeout: 60000 });
    assert.match(await pp.evaluate(() => document.getElementById('sblog-panel').innerText), /Goes under Liquid Death/);
    assert.equal(await pp.inputValue('#sblogtitle'), 'Head of Partnerships');
    await pp.click('#sblogacc');
    await pp.waitForFunction(() => /Logged/.test(document.getElementById('sblog-panel').innerText), null, { timeout: 60000 });
    const jane = await prisma.contact.findFirst({ where: { name: 'Jane Doe' }, include: { targets: { include: { events: true } } } });
    assert.deepEqual([jane.brandId, jane.source, jane.linkedinUrl, jane.title], ['b_ld', 'manual', 'https://www.linkedin.com/in/jane-doe-4b21a/', 'Head of Partnerships']);
    const jt = jane.targets[0];
    assert.deepEqual([jt.status, jt.sentAt, jt.queuedFor, jt.shelved], ['accepted', null, null, false]);
    assert.deepEqual(jt.events.map(e => [e.toStatus, e.actor]), [['accepted', 'SB pill']]);
    ok('Zach\'s log script on a profile: They accepted puts someone new under their brand, accepted, no invite date, no queue');

    await pp.click('#sblogundo');
    await pp.waitForFunction(() => /Undone/.test(document.getElementById('sblog-panel').innerText), null, { timeout: 60000 });
    assert.equal(await prisma.contact.count({ where: { name: 'Jane Doe' } }), 0);
    ok('Undo takes them off again');

    // Someone the run just queued: Invite sent, dated now.
    await pp.goto('http://127.0.0.1:' + LI_PORT + '/in/ea-ld/');
    await pp.waitForSelector('#sblogpill', { state: 'visible' });
    await pp.click('#sblogpill');
    await pp.waitForSelector('#sblogsent', { timeout: 60000 });
    assert.match(await pp.evaluate(() => document.getElementById('sblog-panel').innerText), /On file at Liquid Death/);
    await pp.click('#sblogsent');
    await pp.waitForFunction(() => /Logged/.test(document.getElementById('sblog-panel').innerText), null, { timeout: 60000 });
    const erin = await prisma.target.findFirst({ where: { contact: { name: 'Erin Alvarez' } } });
    assert.equal(erin.status, 'sent');
    assert.ok(erin.sentAt && Date.now() - erin.sentAt.getTime() < 120000, 'dated now');
    assert.equal(await prisma.contact.count({ where: { name: 'Erin Alvarez' } }), 1, 'no second copy');
    assert.deepEqual(errors, [], 'no page errors');
    ok('Invite sent for someone on file: dated now, no second copy');

    // Zach's SB · Read people on a brand off "Read on Zach's LinkedIn":
    // everyone readable is on file or not a buyer, so "Nobody new" marks
    // it read — off the list, back with Undo.
    assert.ok((await data('linkedinPeople')).zachList.some(r => r.brandId === 'b_ld'), 'Liquid Death waits on Zach');
    await pp.goto('http://127.0.0.1:' + LI_PORT + '/company/liquid-death/people/?keywords=marketing');
    await pp.waitForFunction(() => (document.getElementById('sblogpill') || {}).textContent === 'SB · Read people');
    await pp.click('#sblogpill');
    await pp.click('#sblogread');
    await pp.waitForSelector('#sblogadd', { timeout: 60000 });
    assert.match(await pp.textContent('#sblogadd'), /Nobody new — mark Liquid Death read/);
    await pp.click('#sblogadd');
    await pp.waitForFunction(() => /marked read/.test(document.getElementById('sblog-panel').innerText), null, { timeout: 60000 });
    let hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    assert.ok(hl.b_ld.zachAt, 'marked read');
    assert.equal(hl.b_ld.zachAdded, 0);
    assert.equal(hl.b_ld.by, 'fill', 'Zach\'s read never rewrites what Leo\'s account saw');
    let zl = await data('linkedinPeople');
    assert.ok(!zl.zachList.some(r => r.brandId === 'b_ld') && zl.zachDone.some(r => r.brandId === 'b_ld'));
    await data('zachRead', { brandId: 'b_ld', undo: true });
    assert.ok((await data('linkedinPeople')).zachList.some(r => r.brandId === 'b_ld'), 'Undo puts it back');
    assert.deepEqual(errors, [], 'no page errors');
    ok('Zach\'s Read people with nobody new marks the brand read: off Zach\'s list (Undo puts it back)');

    // A parent's tab searched for the brand (Diageo's, for Tanqueray) — the
    // link on Zach's list for a brand read via its parent: the read is
    // Tanqueray's, and Diageo's page and headcount are never put on it.
    const dgUrl = 'https://www.linkedin.com/company/diageo/people/?keywords=Tanqueray';
    hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    hl[tq.id] = { at: new Date().toISOString(), by: 'fill', n: 2, likely: 2, titles: ['Brand Manager'], url: dgUrl, q: 'Tanqueray' };
    await prisma.setting.update({ where: { key: 'liHidden' }, data: { value: JSON.stringify(hl) } });
    const dgRows = [
      { name: 'Grace Lin', headline: 'Brand Manager, Tanqueray', linkedinUrl: 'https://www.linkedin.com/in/gl-dg/' },
      { name: 'Cara Reed', headline: 'Senior Brand Manager, Crown Royal', linkedinUrl: 'https://www.linkedin.com/in/cr-dg/' },
    ];
    const pvz = (await ingest({ action: 'liPreview', via: 'log', companyUrl: dgUrl, companyName: 'Diageo', rows: dgRows })).j;
    assert.deepEqual([pvz.brand && pvz.brand.name, pvz.matchedBy], ['Tanqueray', 'keyword']);
    assert.deepEqual(pvz.rows.map(r => r.verdict), ['dupe', 'notBuyer'], 'Grace is on file; Cara works on Crown Royal');
    const cz = (await ingest({ action: 'liCapture', via: 'log', companyUrl: dgUrl, companyName: 'Diageo', members: 31402, rows: dgRows })).j;
    assert.equal(cz.added, 0);
    const tq2 = await prisma.brand.findUnique({ where: { id: tq.id } });
    assert.deepEqual([tq2.linkedinUrl, tq2.liMembers], [null, null], 'Diageo\'s page and headcount stay off Tanqueray');
    hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    assert.ok(hl[tq.id].zachAt, 'Tanqueray marked read');
    ok('Zach reading Diageo\'s tab searched for Tanqueray: Tanqueray\'s read (by the search word), parent page and headcount never saved on it');

    // Leo's own hand read reports what it saw; an older script's visit
    // leaves the list alone; a fill visit that saw nobody hidden clears it.
    const leo = { slug: 'leo-z', name: 'Leo Z' };
    const oliHidden = [{ q: 'partnerships', url: 'https://www.linkedin.com/company/drinkolipop/people/?keywords=partnerships', heads: ['Head of Partnerships', ''] }];
    await ingest({ action: 'liPreview', me: leo, companyUrl: 'https://www.linkedin.com/company/drinkolipop/people/?keywords=partnerships', companyName: 'OLIPOP', rows: [], hidden: oliHidden });
    hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    assert.deepEqual([hl.b_oli.by, hl.b_oli.likely, hl.b_oli.q], ['hand', 2, 'partnerships']);
    await ingest({ action: 'liSwept', me: leo, brandId: 'b_oli', seen: 3, added: 0, note: '' });
    hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    assert.equal(hl.b_oli.by, 'hand', 'a visit with no hidden field (older script) changes nothing');
    await ingest({ action: 'liSwept', me: leo, brandId: 'b_oli', seen: 3, added: 0, note: '', hidden: [] });
    hl = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
    assert.equal(hl.b_oli, undefined, 'a fill visit that saw nobody hidden clears it');
    ok('Leo\'s hand read reports hidden people; an older script\'s visit leaves them; a fill visit with none clears them');

    // Read again only when something went wrong (1.38, Leo, Oct 14 2026):
    // a clean read never comes back; an issue goes first, three runs, then
    // waits a month; a People-tab read from before Sales Navigator whose
    // buyers were hidden comes back once for it. A member-id link keeps its
    // case and still matches duplicates.
    {
      const sn = await prisma.brand.create({ data: { name: 'Sn Retry Co', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/sn-retry-co/' } });
      const listOf = async (salesNav, extra) => (await ingest(Object.assign({ action: 'liList', me: leo, focus: '', salesNav }, extra || {}))).j;
      const itemOf = async (salesNav, extra) => (await listOf(salesNav, extra)).items.find(i => i.brandId === sn.id);
      const setMark = async (m) => {
        const row = await prisma.setting.findUnique({ where: { key: 'liSweepLog' } });
        const log = row ? JSON.parse(row.value) : {};
        log[sn.id] = m;
        await prisma.setting.upsert({ where: { key: 'liSweepLog' }, create: { key: 'liSweepLog', value: JSON.stringify(log) }, update: { value: JSON.stringify(log) } });
      };
      const markOf = async () => JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value)[sn.id];
      // A read from before Sales Navigator (Oct 1) whose buyers were hidden.
      await setMark({ at: '2026-10-01T12:00:00Z', seen: 4, added: 0, note: '', v: 2 });
      await prisma.setting.upsert({ where: { key: 'liHidden' }, create: { key: 'liHidden', value: '{}' }, update: {} });
      const hl0 = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liHidden' } })).value);
      hl0[sn.id] = { at: '2026-10-01T12:00:00Z', by: 'fill', n: 2, likely: 2, titles: ['Brand Manager'], url: null, q: 'marketing' };
      await prisma.setting.update({ where: { key: 'liHidden' }, data: { value: JSON.stringify(hl0) } });
      assert.equal(await itemOf(false), undefined, 'without Sales Navigator it waits');
      const back = await itemOf(true);
      assert.deepEqual([back && back.retry, back && back.issue], [true, 'noSalesNav'], 'back once for Sales Navigator');

      const memberId = 'ACwAAB1c2D3e4F5g6H7i8J9k0LmNoPqRsTuVwXy';
      const cap = await ingest({ action: 'liCapture', me: leo, brandId: sn.id, companyUrl: sn.linkedinUrl, companyName: 'Sn Retry Co', checkPage: false,
        rows: [{ name: 'Nia Named', headline: 'Brand Manager at Sn Retry Co', linkedinUrl: 'https://www.linkedin.com/in/' + memberId + '/' }] });
      assert.equal(cap.j.added, 1);
      const nia = await prisma.contact.findFirst({ where: { brandId: sn.id, name: 'Nia Named' } });
      assert.equal(nia.linkedinUrl, 'https://www.linkedin.com/in/' + memberId + '/', 'the member id keeps its case');
      const dupe = await ingest({ action: 'liCapture', me: leo, brandId: sn.id, companyUrl: sn.linkedinUrl, companyName: 'Sn Retry Co', checkPage: false,
        rows: [{ name: 'Nia Named', headline: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/' + memberId.toLowerCase() + '/' }] });
      assert.equal(dupe.j.added, 0, 'the same person again is a duplicate, whatever the case');

      // An issue: first on the next run (after the Schedule's / asked-for).
      const swept = (run, extra) => ingest(Object.assign({ action: 'liSwept', me: leo, brandId: sn.id, run, name: 'Sn Retry Co', seen: 0, added: 0, note: '', hidden: [], script: VERSION }, extra));
      await swept('r1', { done: false, salesNav: false, issue: 'snNoLoad', issueNote: 'Sales Navigator\'s results did not load', key: 'r1:0:' + sn.id });
      let l = await listOf(true);
      const at = l.items.findIndex(i => i.brandId === sn.id);
      assert.ok(at >= 0 && l.items.slice(0, at).every(i => i.planned || i.asked || i.retry), 'ahead of everything but the Schedule\'s and asked-for names');
      assert.deepEqual([l.items[at].retry, l.items[at].issue, l.items[at].tries, l.items[at].issueText], [true, 'snNoLoad', 1, 'Sales Navigator’s results didn’t load']);
      assert.ok(l.retry >= 1);
      // The same run posting again (the in-run second try, a retried post): one try.
      await swept('r1', { done: false, salesNav: false, issue: 'snNoLoad', again: true, key: 'r1:5:' + sn.id });
      assert.equal((await markOf()).tries, 1);
      await swept('r2', { done: false, issue: 'partial', issueNote: 'read 18 of 25' });
      await swept('r3', { done: false, issue: 'partial', issueNote: 'read 18 of 25' });
      assert.equal((await markOf()).tries, 3);
      assert.equal(await itemOf(true), undefined, 'three runs in a row: it waits a month');
      assert.ok((await listOf(true)).stuck >= 1);
      const rep2 = await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json();
      const iss = rep2.issues.find(x => x.brand === 'Sn Retry Co');
      assert.deepEqual([iss.issue, iss.tries, iss.stuck, iss.note], ['partial', 3, true, 'read 18 of 25']);
      // Clean: never back, even a year on.
      await swept('r4', { done: true, salesNav: true, issue: null, shown: 9, read: 9 });
      const m = await markOf();
      assert.deepEqual([m.clean, m.issue, m.tries, m.shown, m.read, m.sn], [true, null, undefined, 9, 9, true]);
      assert.equal(await itemOf(true), undefined, 'read in full: off the list');
      await setMark({ ...m, at: new Date(Date.now() - 400 * 864e5).toISOString() });
      assert.equal(await itemOf(true), undefined, 'and still off a year later');
      assert.equal(await itemOf(true, { ignoreRest: true }) && true, true, 'only by hand (ignoreRest)');
      // A run with Sales Navigator off reads it: the issue stays (only Sales
      // Navigator clears it), and such runs leave it for a month.
      await swept('r4b', { done: false, salesNav: false, issue: 'snNoLoad' });
      await swept('r4c', { done: false, salesNav: false, issue: null, snOn: false });
      const offMark = await markOf();
      assert.deepEqual([offMark.issue, offMark.tries, offMark.snOff], ['snNoLoad', 1, true]);
      assert.equal(await itemOf(false), undefined, 'a run with it off leaves it');
      assert.equal((await itemOf(true) || {}).retry, true, 'a run with it on reads it first');
      await swept('r4d', { done: true, salesNav: true, issue: null });
      // An older copy (no `done`) that read the People tab with Sales Navigator on: an issue.
      await ingest({ action: 'liSwept', me: leo, brandId: sn.id, seen: 1, added: 0, note: '', snMissed: true, hidden: [] });
      assert.equal((await itemOf(true) || {}).issue, 'noSalesNav');
      // A retried post counts once in the run's report.
      const before = (await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json()).runs.find(x => x.id === 'r1');
      await swept('r1', { done: false, issue: 'snNoLoad', key: 'r1:0:' + sn.id });
      const after = (await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json()).runs.find(x => x.id === 'r1');
      assert.equal(after.brands.length, before.brands.length, 'same key: not counted twice');
      // Skipped at 1,500+: headcount saved — off the list while Skip very big
      // brands is on, back when it's off; the items say who may be read big.
      await swept('r6', { done: false, issue: null, skipped: 'veryBig', members: 2400 });
      assert.equal((await prisma.brand.findUnique({ where: { id: sn.id } })).liMembers, 2400);
      assert.equal(await itemOf(true, { skipGiants: true }), undefined);
      const unskipped = await itemOf(true);
      assert.ok(unskipped, 'with the skip off it\'s read');
      assert.equal(unskipped.bigOk, true, 'nothing to skip with the switch off');
      const withSkip = await listOf(true, { skipGiants: true });
      const bc = withSkip.items.find(i => i.name === 'Blank Cards');
      assert.ok(bc && bc.bigOk === false, 'with it on, an ordinary brand may be skipped at 1,500+');
      assert.equal(withSkip.skipBig, true);
      // Skipped at 1,500+ on a page that isn't the brand's (another, bigger
      // company): the count isn't kept, and the page goes on Leo's list.
      const wb = await prisma.brand.create({ data: { name: 'Wrongbig Seltzer', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/wrongbig-defense/' } });
      await ingest({ action: 'liSwept', me: leo, brandId: wb.id, run: 'r7', name: 'Wrongbig Seltzer', seen: 0, added: 0, note: 'very big', hidden: [],
        done: false, issue: null, skipped: 'veryBig', members: 9000, companyIndustry: 'Defense and Space Manufacturing', companyUrl: wb.linkedinUrl });
      assert.equal((await prisma.brand.findUnique({ where: { id: wb.id } })).liMembers, null, 'another company\'s headcount never lands on the brand');
      const rv = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liPageReview' } })).value);
      assert.equal(rv[wb.id] && rv[wb.id].why, 'wrong');
      const wm = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value)[wb.id];
      assert.deepEqual([wm.skip, wm.clean, wm.issue], [null, false, null], 'a page problem: the old month');
    }
    ok('read again only when something went wrong: issues first for 3 runs then a month, clean never back, 1,500+ skips saved');

    // A Brand Fit floor (Leo: "only fill in the brands that score highly"):
    // every brand carries its score; under the floor, it's left off.
    {
      const all = (await ingest({ action: 'liList', me: leo, focus: '' })).j
      assert.ok(all.items.filter(i => !i.research).every(i => typeof i.fit === 'number'), 'each brand carries its Brand Fit')
      const floor = Math.max(...all.items.filter(i => !i.research && !i.planned && !i.mine).map(i => i.fit))
      const high = (await ingest({ action: 'liList', me: leo, focus: '', minFit: floor })).j
      assert.equal(high.minFit, floor)
      assert.ok(high.items.filter(i => !i.research && !i.planned && !i.mine).every(i => i.fit >= floor), 'only brands at the floor or above')
      assert.ok(high.belowFit > 0, 'the rest are counted as left out')
      // Best Brand Fit first (Leo, Oct 19 2026: "have the highest rated brands
      // … ran first then the lower ones after"), re-reads included.
      for (const list of [high, all]) {
        const plain = list.items.filter(i => !i.research && !i.planned && !i.mine && !i.last).map(i => i.fit)
        assert.deepEqual(plain, [...plain].sort((a, b) => b - a), 'highest score first')
        assert.equal(list.fitFirst, true)
        assert.equal(list.midFirst, false)
      }
    }
    {
      // A big company with the better score goes before a mid-size one now.
      const bigCo = await prisma.brand.create({ data: { name: 'Bigco Energy', category: 'energy', liMembers: 600, linkedinUrl: 'https://www.linkedin.com/company/bigco-energy/' } })
      const midCo = await prisma.brand.create({ data: { name: 'Middleton Snacks', category: 'wellness', liMembers: 80, linkedinUrl: 'https://www.linkedin.com/company/middleton-snacks/' } })
      const j = (await ingest({ action: 'liList', me: leo, focus: '', minFit: 1 })).j
      const at = (id) => j.items.findIndex(i => i.brandId === id)
      assert.ok(at(midCo.id) >= 0 && at(bigCo.id) >= 0)
      assert.ok(j.items[at(bigCo.id)].fit > j.items[at(midCo.id)].fit, 'the big one scores higher')
      assert.ok(at(bigCo.id) < at(midCo.id), 'and goes first')
      await prisma.brand.deleteMany({ where: { id: { in: [bigCo.id, midCo.id] } } })
    }
    {
      // Leo's own picks (Oct 20 2026, on OluKai — Brand Fit 37, nobody on file:
      // "why are there no contacts for it"): a brand he added himself and one he
      // put on his Week plan list go right after the Schedule's, under the floor
      // or not, a very big one too; one confirmed not sold in the US stays off.
      const added = await prisma.brand.create({ data: { name: 'Olukai E2E', category: 'apparel', source: 'chat', website: 'https://olukai.example' } })
      const listed = await prisma.brand.create({ data: { name: 'Listed Lowfit', category: 'apparel', liMembers: 1700, linkedinUrl: 'https://www.linkedin.com/company/listed-lowfit/' } })
      const abroad = await prisma.brand.create({ data: { name: 'Abroad Added', category: 'apparel', source: 'site', usStatus: 'no', linkedinUrl: 'https://www.linkedin.com/company/abroad-added/' } })
      const bank = JSON.stringify({ size: 100, hand: [{ id: listed.id, at: new Date().toISOString() }], removed: {} })
      await prisma.setting.upsert({ where: { key: 'weekBank' }, create: { key: 'weekBank', value: bank }, update: { value: bank } })
      const j = (await ingest({ action: 'liList', me: leo, focus: '', minFit: 90, skipGiants: true })).j
      const at = (id) => j.items.findIndex(i => i.brandId === id)
      assert.ok(at(added.id) >= 0 && at(listed.id) >= 0, 'both on the list under a floor of 90')
      assert.ok(j.items[at(added.id)].fit < 90 && j.items[at(listed.id)].fit < 90, 'though they score under it')
      assert.deepEqual([j.items[at(added.id)].mine, j.items[at(listed.id)].mine], ['added', 'list'])
      assert.ok(j.items.slice(0, Math.max(at(added.id), at(listed.id)) + 1).every(i => i.planned || i.mine), 'nothing but the Schedule\'s ahead of them')
      assert.ok(j.items[at(listed.id)].bigOk, 'a very big one isn\'t skipped')
      assert.equal(at(abroad.id), -1, 'not sold in the US: still off')
      assert.equal(j.mine, 2)
      const sch = await data('fillSchedule', { minFit: 90 })
      const rows = sch.days.flatMap(d => d.rows)
      assert.equal(sch.mine, 2)
      assert.equal(rows.find(r => r.brandId === added.id).why, 'You added it')
      assert.match(rows.find(r => r.brandId === listed.id).why, /Week plan list/)
      await prisma.setting.delete({ where: { key: 'weekBank' } })
      await prisma.brand.deleteMany({ where: { id: { in: [added.id, listed.id, abroad.id] } } })
    }
    ok('a Brand Fit floor: every brand carries its score, the ones under it are left off; best fit first; Leo\'s own picks whatever their score');

    // Very big brands skipped (Leo: "skip the very big brands"): a giant by
    // name and one with 1,500+ on LinkedIn are off the list; the rest stay.
    {
      const giant = await prisma.brand.create({ data: { name: 'Skoal', category: 'nicotine', linkedinUrl: 'https://www.linkedin.com/company/skoal-e2e/' } })
      const huge = await prisma.brand.create({ data: { name: 'Hugeco Drinks', category: 'beverage', liMembers: 1600, linkedinUrl: 'https://www.linkedin.com/company/hugeco/' } })
      const mid = await prisma.brand.create({ data: { name: 'Midco Drinks', category: 'beverage', liMembers: 80, linkedinUrl: 'https://www.linkedin.com/company/midco/' } })
      // A conglomerate is never skipped (Leo: "yes except for congomerates").
      const cong = await prisma.brand.create({ data: { name: 'Brown-Forman', category: 'spirits', liMembers: 5200, linkedinUrl: 'https://www.linkedin.com/company/brown-forman-e2e/' } })
      const ids = (j) => j.items.map(i => i.brandId)
      const kept = (await ingest({ action: 'liList', me: leo, focus: '' })).j
      assert.ok([giant.id, huge.id, mid.id, cong.id].every(id => ids(kept).includes(id)), 'without the skip, all four are on the list')
      const skip = (await ingest({ action: 'liList', me: leo, focus: '', skipGiants: true })).j
      assert.ok(!ids(skip).includes(giant.id) && !ids(skip).includes(huge.id), 'the giant and the 1,600-person brand are skipped')
      assert.ok(ids(skip).includes(mid.id), 'a mid-size brand stays')
      assert.ok(ids(skip).includes(cong.id), 'a conglomerate stays, 5,200 on LinkedIn or not')
      assert.ok(skip.bigSkipped >= 2)
      await prisma.brand.deleteMany({ where: { id: { in: [giant.id, huge.id, mid.id, cong.id] } } })
    }
    ok('very big brands skipped: a household name and a 1,500+ company are left off, a mid-size brand and a conglomerate stay');

    // Outreach → People's Fill schedule is the same list, cut into days.
    {
      // The run's defaults: very big brands skipped (the schedule's default too).
      const want = (await ingest({ action: 'liList', me: leo, focus: 'electrolyte', research: true, salesNav: true, minFit: 0, skipGiants: true })).j
      const sch = await data('fillSchedule', { minFit: 0 })
      const rows = sch.days.flatMap(d => d.rows)
      assert.deepEqual(rows.map(r => r.name), want.items.map(i => i.name), 'the schedule lists what the fill reads, in its order')
      assert.equal(sch.total, want.items.length)
      assert.ok(sch.days.every(d => d.rows.length <= sch.perDay), 'never more than a day\'s worth')
      assert.ok(rows.every(r => r.why), 'each says why it is there')
      const hi = await data('fillSchedule', { minFit: 100 })
      assert.ok(hi.days.flatMap(d => d.rows).every(r => r.research || r.fit >= 100 || /Schedule|Asked|You added|Week plan/.test(r.why)), 'the floor holds, for a read that went wrong too')
    }
    ok('Fill schedule: the fill\'s own list in its order, a day\'s worth a day, with the floor');

    // The clean-up of people saved before the October rules: a new grad
    // nobody wrote to is listed, a store manager already invited is kept,
    // a league on the roster is offered for Archive. Remove, then Undo.
    const ldBrand = await prisma.brand.findFirst({ where: { name: 'Liquid Death' } });
    const grad = await prisma.contact.create({ data: { brandId: ldBrand.id, name: 'Riley Grad', title: 'Recent graduate from UCLA', linkedinUrl: 'https://www.linkedin.com/in/riley-grad/', source: 'linkedin', isDecisionMaker: true } });
    await prisma.target.create({ data: { brandId: ldBrand.id, contactId: grad.id, fitScore: 40 } });
    const store = await prisma.contact.create({ data: { brandId: ldBrand.id, name: 'Stan Store', title: 'Assistant Store Manager', linkedinUrl: 'https://www.linkedin.com/in/stan-store/', source: 'linkedin' } });
    await prisma.target.create({ data: { brandId: ldBrand.id, contactId: store.id, status: 'sent', sentAt: new Date() } });
    const nhl = await prisma.brand.create({ data: { name: 'National Hockey League (NHL)', category: 'entertainment', source: 'linkedin-discover' } });
    let clean = await data('liCleanup', { preview: true });
    assert.deepEqual(clean.people.map(p => p.name + ' — ' + p.why), ['Riley Grad — student'], 'only the grad: the run\'s own people are all buyers, and Stan was written to');
    assert.equal(clean.kept, 1);
    assert.deepEqual(clean.brands.map(b => b.name), ['National Hockey League (NHL)']);
    const done = await data('liCleanup', { preview: false, contactIds: [grad.id, store.id], brandIds: [nhl.id] });
    assert.deepEqual([done.removed, done.archived], [1, 1], 'Stan was never on the list, so never removed');
    assert.equal(await prisma.contact.count({ where: { name: 'Riley Grad' } }), 0);
    assert.equal(await prisma.contact.count({ where: { name: 'Stan Store' } }), 1);
    assert.ok((await prisma.brand.findUnique({ where: { id: nhl.id } })).passedAt, 'the league is archived');
    clean = await data('liCleanup', { preview: true });
    assert.deepEqual([clean.people.length, clean.brands.length, clean.last.people, clean.last.brands], [0, 0, 1, 1]);
    const undo = await data('liCleanupUndo', {});
    assert.deepEqual([undo.back, undo.brands], [1, 1]);
    const back = await prisma.contact.findFirst({ where: { name: 'Riley Grad' }, include: { targets: true } });
    assert.ok(back && back.targets.length === 1 && back.targets[0].fitScore === 40, 'back, with a place in the queue');
    assert.equal((await prisma.brand.findUnique({ where: { id: nhl.id } })).passedAt, null);
    await assert.rejects(data('liCleanupUndo', {}), /No clean-up to undo/);
    ok('clean-up: lists who the new rules leave out (never anyone written to), removes only that, archives the league; Undo puts it back');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    linkedin.close();
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
