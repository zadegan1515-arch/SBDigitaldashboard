// scripts/test-person-e2e.js — + Add brand → Person (Leo, Oct 12 2026: "sometimes we want
// to send the show board to individual people"), against the real handlers and a
// throwaway Postgres (wiped): createBrand({ kind: 'person' }), setBrandKind, and that a
// person never shows up as a brand to work.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-person-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-person-e2e.js');
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

    // A person: code minted, off outreach, email on a contact, no outreach row.
    const r = await data('createBrand', { kind: 'person', name: 'Miles Carter', email: ' Miles@Example.com ', phone: '555-0100', notes: 'Friend of Zach' });
    assert.equal(r.created, true);
    const p = await prisma.brand.findUnique({ where: { id: r.brand.id }, include: { contacts: true, targets: true } });
    assert.equal(p.kind, 'person');
    assert.ok(p.passedAt, 'archived = off every outreach pick');
    assert.equal(p.doNotEmail, true);
    assert.equal(p.category, null);
    assert.match(p.boardCode || '', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'board code minted');
    assert.equal(p.contacts.length, 1);
    assert.equal(p.contacts[0].email, 'miles@example.com');
    assert.equal(p.contacts[0].phone, '555-0100');
    assert.equal(p.targets.length, 0, 'no outreach row');
    ok('Add person makes a board code, an off-outreach row and a contact with their email');

    // The code opens the board as them.
    const g = await data('getBrand', { brandId: p.id });
    assert.equal(g.brand.kind, 'person');
    const talks = await data('listTalks');
    const t = talks.talks.find(x => x.brand.id === p.id);
    assert.ok(t && t.brand.kind === 'person' && t.code === p.boardCode, 'on Board codes, marked person');
    ok('the person is on Show Board → Board codes with their code');

    // Never on the roster or in the category counts.
    await prisma.brand.create({ data: { id: 'realbrand', name: 'Real Brand', category: 'energy' } });
    const all = await data('listBrands', { category: 'all' });
    assert.ok(all.some(b => b.id === 'realbrand'));
    assert.ok(!all.some(b => b.id === p.id), 'not on All brands');
    const none = await data('listBrands', { category: 'none' });
    assert.ok(!none.some(b => b.id === p.id), 'not on No category');
    const reach = await data('categoryReach');
    assert.equal(reach.all.total, 1, 'category counts leave the person out');
    ok('a person is never on the brand roster or in the category counts');

    // Same name twice is refused, naming what's there.
    await assert.rejects(data('createBrand', { kind: 'person', name: 'Real Brand' }), /already on file as a brand/);
    await assert.rejects(data('createBrand', { kind: 'person', name: 'Bob', email: 'not-an-email' }), /email/);
    ok('a name already on file, or a bad email, is refused');

    // An old brand row for one person → person (preview first), and back.
    await prisma.brand.create({ data: { id: 'miles2', name: 'Miles (personal)', category: 'unresolved' } });
    const c = await prisma.contact.create({ data: { brandId: 'miles2', name: 'Miles', linkedinUrl: 'https://www.linkedin.com/in/miles' } });
    await prisma.target.create({ data: { brandId: 'miles2', contactId: c.id, status: 'queued' } });
    const prev = await data('setBrandKind', { brandId: 'miles2', kind: 'person' });
    assert.equal(prev.preview, true);
    assert.ok(prev.changes.some(x => /Archived/.test(x)) && prev.changes.some(x => /1 queued person shelved/.test(x)), JSON.stringify(prev.changes));
    let m = await prisma.brand.findUnique({ where: { id: 'miles2' } });
    assert.equal(m.kind, null, 'preview writes nothing');
    await data('setBrandKind', { brandId: 'miles2', kind: 'person', confirm: true });
    m = await prisma.brand.findUnique({ where: { id: 'miles2' }, include: { targets: true } });
    assert.equal(m.kind, 'person'); assert.ok(m.passedAt); assert.equal(m.doNotEmail, true);
    assert.equal(m.targets[0].shelved, true);
    await data('setBrandKind', { brandId: 'miles2', kind: null, confirm: true });
    m = await prisma.brand.findUnique({ where: { id: 'miles2' } });
    assert.equal(m.kind, null); assert.ok(m.passedAt, 'back to a brand stays archived');
    ok('This is a person… previews, then takes the brand off outreach; back to a brand only drops the mark');

    // Show Board → Access codes: the lookup searches the whole roster (it used
    // to filter listBrands' first 500 rows, in no order), people and aka too.
    await prisma.brand.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ id: 'bulk' + i, name: 'Bulk Brand ' + String(i).padStart(3, '0'), category: 'energy' })) });
    await prisma.brand.create({ data: { id: 'ultra', name: 'Zzz Ultra Pouches', aka: 'UP Nicotine', category: 'nicotine', boardCode: 'ULTRA1' } });
    let lk = await data('boardCodeLookup', { q: 'ultra po' });
    assert.ok(lk.brands.some(b => b.id === 'ultra' && b.boardCode === 'ULTRA1'), JSON.stringify(lk));
    lk = await data('boardCodeLookup', { q: 'up nico' });
    assert.ok(lk.brands.some(b => b.id === 'ultra' && b.aka), 'found by aka');
    lk = await data('boardCodeLookup', { q: p.name.slice(0, 5) });
    assert.ok(lk.brands.some(b => b.id === p.id && b.person), 'a person is found, marked person');
    lk = await data('boardCodeLookup', { q: 'bulk brand 59' });
    assert.equal(lk.brands.length, 10); assert.equal(lk.brands[0].name, 'Bulk Brand 590', 'in name order');
    ok('Show Board code lookup finds any brand past the first 500, by aka, and people');

    console.log('person e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
