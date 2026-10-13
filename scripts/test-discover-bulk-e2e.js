// scripts/test-discover-bulk-e2e.js — Brands → Discover's "Add all A's"
// (Leo, Oct 13 2026): addDiscoveredBulk preview → apply → undoDiscoverBulk,
// against the real handlers and a throwaway Postgres (wiped).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-discover-bulk-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-discover-bulk-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
// Its own port: the other e2e runs in the same CI job use 3457–3464.
const PORT = Number(process.env.E2E_PORT || 3465);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

const data = async (fn, args, timeoutMs) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN },
    body: JSON.stringify({ fn, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) throw new Error(fn + ': ' + (j.error || r.status));
  return j.data;
};

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };

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
    let lastErr = '';
    for (;;) {
      try { await data('categoryReach', {}, 60000); break; } catch (e) { lastErr = String(e && e.message || e); }
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered (last try: ' + lastErr + '):\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // On the roster already: Lucky Energy (its website).
    await prisma.brand.create({ data: { id: 'lucky', name: 'Lucky Energy', category: 'energy', website: 'https://luckyenergy.com/' } });
    const q = 'Claude hunt · Oct 13';
    const find = (id, name, category, signals, extra) => prisma.discoveredBrand.create({ data: { id, query: q, name, category, signals, reason: 'why ' + name, ...(extra || {}) } });
    await find('koloa', 'Koloa Rum', 'spirits', 'sponsors,genz,midsize', { website: 'https://koloarum.com/' });
    // The same brand from a second search: one brand, both finds linked.
    await prisma.discoveredBrand.create({ data: { id: 'koloa2', query: 'LinkedIn: similar to Bacardi', name: 'Koloa Rum', category: 'spirits', signals: 'sponsors,genz,midsize' } });
    await find('bayou', 'Bayou Rum', 'spirits', 'sponsors,genz', { activation: 'Tasting at tailgates', sourceUrl: 'https://news.example.com/bayou' });
    await find('soju', 'Hello Soju', 'rtd', 'sponsors,genz,midsize');
    await find('luckyd', 'Lucky Energy Drinks', 'energy', 'sponsors,genz', { website: 'https://www.luckyenergy.com' });
    await find('shirt', 'Shirt Co', 'apparel', '');
    await find('done', 'Done Co', 'spirits', 'sponsors', { status: 'added' });

    const listed = (await data('listDiscoveries', {})).rows;
    const gradeOf = id => listed.find(r => r.id === id).grade.grade;
    for (const id of ['koloa', 'koloa2', 'bayou', 'soju', 'luckyd']) assert.equal(gradeOf(id), 'A', id + ' is grade A: ' + JSON.stringify(listed.find(r => r.id === id).grade));
    assert.notEqual(gradeOf('shirt'), 'A');
    ok('the finds grade as expected (a Top category with college / music signs = A)');

    const pv = await data('addDiscoveredBulk', { grade: 'A' });
    assert.equal(pv.applied, false);
    assert.deepEqual(pv.rows.map(r => r.id).sort(), ['bayou', 'koloa', 'koloa2', 'soju']);
    assert.deepEqual(pv.held.map(h => [h.id, h.match]), [['luckyd', 'Lucky Energy']], 'a find whose website is a roster brand\'s is held back');
    assert.equal(pv.rows.find(r => r.id === 'soju').category, 'rtd');
    assert.equal(await prisma.brand.count(), 1, 'a preview writes nothing');
    ok('preview: every A waiting for review, as filed; the one that may already be on the roster held back');

    const stale = await data('addDiscoveredBulk', { grade: 'A', confirm: true, expect: 'old', ids: ['koloa'] });
    assert.equal(stale.stale, true);
    assert.equal(await prisma.brand.count(), 1);
    await assert.rejects(data('addDiscoveredBulk', { grade: 'A', confirm: true, expect: pv.expect, ids: ['luckyd'] }), /Tick at least one/, 'a held find can\'t be sneaked in');
    ok('an out-of-date preview writes nothing; a held find is never added');

    const done = await data('addDiscoveredBulk', { grade: 'A', confirm: true, expect: pv.expect, ids: ['koloa', 'koloa2', 'bayou'] });
    assert.equal(done.applied, true);
    assert.equal(done.added, 2);
    assert.equal(done.linked, 1);
    const koloa = await prisma.brand.findFirst({ where: { name: 'Koloa Rum' } });
    assert.deepEqual({ source: koloa.source, tier: koloa.tier, category: koloa.category, website: koloa.website }, { source: 'discover', tier: 'growth', category: 'spirits', website: 'https://koloarum.com/' });
    const bayou = await prisma.brand.findFirst({ where: { name: 'Bayou Rum' } });
    assert.match(bayou.notes, /Discover: why Bayou Rum[\s\S]*Activation idea: Tasting at tailgates[\s\S]*Found in: https:\/\/news\.example\.com\/bayou/);
    assert.equal(bayou.tier, null);
    assert.equal(await prisma.brand.count({ where: { name: 'Koloa Rum' } }), 1, 'two finds, one brand');
    const d = Object.fromEntries((await prisma.discoveredBrand.findMany()).map(r => [r.id, r]));
    assert.deepEqual([d.koloa.status, d.koloa2.status, d.koloa2.brandId], ['added', 'added', koloa.id]);
    assert.equal(d.soju.status, 'new', 'unticked stays to review');
    assert.equal(d.luckyd.status, 'new');
    const after = await data('listDiscoveries', {});
    assert.deepEqual(after.bulkUndo && { n: after.bulkUndo.n, grade: after.bulkUndo.grade }, { n: 2, grade: 'A' });
    ok('apply: exactly the ticked finds become brands (filed like a single Add); a find twice is one brand; Undo offered');

    // Bayou gets a person (the fill was quick): it stays on undo.
    await prisma.contact.create({ data: { brandId: bayou.id, name: 'Pat Rum', title: 'Brand Manager' } });
    const up = await data('undoDiscoverBulk', {});
    assert.deepEqual(up.goes, ['Koloa Rum']);
    assert.deepEqual(up.stays, [{ name: 'Bayou Rum', why: '1 person on file' }]);
    assert.equal(up.backToReview, 2);
    assert.equal(await prisma.brand.count({ where: { name: 'Koloa Rum' } }), 1, 'an undo preview writes nothing');
    await data('undoDiscoverBulk', { confirm: true });
    assert.equal(await prisma.brand.count({ where: { name: 'Koloa Rum' } }), 0);
    assert.equal(await prisma.brand.count({ where: { name: 'Bayou Rum' } }), 1);
    const d2 = Object.fromEntries((await prisma.discoveredBrand.findMany()).map(r => [r.id, r]));
    assert.deepEqual([d2.koloa.status, d2.koloa.brandId, d2.koloa2.status, d2.koloa2.brandId], ['new', null, 'new', null]);
    assert.equal(d2.bayou.status, 'added');
    assert.equal((await data('listDiscoveries', {})).bulkUndo, null);
    await assert.rejects(data('undoDiscoverBulk', {}), /Nothing to undo/);
    ok('undo: brands nothing touched go and their finds return to review; one with a person stays, named');

    // The single Add still works the same way.
    const one = await data('addDiscoveredBrand', { id: 'soju' });
    const soju = await prisma.brand.findUnique({ where: { id: one.brandId } });
    assert.deepEqual({ name: soju.name, tier: soju.tier, source: soju.source }, { name: 'Hello Soju', tier: 'growth', source: 'discover' });
    ok('the one-at-a-time Add is unchanged');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
