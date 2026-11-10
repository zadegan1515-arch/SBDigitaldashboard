// scripts/test-tracker-e2e.js — In talks → Every brand reached against the real
// handlers and a throwaway Postgres (wiped): every brand reached (an invite, an
// accept logged with no invite, a hand or machine email, Elizabeth's rows) and
// every brand on In talks, each at one step — Reached out → Accepted → Replied
// → Wants to continue → Email sent → In talks, or Out — with its people, what's
// next, the counts and the "so far" numbers; never a person-brand, never a
// brand nobody was written to (outreachTracker, src/lib/tracker.ts).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-tracker-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-tracker-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3477);
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
    const brand = (id, name, extra) => prisma.brand.create({ data: Object.assign({ id, name, category: 'energy' }, extra || {}) });
    const mk = async (brandId, name, title, t, accept, extra) => {
      const c = await prisma.contact.create({ data: Object.assign({ brandId, name, title, linkedinUrl: 'https://www.linkedin.com/in/' + name.toLowerCase().replace(/\W+/g, '') }, extra || {}) });
      const row = await prisma.target.create({ data: Object.assign({ brandId, contactId: c.id }, t) });
      if (accept) await prisma.targetEvent.create({ data: { targetId: row.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: accept } });
      return { c, row };
    };

    // Reached out: an invite, nobody answered.
    await brand('b_reach', 'Reach Co')
    await mk('b_reach', 'Rae Reach', 'Partnerships', { status: 'sent', sentAt: D(3) })
    await mk('b_reach', 'Quinn Queued', 'Marketing', { status: 'queued' })
    // Accepted, the first message due (accepted 9 days ago, no DM).
    await brand('b_acc', 'Accept Co')
    await mk('b_acc', 'Al Accept', 'Events Manager', { status: 'accepted', sentAt: D(12) }, D(9))
    // An accept logged from LinkedIn with no invite date counts as reached.
    await brand('b_log', 'Logged Co')
    await mk('b_log', 'Lou Logged', 'Brand Manager', { status: 'accepted' })
    // Replied, no path yet.
    await brand('b_rep', 'Reply Co')
    await mk('b_rep', 'Rita Reply', 'Head of Partnerships', { status: 'replied', sentAt: D(10), repliedAt: D(2) }, D(8))
    // Wants an email, not sent.
    await brand('b_cont', 'Continue Co')
    await mk('b_cont', 'Cal Cont', 'Marketing Director', { status: 'replied', sentAt: D(10), repliedAt: D(3), handWantsEmailAt: D(3) }, D(8))
    await mk('b_cont', 'Ivy Invited', 'Brand Manager', { status: 'sent', sentAt: D(10) })
    // Email sent after they wanted it.
    await brand('b_mail', 'Mailed Co')
    await mk('b_mail', 'Mo Mailed', 'Partnerships Lead', { status: 'replied', sentAt: D(14), repliedAt: D(6), handWantsEmailAt: D(6), emailedAt: D(4) }, D(11))
    // In talks: a call booked.
    await brand('b_call', 'Call Co')
    await mk('b_call', 'Cora Call', 'VP Marketing', { status: 'replied', sentAt: D(20), repliedAt: D(8), callAt: new Date(Date.now() + 4 * 864e5), callBookedAt: D(1) }, D(15))
    // In talks by hand, nobody reached on the site.
    await brand('b_hand', 'Hand Co', { talksAddedAt: D(1), talksAddedBy: 'Leo' })
    // An open deal, a plain accept.
    await brand('b_deal', 'Deal Co')
    await mk('b_deal', 'Dee Deal', 'Founder', { status: 'accepted', sentAt: D(12), dmSentAt: D(8) }, D(10))
    await prisma.deal.create({ data: { brandId: 'b_deal', name: 'Deal Co — spring', stage: 'proposal', valueCents: 500000 } })
    // Out: said no; doesn't want to continue (whole brand); gone quiet after the final.
    await brand('b_no', 'No Co')
    await mk('b_no', 'Nat No', 'CMO', { status: 'declined', sentAt: D(30) })
    await brand('b_stop', 'Stop Co', { stoppedAt: D(2), passedAt: D(2), doNotEmail: true })
    await mk('b_stop', 'Sid Stop', 'Events', { status: 'replied', sentAt: D(15), repliedAt: D(5), handDeclinedAt: D(2), handDeclinedScope: 'brand' }, D(12))
    await brand('b_quiet', 'Quiet Co')
    await mk('b_quiet', 'Qi Quiet', 'Marketing', { status: 'accepted', sentAt: D(40), dmSentAt: D(35), nudgedAt: D(20) }, D(37))
    // A call, then taken off In talks.
    await brand('b_off', 'Off Co', { talksRemovedAt: D(1) })
    await mk('b_off', 'Oz Off', 'Brand', { status: 'replied', sentAt: D(20), repliedAt: D(9), callAt: D(4), callBookedAt: D(7) }, D(15))
    // The email machine: a cold email, no answer.
    await brand('b_machine', 'Machine Co')
    const m = await mk('b_machine', 'Mac Machine', 'Partnerships', { status: 'drafted' })
    await prisma.emailMessage.create({ data: { targetId: m.row.id, direction: 'out', kind: 'intro', status: 'sent', sentAt: D(5), subject: 's', body: 'b' } })
    // Elizabeth: an email that got a reply, and her LinkedIn accept at a brand Zach invited.
    await brand('b_el', 'Liz Co')
    const lc = await prisma.contact.create({ data: { brandId: 'b_el', name: 'Elle Email', title: 'Founder', email: 'elle@liz.co' } })
    await prisma.repOutreach.create({ data: { rep: 'elizabeth', brandId: 'b_el', contactId: lc.id, brandName: 'Liz Co', name: 'Elle Email', title: 'Founder', email: 'elle@liz.co', channel: 'email', status: 'replied', sentAt: D(6), repliedAt: D(2) } })
    const zr = await mk('b_reach', 'Zed Both', 'Brand Manager', { status: 'sent', sentAt: D(2) })
    await prisma.repOutreach.create({ data: { rep: 'elizabeth', brandId: 'b_reach', contactId: zr.c.id, brandName: 'Reach Co', name: 'Zed Both', title: 'Brand Manager', channel: 'linkedin', status: 'accepted', sentAt: D(6), acceptedAt: D(4) } })
    // Her row still waiting to go out doesn't count.
    await brand('b_elq', 'Liz Queue Co')
    await prisma.repOutreach.create({ data: { rep: 'elizabeth', brandId: 'b_elq', brandName: 'Liz Queue Co', name: 'Wait', channel: 'email', status: 'queued' } })
    // Never in: a brand nobody was written to, a person.
    await brand('b_none', 'Nobody Co')
    await mk('b_none', 'Nan None', 'Marketing', { status: 'queued' })
    await brand('b_person', 'Pat Person', { kind: 'person', passedAt: D(1), doNotEmail: true })
    await mk('b_person', 'Pat Person', null, { status: 'sent', sentAt: D(2) })

    const r = await data('outreachTracker')
    const by = Object.fromEntries(r.brands.map(b => [b.id, b]))
    if (process.env.TK_DEBUG) console.log(JSON.stringify(r.brands.map(b => [b.id, b.stage, b.out]), null, 0))
    const stageOf = (id) => by[id] && [by[id].stage, by[id].out]
    assert.ok(!by.b_none && !by.b_person && !by.b_elq, 'only brands written to, never a person or a row still waiting')
    assert.deepEqual(stageOf('b_reach'), ['accepted', null], 'Elizabeth’s accept lifts a brand Zach only invited')
    assert.deepEqual(stageOf('b_acc'), ['accepted', null])
    assert.deepEqual(stageOf('b_log'), ['accepted', null])
    assert.deepEqual(stageOf('b_rep'), ['replied', null])
    assert.deepEqual(stageOf('b_cont'), ['continue', null])
    assert.deepEqual(stageOf('b_mail'), ['emailed', null])
    assert.deepEqual(stageOf('b_call'), ['talks', null])
    assert.deepEqual(stageOf('b_hand'), ['talks', null])
    assert.deepEqual(stageOf('b_deal'), ['talks', null])
    assert.deepEqual(stageOf('b_no'), ['out', 'no'])
    assert.deepEqual(stageOf('b_stop'), ['out', 'stopped'])
    assert.deepEqual(stageOf('b_quiet'), ['out', 'quiet'])
    assert.deepEqual(stageOf('b_off'), ['out', 'removed'])
    assert.deepEqual(stageOf('b_machine'), ['reached', null])
    assert.deepEqual(stageOf('b_el'), ['replied', null])
    ok('every brand reached sits at its step: reached, accepted, replied, wants to continue, email sent, in talks, out')

    // Order: furthest step first, Out last.
    const order = r.brands.map(b => b.stage)
    const rank = { talks: 0, emailed: 1, lireply: 1.5, continue: 2, referral: 2.5, replied: 3, accepted: 4, reached: 5, out: 6 }
    assert.deepEqual(order, [...order].sort((a, b) => rank[a] - rank[b]), 'furthest step first: ' + order.join(','))
    // Inside Replied: Rita (Zach, ours to do) and Elizabeth's — both ours.
    assert.ok(by.b_rep.onUs && by.b_el.onUs)
    assert.ok(by.b_acc.onUs && /Text them on LinkedIn/.test(by.b_acc.next) && by.b_acc.due, 'accepted 9 days ago: the first message is late')
    assert.ok(!by.b_deal.onUs && by.b_deal.next === 'Deal · proposal sent', by.b_deal.next)
    assert.ok(/^Call /.test(by.b_call.next) && by.b_call.nextCallAt && by.b_call.inTalks)
    assert.equal(by.b_hand.next, 'Added to In talks')
    assert.equal(by.b_hand.people.length, 0)
    assert.equal(by.b_cont.next, 'Send them the email')
    assert.ok(/^Emailed .* — book the call$/.test(by.b_mail.next), by.b_mail.next)
    assert.ok(/^Emailed .* — no answer yet$/.test(by.b_machine.next), by.b_machine.next)
    assert.ok(by.b_stop.archived && by.b_stop.next === 'Doesn’t want to continue')
    ok('what’s next for each, ours to do flagged (late first message), calls and deals');

    // People: the reached ones only, furthest first, who reached them.
    assert.deepEqual(by.b_reach.people.map(p => [p.name, p.by, p.stage]), [['Zed Both', 'elizabeth', 'accepted'], ['Zed Both', 'zach', 'reached'], ['Rae Reach', 'zach', 'reached']])
    assert.ok(by.b_reach.elizabeth)
    assert.deepEqual(by.b_cont.people.map(p => [p.name, p.stage, p.label]), [['Cal Cont', 'continue', 'wants an email'], ['Ivy Invited', 'reached', 'invited']])
    assert.equal(by.b_cont.lead.name, 'Cal Cont')
    const elle = by.b_el.people[0]
    assert.deepEqual([elle.by, elle.channel, elle.email, elle.next], ['elizabeth', 'email', 'elle@liz.co', 'They replied to Elizabeth — book a call'])
    assert.equal(by.b_machine.people[0].channel, 'email')
    assert.ok(by.b_machine.people[0].emailedAt)
    assert.deepEqual(by.b_mail.steps, ['reached', 'accepted', 'replied', 'continue', 'emailed'])
    assert.deepEqual(by.b_call.steps, ['reached', 'accepted', 'replied', 'talks'])
    ok('each brand’s people (Zach’s and Elizabeth’s), the lead person, the steps it got through');

    // Counts.
    assert.equal(r.total, 15)
    assert.deepEqual(r.counts, { referred: 0, reached: 1, accepted: 3, replied: 2, referral: 0, continue: 1, lireply: 0, emailed: 1, talks: 3, out: 4 })
    assert.equal(r.onUs.replied, 2)
    assert.equal(r.onUs.continue, 1)
    // So far: every brand reached; accepted = anyone accepted, also the ones out since.
    assert.equal(r.ever.reached, 15)
    // Accepted: Reach (Elizabeth), Accept, Logged, Reply, Continue, Mailed, Call, Deal, Stop, Quiet, Off — not No Co (said no straight off).
    assert.equal(r.ever.accepted, 11, JSON.stringify(r.ever))
    assert.equal(r.ever.replied, 7)    // Reply, Continue, Mailed, Call, Stop, Off, Liz
    assert.equal(r.ever.continue, 2)
    assert.equal(r.ever.emailed, 1)
    assert.equal(r.ever.talks, 4)    // call, hand, deal, and Off Co's call before it came off
    assert.deepEqual(r.stages.map(s => s.key), ['referred', 'reached', 'accepted', 'replied', 'referral', 'continue', 'lireply', 'emailed', 'talks', 'out'])
    ok('the counts per step, ours to do, and the so-far numbers');

    // Read-only: nothing changed, no ClaudeAction.
    assert.equal(await prisma.claudeAction.count({ where: { fn: 'outreachTracker' } }), 0)
    ok('read-only: never logged as a change');

    // LinkedIn response (Leo, Nov 9 2026): they replied, wanted LinkedIn, we answered there — waiting on them.
    await brand('b_li', 'Li Co')
    await mk('b_li', 'Lee Linked', 'Partnerships', { status: 'replied', sentAt: D(12), repliedAt: D(6), handLiPathAt: D(6), handLiSentAt: D(4) }, D(10))
    // A person's step set by hand on their chart: only a mark, Zach's list untouched.
    const al = await prisma.target.findFirst({ where: { brandId: 'b_acc' } })
    const before = JSON.stringify(al)
    const set = await data('setTrackerStage', { key: 't:' + al.id, stage: 'replied' })
    assert.equal(set.name, 'Al Accept'); assert.equal(set.brandName, 'Accept Co'); assert.equal(set.stage, 'replied')
    let r2 = await data('outreachTracker')
    const by2 = Object.fromEntries(r2.brands.map(b => [b.id, b]))
    assert.equal(by2.b_li.stage, 'lireply'); assert.ok(/Answered on LinkedIn .* — waiting on them/.test(by2.b_li.next), by2.b_li.next)
    assert.deepEqual(by2.b_li.people[0].steps, ['reached', 'accepted', 'replied', 'continue', 'lireply'])
    assert.equal(r2.counts.lireply, 1)
    const alp = by2.b_acc.people.find(p => p.key === 't:' + al.id)
    assert.equal(alp.stage, 'replied'); assert.equal(alp.hand.stage, 'replied'); assert.equal(alp.canUndo, true)
    assert.equal(by2.b_acc.stage, 'replied')
    assert.equal(JSON.stringify(await prisma.target.findUnique({ where: { id: al.id } })), before, 'the row itself unchanged')
    assert.equal(await prisma.claudeAction.count({ where: { fn: 'setTrackerStage' } }), 1)
    await assert.rejects(data('setTrackerStage', { key: 't:' + al.id, stage: 'nope' }))
    await assert.rejects(data('setTrackerStage', { key: 'x:1', stage: 'replied' }))
    // Undo: back to what happened.
    const un = await data('setTrackerStage', { key: 't:' + al.id, undo: true })
    assert.equal(un.stage, null); assert.equal(un.undone, 'replied')
    r2 = await data('outreachTracker')
    assert.equal(r2.brands.find(b => b.id === 'b_acc').stage, 'accepted')
    await assert.rejects(data('setTrackerStage', { key: 't:' + al.id, undo: true }), /Nothing to undo/)
    // Something newer on the row wins over a mark.
    await data('setTrackerStage', { key: 't:' + al.id, stage: 'out' })
    assert.equal((await data('outreachTracker')).brands.find(b => b.id === 'b_acc').stage, 'out')
    await prisma.target.update({ where: { id: al.id }, data: { dmSentAt: new Date(Date.now() + 1000) } })
    assert.equal((await data('outreachTracker')).brands.find(b => b.id === 'b_acc').stage, 'accepted')
    ok('LinkedIn response; a person set on a step by hand, Undo, newer news wins');

    // A referral (Leo, Nov 10 2026): Lee Linked points us to Mike Ref.
    const lee = await prisma.target.findFirst({ where: { brandId: 'b_li' } })
    const rf = await data('addReferral', { fromKey: 't:' + lee.id, name: 'Mike Ref', title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/mikeref' })
    assert.equal(rf.brandName, 'Li Co'); assert.equal(rf.fromName, 'Lee Linked'); assert.equal(rf.created, true); assert.equal(rf.queued, true)
    const mike = await prisma.contact.findUnique({ where: { id: rf.contactId }, include: { targets: true } })
    assert.equal(mike.source, 'referral'); assert.ok(/Referred by Lee Linked/.test(mike.notes))
    assert.equal(mike.targets.length, 1); assert.equal(mike.targets[0].status, 'queued'); assert.ok(mike.targets[0].queuedFor, 'in the outreach queue')
    let r3 = await data('outreachTracker')
    let li3 = r3.brands.find(b => b.id === 'b_li')
    const mp = li3.people.find(p => p.key === 'r:' + rf.id)
    assert.equal(mp.stage, 'referred'); assert.equal(mp.referredBy, 'Lee Linked'); assert.equal(mp.onUs, true); assert.deepEqual(mp.steps, ['referred'])
    const lp = li3.people.find(p => p.key === 't:' + lee.id)
    assert.equal(lp.stage, 'referral'); assert.deepEqual(lp.referred, ['Mike Ref']); assert.ok(lp.steps.includes('referral'))
    assert.equal(li3.stage, 'referral')
    // The same person again: reused, not a second copy; the one who referred can't refer themselves.
    const again = await data('addReferral', { fromKey: 't:' + lee.id, name: 'mike ref' })
    assert.equal(again.created, false); assert.equal(again.contactId, rf.contactId)
    assert.equal(await prisma.contact.count({ where: { brandId: 'b_li', name: { equals: 'Mike Ref', mode: 'insensitive' } } }), 1)
    await assert.rejects(data('addReferral', { fromKey: 't:' + lee.id, name: 'Lee Linked' }), /same person/)
    await assert.rejects(data('addReferral', { fromKey: 't:' + lee.id, name: '' }), /name/)
    // Mike's own chart: a step by hand.
    const again2 = (await data('outreachTracker')).brands.find(b => b.id === 'b_li').people.find(p => p.contactId === rf.contactId)
    await data('setTrackerStage', { key: again2.key, stage: 'replied' })
    assert.equal((await data('outreachTracker')).brands.find(b => b.id === 'b_li').people.find(p => p.key === again2.key).stage, 'replied')
    // Once his invite goes out, his own row takes over — still "Referred by Lee".
    await prisma.target.update({ where: { id: mike.targets[0].id }, data: { status: 'sent', sentAt: new Date() } })
    r3 = await data('outreachTracker')
    li3 = r3.brands.find(b => b.id === 'b_li')
    const mrow = li3.people.filter(p => p.contactId === rf.contactId)
    assert.equal(mrow.length, 1); assert.equal(mrow[0].key, 't:' + mike.targets[0].id); assert.equal(mrow[0].referredBy, 'Lee Linked')
    assert.deepEqual(mrow[0].steps, ['referred', 'reached'])
    // Taking a referral off: a preview first; the person stays.
    const pv = await data('removeReferral', { id: again.id })
    assert.equal(pv.preview, true); assert.ok(/stays on Li Co/.test(pv.stays))
    await data('removeReferral', { id: again.id, confirm: true })
    await assert.rejects(data('removeReferral', { id: rf.id, confirm: true }), /not found/, 'the second add replaced the first')
    assert.ok(await prisma.contact.findUnique({ where: { id: rf.contactId } }), 'the person stays')
    assert.equal((await data('outreachTracker')).brands.find(b => b.id === 'b_li').people.find(p => p.contactId === rf.contactId).referredBy, null)
    assert.equal(await prisma.claudeAction.count({ where: { fn: 'addReferral' } }), 2)
    ok('a referral: the person named on the brand and in the queue, starting at Referred; the one who referred on Referred us');
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
  console.log(`\ntracker e2e: all ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
