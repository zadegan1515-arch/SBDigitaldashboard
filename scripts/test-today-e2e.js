// scripts/test-today-e2e.js — Home → Today against the real handlers and a
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
const PORT = Number(process.env.E2E_PORT || 3461);
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

    const today = nyKey(new Date());
    await prisma.brand.create({ data: { id: 'b1', name: 'Alpha Water', category: 'electrolytes' } });
    const c1 = await prisma.contact.create({ data: { brandId: 'b1', name: 'Ann Able', title: 'CMO' } });
    const c2 = await prisma.contact.create({ data: { brandId: 'b1', name: 'Ben Bright', title: 'Brand Manager' } });
    const t1 = await prisma.target.create({ data: { brandId: 'b1', contactId: c1.id, status: 'sent', sentAt: new Date() } });
    await prisma.target.create({ data: { brandId: 'b1', contactId: c2.id, status: 'accepted', dmSentAt: new Date() } });
    await prisma.targetEvent.create({ data: { targetId: t1.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted' } });
    await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · ' + today, name: 'Flerish', category: 'electrolytes', signals: 'sponsors' } });

    // 1. The recap reads the day.
    let r = await data('dayRecap', {});
    assert.equal(r.day, today);
    assert.equal(r.reached.invites, 1);
    assert.deepEqual(r.reached.companies.map(c => [c.name, c.people]), [['Alpha Water', ['Ann Able']]]);
    assert.deepEqual(r.reached.accepted.map(p => p.name), ['Ann Able']);
    assert.deepEqual(r.reached.steps.map(s => s.step), ['First LinkedIn message']);
    assert.deepEqual(r.found.discovered.map(f => [f.name, f.source]), [['Flerish', 'Claude hunt']]);
    assert.ok(r.todo && typeof r.todo.queued === 'number', 'today has a to-do');
    assert.deepEqual(r.asks.map(a => [a.key, a.n]), [['discover', 1]]);
    assert.ok(r.ideas.length >= 5);
    ok('dayRecap: invites, accepts, Zach steps, finds, asks');

    // 2. Paste two chats; NEED and ideas are sorted out.
    const paste = 'Brand hunt\n- Posted 49 brands\n**NEED: Review the finds**\n1. Open Discover\n\nIdeas:\n- Score by funding\n---\nSnag session\n- Found Snag on LinkedIn';
    const saved = await data('addWorkLog', { text: paste });
    assert.equal(saved.saved, 2);
    assert.equal(saved.needs, 1);
    r = await data('dayRecap', {});
    assert.deepEqual(r.chats.map(c => c.title), ['Brand hunt', 'Snag session']);
    assert.deepEqual(r.chats[0].needs, [{ label: 'Review the finds', steps: ['Open Discover'], i: 0, done: false, auto: null }]);
    assert.deepEqual(r.chats[0].ideas, ['Score by funding']);
    assert.deepEqual(r.logDays, [{ day: today, n: 2 }]);
    await assert.rejects(data('addWorkLog', { text: '   ' }), /Paste what the chat did/);
    ok('addWorkLog: two chats saved, NEED / ideas sorted');

    // 3. Tick a need, pick an idea.
    await data('setWorkNeedDone', { id: r.chats[0].id, index: 0, done: true });
    const ideaId = r.ideas[0].id;
    await data('pickBuildIdea', { id: ideaId, on: true });
    r = await data('dayRecap', {});
    assert.equal(r.chats[0].needs[0].done, true);
    assert.deepEqual(r.picked, [ideaId]);
    ok('need ticked and idea picked are kept');

    // 4. Delete previews first, then deletes. A past day reads alone.
    const pv = await data('deleteWorkLog', { id: r.chats[1].id });
    assert.equal(pv.preview, true);
    assert.equal(await prisma.workLog.count(), 2, 'a preview deletes nothing');
    await data('deleteWorkLog', { id: r.chats[1].id, confirm: true });
    assert.equal(await prisma.workLog.count(), 1);
    await data('addWorkLog', { text: 'Old chat\n- did x', day: '2026-10-01' });
    const old = await data('dayRecap', { day: '2026-10-01' });
    assert.deepEqual([old.isToday, old.todo, old.chats.map(c => c.title), old.reached.invites], [false, null, ['Old chat'], 0]);
    ok('delete previews first; a past day has its own log and no to-do');

    // 5. Done things leave: a saved research batch stops counting, and a
    //    pasted NEED about it reads as done.
    await prisma.setting.upsert({ where: { key: 'researchStaged' }, create: { key: 'researchStaged', value: JSON.stringify({ at: 'x', rows: [{ name: 'A' }, { name: 'B' }] }) }, update: { value: JSON.stringify({ at: 'x', rows: [{ name: 'A' }, { name: 'B' }] }) } })
    await data('addWorkLog', { text: 'Research chat\nNEED: review the research\n1. Open Brand Fit\n2. Save facts' })
    r = await data('dayRecap', {})
    assert.ok(r.asks.some(a => a.key === 'research' && a.n === 2))
    let need = r.chats.find(c => c.title === 'Research chat').needs[0]
    assert.deepEqual([need.done, need.auto], [false, null])
    await prisma.setting.update({ where: { key: 'researchStaged' }, data: { value: JSON.stringify({ at: 'x', rows: [{ name: 'A' }], appliedAt: 'now' }) } })
    r = await data('dayRecap', {})
    assert.ok(!r.asks.some(a => a.key === 'research'), 'a saved batch is not waiting')
    need = r.chats.find(c => c.title === 'Research chat').needs[0]
    assert.equal(need.done, true); assert.match(need.auto, /research/)
    ok('saved research leaves the recap; its pasted NEED reads as done')

    // 6. Today's send list: by company, flags a non-buyer, offers a better person.
    await prisma.brand.create({ data: { id: 'b5', name: 'Echo Pouch', category: 'nicotine' } })
    const store = await prisma.contact.create({ data: { brandId: 'b5', name: 'Sam Store', title: 'Store Manager', linkedinUrl: 'https://www.linkedin.com/in/sam' } })
    const pm = await prisma.contact.create({ data: { brandId: 'b5', name: 'Mo Market', title: 'Marketing Manager', linkedinUrl: 'https://www.linkedin.com/in/mo' } })
    await prisma.contact.create({ data: { brandId: 'b5', name: 'Pat Partner', title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/pat' } })
    await prisma.target.create({ data: { brandId: 'b5', contactId: store.id, status: 'queued', queuedFor: new Date() } })
    await prisma.target.create({ data: { brandId: 'b5', contactId: pm.id, status: 'queued', queuedFor: new Date() } })
    let sl = await data('todaySendList', {})
    let echo = sl.brands.find(b => b.name === 'Echo Pouch')
    assert.ok(echo, 'Echo Pouch is on today\'s list')
    const sam = echo.people.find(p => p.name === 'Sam Store')
    assert.match(sam.problem, /store staff/)
    assert.equal(sam.better.name, 'Pat Partner')
    assert.equal(echo.people.find(p => p.name === 'Mo Market').better, null, 'Pat goes to the weakest only')
    // Swap = queue Pat, leave Sam out.
    await data('queueContact', { contactId: sam.better.contactId })
    await data('passContact', { contactId: sam.contactId })
    sl = await data('todaySendList', {})
    echo = sl.brands.find(b => b.name === 'Echo Pouch')
    assert.deepEqual(echo.people.map(p => p.name).sort(), ['Mo Market', 'Pat Partner'])
    ok('today\'s send list: flags store staff, offers a partnerships person, swap works')

    // 7. Adding from Discover no longer files a brand as "established".
    const dm = await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · x', name: 'Mid Fizz', category: 'energy', signals: 'genz,midsize' } })
    const dn = await prisma.discoveredBrand.create({ data: { query: 'Claude hunt · x', name: 'Plain Fizz', category: 'energy', signals: 'genz' } })
    const am = await data('addDiscoveredBrand', { id: dm.id })
    const an = await data('addDiscoveredBrand', { id: dn.id })
    assert.equal((await prisma.brand.findUnique({ where: { id: am.brandId } })).tier, 'growth')
    assert.equal((await prisma.brand.findUnique({ where: { id: an.brandId } })).tier, null)
    ok('Discover adds: midsize → growth, otherwise no tier (never "established")')

    // 8. A Best fit day: any category, the higher Brand Fit first.
    const mk = async (id, name, category, extra) => {
      await prisma.brand.create({ data: { id, name, category, usStatus: 'yes', ...extra } })
      for (let i = 0; i < 3; i++) {
        const c = await prisma.contact.create({ data: { brandId: id, name: name + ' P' + i, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id + i + '/' } })
        await prisma.target.create({ data: { brandId: id, contactId: c.id, status: 'queued' } })
      }
    }
    await mk('bf_rich', 'Rich Pop', 'snacks', { fundingCents: 50n * 100000000n, sponsorsCollege: true, liMembers: 120 })
    await mk('bf_poor', 'Poor Fizz', 'energy', { liMembers: 30 })
    let op = await data('getOutreachPlan', {})
    // Every coming day Best fit, so no category rotation takes one first.
    for (const d of op.days) if (d.date >= op.today) await data('planSetCategory', { date: d.date, category: 'bestfit' })
    op = await data('getOutreachPlan', {})
    const day = op.days.find(d => (d.brands || []).some(b => b.name === 'Rich Pop' || b.name === 'Poor Fizz'))
    const order = (day.brands || []).map(b => b.name).filter(n => n === 'Rich Pop' || n === 'Poor Fizz')
    assert.deepEqual(order, ['Rich Pop', 'Poor Fizz'], 'both categories, best fit first: ' + JSON.stringify((day.brands || []).map(b => b.name)))
    ok('a Best fit day takes every category, the best Brand Fit first')

    // 9. A category change reshapes a day full of planned brands.
    const opd = await data('getOutreachPlan', {})
    const fut = opd.days.filter(d => d.date > opd.today)
    const dayA = fut[0].date
    await data('planSetCategory', { date: dayA, category: null })
    await data('planAddBrands', { date: dayA, brandIds: ['bf_poor', 'bf_rich'] })
    let pv2 = await data('planApplyCategory', { date: dayA, category: 'energy' })
    assert.deepEqual(pv2.moves.map(m => m.name), ['Rich Pop'], 'only the other category moves')
    const plan0 = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    assert.ok(JSON.parse(plan0.value)[dayA].brandIds.includes('bf_rich'), 'a preview moves nothing')
    const ap = await data('planApplyCategory', { date: dayA, category: 'energy', preview: false })
    assert.equal(ap.moved, 1)
    let planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual(planNow[dayA].brandIds, ['bf_poor'])
    assert.ok(planNow[ap.to].brandIds.includes('bf_rich'), 'moved to the next sending day')
    // Best fit: the planned brands in fit order.
    await data('planMoveBrand', { brandId: 'bf_rich', from: ap.to, to: dayA })
    planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual(planNow[dayA].brandIds, ['bf_poor', 'bf_rich'])
    pv2 = await data('planApplyCategory', { date: dayA, category: 'bestfit' })
    assert.deepEqual(pv2.order.map(o => o.name), ['Rich Pop', 'Poor Fizz'])
    await data('planApplyCategory', { date: dayA, category: 'bestfit', preview: false })
    planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual(planNow[dayA].brandIds, ['bf_rich', 'bf_poor'])
    ok('a category change moves other categories on; Best fit puts planned brands in fit order (preview first)')

    // 10. Leo's picked ideas: scoreboard, brand timeline, deals gone quiet, the week's recap.
    const ws = await data('weeklyScore', {})
    const thisWeek = ws.weeks[ws.weeks.length - 1]
    assert.equal(ws.weeks.length, 8)
    assert.ok(thisWeek.invites >= 1 && thisWeek.accepts >= 1, 'this week counts the invite and the accept: ' + JSON.stringify(thisWeek))
    assert.equal(ws.goals.invites, 90)
    const sg = await data('setWeeklyGoals', { goals: { invites: 60, bogus: 5, calls: -1 } })
    assert.deepEqual([sg.goals.invites, sg.goals.calls, sg.goals.bogus], [60, 3, undefined])
    const tl = await data('brandTimeline', { brandId: 'b1' })
    assert.ok(tl.items.some(i => /accepted on LinkedIn/.test(i.text)), 'the accept is on the timeline')
    assert.ok(tl.items.some(i => /people added|person added/.test(i.text)))
    assert.equal(tl.items[tl.items.length - 1].kind, 'brand', 'oldest last: the brand being added')
    const monthAgo = new Date(Date.now() - 30 * 864e5)
    const dq = await prisma.deal.create({ data: { brandId: 'b5', name: 'Echo × Fall tour', stage: 'proposal', valueCents: 500000 } })
    await prisma.$executeRawUnsafe('UPDATE "Deal" SET "updatedAt" = $1::timestamp WHERE id = $2', monthAgo.toISOString(), dq.id)
    await prisma.deal.create({ data: { brandId: 'b1', name: 'Fresh deal', stage: 'conversation' } })
    const sd = await data('staleDeals', {})
    const quiet = sd.deals.map(d => d.name)
    assert.ok(!quiet.includes('Fresh deal'), 'a fresh deal is not quiet')
    // Echo Pouch had outreach today (the send-list test), so it is not quiet either.
    assert.ok(!quiet.includes('Echo × Fall tour'), 'brand activity counts as activity')
    await prisma.targetEvent.updateMany({ where: { target: { brandId: 'b5' } }, data: { createdAt: monthAgo } })
    assert.ok((await data('staleDeals', {})).deals.some(d => d.name === 'Echo × Fall tour' && d.quietDays >= 29), 'quiet for 30 days')
    const wk = await data('dayRecap', { day: '2026-10-01', to: nyKey(new Date()) })
    assert.equal(wk.range, true); assert.equal(wk.todo, null)
    assert.ok(wk.chats.some(c => c.title === 'Old chat'), 'a range has every day\'s chats')
    ok('scoreboard, goals, brand timeline, deals gone quiet, the week as a recap')

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
