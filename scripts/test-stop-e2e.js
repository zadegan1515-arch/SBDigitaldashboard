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
// Coming Tue–Thu days (New York day keys), a week or more out.
function comingSendingDays(count) {
  const out = [];
  for (let i = 7; i < 30 && out.length < count; i++) {
    const k = new Date(Date.now() + i * DAY).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dow = new Date(k + 'T12:00:00Z').getUTCDay();
    if (dow >= 2 && dow <= 4) out.push(k);
  }
  return out;
}
const zachIds = async (args) => {
  const z = await data('zachTodo', args || {});
  return z.brands.flatMap((g) => g.people.map((p) => p.targetId)).sort();
};
const readPlan = async (prisma) => JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);

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
    // waiting in the pool (Ed), one invite still out (Fay), a call booked
    // (Carl). Bravo: Zoe accepted, and a second copy of Alex (same LinkedIn
    // profile, another link form) waiting in its pool.
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
    await person('carl', 'alpha', 'Carl Cole', 'VP Marketing', 'https://www.linkedin.com/in/carlcole/', { status: 'replied', sentAt: ago(12), repliedAt: ago(4), callAt: new Date(Date.now() + 3 * DAY) });
    await person('zoe', 'bravo', 'Zoe Zhang', 'Partnerships Lead', 'https://www.linkedin.com/in/zoezhang/', { status: 'accepted', sentAt: ago(9) });
    await person('alex2', 'bravo', 'Alex S.', 'Brand Manager', 'http://linkedin.com/in/AlexSeamon', { status: 'queued' });
    const [day, day2] = comingSendingDays(2);
    // day2 holds only Alpha: the stop empties it (and so drops it).
    await prisma.setting.create({ data: { key: 'outreachPlan', value: JSON.stringify({ [day]: { category: null, brandIds: ['bravo', 'alpha'] }, [day2]: { category: null, brandIds: ['alpha'] } }) } });
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    ok('Zach’s list has everyone who accepted');

    // ---- just them ----
    const r1 = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    assert.equal(r1.scope, 'person');
    assert.deepEqual(r1.twins, ['Alex S. (Bravo Soda)'], 'their other copy is named');
    let alex = await prisma.contact.findUnique({ where: { id: 'c_alex' }, include: { targets: true } });
    assert.ok(alex.doNotContactAt, 'the person is marked');
    assert.equal(alex.targets[0].status, 'accepted', 'their status stays (they were reached)');
    assert.equal(alex.targets[0].handDeclinedScope, 'person');
    let alex2 = await prisma.contact.findUnique({ where: { id: 'c_alex2' }, include: { targets: true } });
    assert.equal(alex2.doNotContactAt?.getTime(), alex.doNotContactAt.getTime(), 'the other copy is marked at the same moment');
    assert.ok(alex2.targets[0].shelved && alex2.targets[0].shelvedHow === null, 'its waiting row is set aside');
    assert.deepEqual(await zachIds(), ['t_beth', 't_zoe'], 'off Zach’s list; the others at the brand stay');
    let z = await data('zachTodo');
    assert.ok(z.done.some((d) => d.targetId === 't_alex' && d.kind === 'declined' && d.scope === 'person'), 'in the Done fold');
    z = await data('zachTodo', { brandId: 'alpha' });
    assert.deepEqual(z.declined.map((d) => [d.targetId, d.scope]), [['t_alex', 'person']]);
    assert.equal(z.brandStopped, null);
    const again = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    assert.equal(again.already, true, 'a second click changes nothing');
    ok('just them: marked with their other copy, status kept, off Zach’s list, the others stay');

    await refused('handStep', { targetId: 't_alex', step: 'dm' }, /Alex Seamon said they don't want to continue/);
    await refused('queueContact', { contactId: 'c_alex' }, /don't want to continue/);
    await refused('queueContact', { contactId: 'c_alex2' }, /don't want to continue/);
    await refused('setTargetShelved', { targetId: 't_alex2', shelved: false }, /don't want to continue/);
    await refused('setTargetStatus', { targetId: 't_alex', dmSent: true }, /don't want to continue/);
    await refused('upsertContact', { brandId: 'alpha', name: 'alex seamon', title: 'Partnerships' }, /don't want to continue/);
    await refused('upsertContact', { brandId: 'bravo', name: 'A. Seamon', linkedinUrl: 'http://linkedin.com/in/AlexSeamon' }, /don't want to continue/);
    const imp = await data('importContacts', { rows: [
      { brandName: 'Alpha Water', name: 'alex seamon', title: 'VP Partnerships' },
      { brandName: 'Bravo Soda', name: 'Alexander Seamon', linkedinUrl: 'https://www.linkedin.com/in/AlexSeamon' },
    ] });
    assert.equal(imp.optedOut, 2, JSON.stringify(imp));
    assert.equal(await prisma.contact.count({ where: { name: { contains: 'Seamon', mode: 'insensitive' } } }), 1, 'no new copy anywhere');
    const accepted = await data('listTargets', { status: 'accepted' });
    assert.ok(!accepted.some((t) => t.id === 't_alex'), 'off Results’ “They accepted — send the DM”');
    await data('queueBrandTargets', { brandId: 'bravo' }).catch(() => {});
    assert.ok((await prisma.target.findUnique({ where: { id: 't_alex2' } })).shelved, 'the queue never promotes the other copy');
    ok('nothing reaches them again: no step, no queue, no Results prompt, no copy by hand or import');

    const upv = await data('undoStopContact', { targetId: 't_alex', preview: true });
    assert.equal(upv.preview, true);
    assert.equal(upv.twins, 1);
    assert.ok((await prisma.contact.findUnique({ where: { id: 'c_alex' } })).doNotContactAt, 'a preview writes nothing');
    const u1 = await data('handStep', { targetId: 't_alex', step: 'declined', on: false });
    assert.equal(u1.twins, 1);
    assert.ok(u1.back.some((x) => x.startsWith('Alex S.')), JSON.stringify(u1));
    alex = await prisma.contact.findUnique({ where: { id: 'c_alex' }, include: { targets: true } });
    alex2 = await prisma.contact.findUnique({ where: { id: 'c_alex2' }, include: { targets: true } });
    assert.equal(alex.doNotContactAt, null);
    assert.equal(alex.targets[0].handDeclinedAt, null);
    assert.equal(alex2.doNotContactAt, null, 'the other copy too');
    assert.ok(!alex2.targets[0].shelved, 'its row back in the pool');
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    await data('handStep', { targetId: 't_alex', step: 'dm' });
    await data('handStep', { targetId: 't_alex', step: 'dm', on: false });
    ok('Undo (previewed): they and their other copy are back and can be written to');

    // ---- the whole brand ----
    const pv = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', preview: true });
    assert.equal(pv.preview, true);
    assert.deepEqual(pv.others, ['Beth Baker']);
    assert.deepEqual(pv.today, ['Dana Dunn']);
    assert.deepEqual(pv.waiting, ['Ed Ellis']);
    assert.deepEqual(pv.invites, ['Fay Fox']);
    assert.deepEqual(pv.calls.map((c) => c.name), ['Carl Cole']);
    assert.deepEqual(pv.twins, ['Alex S. (Bravo Soda)']);
    assert.equal(pv.days.length, 2);
    assert.equal(pv.archived, false);
    assert.equal(pv.doNotEmail, false);
    let alpha = await prisma.brand.findUnique({ where: { id: 'alpha' } });
    assert.equal(alpha.stoppedAt, null, 'a preview writes nothing');
    assert.equal(alpha.passedAt, null);
    ok('the whole brand: a preview names who stops, their other copy and what’s left as it is, writes nothing');

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
    assert.ok((await prisma.contact.findUnique({ where: { id: 'c_alex2' } })).doNotContactAt, 'their other copy is marked');
    assert.deepEqual(await zachIds(), ['t_zoe'], 'nobody at the brand on Zach’s list; another brand stays');
    let plan = await readPlan(prisma);
    assert.deepEqual(plan[day].brandIds, ['bravo'], 'off the coming Schedule day');
    assert.equal(plan[day2], undefined, 'the day it emptied is gone');
    z = await data('zachTodo', { brandId: 'alpha' });
    assert.ok(z.brandStopped && z.brandStopped.targetId === 't_alex');
    assert.deepEqual(z.calls.map((c) => [c.name, !!c.stopped]), [['Carl Cole', true]], 'the booked call stays listed, marked, to cancel');
    ok('Stop: archived, do not email, its queue set aside, off the Schedule, off Zach’s list; the call stays to cancel');

    await refused('queueBrandTargets', { brandId: 'alpha' }, /Alpha Water said they don't want to continue/);
    await refused('queueContact', { contactId: 'c_dana' }, /don't want to continue/);
    await refused('setTargetShelved', { targetId: 't_dana', shelved: false }, /don't want to continue/);
    await refused('handStep', { targetId: 't_beth', step: 'dm' }, /Alpha Water said they don't want to continue/);
    await refused('setBrandPassed', { brandId: 'alpha', passed: false }, /don't want to continue/);
    await refused('updateBrand', { brandId: 'alpha', doNotEmail: false }, /Alpha Water said they don't want to continue/);
    await refused('mergeBrands', { fromId: 'alpha', toId: 'bravo' }, /Alpha Water said they don't want to continue/);
    await refused('mergeBrands', { fromId: 'bravo', toId: 'alpha' }, /Alpha Water said they don't want to continue/);
    await data('updateBrand', { brandId: 'alpha', doNotEmail: false, notes: 'Said no on LinkedIn' });
    assert.equal((await prisma.brand.findUnique({ where: { id: 'alpha' } })).doNotEmail, true, 'do not email stays on');
    const up = await call('upsertContact', { brandId: 'alpha', name: 'Gus Gray', title: 'Brand Manager' });
    if (up.ok) assert.equal(await prisma.target.count({ where: { brandId: 'alpha', contact: { name: 'Gus Gray' } } }), 0, 'a person added later is never queued');
    const ro = await data('repliedOverview');
    assert.ok(!ro.people.some((x) => x.id === 't_carl'), 'off “They replied — keep it moving”');
    assert.ok(!(await data('listTargets', { status: 'accepted' })).some((t) => t.brandId === 'alpha'), 'off “They accepted — send the DM”');
    ok('nothing at the brand can be queued, promoted, written to, merged away, un-archived or emailed until the Undo');

    // Someone changed since the stop stays as they are.
    await prisma.target.update({ where: { id: 't_ed' }, data: { status: 'passed' } });
    const bpv = await data('undoStopContact', { brandId: 'alpha', preview: true });
    assert.equal(bpv.scope, 'brand');
    assert.ok(bpv.unarchive && bpv.emailsOn, 'says it comes off the archive, emails on');
    assert.ok(bpv.back.includes('Dana Dunn (today’s list)'), JSON.stringify(bpv));
    assert.ok(bpv.stays.includes('Ed Ellis'), 'changed since → named');
    assert.equal(bpv.days.length, 2, 'both days, the one it emptied too');
    assert.ok((await prisma.brand.findUnique({ where: { id: 'alpha' } })).stoppedAt, 'the Undo’s preview writes nothing');
    const u = await data('undoStopContact', { brandId: 'alpha' });
    assert.equal(u.scope, 'brand');
    assert.ok(u.back.includes('Dana Dunn (today’s list)'), JSON.stringify(u));
    assert.ok(u.stays.includes('Ed Ellis'), 'changed since → stays, named');
    assert.ok(u.back.some((x) => /^back on /.test(x)), 'back on the Schedule days');
    alpha = await prisma.brand.findUnique({ where: { id: 'alpha' }, include: { targets: true, contacts: true } });
    assert.ok(!alpha.stoppedAt && !alpha.passedAt && !alpha.doNotEmail, 'not stopped, not archived, emails on');
    const dana = alpha.targets.find((t) => t.id === 't_dana');
    assert.ok(!dana.shelved && dana.queuedFor, 'Dana back in today’s list');
    assert.equal(alpha.contacts.find((c) => c.id === 'c_alex').doNotContactAt, null, 'Alex can be reached again');
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_alex2' } })).doNotContactAt, null, 'and their other copy');
    plan = await readPlan(prisma);
    assert.deepEqual(plan[day].brandIds, ['bravo', 'alpha'], 'back where it was on the day');
    assert.deepEqual(plan[day2] && plan[day2].brandIds, ['alpha'], 'the day it emptied is back, with it');
    assert.deepEqual(await zachIds(), ['t_alex', 't_beth', 't_zoe']);
    ok('Undo by brand (previewed) puts back exactly what the stop changed, the emptied day too; someone changed since stays, named');

    // ---- widen: just them first, then the whole brand through them ----
    await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    const wpv = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', preview: true });
    assert.equal(wpv.preview, true, 'a person stopped on their own can still widen to the brand');
    assert.deepEqual(wpv.twins, [], 'their copy is already marked');
    const w = await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'brand', expect: wpv.expect });
    assert.equal(w.ok, true);
    assert.ok((await prisma.brand.findUnique({ where: { id: 'alpha' } })).stoppedAt, 'the brand is stopped');
    const wu = await data('handStep', { targetId: 't_alex', step: 'declined', on: false });
    assert.equal(wu.scope, 'brand');
    assert.ok(wu.stays.some((x) => /said it for themselves first/.test(x)), JSON.stringify(wu));
    assert.equal((await prisma.brand.findUnique({ where: { id: 'alpha' } })).stoppedAt, null, 'the brand is back');
    alex = await prisma.contact.findUnique({ where: { id: 'c_alex' }, include: { targets: true } });
    assert.ok(alex.doNotContactAt && alex.targets[0].handDeclinedScope === 'person', 'Alex still isn’t contacted');
    await data('handStep', { targetId: 't_alex', step: 'declined', on: false });
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_alex' } })).doNotContactAt, null);
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_alex2' } })).doNotContactAt, null);
    ok('widened to the brand: the brand’s Undo leaves the person who said it themselves stopped; theirs takes it back');

    const ev = await prisma.targetEvent.findMany({ where: { targetId: 't_alex', kind: { contains: 'continue' } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(ev.map((e) => e.detail), ['just them', 'just them', 'whole brand — nobody at Alpha Water is contacted', 'whole brand',
      'just them', 'whole brand — nobody at Alpha Water is contacted', 'whole brand — they still aren’t contacted', 'just them']);
    ok('each step and Undo is on the person’s history');

    // ---- the same person twice at one brand: merges keep the mark straight ----
    await prisma.brand.create({ data: { id: 'charlie', name: 'Charlie Chews', category: 'beverage', tier: 'growth', usStatus: 'yes' } });
    await person('cam1', 'charlie', 'Cam Cole', 'Head of Partnerships', 'https://www.linkedin.com/in/camcole/', { status: 'replied', sentAt: ago(9), repliedAt: ago(3) });
    await person('cam2', 'charlie', 'Cam Cole', 'Partnerships', null, { status: 'accepted', sentAt: ago(9) });
    // (a) the copy that said it is merged away; the stop is taken back; then the merge.
    await data('handStep', { targetId: 't_cam2', step: 'declined', scope: 'person' });
    let mp = await data('mergePeople', { brandId: 'charlie' });
    await data('mergePeople', { brandId: 'charlie', confirm: true, expect: mp.expect });
    const kept = await prisma.target.findFirst({ where: { brandId: 'charlie' } });
    assert.ok(kept.handDeclinedAt, 'the outreach row that stays carries the mark');
    await data('undoStopContact', { targetId: kept.id });
    await data('undoMergePeople', { brandId: 'charlie', confirm: true });
    let cams = await prisma.contact.findMany({ where: { brandId: 'charlie' }, include: { targets: true } });
    assert.equal(cams.length, 2);
    assert.ok(cams.every((c) => !c.doNotContactAt && c.targets.every((t) => !t.handDeclinedAt)), 'taken back before the merge’s Undo: no copy comes back marked');
    // (b) merged first, then the stop, then the merge's Undo: both copies keep it, and its Undo clears both.
    mp = await data('mergePeople', { brandId: 'charlie' });
    await data('mergePeople', { brandId: 'charlie', confirm: true, expect: mp.expect });
    const kept2 = await prisma.target.findFirst({ where: { brandId: 'charlie' } });
    await data('handStep', { targetId: kept2.id, step: 'declined', scope: 'person' });
    await data('undoMergePeople', { brandId: 'charlie', confirm: true });
    cams = await prisma.contact.findMany({ where: { brandId: 'charlie' } });
    assert.equal(cams.length, 2);
    assert.ok(cams.every((c) => c.doNotContactAt) && cams[0].doNotContactAt.getTime() === cams[1].doNotContactAt.getTime(), 'still said: both copies keep it');
    await data('undoStopContact', { targetId: kept2.id });
    cams = await prisma.contact.findMany({ where: { brandId: 'charlie' } });
    assert.ok(cams.every((c) => !c.doNotContactAt), 'its Undo clears both');
    ok('merging the person’s two copies, and undoing it, never strands the mark on one of them');

    // ---- second review ----
    // A marked copy's row that comes back stamped for today (as an Undo of a
    // merge or of a Leave out can bring it) never shows in today's list.
    await data('handStep', { targetId: 't_alex', step: 'declined', scope: 'person' });
    await prisma.target.update({ where: { id: 't_alex2' }, data: { shelved: false, shelvedHow: null, queuedFor: new Date() } });
    const tq = JSON.stringify(await data('getTodayQueue'));
    assert.ok(!tq.includes('t_alex2'), 'a marked copy’s row is not in today’s list');
    assert.ok(!JSON.stringify(await data('todaySendList')).includes('Alex S.'), 'nor in Copy for Zach');
    const recap = await data('dayRecap');
    assert.ok(recap.reached.steps.some((x) => x.name === 'Alex Seamon' && x.stop), 'the recap lists it as a stop, not as outreach');
    // Through someone else: the brand stops via Beth while Alex has his own mark.
    const bpv2 = await data('handStep', { targetId: 't_beth', step: 'declined', scope: 'brand', preview: true });
    await data('handStep', { targetId: 't_beth', step: 'declined', scope: 'brand', expect: bpv2.expect });
    const noop = await data('undoStopContact', { targetId: 't_dana' });
    assert.equal(noop.already, true, 'an Undo through someone with no mark of their own changes nothing');
    assert.ok((await prisma.brand.findUnique({ where: { id: 'alpha' } })).stoppedAt, 'the brand stays stopped');
    const ua = await data('undoStopContact', { targetId: 't_alex' });
    assert.equal(ua.brandStopped, true);
    assert.ok(ua.stays.some((x) => /whole brand's stop stands/.test(x)), JSON.stringify(ua));
    assert.ok(!(await zachIds()).includes('t_alex'), 'still off Zach’s list: the brand’s stop stands');
    // The combine's Undo on a stopped company is refused.
    await prisma.setting.upsert({ where: { key: 'parentCombineLast' }, create: { key: 'parentCombineLast', value: JSON.stringify({ parent: 'Alpha', keeperId: 'alpha', at: new Date().toISOString(), brands: [{ id: 'gone1', name: 'Alpha Label' }], moved: {}, people: [] }) }, update: {} });
    const uc = await data('undoCombineParent', {});
    assert.ok(uc.blocks.some((x) => /Alpha Water said they don't want to continue/.test(x)), JSON.stringify(uc.blocks));
    await refused('undoCombineParent', { confirm: true }, /Alpha Water said they don't want to continue/);
    await prisma.setting.delete({ where: { key: 'parentCombineLast' } });
    await data('undoStopContact', { brandId: 'alpha' });
    assert.equal((await prisma.brand.findUnique({ where: { id: 'alpha' } })).stoppedAt, null);
    ok('today’s list never shows a marked copy’s row; the recap doesn’t count a stop; Undo through the wrong person changes nothing; the brand’s stop outlives a person’s Undo; a combine’s Undo is refused');

    // A copy whose LinkedIn link is stored percent-encoded (an accented name) is found.
    await prisma.brand.create({ data: { id: 'delta', name: 'Delta Drinks', category: 'beverage', tier: 'growth', usStatus: 'yes' } });
    await person('maria', 'delta', 'María López', 'Brand Partnerships', 'https://www.linkedin.com/in/maría-lópez-12/', { status: 'accepted', sentAt: ago(9) });
    await person('maria2', 'bravo', 'Maria L.', 'Marketing', 'https://www.linkedin.com/in/mar%C3%ADa-l%C3%B3pez-12/', { status: 'queued' });
    const rm = await data('handStep', { targetId: 't_maria', step: 'declined', scope: 'person' });
    assert.deepEqual(rm.twins, ['Maria L. (Bravo Soda)']);
    assert.ok((await prisma.contact.findUnique({ where: { id: 'c_maria2' } })).doNotContactAt, 'the encoded copy is marked');
    ok('a copy stored with a percent-encoded LinkedIn link is marked too');

    // ---- third review ----
    // Copies of copies: a SponsorUnited copy shares their email; a LinkedIn
    // copy of that one shares its name at its brand.
    await prisma.brand.create({ data: { id: 'echo', name: 'Echo Energy', category: 'energy', tier: 'growth', usStatus: 'yes' } });
    await prisma.brand.create({ data: { id: 'fox', name: 'Fox Fizz', category: 'beverage', tier: 'growth', usStatus: 'yes' } });
    await person('eve', 'echo', 'Eve Eng', 'Partnerships Lead', 'https://www.linkedin.com/in/eveeng/', { status: 'accepted', sentAt: ago(9) });
    await prisma.contact.update({ where: { id: 'c_eve' }, data: { email: 'eve@eng.com' } });
    await prisma.contact.create({ data: { id: 'c_eve2', brandId: 'fox', name: 'Eve Eng', title: 'Marketing', email: 'Eve@eng.com', source: 'sponsorunited' } });
    await person('eve3', 'fox', 'Eve Eng', 'Brand Manager', 'https://www.linkedin.com/in/eveeng-2/', { status: 'queued' });
    const re = await data('handStep', { targetId: 't_eve', step: 'declined', scope: 'person' });
    assert.deepEqual(re.twins.sort(), ['Eve Eng (Fox Fizz)', 'Eve Eng (Fox Fizz)'], JSON.stringify(re.twins));
    assert.ok((await prisma.target.findUnique({ where: { id: 't_eve3' } })).shelved, 'the copy of a copy’s waiting row is set aside');
    await data('undoStopContact', { targetId: 't_eve' });
    assert.equal(await prisma.contact.count({ where: { brandId: 'fox', doNotContactAt: { not: null } } }), 0, 'its Undo clears every copy');
    assert.ok(!(await prisma.target.findUnique({ where: { id: 't_eve3' } })).shelved, 'and brings the row back');
    // A copy filed after the stop (an old import) merged with a marked one:
    // the merge carries the mark, and its waiting row goes aside on the stop's record.
    await data('handStep', { targetId: 't_eve', step: 'declined', scope: 'person' });
    await prisma.contact.create({ data: { id: 'c_eve4', brandId: 'fox', name: 'Eve Eng', title: 'Head of Brand', linkedinUrl: 'https://www.linkedin.com/in/eve-eng-4/', source: 'linkedin' } });
    await prisma.target.create({ data: { id: 't_eve4', brandId: 'fox', contactId: 'c_eve4', status: 'queued', queuedFor: new Date() } });
    const mf = await data('mergePeople', { brandId: 'fox' });
    await data('mergePeople', { brandId: 'fox', confirm: true, expect: mf.expect });
    const foxLive = () => prisma.target.count({ where: { brandId: 'fox', status: { in: ['queued', 'drafted'] }, shelved: false } });
    assert.equal(await foxLive(), 0, 'after the merge nobody of theirs is waiting');
    assert.ok(!JSON.stringify(await data('getTodayQueue')).includes('t_eve4'), 'and nothing of theirs is in today’s list');
    await data('undoStopContact', { targetId: 't_eve' });
    assert.equal(await foxLive(), 1, 'the stop’s Undo brings the row the merge set aside back');
    ok('copies of copies are marked; a merge that carries the mark sets the waiting row aside, and the stop’s Undo brings it back');

    console.log('stop e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
