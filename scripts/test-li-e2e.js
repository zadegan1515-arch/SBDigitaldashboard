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
//   · read Liquid Death's people, and add Hoplark from its lookalikes —
//     not Waterloo Sparkling Water (Waterloo is on the roster, archived),
//     not an 812-follower seltzer, not an ad agency;
//   · find Olipop's page by search and save it;
//   · save buyers only, with clean names and titles, each in the queue;
//   · report the run — and Blank Cards, whose cards the reader gets
//     wrong, with a sample — readable at /api/reports/linkedin;
//   · leave nothing for a second run (every brand rests a month).
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
  if (!sessionStorage.getItem('__gm_seeded')) { sessionStorage.setItem(P + 'sbIngestToken', JSON.stringify(${JSON.stringify(TOKEN)})); sessionStorage.setItem('__gm_seeded', '1'); }
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
    assert.deepEqual(list.items.map(i => i.name).slice(0, 2), ['Huel', 'Powerade'], 'asked-for names first, then the focus lane');
    assert.deepEqual(list.items.slice(2).map(i => i.name).sort(), ['Big Bev', 'Blank Cards', 'Liquid Death', 'Native', 'Olipop', 'Tanqueray']);
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
    assert.match(panel, /16 people added across 9 brands/);
    assert.match(panel, /Big Bev — 3 added \(big company, 423 people: searched partnerships, sponsorship, brand manager\)/);
    assert.match(panel, /Tanqueray — 1 added \(via Diageo\)/);
    assert.match(panel, /What it did/);
    assert.match(panel, /Native — its saved LinkedIn page looks like another company/);
    assert.match(panel, /4 new brands added/);
    assert.deepEqual(errors, [], 'no page errors');
    assert.ok(!visits.some(v => /waterloo|tiny-seltzer|loud-agency/.test(v)), 'no visits to brands it shouldn\'t add');
    ok('the run started from #sb-fill and finished by itself: 16 people, 9 brands, 4 new, and a list of what it did');

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
    assert.equal(by.Hoplark.source, 'linkedin-discover'); assert.equal(by.Hoplark.category, 'beverage');
    assert.deepEqual(people('Hoplark'), ['Ana Reyes — Marketing Coordinator', 'Dean Thomas — Founder & CEO']);
    const all = await prisma.brand.findMany({ select: { name: true } });
    for (const bad of ['Waterloo Sparkling Water', 'Tiny Seltzer', 'Loud Agency']) assert.ok(!all.some(b => b.name === bad), bad + ' not added');
    ok('lookalikes: Hoplark added and read; Waterloo Sparkling Water (= Waterloo), a small page and an agency left out');

    assert.equal(by.Olipop.linkedinUrl, 'https://www.linkedin.com/company/drinkolipop/');
    assert.deepEqual(people('Olipop'), ['Ben Goodwin — Co-Founder and CEO', 'Mia Lopez — Associate Brand Manager']);
    ok('Olipop\'s page found by search and saved');

    const contacts = await prisma.contact.findMany({ include: { targets: true } });
    assert.equal(contacts.length, 16);
    assert.ok(contacts.every(c => c.source === 'linkedin' && c.linkedinUrl && c.targets.length === 1), 'each from LinkedIn, with a profile and a place in the queue');
    assert.ok(!contacts.some(c => /[·•🌱]|3rd|2nd/.test(c.name)), 'names clean');
    ok('buyers only, clean names, each one queued');

    const sweep = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value);
    assert.equal(sweep.b_ld.added, 3, 'a brand with lookalikes logs what it added');
    assert.equal(sweep.b_blank.seen, 3); assert.equal(sweep.b_blank.added, 0);
    const research = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liResearchLog' } })).value);
    assert.equal(research.huel.outcome, 'added'); assert.equal(research.powerade.outcome, 'added');
    const next = (await ingest({ action: 'liList', focus: 'electrolyte', research: true })).j;
    assert.deepEqual(next.items, [], 'nothing left for a second run');
    ok('visit and research logs written; a second run has nothing to redo');

    // The report, as the morning check reads it.
    const denied = await fetch(BASE + '/api/reports/linkedin');
    assert.equal(denied.status, 401, 'no token, no report');
    const rep = await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json();
    assert.equal(rep.latest, VERSION);
    const run = rep.runs[0];
    assert.equal(run.status, 'finished'); assert.equal(run.script, VERSION); assert.equal(run.focus, 'electrolyte');
    assert.equal(run.added, 16); assert.equal(run.newBrands, 4);
    assert.deepEqual(run.brands.map(b => b.name).sort(), ['Big Bev', 'Blank Cards', 'Hoplark', 'Huel', 'Liquid Death', 'Native', 'Olipop', 'Powerade', 'Tanqueray']);
    assert.equal(run.brands.find(b => b.name === 'Tanqueray').via, 'via Diageo');
    assert.equal(run.brands.find(b => b.name === 'Big Bev').members, 423);
    // The headcount is saved on the brand: 423 is a target (mid-size) brand.
    const bigBev = await prisma.brand.findUnique({ where: { id: 'b_big' } });
    assert.equal(bigBev.liMembers, 423);
    assert.ok(bigBev.liMembersAt instanceof Date);
    ok('the People tab\'s headcount is saved on the brand');
    {
      // The fill's order by size: target, not measured, small, big.
      await prisma.brand.createMany({ data: [
        { id: 'sz_big', name: 'Size Big', category: 'beverage', liMembers: 2400 },
        { id: 'sz_small', name: 'Size Small', category: 'beverage', liMembers: 7 },
        { id: 'sz_none', name: 'Size None', category: 'beverage' },
        { id: 'sz_mid', name: 'Size Mid', category: 'beverage', liMembers: 120 },
        { id: 'sz_tier', name: 'Size Tier', category: 'beverage', tier: 'growth' },
      ] });
      const l = (await ingest({ action: 'liList' })).j;
      const order = l.items.filter(i => /^Size /.test(i.name)).map(i => i.name + ':' + i.size);
      assert.deepEqual(order, ['Size Mid:target', 'Size Tier:target', 'Size None:unknown', 'Size Small:small', 'Size Big:big']);
      assert.equal(l.sizes.target, 2);
      await prisma.brand.deleteMany({ where: { id: { startsWith: 'sz_' } } });
    }
    ok('the fill goes target brands first, then not measured, small, big last');
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
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nat' } })).linkedinUrl, 'https://www.linkedin.com/company/native-co./', 'the run never swaps a saved page itself');
    const picked = await data('liPagePick', { brandId: 'b_nat', url: 'https://www.linkedin.com/company/native-cos/' });
    assert.equal(picked.linkedinUrl, 'https://www.linkedin.com/company/native-cos/');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nat' } })).linkedinUrl, 'https://www.linkedin.com/company/native-cos/');
    assert.ok(!(await data('linkedinPeople')).pageReview.some(e => e.brandId === 'b_nat'), 'off the list');
    const again = (await ingest({ action: 'liList', focus: 'electrolyte', research: true, me: { slug: 'leo-z', name: 'Leo Z' } })).j;
    assert.deepEqual(again.items.map(i => [i.name, i.linkedinUrl]), [['Native', 'https://www.linkedin.com/company/native-cos/']], 'the next run reads it');
    ok('Native\'s wrong page: nobody saved, on Leo\'s list with the right page first; picking it sends it to the next run');

    // Everything the run did, with the people's names.
    const detail = await data('liRunDetail', { id: run.id });
    const ld = detail.brands.find(b => b.name === 'Liquid Death');
    assert.deepEqual(ld.people.map(p => p.name).sort(), ['Erin Alvarez', 'Hana Sato', 'Mike Cessario']);
    assert.match(detail.brands.find(b => b.name === 'Native').note, /looks like another company/);
    assert.equal(detail.brands.find(b => b.name === 'Hoplark').isNew, true);
    assert.deepEqual(detail.newBrands.map(b => b.name).sort(), ['Hoplark', 'Huel', 'Powerade', 'Tanqueray']);
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
