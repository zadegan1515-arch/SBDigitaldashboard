// scripts/test-coverage-e2e.js — "Every brand a marketing / partnerships
// person" for real: the /api/data handlers and /api/reports/linkedin on a
// local `next dev`, backed by a throwaway Postgres.
//
// Covers what the pure rules (test-coverage.mjs) can't: listBrands'
// `cover` from the real LinkedIn visit log and Leo's page answers,
// buyerCoverage's week by source / brands covered this week / last run,
// and the read-only report's counts (no names, no people).
//
// Needs a throwaway LOCAL Postgres — it is wiped:
//   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-coverage-e2e.js
// ~1 min, most of it `next dev` compiling the routes.

const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-coverage-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3459);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const REPORT_TOKEN = 'e2e-report-token-0123456789abcdef';

const data = async (fn, args) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN },
    body: JSON.stringify({ fn, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) throw new Error(fn + ': ' + (j.error || r.status));
  return j.data;
};

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };
const ago = (d) => new Date(Date.now() - d * 864e5);

(async () => {
  let server = null, prisma = null;
  try {
    const env = { ...process.env, DATABASE_URL: DB };
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { cwd: ROOT, env, stdio: 'pipe' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DASHBOARD_TOKEN, REPORT_TOKEN, NEXTAUTH_SECRET: 'e2e-only', NEXT_TELEMETRY_DISABLED: '1' },
    });
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    const t0 = Date.now();
    for (;;) {
      try { await data('categoryReach'); break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // One brand in each state.
    const li = (slug) => 'https://www.linkedin.com/company/' + slug + '/';
    await prisma.brand.createMany({ data: [
      { id: 'b_cov', name: 'Covered This Week', category: 'energy', linkedinUrl: li('cov') },
      { id: 'b_old', name: 'Covered Long Ago', category: 'energy' },
      { id: 'b_next', name: 'Next Up Soda', category: 'beverage' },
      { id: 'b_page', name: 'Page Pick Gin', category: 'spirits' },
      { id: 'b_none', name: 'No Page Co', category: 'apparel' },
      { id: 'b_rest', name: 'Rested Bev', category: 'beverage', linkedinUrl: li('rested') },
      { id: 'b_off', name: 'Archived Co', category: 'energy', passedAt: new Date() },
      { id: 'b_full', name: 'Full Of Sales', category: 'cpg', linkedinUrl: li('full') },
      // A brand under a parent company (Ketel One → Diageo): Leo's "no page"
      // doesn't stop the fill searching the parent.
      { id: 'b_kid', name: 'Ketel One', category: 'spirits' },
    ] });
    await prisma.contact.createMany({ data: [
      { brandId: 'b_cov', name: 'Pat Partner', title: 'Brand Partnerships Manager', source: 'linkedin' },
      { brandId: 'b_old', name: 'Cam Old', title: 'CMO', source: 'sponsorunited', createdAt: ago(30) },
      { brandId: 'b_next', name: 'Acct One', title: 'Accountant', source: 'sponsorunited' },
      { brandId: 'b_next', name: 'Acct Two', title: 'Staff Accountant', source: 'sponsorunited' },
      ...Array.from({ length: 25 }, (_, i) => ({ brandId: 'b_full', name: 'Seller ' + i, title: 'Sales Associate', createdAt: ago(20) })),
      { brandId: 'b_off', name: 'Off Person', title: 'Brand Manager', source: 'linkedin' },
    ] });
    const setting = (key, value) => prisma.setting.create({ data: { key, value: JSON.stringify(value) } });
    await setting('liSweepLog', {
      b_rest: { at: ago(2).toISOString(), seen: 40, added: 0, v: 2, note: 'big company (173 people) — nobody new in its partnerships, sponsorship, brand manager, marketing searches' },
      // Read long ago: due again.
      b_next: { at: ago(45).toISOString(), seen: 3, added: 0, v: 2 },
    });
    await setting('liPageReview', { b_page: { at: ago(2).toISOString(), why: 'unclear', saved: null, pageIndustry: null, candidates: [] } });
    await setting('liPageConfirmed', { b_none: 'none', b_kid: 'none' });
    await setting('liRunReports', [{
      id: 'r1', startedAt: ago(1).toISOString(), lastAt: ago(1).toISOString(), script: '1.25', reader: 2, focus: 'electrolyte', items: 6,
      status: 'stopped', added: 11, brands: [{ at: ago(1).toISOString(), name: 'Covered This Week', brandId: 'b_cov', seen: 5, added: 1 }],
      pauses: [], problems: 0, samples: [], newBrands: 0,
    }]);

    // 1. The roster's rows say where each brand stands.
    const list = await data('listBrands', { take: 5000, fit: true, coverage: true });
    const st = Object.fromEntries(list.map(b => [b.id, b.cover && b.cover.state]));
    assert.deepEqual(st, {
      b_cov: 'covered', b_old: 'covered', b_next: 'next', b_page: 'page', b_none: 'noPage',
      b_rest: 'resting', b_off: 'off', b_full: 'full', b_kid: 'next',
    });
    const rest = list.find(b => b.id === 'b_rest').cover;
    assert.match(rest.note, /^big company/);
    assert.equal(Date.parse(rest.back) - Date.parse(rest.at), 30 * 864e5, 'back on the fill a month after the visit');
    assert.equal(list.find(b => b.id === 'b_cov').cover.note, null);
    assert.equal((await data('listBrands', {}))[0].cover, undefined, 'the pickers don\'t pay for it');
    ok('listBrands: each brand covered, off, or what stands in the way — from the real visit log and page answers');

    // 2. This week, and the fill's last run.
    const info = await data('buyerCoverage');
    assert.deepEqual(info.week, { linkedin: 2, sponsorunited: 2, other: 0 }, 'people added this week by where they came from');
    assert.equal(info.coveredWeek, 1, 'one in-play brand got its first buyer this week (the archived one doesn\'t count)');
    assert.equal(info.target, 1);
    assert.equal(info.perDay, 100);
    assert.deepEqual(
      { brands: info.run.brands, added: info.run.added, script: info.run.script, status: info.run.status },
      { brands: 1, added: 11, script: '1.25', status: 'stopped' });
    assert.equal(typeof info.latestScript, 'string');
    ok('buyerCoverage: people this week by source, brands covered this week, the last LinkedIn run');

    // 3. The morning check's report: counts only.
    const denied = await fetch(BASE + '/api/reports/linkedin');
    assert.equal(denied.status, 401);
    const rep = await (await fetch(BASE + '/api/reports/linkedin', { headers: { Authorization: 'Bearer ' + REPORT_TOKEN } })).json();
    assert.deepEqual(rep.coverage, { covered: 2, off: 1, full: 1, page: 1, noPage: 1, resting: 1, next: 2, inPlay: 8, need: 6 });
    assert.ok(!JSON.stringify(rep.coverage).includes('Pat Partner') && !JSON.stringify(rep.coverage).includes('Page Pick'), 'no names in the counts');
    ok('/api/reports/linkedin carries the coverage counts — numbers only');

    console.log(n + ' coverage end-to-end checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
