// scripts/test-stop-e2e.js — "Doesn't want to continue" on Zach's list (Leo,
// Oct 15 2026: "some people respond but i want to make sure we dont reach out
// to them again"; the step asks just this person or the whole brand), against
// the real handlers and a throwaway Postgres (wiped):
//   · just them: off Zach's list, never queued / logged / added again — a second
//     copy of them (same name at the brand, same LinkedIn anywhere) is refused
//     too; the others at the brand stay; Undo takes it back.
//   · the whole brand: a preview names everything (nothing written); a stale
//     expect is refused; Stop archives it, do not email, sets its queue aside,
//     takes it off coming Schedule days; nothing at the brand can be queued or
//     brought back except by the Undo, which puts back exactly what it changed
//     (someone changed since stays, named).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-stop-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-stop-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3471);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

const call = async (fn, args) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN },
    body: JSON.stringify({ fn, args: args || {} }),
  });
  return r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
};
const data = async (fn, args) => {
  const j = await call(fn, args);
  if (!j.ok) throw new Error(fn + ': ' + (j.error || 'failed'));
  return j.data;
};
// A call that must be refused, saying why.
const refused = async (fn, args, re) => {
  const j = await call(fn, args);
  assert.equal(j.ok, false, fn + ' should be refused: ' + JSON.stringify(j).slice(0, 300));
  assert.match(j.error || '', re);
};

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
// A coming Tue–Thu (New York day key), a week or more out.
function comingSendingDay() {
  for (let i = 7; i < 20; i++) {
    const k = new Date(Date.now() + i * DAY).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dow = new Date(k + 'T12:00:00Z').getUTCDay();
    if (dow >= 2 && dow <= 4) return k;
  }
  throw new Error('no sending day');
}
const zachIds = async (args) => {
  const z = await data('zachTodo', args || {});
  return z.brands.flatMap((g) => g.people.map((p) => p.targetId)).sort();
};

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
      try { if ((await call('categoryReach')).ok) break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // Alpha Water: two accepted (Alex, Beth), one in today's list (Dana), one
    // waiting in the pool (Ed), one invite still out (Fay). Bravo: Zoe accepted.
    await prisma.brand.create({ data: { id: 'alpha', name: 'Alpha Water', category: 'electrolytes', tier: 'growth', usStatus: 'yes' } });
    await prisma.brand.create({ data: { id: 'bravo', name: 'Bravo Soda', category: 'beverage', tier: 'growth', usStatus: 'yes' } });
    const person = async (id, brandId, name, title, li, t) => {
      await prisma.contact.create({ data: { id: 'c_' + id, brandId, name, title, linkedinUrl: li, source: 'linkedin' } });
      await prisma.target.create({ data: { id: 't_' + id, brandId, contactId: 'c_' + id, ...t } });
      if (t.status === 'accepted') await prisma.targetEvent.create({ data: { targetId: 't_' + id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: ago(5) } });
    };
    await person('alex', 'alpha', 'Alex Seamon', 'Brand Partnerships Manager', 'https://www.linkedin.com/in/alexseamon/', { status: 'accepted', sentAt: ago(9) });
    await person('beth', 'alpha', 'Beth Baker', 'Director of Marketing', 'https://www.linkedin.com/in/bethbaker/', { status: 'accepted', sentAt: ago(9) });
    await person('dana', 'alpha', 'Dana Dunn', 'Marketing Manager', 'https://www.linkedin.com/in/danadunn/', { status: 'queued', queuedFor: new Date() });
    await person('ed', 'alpha', 'Ed Ellis', 'Events Manager', 'https://www.linkedin.com/in/edellis/', { status: 'queued' });
    await person('fay', 'alpha', 'Fay Fox', 'Head of Brand', 'https://www.linkedin.com/in/fayfox/', { status: 'sent', sentAt: ago(3) });
    await person('zoe', 'bravo', 'Zoe Zhang', 'Partnerships Lead', 'https://www.linkedin.com/in/zoezhang/', { status: 'accepted', sentAt: ago(9) });
    const day = comingSendingDay();
    await prisma.setting.create({ data: { key: 'outreachPlan', value: JSON.stringify({ [day]: { category: null, brandIds: ['bravo', 'alpha'] } }) } });
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    ok('Zach’s list has everyone who accepted');

    // ---- just them ----
    const r1 = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    assert.equal(r1.scope, 'person');
    let alex = await prisma.contact.findUnique({ where: { id: 'c_alex' }, include: { targets: true } });
    assert.ok(alex.doNotContactAt, 'the person is marked');
    assert.equal(alex.targets[0].status, 'accepted', 'their status stays (they were reached)');
    assert.equal(alex.targets[0].handDeclinedScope, 'person');
    assert.deepEqual(await zachIds(), ['t_beth', 't_zoe'], 'off Zach’s list; the others at the brand stay');
    let z = await data('zachTodo');
    assert.ok(z.done.some((d) => d.targetId === 't_alex' && d.kind === 'declined' && d.scope === 'person'), 'in the Done fold');
    z = await data('zachTodo', { brandId: 'alpha' });
    assert.deepEqual(z.declined.map((d) => [d.targetId, d.scope]), [['t_alex', 'person']]);
    assert.equal(z.brandStopped, null);
    const again = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    assert.equal(again.already, true, 'a second click changes nothing');
    ok('just them: marked, status kept, off Zach’s list, the others stay');

    await refused('handStep', { targetId: 't_alex', step: 'dm' }, /Alex Seamon said they don't want to continue/);
    await refused('queueContact', { contactId: 'c_alex' }, /don't want to continue/);
    await refused('upsertContact', { brandId: 'alpha', name: 'alex seamon', title: 'Partnerships' }, /don't want to continue/);
    await refused('upsertContact', { brandId: 'bravo', name: 'A. Seamon', linkedinUrl: 'http://linkedin.com/in/AlexSeamon' }, /don't want to continue/);
    const imp = await data('importContacts', { rows: [
      { brandName: 'Alpha Water', name: 'alex seamon', title: 'VP Partnerships' },
      { brandName: 'Bravo Soda', name: 'Alexander Seamon', linkedinUrl: 'https://www.linkedin.com/in/AlexSeamon' },
    ] });
    assert.equal(imp.optedOut, 2, JSON.stringify(imp));
    assert.equal(await prisma.contact.count({ where: { name: { contains: 'Seamon', mode: 'insensitive' } } }), 1, 'no second copy anywhere');
    assert.equal(await prisma.contact.count({ where: { brandId: 'alpha', name: 'Alex Seamon' } }), 1, 'no second copy');
    ok('nothing reaches them again: no step, no queue, no second copy by hand or import');

    await data('handStep', { targetId: 't_alex', step: 'declined', on: false });
    alex = await prisma.contact.findUnique({ where: { id: 'c_alex' }, include: { targets: true } });
    assert.equal(alex.doNotContactAt, null);
    assert.equal(alex.targets[0].handDeclinedAt, null);
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    await data('handStep', { targetId: 't_alex', step: 'dm' });
    await data('handStep', { targetId: 't_alex', step: 'dm', on: false });
    ok('Undo: they’re back on the list and can be written to');

    // ---- the whole brand ----
    const pv = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', preview: true });
    assert.equal(pv.preview, true);
    assert.deepEqual(pv.others, ['Beth Baker']);
    assert.deepEqual(pv.today, ['Dana Dunn']);
    assert.deepEqual(pv.waiting, ['Ed Ellis']);
    assert.deepEqual(pv.invites, ['Fay Fox']);
    assert.equal(pv.days.length, 1);
    assert.equal(pv.archived, false);
    assert.equal(pv.doNotEmail, false);
    let alpha = await prisma.brand.findUnique({ where: { id: 'alpha' } });
    assert.equal(alpha.stoppedAt, null, 'a preview writes nothing');
    assert.equal(alpha.passedAt, null);
    ok('the whole brand: a preview names who stops and what’s left as it is, writes nothing');

    const st = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', expect: 'not-the-preview' });
    assert.equal(st.stale, true, 'an expect that isn’t the preview’s is shown again');
    alpha = await prisma.brand.findUnique({ where: { id: 'alpha' } });
    assert.equal(alpha.stoppedAt, null);
    const done = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', expect: pv.expect });
    assert.equal(done.ok, true);
    alpha = await prisma.brand.findUnique({ where: { id: 'alpha' }, include: { targets: true } });
    assert.ok(alpha.stoppedAt && alpha.passedAt && alpha.doNotEmail, 'stopped, archived, do not email');
    const tOf = (id) => alpha.targets.find((t) => t.id === 't_' + id);
    assert.ok(tOf('dana').shelved && !tOf('dana').queuedFor, 'out of today’s list');
    assert.ok(tOf('ed').shelved, 'out of the pool');
    assert.equal(tOf('fay').status, 'sent', 'an invite still out is left as it is');
    assert.deepEqual(await zachIds(), ['t_zoe'], 'nobody at the brand on Zach’s list; another brand stays');
    let plan = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.deepEqual(plan[day].brandIds, ['bravo'], 'off the coming Schedule day');
    z = await data('zachTodo', { brandId: 'alpha' });
    assert.ok(z.brandStopped && z.brandStopped.targetId === 't_alex');
    ok('Stop: archived, do not email, its queue set aside, off the Schedule, off Zach’s list');

    await refused('queueBrandTargets', { brandId: 'alpha' }, /Alpha Water said they don't want to continue/);
    await refused('queueContact', { contactId: 'c_dana' }, /don't want to continue/);
    await refused('handStep', { targetId: 't_beth', step: 'dm' }, /Alpha Water said they don't want to continue/);
    await refused('setBrandPassed', { brandId: 'alpha', passed: false }, /don't want to continue/);
    await refused('updateBrand', { brandId: 'alpha', doNotEmail: false }, /Alpha Water said they don't want to continue/);
    await data('updateBrand', { brandId: 'alpha', doNotEmail: false, notes: 'Said no on LinkedIn' });
    assert.equal((await prisma.brand.findUnique({ where: { id: 'alpha' } })).doNotEmail, true, 'do not email stays on');
    const up = await call('upsertContact', { brandId: 'alpha', name: 'Gus Gray', title: 'Brand Manager' });
    if (up.ok) assert.equal(await prisma.target.count({ where: { brandId: 'alpha', contact: { name: 'Gus Gray' } } }), 0, 'a person added later is never queued');
    ok('nothing at the brand can be queued, written to, un-archived or emailed until the Undo');

    // Someone changed since the stop stays as they are.
    await prisma.target.update({ where: { id: 't_ed' }, data: { status: 'passed' } });
    const u = await data('undoStopContact', { brandId: 'alpha' });
    assert.equal(u.scope, 'brand');
    assert.ok(u.back.includes('Dana Dunn'), JSON.stringify(u));
    assert.ok(u.stays.includes('Ed Ellis'), 'changed since → stays, named');
    assert.ok(u.back.some((x) => /^back on /.test(x)), 'back on the Schedule day');
    alpha = await prisma.brand.findUnique({ where: { id: 'alpha' }, include: { targets: true, contacts: true } });
    assert.ok(!alpha.stoppedAt && !alpha.passedAt && !alpha.doNotEmail, 'not stopped, not archived, emails on');
    const dana = alpha.targets.find((t) => t.id === 't_dana');
    assert.ok(!dana.shelved && dana.queuedFor, 'Dana back in today’s list');
    assert.equal(alpha.contacts.find((c) => c.id === 'c_alex').doNotContactAt, null, 'Alex can be reached again');
    plan = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.deepEqual(plan[day].brandIds, ['bravo', 'alpha'], 'back where it was on the day');
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    ok('Undo by brand puts back exactly what the stop changed; someone changed since stays, named');

    const ev = await prisma.targetEvent.findMany({ where: { targetId: 't_alex', kind: { contains: 'continue' } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(ev.map((e) => e.detail), ['just them', 'just them', 'whole brand — nobody at Alpha Water is contacted', 'whole brand']);
    ok('each step and Undo is on the person’s history');

    console.log('stop e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
