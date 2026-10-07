// scripts/test-pass-e2e.js — Pass = two weeks off outreach, betting set aside (Leo, Oct 7 2026),
// against the real handlers and a
// throwaway Postgres (wiped): dayRecap, addWorkLog, setWorkNeedDone,
// pickBuildIdea, deleteWorkLog.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-today-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-brand-fit-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3463);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const M = 1000000 * 100; // $1M in cents

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

// New York day keys, the way the dashboard counts days.
const nyKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);

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
    for (;;) {
      try { await data('categoryReach'); break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // Two never-reached brands with a buyer on LinkedIn: one electrolytes
    // (Top), one betting (set aside = Skip).
    const mk = async (id, name, category) => {
      await prisma.brand.create({ data: { id, name, category, tier: 'growth', liMembers: 120, usStatus: 'yes' } });
      for (const [i, t] of ['Head of Partnerships', 'Brand Manager', 'CMO'].entries()) {
        await prisma.contact.create({ data: { brandId: id, name: name + ' P' + i, title: t, linkedinUrl: 'https://www.linkedin.com/in/' + id + i, isDecisionMaker: true } });
      }
    };
    await mk('hydra', 'Hydra Water', 'electrolytes');
    await mk('betco', 'BetCo', 'betting');

    const nb = async () => (await data('nextBestBrands', {})).brands.map(b => b.id);
    const planned = async () => {
      const p = await data('getOutreachPlan', {});
      return { days: p.days, ids: new Set(p.days.flatMap(d => d.brands.concat(d.pinned).map(b => b.id))) };
    };
    let ids = await nb();
    assert.ok(ids.includes('hydra'), 'Hydra offered');
    assert.ok(!ids.includes('betco'), 'betting never offered');
    let p = await planned();
    assert.ok(p.ids.has('hydra'), 'Best fit puts Hydra on a day');
    assert.ok(!p.ids.has('betco'), 'Best fit never picks betting');
    ok('betting is set aside: not in Brands not reached yet, not on any Best fit day');

    // Pass: two weeks off every automatic pick.
    const r = await data('passBrandToday', { brandId: 'hydra' });
    const days = (new Date(r.passedUntil).getTime() - Date.now()) / 864e5;
    assert.ok(days > 13.9 && days <= 14, 'passed for 14 days, got ' + days);
    assert.ok(!(await nb()).includes('hydra'), 'passed brand not offered');
    p = await planned();
    assert.ok(!p.ids.has('hydra'), 'passed brand on no day');
    // Still out once "today" is over: only passedUntil holds it now.
    await prisma.brand.update({ where: { id: 'hydra' }, data: { passedTodayAt: new Date(Date.now() - 3 * 864e5) } });
    assert.ok(!(await nb()).includes('hydra'), 'still out after the day it was passed');
    p = await planned();
    assert.ok(!p.ids.has('hydra'), 'still on no day after the day it was passed');
    ok('Pass keeps the brand out for two weeks, not just today');

    // Two weeks later it is back by itself.
    await prisma.brand.update({ where: { id: 'hydra' }, data: { passedUntil: new Date(Date.now() - 1000) } });
    assert.ok((await nb()).includes('hydra'), 'back after two weeks');
    ok('after two weeks it comes back on its own');

    // A hand add ends the pass.
    await data('passBrandToday', { brandId: 'hydra' });
    const later = p.days[p.days.length - 1].date;
    await data('planAddBrands', { date: later, brandIds: ['hydra'] });
    const b = await prisma.brand.findUnique({ where: { id: 'hydra' } });
    assert.equal(b.passedUntil, null, 'planning it by hand clears the pass');
    ok('planning it by hand brings it back');

    console.log('pass e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
