// scripts/test-find-emails-e2e.js — Outreach → Email's "Emails for people who
// didn't answer on LinkedIn" (Leo, Nov 16 2026) against the real handlers and
// a throwaway Postgres (wiped): who's on the list for Hunter (never a brand
// that answered, is in talks, said no, stopped, archived; never a fresh
// invite or a name LinkedIn cut short), where Hunter looks a brand up (the
// domain its people already mail from, else its website, a parent's name for
// a label), Hunter's file brought back — preview first, only empty email
// fields filled, never over another address, never a stopped person, never
// somebody else's address — the stale check, the Claude's-day line, and Undo
// (names who loses theirs; a changed address stays).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-find-emails-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-find-emails-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3479);
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
const cell = (v) => (/[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
const csv = (grid) => grid.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

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
    const brand = (id, name, extra) => prisma.brand.create({ data: Object.assign({ id, name, category: 'energy' }, extra || {}) });
    const mk = async (id, brandId, name, t, accept, extra) => {
      const c = await prisma.contact.create({ data: Object.assign({ id, brandId, name, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id }, extra || {}) });
      const row = await prisma.target.create({ data: Object.assign({ brandId, contactId: c.id }, t) });
      if (accept) await prisma.targetEvent.create({ data: { targetId: row.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: accept } });
      return { c, row };
    };

    // Nobody accepted: two old invites, a fresh one, a withdrawn one, a name cut short, one who has an email, one never invited.
    await brand('b_cold', 'Cold Co', { website: 'https://www.coldco.com/shop' })
    await mk('c_ann', 'b_cold', 'Ann Lee', { status: 'sent', sentAt: D(30) })
    await mk('c_bo', 'b_cold', 'Dr. Bo Chen, MBA', { status: 'sent', sentAt: D(25) }, null, { notes: 'Met at SXSW' })
    await mk('c_new', 'b_cold', 'Ned New', { status: 'sent', sentAt: D(4) })
    await mk('c_wd', 'b_cold', 'Wes Drew', { status: 'withdrawn', sentAt: D(6) })
    await mk('c_cut', 'b_cold', 'Cara S.', { status: 'sent', sentAt: D(30) })
    await mk('c_has', 'b_cold', 'Hal Has', { status: 'sent', sentAt: D(30) }, null, { email: 'Hal.Has@ColdCo.com' })
    await mk('c_q', 'b_cold', 'Quinn Queued', { status: 'queued' })
    // A label under a parent: its people already mail from the parent's domain.
    await brand('b_ketel', 'Ketel One', { website: 'https://www.ketelone.com' })
    await mk('c_kay', 'b_ketel', 'Kay Vodka', { status: 'sent', sentAt: D(40) })
    await mk('c_kim', 'b_ketel', 'Kim Mail', { status: 'sent', sentAt: D(40) }, null, { email: 'kim.mail@diageo.com' })
    // A label under a parent with no address on file: looked up by the parent's name.
    await brand('b_smir', 'Smirnoff', { website: 'https://www.smirnoff.com' })
    await mk('c_sam', 'b_smir', 'Sam Spirit', { status: 'sent', sentAt: D(40) })
    // Accepted, then quiet after the final reach-out.
    await brand('b_quiet', 'Quiet Co')
    await mk('c_qi', 'b_quiet', 'Qi Quiet', { status: 'accepted', sentAt: D(60), dmSentAt: D(55), nudgedAt: D(30) }, D(57))
    // Someone accepted and is still being worked: the brand waits.
    await brand('b_wait', 'Waiting Co', { website: 'waitingco.com' })
    await mk('c_wa', 'b_wait', 'Wa Accepted', { status: 'accepted', sentAt: D(12), dmSentAt: D(3) }, D(9))
    await mk('c_wb', 'b_wait', 'Wb Invited', { status: 'sent', sentAt: D(30) })
    // Replied / in talks / said no / stopped / archived / do not email: never on the list.
    await brand('b_rep', 'Reply Co')
    await mk('c_r1', 'b_rep', 'Rita Reply', { status: 'replied', sentAt: D(30), repliedAt: D(5) }, D(20))
    await mk('c_r2', 'b_rep', 'Rob Invited', { status: 'sent', sentAt: D(30) })
    await brand('b_no', 'No Co')
    await mk('c_n1', 'b_no', 'Nat No', { status: 'declined', sentAt: D(30) })
    await mk('c_n2', 'b_no', 'Nia Invited', { status: 'sent', sentAt: D(30) })
    await brand('b_stop', 'Stop Co', { stoppedAt: D(2), passedAt: D(2), doNotEmail: true })
    await mk('c_s1', 'b_stop', 'Sid Stop', { status: 'sent', sentAt: D(30) })
    await brand('b_arch', 'Archived Co', { passedAt: D(2) })
    await mk('c_a1', 'b_arch', 'Art Archived', { status: 'sent', sentAt: D(30) })
    await brand('b_dne', 'Quiet Please Co', { doNotEmail: true })
    await mk('c_d1', 'b_dne', 'Dee Dne', { status: 'sent', sentAt: D(30) })
    // One person at a cold brand said they don't want to continue ("just me"): the company isn't approached again.
    await brand('b_mix', 'Mixed Co', { website: 'mixedco.com' })
    await mk('c_m1', 'b_mix', 'Max Stopped', { status: 'sent', sentAt: D(30) }, null, { doNotContactAt: D(3), doNotContactBy: 'leo', email: null })
    await mk('c_m2', 'b_mix', 'May Fine', { status: 'sent', sentAt: D(30) })
    // A person (Show Board) is never a brand.
    await brand('b_person', 'Pat Person', { kind: 'person', passedAt: D(1), doNotEmail: true })

    // ---- the list ----
    let l = await data('noAnswerList')
    const ids = (rows) => rows.map(r => r.contactId).sort()
    // No Co (Nat said no) and Mixed Co (Max asked us to stop): their never-accepted colleagues stay off the list too.
    assert.deepEqual(ids(l.people), ['c_ann', 'c_bo', 'c_kay', 'c_qi', 'c_sam', 'c_wd'])
    assert.deepEqual(ids(l.ready), ['c_has', 'c_kim'])
    assert.equal(l.minDays, 21)
    assert.equal(l.counts.need, 6); assert.equal(l.counts.needBrands, 4)
    assert.equal(l.counts.noaccept, 5); assert.equal(l.counts.quiet, 1)
    assert.equal(l.counts.have, 2); assert.equal(l.counts.tooNew, 1); assert.equal(l.counts.noName, 1)
    assert.equal(l.counts.waitingBrands, 1)
    assert.equal(l.counts.offBrands, 2, 'Archived Co and Quiet Please Co (Stop Co said no more — never offered)')
    assert.equal(l.last, null)
    const by = (id) => l.people.find(p => p.contactId === id) || l.ready.find(p => p.contactId === id)
    assert.deepEqual([by('c_bo').first, by('c_bo').last], ['Bo', 'Chen'])
    assert.equal(by('c_qi').group, 'quiet'); assert.equal(by('c_ann').group, 'noaccept')
    for (const id of ['c_n2', 'c_m2', 'c_r2', 'c_wb', 'c_s1', 'c_a1', 'c_d1', 'c_q', 'c_new', 'c_cut'])
      assert.equal(l.people.some(p => p.contactId === id) || l.ready.some(p => p.contactId === id), false, id + ' is not on the list')
    ok('the list: invited 21+ days ago with no accept (or withdrawn), or accepted and gone quiet — at brands nobody answered from');

    assert.deepEqual([by('c_ann').company, by('c_ann').domain, by('c_ann').domainFrom], ['Cold Co', 'coldco.com', 'emails'])
    assert.deepEqual([by('c_kay').company, by('c_kay').domain, by('c_kay').domainFrom, by('c_kay').parent], ['Ketel One', 'diageo.com', 'emails', 'Diageo'])
    assert.deepEqual([by('c_sam').company, by('c_sam').domain, by('c_sam').parent], ['Diageo', null, 'Diageo'])
    assert.deepEqual([by('c_qi').company, by('c_qi').domain], ['Quiet Co', null])
    assert.equal(l.counts.noDomain, 2)
    ok('where Hunter looks: the domain its people mail from, else the website; a label with neither goes by its parent');

    l = await data('noAnswerList', { minDays: 0 })
    assert.deepEqual(ids(l.people), ['c_ann', 'c_bo', 'c_kay', 'c_new', 'c_qi', 'c_sam', 'c_wd'])
    assert.equal(l.counts.tooNew, 0)
    ok('any time lets the fresh invite in');

    // ---- Hunter's file ----
    const HEAD = ['First name', 'Last name', 'Company', 'Company website', 'SB brand', 'SB title', 'SB LinkedIn', 'SB id', 'Email address', 'Confidence score', 'Verification status'];
    const line = (id, first, last, brandName, email, status, score) => [first, last, brandName, '', brandName, 'Head of Partnerships', '', id, email, score == null ? '' : score, status || ''];
    const file = csv([HEAD,
      line('c_ann', 'Ann', 'Lee', 'Cold Co', 'Ann.Lee@ColdCo.com', 'valid', 97),
      line('c_bo', 'Bo', 'Chen', 'Cold Co', 'bo@coldco.com', 'accept_all', 70),
      line('c_wd', 'Wes', 'Drew', 'Cold Co', '', '', ''),
      line('c_kay', 'Kay', 'Vodka', 'Ketel One', 'kim.mail@diageo.com', 'valid', 90),
      line('c_has', 'Hal', 'Has', 'Cold Co', 'hal@elsewhere.com', 'valid', 90),
      line('c_sam', 'Sam', 'Spirit', 'Smirnoff', 'sam.spirit@diageo.com', 'invalid', 5),
      line('c_m1', 'Max', 'Stopped', 'Mixed Co', 'max@mixedco.com', 'valid', 95),
      line('c_s1', 'Sid', 'Stop', 'Stop Co', 'sid@stopco.com', 'valid', 95),
      line('c_gone', 'No', 'Body', 'Nowhere', 'no.body@nowhere.com', 'valid', 95),
      line('c_qi', 'Qi', 'Quiet', 'Quiet Co', 'qi@quietco.com', 'valid', 92),
    ]);
    const pv = await data('saveFoundEmails', { csv: file })
    assert.equal(pv.preview, true)
    assert.equal(pv.rows, 10); assert.equal(pv.notFound, 1)
    assert.deepEqual(pv.cols, { email: 'Email address', status: 'Verification status', score: 'Confidence score', id: 'SB id' })
    assert.deepEqual(pv.lines.map(x => [x.contactId, x.action, x.tick]), [
      ['c_ann', 'save', true], ['c_bo', 'save', false], ['c_kay', 'taken', false], ['c_has', 'has', false], ['c_sam', 'invalid', false],
      ['c_m1', 'stopped', false], ['c_s1', 'stopped', false], [null, 'unknown', false], ['c_qi', 'save', true],
    ])
    assert.match(pv.lines[2].why, /Kim Mail’s address at Ketel One/)
    assert.match(pv.lines[3].why, /Already has hal\.has@coldco\.com/)
    assert.match(pv.lines[5].why, /Max Stopped said they don't want to continue/)
    assert.match(pv.lines[6].why, /Stop Co said they don't want to continue/)
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_ann' } })).email, null, 'a preview writes nothing')
    assert.equal(await prisma.claudeAction.count({ where: { fn: 'saveFoundEmails' } }), 0, 'a preview is not a change')
    ok('Hunter’s file: every line named before anything is saved — taken, already has one, invalid, stopped, not on file');

    await assert.rejects(data('saveFoundEmails', { csv: csv([HEAD.slice(0, 8), ['Ann', 'Lee', 'Cold Co', '', 'Cold Co', '', '', 'c_ann']]) }), /No email addresses in that file/)
    await assert.rejects(data('saveFoundEmails', { csv: '' }), /no rows/)
    await assert.rejects(data('saveFoundEmails', { csv: file, confirm: true, expect: pv.expect, ids: [] }), /Nothing is ticked/)
    ok('the wrong file, an empty one and nothing ticked are refused');

    // Stale: someone typed Qi's email in since the preview.
    await prisma.contact.update({ where: { id: 'c_qi' }, data: { email: 'qi@typed.com' } })
    const stale = await data('saveFoundEmails', { csv: file, confirm: true, expect: pv.expect, ids: ['c_ann', 'c_bo', 'c_qi'] })
    assert.equal(stale.stale, true); assert.equal(stale.applied, false)
    assert.equal(stale.lines.find(x => x.contactId === 'c_qi').action, 'has')
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_ann' } })).email, null, 'a stale answer writes nothing')
    ok('changed since the preview: shown again, nothing written');

    // Save: only the ticked, only empty fields.
    const done = await data('saveFoundEmails', { csv: file, confirm: true, expect: stale.expect, ids: ['c_ann', 'c_bo', 'c_qi', 'c_has', 'c_m1'] })
    assert.equal(done.applied, true); assert.equal(done.saved, 2); assert.equal(done.brands, 1)
    const ann = await prisma.contact.findUnique({ where: { id: 'c_ann' } })
    const bo = await prisma.contact.findUnique({ where: { id: 'c_bo' } })
    assert.equal(ann.email, 'ann.lee@coldco.com')
    assert.match(ann.notes, /^Email added from Hunter’s file, .* \(verified\)$/)
    assert.equal(bo.email, 'bo@coldco.com')
    assert.match(bo.notes, /^Met at SXSW\nEmail added from Hunter’s file, .* \(not verified\)$/)
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_has' } })).email, 'Hal.Has@ColdCo.com', 'never over an address already there')
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_qi' } })).email, 'qi@typed.com')
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_m1' } })).email, null, 'never someone who said they don’t want to continue')
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_kay' } })).email, null, 'never somebody else’s address')
    const act = await prisma.claudeAction.findMany({ where: { fn: 'saveFoundEmails' } })
    assert.equal(act.length, 1)
    assert.match(act[0].text, /Saved 2 emails from Hunter's file/)
    ok('Save fills only the ticked people’s empty email fields, with a note, and Claude’s day words it');

    l = await data('noAnswerList')
    assert.deepEqual(ids(l.people), ['c_kay', 'c_sam', 'c_wd'])
    assert.deepEqual(ids(l.ready), ['c_ann', 'c_bo', 'c_has', 'c_kim', 'c_qi'])
    assert.equal(l.last.count, 2); assert.equal(l.last.by, 'Claude')
    // The same file again: nothing left to save for them.
    const again = await data('saveFoundEmails', { csv: file })
    assert.deepEqual(again.lines.filter(x => ['c_ann', 'c_bo'].includes(x.contactId)).map(x => x.action), ['same', 'same'])
    ok('the people saved move to "already have an email"; the same file again saves nothing');

    // A file without our id column: matched by name and brand, or the profile link.
    const loose = csv([
      ['Full name', 'Company', 'LinkedIn URL', 'Work Email', 'Email Status'],
      ['Wes Drew', 'Cold Co', '', 'wes@coldco.com', 'Verified'],
      ['Somebody Renamed', 'Whatever', 'https://www.linkedin.com/in/c_sam/', 'sam@diageo.com', 'Verified'],
      ['Zed Zero', 'Nowhere', '', 'zed@nowhere.com', 'Verified'],
      // Hal's address is on file as "Hal.Has@ColdCo.com": the same address in any case is his.
      ['Kay Vodka', 'Ketel One', '', 'HAL.HAS@coldco.com', 'Verified'],
    ]);
    const lp = await data('saveFoundEmails', { csv: loose })
    assert.equal(lp.cols.id, null)
    assert.deepEqual(lp.lines.map(x => [x.contactId, x.action]), [['c_wd', 'save'], ['c_sam', 'save'], [null, 'unknown'], ['c_kay', 'taken']])
    assert.match(lp.lines[3].why, /Hal Has’s address at Cold Co/)
    ok('a file without the SB id column is matched by name and brand, else the profile link');

    // ---- Undo ----
    await prisma.contact.update({ where: { id: 'c_bo' }, data: { email: 'bo.chen@coldco.com' } })
    const up = await data('undoFoundEmails')
    assert.equal(up.preview, true); assert.equal(up.count, 2)
    assert.deepEqual(up.goes.map(g => g.name), ['Ann Lee'])
    assert.deepEqual(up.stays.map(s => [s.name, s.why]), [['Dr. Bo Chen, MBA', 'their email was changed since']])
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_ann' } })).email, 'ann.lee@coldco.com', 'the preview takes nothing back')
    const un = await data('undoFoundEmails', { confirm: true })
    assert.equal(un.applied, true); assert.equal(un.removed, 1)
    const ann2 = await prisma.contact.findUnique({ where: { id: 'c_ann' } })
    assert.equal(ann2.email, null); assert.equal(ann2.notes, null)
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_bo' } })).email, 'bo.chen@coldco.com')
    await assert.rejects(data('undoFoundEmails'), /Nothing to undo/)
    assert.equal((await data('noAnswerList')).last, null)
    const undone = await prisma.claudeAction.findMany({ where: { fn: 'undoFoundEmails' } })
    assert.equal(undone.length, 1)
    assert.match(undone[0].text, /Took back 1 email saved from Hunter's file/)
    ok('Undo names who loses their email first, leaves a changed one alone, and takes the note back out');

    // An email drafted to someone since: their address stays on Undo.
    const p2 = await data('saveFoundEmails', { csv: file })
    await data('saveFoundEmails', { csv: file, confirm: true, expect: p2.expect, ids: ['c_ann'] })
    const annRow = await prisma.target.findFirst({ where: { contactId: 'c_ann' } })
    await prisma.emailMessage.create({ data: { targetId: annRow.id, direction: 'out', kind: 'intro', status: 'draft', toEmail: 'ann.lee@coldco.com', subject: 'Hi', body: 'Hi Ann' } })
    const up2 = await data('undoFoundEmails')
    assert.deepEqual(up2.goes, [])
    assert.deepEqual(up2.stays.map(s => s.why), ['an email to them was drafted or sent since'])
    ok('an address an email was drafted to since stays on Undo');

    // ---- never sends ----
    assert.equal(await prisma.emailMessage.count({ where: { status: 'sent' } }), 0)
    ok('nothing was emailed');
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
  console.log(`\nfind-emails e2e: all ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
