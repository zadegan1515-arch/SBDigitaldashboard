// scripts/test-accepted-e2e.js — Home → Accepted on LinkedIn against the real
// handlers and a throwaway Postgres (wiped): acceptedPeople's who, order, dates
// and stages (src/lib/accepted.ts).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-accepted-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-accepted-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3467);
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
    await prisma.brand.create({ data: { id: 'ab1', name: 'Alpha Water', category: 'electrolytes' } });
    await prisma.brand.create({ data: { id: 'ab2', name: 'Beta Pouches', category: 'nicotine', stoppedAt: D(1) } });
    const mk = async (brandId, name, title, t, accept) => {
      const c = await prisma.contact.create({ data: { brandId, name, title } });
      const row = await prisma.target.create({ data: Object.assign({ brandId, contactId: c.id }, t) });
      if (accept) await prisma.targetEvent.create({ data: { targetId: row.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: accept } });
      return row;
    };
    await mk('ab1', 'Ann Able', 'CMO', { status: 'accepted', sentAt: D(6) }, D(3));
    await mk('ab1', 'Ben Bright', 'Brand Manager', { status: 'accepted' }, null);                    // "They accepted", no invite date
    await mk('ab1', 'Cy Cole', 'Events Lead', { status: 'replied', sentAt: D(14), repliedAt: D(8) }, D(10));
    const emailOnly = await mk('ab1', 'Di Dunn', 'Marketing', { status: 'replied', sentAt: D(9), repliedAt: D(2) }, null);
    await prisma.emailMessage.create({ data: { targetId: emailOnly.id, direction: 'in', kind: 'reply', status: 'received' } });
    await mk('ab1', 'Ed Ely', 'Partnerships', { status: 'replied', sentAt: D(9), repliedAt: D(1) }, null);  // replied on LinkedIn, no accept logged
    await mk('ab1', 'Flo Fay', 'Marketing', { status: 'sent', sentAt: D(9) }, D(4));                         // accept undone
    await mk('ab1', 'Gus Gray', 'VP Marketing', { status: 'declined', sentAt: D(25) }, D(20));
    await mk('ab2', 'Hal Hart', 'Brand Director', { status: 'accepted', sentAt: D(33) }, D(30));
    await mk('ab2', 'Ivy Ives', 'Marketing', { status: 'queued' }, null);

    const r = await data('acceptedPeople');
    assert.deepEqual(r.people.map(p => p.name), ['Ben Bright', 'Ed Ely', 'Ann Able', 'Cy Cole', 'Gus Gray', 'Hal Hart'], 'newest first');
    assert.equal(r.total, 6);
    assert.equal(r.brands, 2);
    ok('everyone accepted, newest first; an undone accept, an email-only reply and the queued are left out');

    const by = Object.fromEntries(r.people.map(p => [p.name, p]));
    assert.equal(by['Ann Able'].title, 'CMO');
    assert.equal(by['Ann Able'].brandName, 'Alpha Water');
    assert.equal(by['Ann Able'].brandId, 'ab1');
    assert.ok(by['Ann Able'].contactId, 'a contact id for the brand page jump');
    assert.equal(Math.round((Date.now() - new Date(by['Ann Able'].at)) / 864e5), 3, 'dated by the accept');
    assert.equal(by['Ed Ely'].kind, 'replied');
    assert.equal(Math.round((Date.now() - new Date(by['Ed Ely'].at)) / 864e5), 1, 'no accept logged: dated by the reply');
    assert.deepEqual([by['Cy Cole'].label, by['Gus Gray'].label, by['Hal Hart'].label, by['Ann Able'].label], ['replied', 'said no', 'doesn’t want to continue', 'accepted']);
    ok('brand, title, the date and where each stands');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
