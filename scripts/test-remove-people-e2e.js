// scripts/test-remove-people-e2e.js — removePeople / undoRemovePeople against the real
// handlers and a throwaway Postgres (wiped). Leo, Nov 18 2026: the nicotine pouch brand
// Rogue had Rogue Fitness's people on it — "remove them". Names first, never someone
// written to or who said no, stale-checked, and an Undo that puts them back.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-remove-people-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-remove-people-e2e.js');
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

    // Rogue the pouch, with another company's people on it — and people who
    // must stay whatever is asked.
    const day = new Date('2026-11-12T15:00:00Z');
    await prisma.brand.create({ data: { id: 'rogue', name: 'Rogue', category: 'nicotine' } });
    await prisma.brand.create({ data: { id: 'other', name: 'Other Co', category: 'energy' } });
    const mk = (id, name, title, x = {}) => prisma.contact.create({ data: { id, brandId: 'rogue', name, title, linkedinUrl: 'https://www.linkedin.com/in/' + id, source: 'sponsorunited', ...x } });
    await mk('bill', 'Bill Henniger', 'Owner', { externalId: 'SU-1', notes: 'From SponsorUnited', isDecisionMaker: true });
    await mk('jon', 'Jonathan Hotaling', 'Director of Rogue Sponsorships and Events', { email: 'jon@example.com' });
    await mk('leia', 'Leia Baez', 'Media Liaison');
    await mk('tom', 'Tom Johnson', 'Creative Director');
    await mk('sent', 'Sent Sally', 'Brand Manager');
    await mk('stop', 'Stop Steve', 'Brand Manager', { doNotContactAt: day, doNotContactBy: 'Zach' });
    await mk('liz', 'Liz Listed', 'Brand Manager');
    await mk('mail', 'Mail Mary', 'Brand Manager');
    await mk('real', 'Christopher Fishe', 'Sr. Brand Manager, Swisher');
    await prisma.contact.create({ data: { id: 'else', brandId: 'other', name: 'Elsewhere Ed', title: 'CMO' } });
    const tg = (id, contactId, x = {}) => prisma.target.create({ data: { id, brandId: 'rogue', contactId, fitScore: 70, assignedTo: 'Zach', ...x } });
    await tg('t-bill', 'bill', { status: 'drafted' });
    await prisma.draft.create({ data: { targetId: 't-bill', variant: 'identity', connectionNote: 'Hi Bill', firstMessage: 'Thanks for connecting' } });
    await tg('t-jon', 'jon', { status: 'passed' });
    await tg('t-leia', 'leia', { shelved: true, shelvedHow: 'cap' });
    await tg('t-sent', 'sent', { status: 'sent', sentAt: day });
    await tg('t-stop', 'stop');
    await tg('t-mail', 'mail');
    await prisma.emailMessage.create({ data: { targetId: 't-mail', direction: 'out', kind: 'intro', status: 'sent', sentAt: day, subject: 'Hi', body: 'Hi' } });
    // An intro the email machine drafted and never sent: no history, it goes with Bill.
    await prisma.emailMessage.create({ data: { id: 'e-bill', targetId: 't-bill', direction: 'out', kind: 'intro', status: 'draft', subject: 'Hi', body: 'Hi' } });
    await prisma.repOutreach.create({ data: { rep: 'elizabeth', brandId: 'rogue', contactId: 'liz', brandName: 'Rogue', name: 'Liz Listed', channel: 'email', status: 'queued' } });

    const fitness = ['bill', 'jon', 'leia', 'tom'];
    const asked = [...fitness, 'sent', 'stop', 'liz', 'mail', 'else', 'nobody'];

    // 1. The preview names everyone and changes nothing.
    const pv = await data('removePeople', { brandId: 'rogue', contactIds: asked });
    assert.equal(pv.preview, true);
    assert.deepEqual(pv.remove.map(p => p.id).sort(), [...fitness].sort());
    assert.equal(pv.remove.find(p => p.id === 'bill').standing, 'in the queue, note drafted');
    assert.equal(pv.remove.find(p => p.id === 'bill').emailDrafts, 1, 'an unsent email draft keeps nobody');
    assert.equal(pv.remove.find(p => p.id === 'jon').standing, 'left out of the queue');
    assert.equal(pv.remove.find(p => p.id === 'leia').standing, 'next in line');
    assert.equal(pv.remove.find(p => p.id === 'tom').standing, 'not in the queue');
    assert.deepEqual(Object.fromEntries(pv.stay.map(p => [p.id, p.why])), { sent: 'reached', stop: 'stopped', liz: 'elizabeth', mail: 'emails' });
    assert.equal(pv.notAtBrand, 2, 'someone at another brand and an id that is nobody');
    assert.equal(pv.leftOnBrand, 5);
    assert.equal(await prisma.contact.count({ where: { brandId: 'rogue' } }), 9, 'a preview removes nobody');
    ok('the preview names who goes, how each stands, who stays and why — and writes nothing');

    // 2. A confirm without the preview's stamp, or after the list changed, is stale.
    let r = await data('removePeople', { brandId: 'rogue', contactIds: asked, confirm: true });
    assert.equal(r.stale, true);
    r = await data('removePeople', { brandId: 'rogue', contactIds: fitness.slice(0, 3), confirm: true, expect: pv.expect });
    assert.equal(r.stale, true, 'another list than the one previewed');
    await prisma.target.create({ data: { id: 't-tom', brandId: 'rogue', contactId: 'tom', status: 'sent', sentAt: new Date() } });
    r = await data('removePeople', { brandId: 'rogue', contactIds: asked, confirm: true, expect: pv.expect });
    assert.equal(r.stale, true, 'Tom was invited since the preview');
    assert.equal(r.stay.find(p => p.id === 'tom').why, 'reached');
    assert.equal(await prisma.contact.count({ where: { brandId: 'rogue' } }), 9);
    await prisma.target.delete({ where: { id: 't-tom' } });
    await prisma.emailMessage.update({ where: { id: 'e-bill' }, data: { status: 'sent', sentAt: new Date() } });
    r = await data('removePeople', { brandId: 'rogue', contactIds: asked, confirm: true, expect: pv.expect });
    assert.equal(r.stale, true, 'Bill\'s email went out since the preview');
    assert.equal(r.stay.find(p => p.id === 'bill').why, 'emails');
    await prisma.emailMessage.update({ where: { id: 'e-bill' }, data: { status: 'draft', sentAt: null } });
    ok('no stamp, another list, or an invite sent since the preview: stale, shown again, nobody removed');

    // 3. Confirm: exactly the previewed people go, with their queue rows and drafts.
    r = await data('removePeople', { brandId: 'rogue', contactIds: asked, confirm: true, expect: pv.expect });
    assert.equal(r.ok, true); assert.equal(r.removed, 4);
    assert.deepEqual([...r.people].sort(), ['Bill Henniger', 'Jonathan Hotaling', 'Leia Baez', 'Tom Johnson']);
    const left = (await prisma.contact.findMany({ where: { brandId: 'rogue' }, select: { id: true } })).map(c => c.id).sort();
    assert.deepEqual(left, ['liz', 'mail', 'real', 'sent', 'stop']);
    assert.equal(await prisma.target.count({ where: { contactId: { in: fitness } } }), 0);
    assert.equal(await prisma.draft.count({ where: { targetId: 't-bill' } }), 0);
    assert.equal(await prisma.emailMessage.count({ where: { id: 'e-bill' } }), 0, 'the unsent draft went with him');
    assert.equal(await prisma.emailMessage.count({ where: { targetId: 't-mail' } }), 1, 'a sent email stays with its person');
    assert.ok(await prisma.contact.findUnique({ where: { id: 'else' } }), 'another brand\'s person is never touched');
    assert.ok((await prisma.contact.findUnique({ where: { id: 'stop' } })).doNotContactAt, 'the no stays on file');
    assert.equal((await prisma.target.findUnique({ where: { id: 't-sent' } })).status, 'sent');
    assert.equal(await prisma.repOutreach.count({ where: { contactId: 'liz' } }), 1);
    ok('confirm removes exactly the previewed four; everyone written to, stopped, emailed or on Elizabeth\'s list stays');

    // 4. It shows on Claude's day as one line; the preview and stale answers never did.
    const acts = await prisma.claudeAction.findMany({ where: { fn: 'removePeople' } });
    assert.equal(acts.length, 1, JSON.stringify(acts.map(a => a.text)));
    assert.match(acts[0].text, /^Removed 4 people from Rogue \(/);
    ok('Claude\'s day logs the removal once, in words');

    // 5. Undo: preview first, then the same people back with their place in the queue.
    await prisma.contact.create({ data: { brandId: 'rogue', name: 'William Henniger', title: 'Owner', linkedinUrl: 'https://linkedin.com/in/BILL/' } });
    let u = await data('undoRemovePeople', {});
    assert.equal(u.preview, true);
    assert.deepEqual(u.back.map(p => p.name).sort(), ['Jonathan Hotaling', 'Leia Baez', 'Tom Johnson']);
    assert.deepEqual(u.alreadyThere, ['Bill Henniger'], 'saved again since, under the same profile');
    assert.equal(await prisma.contact.count({ where: { brandId: 'rogue' } }), 6, 'the preview puts nobody back');
    u = await data('undoRemovePeople', { confirm: true });
    assert.equal(u.back, 3);
    const jon = await prisma.contact.findFirst({ where: { brandId: 'rogue', name: 'Jonathan Hotaling' }, include: { targets: true } });
    assert.equal(jon.email, 'jon@example.com'); assert.equal(jon.source, 'sponsorunited');
    assert.equal(jon.targets[0].status, 'passed', 'left out of the queue, as before');
    const leia = await prisma.contact.findFirst({ where: { brandId: 'rogue', name: 'Leia Baez' }, include: { targets: true } });
    assert.equal(leia.targets.length, 1);
    const tom = await prisma.contact.findFirst({ where: { brandId: 'rogue', name: 'Tom Johnson' }, include: { targets: true } });
    assert.equal(tom.targets.length, 0, 'had no queue row, gets none');
    await assert.rejects(() => data('undoRemovePeople', { confirm: true }), /No removal to undo/);
    ok('Undo names who comes back, skips someone saved again since, and works once');

    // 6. Refusals.
    await assert.rejects(() => data('removePeople', { brandId: 'nope', contactIds: ['a'] }), /Brand not found/);
    await assert.rejects(() => data('removePeople', { brandId: 'rogue', contactIds: [] }), /Name the people/);
    const none = await data('removePeople', { brandId: 'rogue', contactIds: ['sent', 'stop'] });
    r = await data('removePeople', { brandId: 'rogue', contactIds: ['sent', 'stop'], confirm: true, expect: none.expect });
    assert.equal(r.ok, false); assert.equal(r.removed, 0);
    assert.equal(await prisma.contact.count({ where: { id: { in: ['sent', 'stop'] } } }), 2);
    ok('an unknown brand, an empty list, and a list of only people who must stay remove nobody');

    console.log('remove-people e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
