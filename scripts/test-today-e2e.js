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

    // 9. A category change replaces the day's list (Leo, Oct 7 2026: "the
    //    drop down menu sometimes doesn't replace the entire list"): preview
    //    writes nothing, apply sends exactly the preview (a stale one is
    //    refused), planned brands go back to the pool (no next-day pile-up),
    //    Undo puts the day back.
    const opd = await data('getOutreachPlan', {})
    const fut = opd.days.filter(d => d.date > opd.today)
    const dayA = fut[0].date
    await data('planSetCategory', { date: dayA, category: null })
    await data('planAddBrands', { date: dayA, brandIds: ['bf_poor', 'bf_rich'] })
    let pv2 = await data('planApplyCategory', { date: dayA, category: 'energy' })
    assert.deepEqual(pv2.unpin.map(m => m.name), ['Rich Pop'], 'only the other category comes off')
    assert.equal(pv2.changes, 1)
    let planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual([planNow[dayA].category, planNow[dayA].brandIds], [null, ['bf_poor', 'bf_rich']], 'a preview writes nothing')
    const stale = await data('planApplyCategory', { date: dayA, category: 'energy', preview: false, expect: 'not-the-preview' })
    assert.equal(stale.stale, true, 'an apply that is not the preview is refused')
    const ap = await data('planApplyCategory', { date: dayA, category: 'energy', preview: false, expect: pv2.expect })
    assert.equal(ap.unpinned, 1)
    planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual([planNow[dayA].category, planNow[dayA].brandIds], ['energy', ['bf_poor']])
    assert.ok(!Object.values(planNow).some(d => d.brandIds.includes('bf_rich')), 'back to the pool, not onto the next day')
    const un = await data('undoDayTheme', { preview: true })
    assert.deepEqual(un.brands, ['Rich Pop'])
    await data('undoDayTheme', {})
    planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual([planNow[dayA].category, planNow[dayA].brandIds], [null, ['bf_poor', 'bf_rich']], 'Undo puts the day back')
    // Best fit: a planned brand already reached comes off, the rest go in
    // Brand Fit order.
    await mk('bf_done', 'Done Co', 'spirits', { liMembers: 300 })
    await prisma.target.updateMany({ where: { brandId: 'bf_done' }, data: { status: 'sent', sentAt: new Date(Date.now() - 20 * 864e5) } })
    await prisma.contact.create({ data: { brandId: 'bf_done', name: 'Done Extra', title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/doneextra/' } })
    await data('planAddBrands', { date: dayA, brandIds: ['bf_done'] })
    pv2 = await data('planApplyCategory', { date: dayA, category: null })
    assert.deepEqual(pv2.unpin.map(m => m.name), ['Done Co'], 'Best fit takes off the brand already reached')
    assert.deepEqual(pv2.reorder.map(o => o.name), ['Rich Pop', 'Poor Fizz'], 'and shows the new order before writing it')
    await data('planApplyCategory', { date: dayA, category: null, preview: false, expect: pv2.expect })
    planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)
    assert.deepEqual(planNow[dayA].brandIds, ['bf_rich', 'bf_poor'], 'the rest in fit order')
    ok('a category change replaces the list: preview first, exact apply, back to the pool, Undo; Best fit drops reached brands')

    // 9b. Best fit is the default (no category = Best fit), never reached
    //     only, a Skip category never picked by itself.
    await data('planRemoveBrand', { date: dayA, brandId: 'bf_rich' })
    await data('planRemoveBrand', { date: dayA, brandId: 'bf_poor' })
    for (const d of (await data('getOutreachPlan', {})).days) if (d.date >= op.today) await data('planSetCategory', { date: d.date, category: null })
    await mk('bf_app', 'Thread Co', 'apparel', { fundingCents: 50n * 100000000n, sponsorsCollege: true, liMembers: 120 })
    await data('setCategoryPriority', { category: 'apparel', priority: 'skip' })
    const op9 = await data('getOutreachPlan', {})
    const autoNames = op9.days.filter(d => d.date >= op9.today).flatMap(d => (d.brands || []).map(b => b.name))
    assert.ok(op9.days.every(d => d.category === 'bestfit' && d.auto), 'every day without a category is Best fit')
    assert.ok(autoNames.includes('Rich Pop'), 'a never-reached brand is picked: ' + JSON.stringify(autoNames))
    assert.ok(!autoNames.includes('Done Co'), 'a brand already reached is never picked on a Best fit day')
    assert.ok(!autoNames.includes('Thread Co'), 'a Skip category is never picked by itself')
    const sug = await data('suggestForDay', { date: fut[0].date, category: 'bestfit' })
    assert.ok(!sug.brands.some(b => b.name === 'Thread Co' || b.name === 'Done Co'), 'nor suggested')
    const found = await data('searchPlanBrands', { q: 'thred co', date: fut[0].date })
    assert.equal(found.brands[0] && found.brands[0].name, 'Thread Co', 'a hand search still finds it (spelling slip too)')
    await data('setCategoryPriority', { category: 'apparel', priority: 'low' })
    ok('Best fit is the default: never reached only, Skip never picked, search still finds everything')

    // 9c. Today: a planned brand that comes off takes its people out of
    //     today's queue (named on the card); Undo puts them back and takes
    //     out whoever the new category brought in.
    const tk = op9.today
    await data('setExtraSendingDay', { date: tk, on: true }) // a no-op on Tue–Thu
    await mk('bf_snack', 'Snack Co', 'snacks', { liMembers: 80 })
    await data('planAddBrands', { date: tk, brandIds: ['bf_snack'] })
    const snackQueued = () => prisma.target.count({ where: { brandId: 'bf_snack', queuedFor: { not: null }, sentAt: null } })
    const n9 = await snackQueued()
    assert.ok(n9 > 0, 'planned for today = in today\'s queue')
    const pvT = await data('planApplyCategory', { date: tk, category: 'energy' })
    const off = pvT.unpin.find(u => u.id === 'bf_snack')
    assert.ok(off, 'Snack Co comes off')
    assert.equal(off.targetIds.length, n9, 'its queued people are named')
    await data('planApplyCategory', { date: tk, category: 'energy', preview: false, expect: pvT.expect })
    assert.equal(await snackQueued(), 0, 'and they leave today\'s queue')
    const refill = (JSON.parse((await prisma.setting.findUnique({ where: { key: 'dayThemeLast' } })).value).refilled) || []
    const unT = await data('undoDayTheme', { preview: true })
    assert.ok(unT.people >= n9)
    assert.equal(unT.out, refill.length)
    await data('undoDayTheme', {})
    assert.equal(await snackQueued(), n9, 'Undo puts them back')
    if (refill.length) {
      assert.equal(await prisma.target.count({ where: { id: { in: refill }, queuedFor: { not: null }, sentAt: null } }), 0, 'and takes the refill back out')
    }
    ok('today: a planned brand that comes off leaves the queue; Undo restores it and removes the refill')

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

    // 11. A big company works ten (Leo, Oct 7 2026); people held back by
    //     the limit are "next in line" (shelvedHow cap), not shelved, and
    //     only they come back by themselves.
    await prisma.brand.create({ data: { id: 'big_cl', name: 'Coors Light', category: 'rtd', usStatus: 'yes' } }) // a Molson Coors brand
    for (let i = 0; i < 12; i++) {
      await prisma.contact.create({ data: { brandId: 'big_cl', name: 'CL Person ' + i, title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/clp' + i + '/' } })
    }
    const imp = await data('importContacts', { source: 'research', rows: [
      { brandName: 'Coors Light', name: 'Research Rita', title: 'Director, Partnership Marketing', linkedinUrl: 'https://www.linkedin.com/in/rrita/', notes: 'Found: example.com, Oct 2026' },
    ] })
    assert.equal(imp.contactsCreated, 1)
    const rita = await prisma.contact.findFirst({ where: { name: 'Research Rita' } })
    assert.deepEqual([rita.source, rita.notes], ['research', 'Found: example.com, Oct 2026'], 'research rows are labelled and keep where they came from')
    // Coors Light is a giant (Molson Coors): held back until Leo says
    // "Add anyway" (queue rules, Oct 12 2026), which OKs it for good.
    const held = await data('queueBrandTargets', { brandId: 'big_cl' })
    assert.deepEqual([held.queued, held.reason], [false, 'giant'], 'a giant asks first')
    const qb = await data('queueBrandTargets', { brandId: 'big_cl', allowGiant: true })
    assert.ok(qb.queued !== false, 'queued: ' + JSON.stringify(qb))
    const liveCL = await prisma.target.count({ where: { brandId: 'big_cl', shelved: false, status: { in: ['queued', 'drafted'] } } })
    assert.equal(liveCL, 10, 'a big company opens with ten')
    const brandCL = await data('getBrand', { brandId: 'big_cl' })
    assert.equal(brandCL.big, true)
    // The limit's overflow is "cap"; a hand shelve is not, and never comes back alone.
    await prisma.brand.create({ data: { id: 'cap_b', name: 'Cap Co', category: 'snacks', usStatus: 'yes' } })
    const capTargets = []
    for (let i = 0; i < 6; i++) {
      const c = await prisma.contact.create({ data: { brandId: 'cap_b', name: 'Cap P' + i, title: 'Marketing Manager', linkedinUrl: 'https://www.linkedin.com/in/capp' + i + '/' } })
      capTargets.push(await prisma.target.create({ data: { brandId: 'cap_b', contactId: c.id, status: 'queued', fitScore: 50 - i } }))
    }
    await data('importContacts', { rows: [{ brandName: 'Cap Co', name: 'Cap Extra', title: 'Brand Director' }] }) // runs the limit for Cap Co
    const capRows = await prisma.target.findMany({ where: { brandId: 'cap_b' }, orderBy: { fitScore: 'desc' } })
    // The brand works three (picks, Oct 12 2026 — it used to keep four).
    assert.deepEqual(capRows.map(t => [t.shelved, t.shelvedHow]), [[false, null], [false, null], [false, null], [true, 'cap'], [true, 'cap'], [true, 'cap']], 'the three past the three are next in line')
    // Two shelved by hand (the best two): the brand works three, so two
    // spots open — and they go to people next in line, never a hand shelve.
    await data('setTargetShelved', { targetId: capRows[0].id, shelved: true })
    await data('setTargetShelved', { targetId: capRows[1].id, shelved: true })
    const hand = await prisma.target.findUnique({ where: { id: capRows[0].id } })
    assert.deepEqual([hand.shelved, hand.shelvedHow], [true, null], 'a hand shelve is a real shelve')
    await data('queueBrandTargets', { brandId: 'cap_b' })
    const after = await prisma.target.findMany({ where: { brandId: 'cap_b' } })
    assert.equal(after.find(t => t.id === capRows[0].id).shelved, true, 'the hand-shelved people stay shelved')
    assert.equal(after.find(t => t.id === capRows[1].id).shelved, true)
    const back = after.find(t => t.id === capRows[4].id)
    assert.deepEqual([back.shelved, back.shelvedHow], [false, null], 'the best next-in-line people fill the open spots')
    assert.deepEqual([after.find(t => t.id === capRows[3].id).shelved, after.find(t => t.id === capRows[5].id).shelvedHow], [false, 'cap'], 'two spots, two back; the third waits')
    // The one-time relabel: rows shelved before shelvedHow existed (no
    // label, last changed before `before`); preview, then only what it showed.
    await prisma.$executeRawUnsafe(`UPDATE "Target" SET "shelvedHow" = NULL, "updatedAt" = NOW() - INTERVAL '2 days' WHERE "brandId" = 'cap_b' AND "shelvedHow" = 'cap'`)
    const relabelBefore = new Date(Date.now() - 864e5).toISOString()
    await assert.rejects(data('markCapShelved', { preview: true }), /before/)
    const mk1 = await data('markCapShelved', { preview: true, before: relabelBefore })
    assert.ok(mk1.preview && mk1.sample.some(x => x.name === 'Cap Co'))
    const capCo = mk1.sample.find(x => x.name === 'Cap Co')
    assert.equal(capCo.people, 1, 'only the old unlabelled row, never the two shelved by hand today')
    const before1 = await prisma.target.count({ where: { shelvedHow: 'cap' } })
    const mk2 = await data('markCapShelved', { preview: false, before: relabelBefore })
    assert.equal(mk2.marked, mk1.people)
    assert.equal(await prisma.target.count({ where: { shelvedHow: 'cap' } }), before1 + mk1.people)
    ok('a big company opens with ten; next in line ≠ shelved; only next in line comes back by itself; relabel previews first')

    // 11b. Each brand opens with exactly its number, best LinkedIn buyers
    //      first (picks, Oct 12 2026); a brand is big only when measured
    //      (big-brand-size) — an established tier alone works four.
    const mkBrand = async (id, x, people) => {
      await prisma.brand.create({ data: { id, name: id, category: 'snacks', usStatus: 'yes', ...x } })
      const out = []
      for (const [name, title, li, email] of people) {
        out.push(await prisma.contact.create({ data: { brandId: id, name, title, linkedinUrl: li === false ? null : 'https://www.linkedin.com/in/' + name.replace(/\W/g, '') + '/', email: email || null } }))
      }
      return out
    }
    const stampedNames = async (id) => (await prisma.target.findMany({
      where: { brandId: id, shelved: false, status: { in: ['queued', 'drafted'] }, queuedFor: { not: null } }, include: { contact: true },
    })).map(t => t.contact.name).sort()
    await mkBrand('Six Buyers', {}, [
      ['Accountant Al', 'Senior Accountant'], ['Mail Mo', 'Partnerships Director', false, 'mo@six.example'],
      ['Brand Bo', 'Brand Manager'], ['Mark Mia', 'Marketing Manager'], ['Event Eve', 'Events Manager'], ['Part Pat', 'Head of Partnerships'],
    ])
    const six = await data('queueBrandTargets', { brandId: 'Six Buyers' })
    assert.equal(six.count, 3, 'six people, works three: ' + JSON.stringify(six))
    assert.deepEqual(await stampedNames('Six Buyers'), ['Event Eve', 'Mark Mia', 'Part Pat'], 'partnerships > events > marketing, LinkedIn before an email-only contact, never the accountant')
    const again = await data('queueBrandTargets', { brandId: 'Six Buyers' })
    assert.equal(again.queued, false, 'asking again stamps nobody new')
    assert.equal((await stampedNames('Six Buyers')).length, 3)
    // Four waiting from the old limit (at least four) at a brand that works
    // three: three go when it comes up, the fourth is next in line.
    const four = await mkBrand('Four Waiting', {}, [['F1', 'Senior Accountant'], ['F2', 'Marketing Lead'], ['F3', 'Partnerships Lead'], ['F4', 'Events Lead']])
    for (const c of four) await prisma.target.create({ data: { brandId: 'Four Waiting', contactId: c.id, status: 'queued', fitScore: 40 } })
    await data('queueBrandTargets', { brandId: 'Four Waiting' })
    const fw = await prisma.target.findMany({ where: { brandId: 'Four Waiting' }, include: { contact: true } })
    assert.deepEqual(fw.filter(t => t.queuedFor).map(t => t.contact.name).sort(), ['F2', 'F3', 'F4'])
    assert.deepEqual(fw.filter(t => t.shelved).map(t => [t.contact.name, t.shelvedHow]), [['F1', 'cap']], 'trimmed as it comes up, next in line')
    // Leo's "work 1" is one, and a new number trims who waits past it.
    await mkBrand('Work One', {}, [['W1', 'Head of Partnerships'], ['W2', 'Brand Manager'], ['W3', 'Marketing Manager']])
    await data('updateBrand', { brandId: 'Work One', workPeople: 1 })
    assert.equal((await data('queueBrandTargets', { brandId: 'Work One' })).count, 1)
    assert.deepEqual(await stampedNames('Work One'), ['W1'])
    // Established, measured mid-size: four. Established, not measured: four
    // too — no longer a "big company" that opens ten.
    const estPeople = Array.from({ length: 12 }, (_, i) => ['Est ' + i, 'Brand Manager'])
    await mkBrand('Est Measured', { tier: 'established', liMembers: 200 }, estPeople.map(([n, t]) => ['M' + n, t]))
    await mkBrand('Est Guess', { tier: 'established' }, estPeople.map(([n, t]) => ['G' + n, t]))
    await mkBrand('Big Measured', { liMembers: 900 }, estPeople.map(([n, t]) => ['B' + n, t]))
    assert.equal((await data('queueBrandTargets', { brandId: 'Est Measured' })).count, 4)
    assert.equal((await data('queueBrandTargets', { brandId: 'Est Guess' })).count, 4, 'an established tier alone is not big')
    assert.equal((await data('getBrand', { brandId: 'Est Guess' })).big, false)
    assert.equal((await data('queueBrandTargets', { brandId: 'Big Measured' })).count, 10, 'measured 500+ is big')
    // The limit never takes anyone out of today's list: five stamped today
    // at a brand that works three stay when a capture runs the limit.
    const td = await mkBrand('Today Five', {}, [['T1', 'CMO'], ['T2', 'CMO'], ['T3', 'CMO'], ['T4', 'CMO'], ['T5', 'CMO']])
    for (const c of td) await prisma.target.create({ data: { brandId: 'Today Five', contactId: c.id, status: 'queued', queuedFor: new Date() } })
    await data('importContacts', { rows: [{ brandName: 'Today Five', name: 'T6', title: 'CMO', linkedinUrl: 'https://www.linkedin.com/in/t6x/' }] })
    assert.equal(await prisma.target.count({ where: { brandId: 'Today Five', shelved: true, contactId: { in: td.map(c => c.id) } } }), 0, 'today\'s five stay')
    const t6 = await prisma.target.findFirst({ where: { brandId: 'Today Five', contact: { name: 'T6' } } })
    assert.deepEqual([t6.shelved, t6.shelvedHow], [true, 'cap'], 'the new one waits — next in line')
    // Out of the way of the sections below (nothing of theirs in today's list).
    await prisma.brand.updateMany({ where: { id: { in: ['Six Buyers', 'Four Waiting', 'Work One', 'Est Measured', 'Est Guess', 'Big Measured', 'Today Five'] } }, data: { passedAt: new Date() } })
    ok('each brand opens with exactly its number, best LinkedIn buyers first; trims as it comes up; never out of today\'s list; big only when measured')

    // 12. A day Leo gives a category fills from the whole category, best
    //     Brand Fit first (category-days) — a Skip category included, since
    //     he chose it; too small still out — and Fill to 30 never puts a
    //     brand into fewer spots than it needs. LinkedIn's week sizes the
    //     day (week-limit): seeded invites six days ago leave today 2 open.
    //     The LinkedIn tab and the Schedule label a brand the same way
    //     (label-select).
    const ppl = async (id, k) => {
      for (let i = 0; i < k; i++) await prisma.contact.create({ data: { brandId: id, name: id + ' P' + i, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id + i + '/' } })
    }
    await data('setCategoryPriority', { category: 'fintech', priority: 'skip' })
    const tk12 = nyKey(new Date())
    await data('planSetCategory', { date: tk12, category: 'fintech' })
    const startNY = new Date(new Date(tk12 + 'T12:00:00Z').getTime() - 6 * 864e5)
    const listed12 = async () => (await data('getTodayQueue', {})).targets.length
    const q0 = await data('getTodayQueue', {})
    const used = q0.sentToday + q0.targets.length
    // 100 − (what today holds + 2) invites six days ago: today's own picks
    // may take 2 more; the Schedule's later days aren't touched by them.
    await prisma.brand.create({ data: { id: 'wk_past', name: 'Past Week Co', category: 'snacks', passedAt: new Date() } })
    const seedN = 100 - (used + 2)
    for (let i = 0; i < seedN; i++) {
      const c = await prisma.contact.create({ data: { brandId: 'wk_past', name: 'Past ' + i, linkedinUrl: 'https://www.linkedin.com/in/past' + i + '/' } })
      await prisma.target.create({ data: { brandId: 'wk_past', contactId: c.id, status: 'sent', sentAt: startNY } })
    }
    // Four people, an established brand of 120 on LinkedIn: works 4, not 10.
    await prisma.brand.create({ data: { id: 'f4', name: 'Four Fin', category: 'fintech', tier: 'established', liMembers: 120, usStatus: 'yes' } })
    await ppl('f4', 4)
    // Too small (5 on LinkedIn): fits the two spots, never picked.
    await prisma.brand.create({ data: { id: 'f0', name: 'Tiny Fin', category: 'fintech', liMembers: 5, usStatus: 'yes' } })
    await ppl('f0', 1)
    const q1 = await data('getTodayQueue', {})
    assert.equal(q1.dayCap, used + 2, 'today\'s own picks stop at what LinkedIn\'s week leaves: ' + JSON.stringify([q1.dayCap, used]))
    assert.equal(q1.cap, 30, 'hand adds stay on the flat 30')
    let f12 = await data('fillToday', {})
    assert.equal(f12.added, 0, 'a four-person brand never goes into two spots: ' + JSON.stringify(f12))
    assert.deepEqual([f12.shortBy, f12.smallest], [2, 4], 'and the answer says why')
    assert.equal(await prisma.target.count({ where: { brandId: 'f0', queuedFor: { not: null } } }), 0, 'too small stays out')
    // A two-person brand, nobody waiting in the pool (contacts only): it
    // goes — the whole category, not the pool's 300.
    await prisma.brand.create({ data: { id: 'f2', name: 'Two Fin', category: 'fintech', liMembers: 60, usStatus: 'yes' } })
    await ppl('f2', 2)
    f12 = await data('fillToday', {})
    assert.deepEqual([f12.added, f12.brands, f12.shortBy], [2, ['Two Fin'], 0], 'the two-person brand fills the two spots: ' + JSON.stringify(f12))
    assert.equal(await listed12(), used + 2 - q0.sentToday, 'today is at its room, not past it')
    // A later day given the Skip category still shows its brands.
    const op12 = await data('getOutreachPlan', {})
    const later12 = op12.days.find(d => d.date > op12.today)
    await data('planSetCategory', { date: later12.date, category: 'fintech' })
    const op12b = await data('getOutreachPlan', {})
    const l12 = op12b.days.find(d => d.date === later12.date)
    assert.ok((l12.brands || []).some(b => b.id === 'f4'), 'a Skip category Leo gave the day still fills it: ' + JSON.stringify(l12.brands))
    assert.ok(!(l12.brands || []).some(b => b.id === 'f0'), 'too small never')
    assert.equal(l12.cap, 30, 'a later day out of the seeded week has its 30')
    // Four Fin by hand (past today's room — hand adds go): now on the
    // LinkedIn tab too, labelled the way the Schedule labels it.
    await data('queueBrandTargets', { brandId: 'f4' })
    const lab = (await data('getTodayQueue', {})).labels
    const opl = (await data('getOutreachPlan', {})).labels
    assert.ok(lab.f4 && lab.f2, 'both labelled on the LinkedIn tab')
    assert.deepEqual([lab.f4.need, lab.f4.kind], [opl.f4.need, opl.f4.kind], 'the LinkedIn tab and the Schedule agree')
    assert.equal(lab.f4.need, 4, 'an established brand of 120 works 4, not a big company\'s 10')
    await data('setCategoryPriority', { category: 'fintech', priority: 'low' })
    ok('a category day: whole category best first, Skip OK when Leo picks it, too small out; Fill never splits; the week sizes the day; labels agree')

    // 13. A Best fit day takes one big company and gives the rest of the
    //     day to smaller brands (Leo, Oct 12 2026) — the Schedule's preview
    //     and Plan my week alike; a brand short of people ranks below the
    //     ready ones, even with a higher Brand Fit (thin-held-back).
    const op13 = await data('getOutreachPlan', {})
    const later13 = op13.days.filter(d => d.date > op13.today).map(d => d.date)
    for (const d of later13) await data('planSetCategory', { date: d, category: null })
    const top13 = { category: 'electrolytes', salesCents: 200 * M, sponsorsCollege: true, usStatus: 'yes' }
    const ten = (p) => Array.from({ length: 10 }, (_, i) => [p + i, 'Head of Partnerships'])
    await mkBrand('BigHydraA', { ...top13, liMembers: 900 }, ten('HA'))
    await mkBrand('BigHydraB', { ...top13, liMembers: 800 }, ten('HB'))
    await mkBrand('MidHydra', { ...top13, salesCents: 2 * M, liMembers: 120 }, [['MH1', 'Head of Partnerships'], ['MH2', 'Brand Manager'], ['MH3', 'Events Lead']])
    await mkBrand('ThinHydra', { ...top13, liMembers: 130 }, [['TH1', 'Head of Partnerships']])
    const op13b = await data('getOutreachPlan', {})
    const ids13 = (k) => (op13b.days.find(d => d.date === k).brands || []).map(b => b.id)
    const d1 = ids13(later13[0]), d2 = ids13(later13[1])
    assert.ok(d1.includes('BigHydraA') && !d1.includes('BigHydraB'), 'one big company on a Best fit day: ' + JSON.stringify(d1))
    assert.ok(d2.includes('BigHydraB') && !d2.includes('BigHydraA'), 'the second goes on the next Best fit day: ' + JSON.stringify(d2))
    assert.ok(d1.includes('MidHydra') && d1.includes('ThinHydra') && d1.indexOf('MidHydra') < d1.indexOf('ThinHydra'),
      'Ready before short, whatever the fit: ' + JSON.stringify(d1))
    const pw13 = await data('planWeek', {})
    const add13 = (i) => pw13.days[i].add.map(a => a.id)
    assert.ok(add13(0).includes('BigHydraA') && !add13(0).includes('BigHydraB'), 'Plan my week: one big company a Best fit day: ' + JSON.stringify(add13(0)))
    assert.ok(add13(1).includes('BigHydraB'), 'and the other the next day')
    assert.ok(add13(0).indexOf('MidHydra') < add13(0).indexOf('ThinHydra'), 'Plan my week: Ready before short')
    ok('a Best fit day takes one big company, the rest smaller brands; Ready before short — the Schedule and Plan my week agree')

    // 14. What gets answered (read-only, suggestions only) and Ready for a
    //     second try (hand-only) — outcome-table and second-try, Oct 12 2026.
    const daysAgo = (k) => new Date(Date.now() - k * 864e5)
    const seedInvites = async (id, category, n, yes, at) => {
      await prisma.brand.create({ data: { id, name: id, category, usStatus: 'yes' } })
      for (let i = 0; i < n; i++) {
        const c = await prisma.contact.create({ data: { brandId: id, name: id + ' I' + i, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id + i + '/' } })
        await prisma.target.create({ data: { brandId: id, contactId: c.id, status: i < yes ? 'accepted' : 'sent', sentAt: at } })
      }
    }
    await seedInvites('OutBeauty', 'beauty', 40, 32, daysAgo(30))
    await seedInvites('OutSnacks', 'snacks', 60, 6, daysAgo(30))
    await seedInvites('OutYoung', 'beauty', 10, 0, daysAgo(3)) // too young to judge
    const ot = await data('outcomeTable', {})
    const cat14 = (k) => ot.byCategory.find(c => c.key === k)
    assert.deepEqual([cat14('beauty').n, cat14('beauty').accepted], [40, 32], 'only invites old enough to answer: ' + JSON.stringify(cat14('beauty')))
    assert.ok(ot.bySize.length && ot.byBuyer.some(c => c.key === 'partnerships') && ot.byThreads.length, 'every grouping')
    const sugs = ot.suggestions.map(x => [x.category, x.from, x.to])
    assert.ok(sugs.some(x => x[0] === 'beauty' && x[2] === 'top') && sugs.some(x => x[0] === 'snacks' && x[2] === 'low'), 'suggests, both ways: ' + JSON.stringify(sugs))
    const pr14 = (await data('getCategoryPriority', {})).categories
    assert.equal(pr14.find(c => c.key === 'beauty').priority, 'middle', 'nothing changes by itself')

    // Quiet Co: three invites a month ago, nobody answered (two withdrawn,
    // one still out), rested — and three new buyers on file.
    const quiet14 = await mkBrand('Quiet Co', { category: 'energy' }, [['Q1', 'Brand Manager'], ['Q2', 'Marketing Lead'], ['Q3', 'Events Lead'],
      ['QN1', 'Head of Partnerships'], ['QN2', 'Partnerships Manager'], ['QN3', 'Sponsorship Lead']])
    const qOpen = await prisma.target.create({ data: { brandId: 'Quiet Co', contactId: quiet14[0].id, status: 'sent', sentAt: daysAgo(30) } })
    await prisma.target.create({ data: { brandId: 'Quiet Co', contactId: quiet14[1].id, status: 'withdrawn', sentAt: daysAgo(30) } })
    await prisma.target.create({ data: { brandId: 'Quiet Co', contactId: quiet14[2].id, status: 'withdrawn', sentAt: daysAgo(30) } })
    const answered14 = await mkBrand('Answered Co', { category: 'energy' }, [['A1', 'Brand Manager'], ['AN1', 'Head of Partnerships']])
    await prisma.target.create({ data: { brandId: 'Answered Co', contactId: answered14[0].id, status: 'accepted', sentAt: daysAgo(30) } })
    const waiting14 = await mkBrand('Waiting Co', { category: 'energy' }, [['WA1', 'Brand Manager'], ['WA2', 'Brand Manager'], ['WAN1', 'Head of Partnerships']])
    await prisma.target.create({ data: { brandId: 'Waiting Co', contactId: waiting14[0].id, status: 'sent', sentAt: daysAgo(30) } })
    await prisma.target.create({ data: { brandId: 'Waiting Co', contactId: waiting14[1].id, status: 'sent', sentAt: daysAgo(10) } })
    let st14 = await data('secondTryBrands', {})
    const qRow = () => st14.brands.find(b => b.id === 'Quiet Co')
    assert.ok(qRow(), 'an unanswered, rested brand with new buyers is offered: ' + JSON.stringify(st14.brands.map(b => b.name)))
    assert.deepEqual(qRow().open.map(o => o.targetId), [qOpen.id], 'its invite still out is named, to withdraw first')
    assert.ok(qRow().going >= 1 && qRow().people.every(p => /^QN/.test(p.name)), 'only new people would go: ' + JSON.stringify(qRow().people))
    assert.ok(!st14.brands.some(b => b.id === 'Answered Co'), 'someone accepted: never')
    assert.ok(!st14.brands.some(b => b.id === 'Waiting Co'), 'an invite under 21 days may still be accepted')
    const opp = await data('getOutreachPlan', {})
    assert.ok(!opp.days.some(d => (d.brands || []).some(b => b.id === 'Quiet Co')), 'never picked by itself')
    await data('markInvitesWithdrawn', { targetIds: [qOpen.id] })
    st14 = await data('secondTryBrands', {})
    assert.deepEqual(qRow().open, [], 'withdrawn: nothing still out')
    const pv14 = await data('planAddBrands', { date: st14.day, brandIds: ['Quiet Co'], preview: true })
    assert.deepEqual([pv14.results[0].added, pv14.results[0].state], [true, 'going'], 'by hand it goes: ' + JSON.stringify(pv14.results[0]))
    ok('What gets answered: only old-enough invites, every grouping, suggestions that change nothing; a second try is offered by hand only')

    // 15. Lock these days (lock-days; Leo, Oct 12 2026: only when he clicks
    //     Lock). A later day's automatic rows are "Shown on <day>, not
    //     locked" on the brand page and in the add boxes; Plan my week never
    //     takes a brand from today's column; Lock pins exactly the rows, in
    //     order, with one Undo.
    const planKey = async () => JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } }))?.value || '{}')
    // Today's list not opened yet: everyone waiting goes back to the pool,
    // so today's column shows automatic rows nobody has stamped — the ones
    // Plan my week used to move to tomorrow.
    await prisma.target.updateMany({ where: { queuedFor: { not: null }, sentAt: null, status: { in: ['queued', 'drafted'] } }, data: { queuedFor: null } })
    let op15 = await data('getOutreachPlan', {})
    let day15 = op15.days.find(d => !d.today && (d.brands || []).length)
    if (!day15) {
      await mk('lock1', 'Lock One', 'energy')
      await mk('lock2', 'Lock Two', 'energy')
      op15 = await data('getOutreachPlan', {})
      day15 = op15.days.find(d => !d.today && (d.brands || []).length)
    }
    assert.ok(day15, 'a later day shows automatic rows')
    const ids15 = day15.brands.map(b => b.id)
    const name15 = day15.brands[0].name
    const other15 = op15.days.filter(d => !d.today && d.date !== day15.date).map(d => d.date)[0]
    const pdc15 = await data('planDayChoices', { brandId: ids15[0] })
    assert.deepEqual([pdc15.brand.pinnedOn, pdc15.brand.shownOn], [null, day15.date], 'the brand page: shown there, not pinned')
    const sr15 = await data('searchPlanBrands', { q: name15, date: other15 })
    const row15 = sr15.brands.find(b => b.id === ids15[0])
    assert.ok(row15 && row15.shownOn === day15.date, 'the add box knows where it shows: ' + JSON.stringify(row15))
    assert.match(row15.text, /^Shown on .+, not locked · Add moves it to /)
    const pa15 = await data('planAddBrands', { date: other15, brandIds: [ids15[0]], preview: true })
    assert.equal(pa15.results[0].shownOn, day15.date, 'Put on a day says so too')
    const todayCol15 = op15.days.find(d => d.today)
    if (todayCol15) {
      assert.ok((todayCol15.brands || []).some(b => !b.inQueue), 'today shows automatic rows nobody has stamped yet')
      const onToday = new Set([...(todayCol15.brands || []).map(b => b.id), ...(todayCol15.pinned || []).map(p => p.id)])
      const pw15 = await data('planWeek', {})
      const taken = pw15.days.flatMap(d => d.add.map(a => a.id)).filter(id => onToday.has(id))
      assert.deepEqual(taken, [], 'Plan my week never takes a brand from today\'s column')
    }
    const before15 = ((await planKey())[day15.date]?.brandIds) || []
    const lk15 = await data('planWeek', { apply: true, lock: true, days: [{ date: day15.date, brandIds: ids15 }] })
    assert.equal(lk15.days[0].added, ids15.length, 'every row pinned: ' + JSON.stringify(lk15.days[0]))
    assert.deepEqual((await planKey())[day15.date].brandIds, [...before15, ...ids15], 'exactly the rows, in their order')
    op15 = await data('getOutreachPlan', {})
    assert.equal(op15.planWeekLast.lock, true, 'the Undo knows it was a lock')
    assert.ok(!op15.days.find(d => d.date === day15.date).brands.some(b => ids15.includes(b.id)), 'locked rows are pins now, not automatic rows')
    assert.equal((await data('planDayChoices', { brandId: ids15[0] })).brand.pinnedOn, day15.date)
    const un15 = await data('undoPlanWeek', { preview: true })
    assert.equal(un15.lock, true)
    assert.equal(un15.brands.length, ids15.length)
    await data('undoPlanWeek', {})
    assert.deepEqual(((await planKey())[day15.date]?.brandIds) || [], before15, 'Undo takes the lock back off')
    ok('lock-days: shown-not-locked on the brand page and add boxes, Plan my week leaves today\'s column alone, Lock pins exactly the rows, Undo')

    // 16. Move or cancel a whole future sending day (skip-day). The day goes
    //     off — no column, no picks, Plan my week leaves it out, nothing can
    //     be put on it without opening it — its plan moves (category and
    //     pins onto an empty day), Undo brings it all back, a day taken off
    //     with no target sends its pins back to waiting, and opening it
    //     again ("send on it after all") just reopens it.
    let op16 = await data('getOutreachPlan', {})
    const D16 = op16.days.filter(d => !d.today).map(d => d.date)[1]
    await mk('skipco', 'Skip Co', 'energy')
    await data('planAddBrands', { date: D16, brandIds: ['skipco'] })
    const p16 = await planKey()
    p16[D16].category = 'energy'
    await prisma.setting.update({ where: { key: 'outreachPlan' }, data: { value: JSON.stringify(p16) } })
    const pins16 = p16[D16].brandIds
    const off16 = (await data('planDayChoices', {})).offDay.key
    await assert.rejects(data('moveDay', { from: D16, to: off16 }), /not a sending day/, 'an off day needs addDay')
    await assert.rejects(data('moveDay', { from: today, to: off16, addDay: true }), /today has Move what/, 'today has its own move')
    const pv16 = await data('moveDay', { from: D16, to: off16, addDay: true })
    assert.equal(pv16.preview, true, 'no confirm = a preview')
    assert.deepEqual([pv16.opening, pv16.whole, pv16.category], [true, true, 'energy'], 'onto an empty day the whole plan moves')
    const sk16 = pv16.results.find(r => r.brandId === 'skipco')
    assert.deepEqual([sk16.added, sk16.movedFrom], [true, D16])
    assert.deepEqual((await planKey())[D16].brandIds, pins16, 'a preview writes nothing')
    const stale16 = await data('moveDay', { from: D16, to: off16, addDay: true, confirm: true, expect: 'nope' })
    assert.equal(stale16.stale, true, 'a changed day is shown again')
    assert.deepEqual((await planKey())[D16].brandIds, pins16)
    const mv16 = await data('moveDay', { from: D16, to: off16, addDay: true, confirm: true, expect: pv16.expect })
    assert.deepEqual([mv16.ok, mv16.opened], [true, true])
    op16 = await data('getOutreachPlan', {})
    assert.ok(!op16.days.some(d => d.date === D16), 'no column for a day taken off')
    assert.deepEqual(op16.skipDays.map(x => [x.date, x.to]), [[D16, off16]], 'the off chip')
    assert.ok(op16.extraDays.includes(off16), 'the target opened as a sending day')
    const pl16 = await planKey()
    assert.equal(pl16[D16], undefined, 'nothing left pinned on the day off')
    assert.deepEqual([pl16[off16].category, pl16[off16].brandIds], ['energy', pins16], 'category and pins, in order')
    assert.ok(!(await data('planWeek', {})).days.some(d => d.date === D16), 'Plan my week leaves it out')
    await assert.rejects(data('planAddBrands', { date: D16, brandIds: ['skipco'], preview: true }), /not a sending day/, 'nothing goes on it unless it is opened')
    const pdc16 = await data('planDayChoices', {})
    assert.ok(!pdc16.days.some(d => d.key === D16), 'the Put on a day menus leave it out')
    if (pdc16.offDay && pdc16.offDay.key === D16) assert.equal(pdc16.offDay.skipped, true, 'offered back as "send on it after all"')
    const un16 = await data('undoMoveDay', { date: D16, preview: true })
    assert.ok(un16.back.includes('Skip Co'))
    assert.deepEqual([un16.categoryBack, un16.closeTo], [true, true], 'the target\'s category goes back and the day it opened closes')
    assert.equal((await planKey())[off16].brandIds.length, pins16.length, 'an Undo preview writes nothing')
    await data('undoMoveDay', { date: D16 })
    op16 = await data('getOutreachPlan', {})
    assert.ok(op16.days.some(d => d.date === D16), 'a sending day again')
    assert.deepEqual(op16.skipDays, [])
    assert.ok(!op16.extraDays.includes(off16), 'the opened day closed')
    const pl16b = await planKey()
    assert.deepEqual([pl16b[D16].category, pl16b[D16].brandIds], ['energy', pins16], 'its plan is back')
    assert.equal(pl16b[off16], undefined)
    // Taken off with no target: back to waiting.
    const pv16b = await data('moveDay', { from: D16 })
    assert.ok(pv16b.results.every(r => r.state === 'back'))
    await data('moveDay', { from: D16, confirm: true, expect: pv16b.expect })
    assert.equal((await planKey())[D16], undefined)
    assert.equal((await data('planDayChoices', { brandId: 'skipco' })).brand.pinnedOn, null, 'Skip Co is pinned nowhere')
    // Opened again from a menu: the day comes back (empty), its Undo with it.
    const re16 = await data('setExtraSendingDay', { date: D16, on: true })
    assert.equal(re16.reopened, true)
    op16 = await data('getOutreachPlan', {})
    assert.ok(op16.days.some(d => d.date === D16) && !op16.skipDays.length && !op16.extraDays.includes(D16), 'a regular day again, not an extra one')
    // A day moved onto one taken off earlier: that one comes back, only the
    // moved day is off, and its Undo leaves the reopened day open.
    const E16 = op16.days.filter(d => !d.today && d.date !== D16).map(d => d.date).slice(-1)[0]
    const pvx16 = await data('moveDay', { from: D16 })
    await data('moveDay', { from: D16, confirm: true, expect: pvx16.expect })
    await mk('skipco2', 'Skip Co Two', 'energy')
    await data('planAddBrands', { date: E16, brandIds: ['skipco2'] })
    const pve16 = await data('moveDay', { from: E16, to: D16, addDay: true })
    assert.deepEqual([pve16.opening, pve16.reopens], [true, true], 'says it sends on that day after all')
    await data('moveDay', { from: E16, to: D16, addDay: true, confirm: true, expect: pve16.expect })
    op16 = await data('getOutreachPlan', {})
    assert.deepEqual(op16.skipDays.map(x => x.date), [E16], 'the target came back; only the moved day is off')
    assert.ok(op16.days.some(d => d.date === D16) && !op16.extraDays.includes(D16))
    assert.ok((await planKey())[D16].brandIds.includes('skipco2'))
    const une16 = await data('undoMoveDay', { date: E16, preview: true })
    assert.equal(une16.closeTo, false, 'a day reopened (not opened) by the move stays open')
    await data('undoMoveDay', { date: E16 })
    assert.ok((await planKey())[E16].brandIds.includes('skipco2') && !((await planKey())[D16]?.brandIds || []).includes('skipco2'))
    ok('skip-day: Move this day previews, refuses stale, moves the whole plan onto an empty day, the day goes off everywhere, Undo, take it off, reopen')

    // 17. Today's list for Zach: flagged people stop holding spots
    //     (copy-flagged). The LinkedIn tab sees the same flag; Leave out
    //     previews, then takes them off today; Undo puts them back.
    const fl17 = await mkBrand('Flag Co', { category: 'nicotine' }, [['Fred Front', 'Store Manager'], ['Pia Partner', 'Head of Partnerships']])
    const fred = await prisma.target.create({ data: { brandId: 'Flag Co', contactId: fl17[0].id, status: 'drafted', queuedFor: new Date() } })
    await prisma.target.create({ data: { brandId: 'Flag Co', contactId: fl17[1].id, status: 'queued', queuedFor: new Date() } })
    const tq17 = await data('getTodayQueue', {})
    const fredRow = tq17.targets.find(t => t.id === fred.id)
    assert.ok(fredRow, 'Fred is in today\'s list')
    assert.match(fredRow.problem, /store staff/, 'the LinkedIn tab gets the flag')
    assert.equal(tq17.targets.find(t => t.contact.name === 'Pia Partner').problem, null)
    let sl17 = await data('todaySendList', {})
    const flagged17 = sl17.brands.flatMap(b => b.people).filter(p => p.problem).length
    assert.equal(sl17.flagged, flagged17, 'flagged = the problem ones only')
    assert.equal(typeof sl17.swaps, 'number')
    const lpv = await data('leaveOutPeople', { targetIds: [fred.id] })
    assert.deepEqual(lpv.people.map(p => [p.name, p.brand]), [['Fred Front', 'Flag Co']])
    assert.match(lpv.people[0].problem, /store staff/)
    assert.equal((await prisma.target.findUnique({ where: { id: fred.id } })).status, 'drafted', 'a preview changes nothing')
    const lo = await data('leaveOutPeople', { targetIds: [fred.id], confirm: true })
    assert.equal(lo.left, 1)
    let fredNow = await prisma.target.findUnique({ where: { id: fred.id } })
    assert.deepEqual([fredNow.status, fredNow.queuedFor], ['passed', null], 'off today and skipped')
    sl17 = await data('todaySendList', {})
    assert.deepEqual([sl17.leftOut.n, sl17.leftOut.names], [1, ['Fred Front']], 'the Undo is offered')
    assert.ok(!sl17.brands.flatMap(b => b.people).some(p => p.name === 'Fred Front'))
    const ul = await data('undoLeaveOutPeople', {})
    assert.deepEqual(ul.names, ['Fred Front'])
    fredNow = await prisma.target.findUnique({ where: { id: fred.id } })
    assert.equal(fredNow.status, 'drafted', 'back as he was')
    assert.ok(fredNow.queuedFor && nyKey(fredNow.queuedFor) === today, 'back in today\'s list')
    assert.equal((await data('undoLeaveOutPeople', {})).ok, false, 'one Undo')
    ok('copy-flagged: the LinkedIn tab gets the flag, flagged counts problems only, Leave out previews then frees the spots, Undo puts them back')

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
