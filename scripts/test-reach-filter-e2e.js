// scripts/test-reach-filter-e2e.js — the Outreach filter's data against the
// real handlers and a throwaway Postgres (wiped). Every brand list the
// dropdown sits on says whether the brand was reached out to by the Reached
// tag's rule (isReached / REACHED_WHERE: an invite ever, an accept logged from
// LinkedIn, an email), the same as reachedBrands: listBrands' outreach.invited /
// emailed, linkedinPeople's reached, listDiscoveries' reached, planBrandRow's
// reached and categoryBrands' Reached group. A queued person or an invite taken
// back the same day (no date) is not reached out.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-reach-filter-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-reach-filter-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3471);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

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

// Brand id → reached out? (what every list must say)
const WANT = { rSent: true, rAccept: true, rOldWithdrawn: true, rEmail: true, rQueued: false, rTodayWithdrawn: false };

(async () => {
  let server = null, prisma = null;
  try {
    const env = { ...process.env, DATABASE_URL: DB };
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { cwd: ROOT, env, stdio: 'pipe' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DASHBOARD_TOKEN, NEXTAUTH_SECRET: 'e2e-only', NEXT_TELEMETRY_DISABLED: '1' },
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

    const D = (days) => new Date(Date.now() - days * 864e5);
    const brand = (id, name) => prisma.brand.create({ data: { id, name, category: 'energy', tier: 'growth' } });
    const person = async (brandId, name, t) => {
      const c = await prisma.contact.create({ data: { brandId, name, title: 'Brand Partnerships Manager', linkedinUrl: 'https://www.linkedin.com/in/' + name.toLowerCase().replace(/\W+/g, '-') } });
      return prisma.target.create({ data: Object.assign({ brandId, contactId: c.id }, t) });
    };
    await brand('rSent', 'Sent Co');
    await person('rSent', 'Ann Able', { status: 'sent', sentAt: D(3) });
    await person('rSent', 'Ann Two', { status: 'queued' });
    await brand('rAccept', 'Accept Log Co');                       // logged straight to accepted, no invite date
    await person('rAccept', 'Ben Bright', { status: 'accepted' });
    await brand('rOldWithdrawn', 'Old Withdrawn Co');              // withdrawn on LinkedIn later: still reached
    await person('rOldWithdrawn', 'Cy Cole', { status: 'withdrawn', sentAt: D(30) });
    await brand('rEmail', 'Email Only Co');                        // the email machine wrote, no invite
    const em = await person('rEmail', 'Di Dunn', { status: 'drafted' });
    await prisma.emailMessage.create({ data: { targetId: em.id, direction: 'out', kind: 'intro', status: 'sent', sentAt: D(40), subject: 's', body: 'b' } });
    await person('rEmail', 'Di Two', { status: 'queued', emailedAt: D(5) });
    await brand('rQueued', 'Queued Co');
    await person('rQueued', 'Ed Ely', { status: 'queued' });
    await brand('rTodayWithdrawn', 'Took Back Co');                // a same-day Withdrew clears the date
    await person('rTodayWithdrawn', 'Flo Fay', { status: 'withdrawn' });
    for (const [i, id] of ['rSent', 'rEmail'].entries()) {
      await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · Oct 18', name: ['Sent Co', 'Email Only Co'][i], status: 'added', brandId: id } });
    }
    await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · Oct 18', name: 'Accept Log Co', status: 'new' } }); // linked by name
    await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · Oct 18', name: 'Nobody Yet Co', status: 'new' } });

    // some = the list leaves some brands out by its own rules (Week plan's
    // browse sets aside brands resting after a recent invite): check the
    // ones it lists, and that it lists both kinds.
    const check = (what, rows, flag, some) => {
      const got = Object.fromEntries(rows.filter(r => r.id in WANT).map(r => [r.id, !!flag(r)]));
      const want = some ? Object.fromEntries(Object.keys(got).map(id => [id, WANT[id]])) : WANT;
      assert.deepEqual(got, want, what);
      if (some) assert.ok(Object.values(got).includes(true) && Object.values(got).includes(false), what + ' lists both kinds');
    };

    const tag = (await data('reachedBrands')).brands;
    check('reachedBrands (the tag)', Object.keys(WANT).map(id => ({ id })), b => !!tag[b.id]);
    ok('the Reached tag: invites (an accept logged from LinkedIn, an old withdrawn invite) and emails');

    const lbs = await data('listBrands', { take: 5000 });
    check('listBrands', lbs, b => b.outreach && (b.outreach.invited > 0 || b.outreach.emailed > 0));
    assert.equal(lbs.find(b => b.id === 'rSent').outreach.invited, 1, 'counts people invited, not the queued one');
    ok('All brands: the same brands as the tag');

    check('linkedinPeople', (await data('linkedinPeople')).brands, b => b.reached > 0);
    ok('Outreach → People: the same');

    const cb = await data('categoryBrands', { category: 'energy' });
    check('categoryBrands', cb.brands, b => b.group === 'reached');
    ok('Schedule drill-in: its Reached column is the same');

    const wb = await data('weekBankBrowse', { category: 'energy' });
    check('weekBankBrowse', wb.brands, b => b.reached, true);
    assert.ok(!wb.brands.some(b => b.id === 'rSent'), 'a brand resting after this week\'s invite is set aside there, as before');
    ok('Week plan → a category: the same');

    const sp = await data('searchPlanBrands', { q: 'Co' });
    check('searchPlanBrands', sp.brands, b => b.reached);
    ok('the find boxes\' rows carry it too');

    const disc = (await data('listDiscoveries')).rows;
    const dr = Object.fromEntries(disc.map(r => [r.name, r.reached]));
    assert.deepEqual(dr, { 'Sent Co': true, 'Email Only Co': true, 'Accept Log Co': true, 'Nobody Yet Co': false });
    ok('Discover: a find\'s brand on the roster (linked or by name) says whether it was reached out to; one not on it never was');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
