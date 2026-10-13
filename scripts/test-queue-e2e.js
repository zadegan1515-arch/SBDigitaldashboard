// scripts/test-queue-e2e.js — today's LinkedIn queue, for real: the
// /api/data handlers on a local `next dev`, backed by a throwaway Postgres
// (wiped). Leo, Oct 12 2026: "make the schedule as efficient as possible".
//
//   A. The morning roll: a brand Zach sent only some of yesterday carries to
//      today and its rest goes out (Leo: "If Zach sends only some of a
//      brand's people one day, the rest go out on the next sending day");
//      one part-sent on an earlier day rests; a brand passed (two weeks)
//      that the Schedule showed yesterday never carries back in.
//   B. A Pass holds on later category days and in Plan my week.
//   C. One order for today (planned → hand → the fill best first), the same
//      on every load, in Today's list for Zach and the Schedule's today
//      column; a reload adds nobody (no executives stepping in).
//   D. Leave out never refills; "+ Person" still may reach the CEO; Off
//      queue = off today only, for a planned and an automatic brand.
//   E. Withdrew on an old invite keeps it counted (the brand stays reached);
//      on one sent today it uncounts.
//   F. Adding to today never pushes out an earlier pin.
//   G. "Ready if you have room" offers whole brands, stamping nobody.
//   Review fixes (Oct 13 2026):
//   H. A part-sent brand's sitting is judged by the calendar as it was: a
//      day taken off (or an extra day opened) that has gone by still counts,
//      and writes keep those days.
//   I. Off queue on a brand part-sent today pins the rest of it at the front
//      of the next sending day.
//   J. A planned brand with one person queued by hand before the tab loaded
//      still opens whole (the Schedule says so first); a reload adds nobody.
//   K. A brand the email machine reached: the queue and its preview agree.
//   L. Flagged people out before executives (a founder who is the only real
//      buyer goes); a flagged person waiting doesn't go ahead of buyers.
//   M. Undo of a day moved onto what is now today takes its brands' people
//      out of today's list — a brand that sent today stays.
//   N. Move this day to…: the preview judges by the calendar the apply uses.
//   P. A deal changes the Schedule's stamp.
//   Q. A big brand already in today's list on a Best fit day: the Schedule's
//      today column says what the queue then stamps.
//   O. LinkedIn's week used up: Fill says so; hand adds keep the flat 30.
//
// The roll runs once per server process per day, so A sets up "yesterday"
// before anything reads the plan.
//   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-queue-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-queue-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3468);
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

// New York day keys, the way the dashboard counts days.
const nyKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const shift = (key, n) => new Date(new Date(key + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const noonNY = (key) => new Date(key + 'T16:00:00Z'); // noon EDT / 11am EST — that New York day either way
const EXEC = /founder|\bceo\b|chief executive|\bcfo\b|president|owner/i;

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
    const yday = shift(today, -1);
    const sixAgo = shift(today, -6);
    const mkBrand = async (id, name, category, o = {}) => {
      await prisma.brand.create({ data: { id, name, category, tier: 'growth', liMembers: 120, usStatus: 'yes', ...o } });
    };
    const mkPeople = async (brandId, titles) => {
      const out = [];
      for (const [i, title] of titles.entries()) {
        out.push(await prisma.contact.create({ data: { brandId, name: brandId + ' P' + i, title, linkedinUrl: 'https://www.linkedin.com/in/' + brandId + i, isDecisionMaker: true } }));
      }
      return out;
    };
    const BUYERS = ['Brand Manager', 'Head of Partnerships', 'Marketing Director'];
    const setting = async (key, value) => {
      const v = JSON.stringify(value);
      await prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
    };

    // ---- A. The morning roll ---------------------------------------------
    // Today is a sending day (an extra one if it isn't Tue–Thu) and a
    // category day, so the Schedule's "shown" rows count for the roll.
    await data('setExtraSendingDay', { date: today, on: true });
    await setting('outreachPlan', { [today]: { category: 'electrolytes', brandIds: [] } });
    // Halfway: two of four sent yesterday (its first outreach), two in
    // yesterday's queue never sent.
    await mkBrand('half', 'Halfway Hydration', 'electrolytes');
    const hp = await mkPeople('half', ['Brand Manager', 'Head of Partnerships', 'Marketing Director', 'Brand Lead']);
    for (const c of hp.slice(0, 2)) await prisma.target.create({ data: { brandId: 'half', contactId: c.id, status: 'sent', sentAt: noonNY(yday), queuedFor: noonNY(yday) } });
    const halfRest = [];
    for (const c of hp.slice(2)) halfRest.push((await prisma.target.create({ data: { brandId: 'half', contactId: c.id, status: 'drafted', queuedFor: noonNY(yday) } })).id);
    // Late: part-sent six days ago — its next sending day has gone by.
    await mkBrand('late', 'Late Lemonade', 'electrolytes');
    const lp = await mkPeople('late', BUYERS);
    await prisma.target.create({ data: { brandId: 'late', contactId: lp[0].id, status: 'sent', sentAt: noonNY(sixAgo), queuedFor: noonNY(sixAgo) } });
    for (const c of lp.slice(1)) await prisma.target.create({ data: { brandId: 'late', contactId: c.id, status: 'drafted', queuedFor: noonNY(sixAgo) } });
    // Passy: passed two days ago (two weeks), people waiting in the pool,
    // and yesterday's Schedule showed it anyway (the old leak).
    await mkBrand('passy', 'Passy Pop', 'electrolytes', {
      passedTodayAt: noonNY(shift(today, -2)), passedUntil: new Date(Date.now() + 12 * 864e5),
    });
    for (const c of await mkPeople('passy', BUYERS)) await prisma.target.create({ data: { brandId: 'passy', contactId: c.id, status: 'queued' } });
    await setting('outreachDayRows', { day: yday, brandIds: ['passy'] });

    let plan = await data('getOutreachPlan');  // the first plan read of the day: the roll
    assert.deepEqual(plan.plan[today].brandIds, ['half'], 'only Halfway carried: ' + JSON.stringify(plan.plan[today]));
    assert.deepEqual((plan.carry?.brands || []).map(b => [b.id, b.from, b.people]), [['half', yday, 2]], 'the carry note names it');
    const todayCol = plan.days.find(d => d.date === today);
    const halfCard = todayCol.pinned.find(p => p.id === 'half');
    assert.deepEqual([halfCard.state, halfCard.going], ['going', 2], 'the Schedule: its two going today, not "resting"');
    assert.ok(!plan.days.some(d => d.brands.concat(d.pinned).some(b => b.id === 'passy')), 'Passy on no day');
    let tq = await data('getTodayQueue');
    assert.deepEqual(tq.targets.filter(t => t.brandId === 'half').map(t => t.id).sort(), halfRest.sort(), 'the rest of Halfway is in today\'s list');
    assert.ok(!tq.targets.some(t => ['late', 'passy'].includes(t.brandId)), 'Late and Passy are not');
    assert.equal(await prisma.target.count({ where: { brandId: 'late', queuedFor: { not: null }, status: { in: ['queued', 'drafted'] } } }), 0, 'Late\'s people back to waiting');
    assert.ok((await prisma.brand.findUnique({ where: { id: 'passy' } })).passedUntil, 'the Pass still runs');
    const brandPage = await data('planDayChoices', { brandId: 'late' });
    assert.equal(brandPage.brand.refusalReason, 'resting', 'Late rests');
    ok('the roll: a part-sent brand\'s rest goes out the next sending day; one a day late rests; a passed brand never carries');

    // ---- B. A Pass holds on later days ----------------------------------
    const later = plan.days.map(d => d.date).filter(k => k > today);
    for (const k of later) await data('planSetCategory', { date: k, category: 'electrolytes' });
    plan = await data('getOutreachPlan');
    assert.ok(!plan.days.some(d => d.brands.concat(d.pinned, d.overflow || []).some(b => b.id === 'passy')), 'not on a later electrolytes day either');
    const pw = await data('planWeek', {});
    assert.ok(!pw.days.some(d => d.add.some(a => a.id === 'passy')), 'Plan my week leaves it out');
    for (const k of later) await data('planSetCategory', { date: k, category: null });
    ok('a Pass holds on every day\'s rows and in Plan my week');

    // ---- C. One order, and a reload adds nobody ---------------------------
    await data('planSetCategory', { date: today, category: null });   // Best fit
    await mkBrand('bigx', 'Bigxo Energy', 'energy', { liMembers: 800 });
    await mkPeople('bigx', ['Brand Manager', 'Head of Partnerships', 'Marketing Director', 'CEO', 'Founder', 'CFO']);
    await mkBrand('topE', 'Topper Electrolytes', 'electrolytes');
    await mkPeople('topE', BUYERS);
    await mkBrand('midS', 'Middle Beauty', 'beauty');
    await mkPeople('midS', BUYERS);
    await mkBrand('lowA', 'Lowly Apparel', 'apparel');
    await mkPeople('lowA', BUYERS);
    await data('planAddBrands', { date: today, brandIds: ['bigx'] });
    const order = (list) => [...new Set(list.map(t => t.brandId))];
    const q1 = await data('getTodayQueue');
    const q2 = await data('getTodayQueue');
    const want = ['half', 'bigx', 'topE', 'midS', 'lowA'];
    assert.deepEqual(order(q1.targets), want, 'planned in order, then the fill best first');
    assert.deepEqual(q2.targets.map(t => t.id), q1.targets.map(t => t.id), 'a reload: the same people, the same order');
    const bigStamped = q2.targets.filter(t => t.brandId === 'bigx');
    assert.equal(bigStamped.length, 3, 'Bigxo: its three marketing people');
    assert.ok(!bigStamped.some(t => EXEC.test(t.contact.title || '')), 'no executive stepped in on the reload');
    const zl = await data('todaySendList');
    assert.deepEqual(zl.brands.map(b => b.brandId), want, 'Today\'s list for Zach: the same order');
    plan = await data('getOutreachPlan');
    const col = plan.days.find(d => d.date === today);
    assert.deepEqual([col.pinned.map(p => p.id), col.brands.map(r => r.id)], [['half', 'bigx'], ['topE', 'midS', 'lowA']], 'the Schedule\'s today column too');
    ok('one order for today on every load (LinkedIn tab, Zach\'s list, the Schedule); a reload adds nobody');

    // ---- D. Leave out, + Person, Off queue --------------------------------
    await data('passContact', { contactId: bigStamped[0].contactId });
    let q3 = await data('getTodayQueue');
    assert.equal(q3.targets.filter(t => t.brandId === 'bigx').length, 2, 'Leave out: nobody refills the spot');
    await data('queueBrandTargets', { brandId: 'bigx', force: true });
    const execNow = (await prisma.target.findMany({ where: { brandId: 'bigx', queuedFor: { not: null }, status: { in: ['queued', 'drafted'] } }, include: { contact: true } }))
      .filter(t => EXEC.test(t.contact.title || ''));
    assert.equal(execNow.length, 1, '+ Person (force) may still reach an executive on purpose');
    await data('unqueueBrand', { brandId: 'bigx' });
    await data('unqueueBrand', { brandId: 'lowA' });
    q3 = await data('getTodayQueue');
    assert.ok(!q3.targets.some(t => ['bigx', 'lowA'].includes(t.brandId)), 'Off queue sticks through a reload');
    const bx = await prisma.brand.findUnique({ where: { id: 'bigx' } });
    assert.ok(bx.passedTodayAt && !bx.passedUntil, 'today only — not the two-week Pass');
    assert.equal(await prisma.target.count({ where: { brandId: 'bigx', shelved: true } }), 0, 'nobody shelved');
    plan = await data('getOutreachPlan');
    assert.ok(!plan.plan[today].brandIds.includes('bigx'), 'off today\'s plan');
    ok('Leave out stays out, + Person still reaches the CEO, Off queue is today only (planned and automatic)');

    // ---- E. Withdrew --------------------------------------------------------
    await mkBrand('oldw', 'Oldway Water', 'electrolytes');
    const ow = await mkPeople('oldw', BUYERS);
    const oldInvite = await prisma.target.create({ data: { brandId: 'oldw', contactId: ow[0].id, status: 'sent', sentAt: new Date(Date.now() - 10 * 864e5) } });
    await mkBrand('neww', 'Newway Water', 'electrolytes');
    const nw = await mkPeople('neww', BUYERS);
    const newInvite = await prisma.target.create({ data: { brandId: 'neww', contactId: nw[0].id, status: 'sent', sentAt: new Date() } });
    await data('setTargetStatus', { targetId: oldInvite.id, status: 'withdrawn' });
    await data('setTargetStatus', { targetId: newInvite.id, status: 'withdrawn' });
    const o1 = await prisma.target.findUnique({ where: { id: oldInvite.id }, include: { events: true } });
    assert.deepEqual([o1.status, !!o1.sentAt], ['withdrawn', true], 'an old invite keeps its date');
    assert.match(o1.events[0].detail, /withdrawn on LinkedIn/);
    assert.equal((await prisma.target.findUnique({ where: { id: newInvite.id } })).sentAt, null, 'one sent today is uncounted');
    tq = await data('getTodayQueue');
    assert.ok(!tq.targets.some(t => t.brandId === 'oldw'), 'Oldway stays reached: Best fit never picks it again');
    ok('Withdrew: an old invite still counts (the brand stays reached), a same-day one is uncounted');

    // ---- F. Adding to today never pushes out a pin ------------------------
    await prisma.target.updateMany({ where: { queuedFor: { not: null } }, data: { queuedFor: null } });
    const pins = [];
    for (let i = 0; i < 10; i++) {
      await mkBrand('pin' + i, 'Pinned Brand ' + i, 'beverage');
      await mkPeople('pin' + i, BUYERS);
      pins.push('pin' + i);
    }
    await mkBrand('extra', 'Extra Energy', 'energy');
    await mkPeople('extra', BUYERS);
    const cur = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    cur[today] = { category: null, brandIds: pins };
    await setting('outreachPlan', cur);
    await data('planAddBrands', { date: today, brandIds: ['extra'] });
    for (const id of pins) assert.equal(await prisma.target.count({ where: { brandId: id, queuedFor: { not: null } } }), 3, id + ' stamped before the add');
    assert.equal(await prisma.target.count({ where: { brandId: 'extra', queuedFor: { not: null } } }), 3, 'the add goes in too (past the 30)');
    tq = await data('getTodayQueue');
    assert.deepEqual(tq.plannedWaiting, [], 'no earlier pin waits');
    assert.deepEqual(order(tq.targets), [...pins, 'extra'], 'in the plan\'s order, the add last');
    ok('adding to today: every earlier pin goes in first, the add last');

    // ---- G. Ready if you have room: whole brands ---------------------------
    await data('planSetCategory', { date: today, category: 'energy' });
    await mkBrand('poolE', 'Pool Energy', 'energy');
    for (const c of await mkPeople('poolE', BUYERS)) await prisma.target.create({ data: { brandId: 'poolE', contactId: c.id, status: 'queued' } });
    tq = await data('getTodayQueue');
    const m = (tq.moreBrands || []).find(x => x.brandId === 'poolE');
    assert.ok(m, 'Pool Energy offered: ' + JSON.stringify(tq.moreBrands));
    assert.deepEqual([m.size, m.people.length, tq.openSpots], [3, 3, 0], 'the whole brand, and the day is full');
    assert.deepEqual(tq.more, [], 'no single people any more');
    assert.equal(await prisma.target.count({ where: { brandId: 'poolE', queuedFor: { not: null } } }), 0, 'offering stamps nobody');
    assert.ok((await prisma.brand.findUnique({ where: { id: 'passy' } })).passedUntil, 'Passy\'s Pass ran through all of it');
    assert.equal(await prisma.target.count({ where: { brandId: 'passy', queuedFor: { not: null } } }), 0);
    ok('"ready if you have room" offers whole brands and stamps nobody');

    // ---- H. The sitting, judged by the calendar as it was ----------------
    const regular = (k) => [2, 3, 4].includes(new Date(k + 'T12:00:00Z').getUTCDay());
    const skipLog = (o) => ({ at: new Date().toISOString(), by: null, to: null, wasExtra: false, opened: false, pins: [], category: null, moved: [], toCategory: null, ...o });
    const unstampAll = () => prisma.target.updateMany({ where: { queuedFor: { not: null } }, data: { queuedFor: null } });
    await unstampAll();
    const d1 = shift(today, -2);
    // A future day taken off, for the write check below.
    let fut = shift(today, 2);
    while (!regular(fut)) fut = shift(fut, 1);
    const extrasRow = await prisma.setting.findUnique({ where: { key: 'outreachExtraDays' } });
    const extrasNow = extrasRow ? JSON.parse(extrasRow.value) : [];
    if (regular(yday)) {
      // Yesterday was a Tue–Thu Leo took off: the brand part-sent the day
      // before finishes today. Rebuilt from today's calendar, yesterday was
      // its second day and today it "rested".
      await setting('outreachSkipDays', { [shift(today, -3)]: skipLog(), [yday]: skipLog(), [fut]: skipLog() });
      await mkBrand('histS', 'History Seltzer', 'rtd');
      const hs = await mkPeople('histS', BUYERS);
      await prisma.target.create({ data: { brandId: 'histS', contactId: hs[0].id, status: 'sent', sentAt: noonNY(d1) } });
      for (const c of hs.slice(1)) await prisma.target.create({ data: { brandId: 'histS', contactId: c.id, status: 'queued' } });
      assert.equal((await data('planDayChoices', { brandId: 'histS' })).brand.refusalReason, null, 'not resting: today is its second day');
      const r = await data('queueBrandTargets', { brandId: 'histS' });
      assert.ok(r.queued, 'the rest goes: ' + JSON.stringify(r));
      assert.equal(await prisma.target.count({ where: { brandId: 'histS', queuedFor: { not: null } } }), 2, 'both the rest');
    } else {
      // Yesterday was an extra day it part-sent on again: its sitting is
      // over. Rebuilt from today's calendar, today was its second day.
      await setting('outreachExtraDays', [yday, ...extrasNow]);
      await setting('outreachSkipDays', { [shift(today, -3)]: skipLog(), [fut]: skipLog() });
      await mkBrand('histX', 'History Xtra', 'rtd');
      const hx = await mkPeople('histX', BUYERS);
      await prisma.target.create({ data: { brandId: 'histX', contactId: hx[0].id, status: 'sent', sentAt: noonNY(d1) } });
      await prisma.target.create({ data: { brandId: 'histX', contactId: hx[1].id, status: 'sent', sentAt: noonNY(yday) } });
      await prisma.target.create({ data: { brandId: 'histX', contactId: hx[2].id, status: 'queued' } });
      assert.equal((await data('planDayChoices', { brandId: 'histX' })).brand.refusalReason, 'resting', 'rests: its sitting was yesterday');
      const r = await data('queueBrandTargets', { brandId: 'histX' });
      assert.deepEqual([r.queued, r.reason], [false, 'resting']);
    }
    // Writes keep the days gone by: reopen the future day off, open and
    // close an extra day.
    await data('setExtraSendingDay', { date: fut, on: true });
    let extraLater = shift(today, 3);
    while (regular(extraLater)) extraLater = shift(extraLater, 1);
    await data('setExtraSendingDay', { date: extraLater, on: true });
    await data('setExtraSendingDay', { date: extraLater, on: false });
    const skipsKept = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachSkipDays' } })).value);
    assert.ok(skipsKept[shift(today, -3)] && !skipsKept[fut], 'a past day off is kept, the reopened one gone: ' + Object.keys(skipsKept));
    if (!regular(yday)) assert.ok(JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachExtraDays' } })).value).includes(yday), 'a past extra day is kept');
    const extraBack = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachExtraDays' } })).value);
    assert.ok(!extraBack.includes(extraLater), 'the extra day closed again');
    await unstampAll();
    ok('a part-sent brand\'s sitting reads the days off and the extra days as they were; writes keep them');

    // ---- I. Off queue on a brand part-sent today ---------------------------
    plan = await data('getOutreachPlan');
    const n1 = plan.days.map(d => d.date).filter(k => k > today)[0];
    await mkBrand('offP', 'Offpart Pop', 'rtd');
    const op = await mkPeople('offP', BUYERS);
    await prisma.target.create({ data: { brandId: 'offP', contactId: op[0].id, status: 'sent', sentAt: new Date(), queuedFor: new Date() } });
    for (const c of op.slice(1)) await prisma.target.create({ data: { brandId: 'offP', contactId: c.id, status: 'queued', queuedFor: new Date() } });
    const uq = await data('unqueueBrand', { brandId: 'offP' });
    assert.equal(uq.restOn, n1, 'the rest goes out the next sending day: ' + JSON.stringify(uq));
    plan = await data('getOutreachPlan');
    assert.equal(plan.plan[n1].brandIds[0], 'offP', 'first on that day');
    const offCard = plan.days.find(d => d.date === n1).pinned.find(p => p.id === 'offP');
    assert.deepEqual([offCard.state, offCard.going], ['going', 2], 'its two going there');
    const ob = await prisma.brand.findUnique({ where: { id: 'offP' } });
    assert.ok(ob.passedTodayAt && !ob.passedUntil, 'off today only');
    assert.equal(await prisma.target.count({ where: { brandId: 'offP', status: 'queued', queuedFor: { not: null } } }), 0, 'out of today\'s list');
    ok('Off queue on a part-sent brand: off today, the rest pinned first on the next sending day');

    // ---- J. A planned brand opens whole after one hand-queued person -------
    await mkBrand('openJ', 'Openjay Juice', 'rtd');
    const oj = await mkPeople('openJ', BUYERS);
    const curJ = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    curJ[today] = { category: curJ[today]?.category ?? null, brandIds: [...(curJ[today]?.brandIds ?? []), 'openJ'] };
    await setting('outreachPlan', curJ);
    await data('queueContact', { contactId: oj[0].id });
    plan = await data('getOutreachPlan');
    const jCard = plan.days.find(d => d.date === today).pinned.find(p => p.id === 'openJ');
    assert.deepEqual([jCard.state, jCard.going, jCard.pendingQueue], ['going', 3, true], 'the Schedule: all three, before the tab loads');
    tq = await data('getTodayQueue');
    assert.equal(tq.targets.filter(t => t.brandId === 'openJ').length, 3, 'the tab opens it to its number');
    tq = await data('getTodayQueue');
    assert.equal(tq.targets.filter(t => t.brandId === 'openJ').length, 3, 'a reload adds nobody');
    await data('passContact', { contactId: oj[1].id });
    tq = await data('getTodayQueue');
    assert.equal(tq.targets.filter(t => t.brandId === 'openJ').length, 2, 'Leave out: nobody refills');
    ok('a planned brand with one hand-queued person opens whole, the Schedule says so first; a reload adds nobody');

    // ---- K. A brand the email machine reached ------------------------------
    await mkBrand('mailK', 'Mailkay Mints', 'rtd');
    const mk = await mkPeople('mailK', [...BUYERS, 'Partnerships Manager']);
    const mt = await prisma.target.create({ data: { brandId: 'mailK', contactId: mk[0].id, status: 'queued' } });
    await prisma.emailMessage.create({ data: { targetId: mt.id, direction: 'out', kind: 'intro', status: 'sent', sentAt: new Date(Date.now() - 28 * 864e5) } });
    await prisma.target.create({ data: { brandId: 'mailK', contactId: mk[1].id, status: 'sent', sentAt: noonNY(yday) } });
    for (const c of mk.slice(2)) await prisma.target.create({ data: { brandId: 'mailK', contactId: c.id, status: 'queued' } });
    const kp = await data('planAddBrands', { date: today, brandIds: ['mailK'], preview: true });
    const kGoing = kp.results[0].going;
    await data('queueBrandTargets', { brandId: 'mailK' });
    const kStamped = await prisma.target.count({ where: { brandId: 'mailK', queuedFor: { not: null } } });
    assert.equal(kStamped, kGoing, 'the queue does what its preview said (' + kGoing + ')');
    assert.equal(kStamped, 1, 'emailed four weeks ago: not finishing a first sitting, its narrower number');
    ok('a brand the email machine reached: the queue and its preview agree on its first outreach');

    // ---- L. Flagged people out before executives ---------------------------
    await mkBrand('flagL', 'Flagell Foods', 'rtd');
    await mkPeople('flagL', ['Founder & CEO', 'Sales Manager', 'Operations Coordinator']);
    const lp2 = await data('planAddBrands', { date: today, brandIds: ['flagL'], preview: true });
    assert.deepEqual(lp2.results[0].people.map(x => x.title), ['Founder & CEO'], 'the preview: the founder');
    await data('queueBrandTargets', { brandId: 'flagL' });
    const lq = await prisma.target.findMany({ where: { brandId: 'flagL', queuedFor: { not: null } }, include: { contact: true } });
    assert.deepEqual(lq.map(t => t.contact.title), ['Founder & CEO'], 'the queue: the founder, not the flagged staff');
    await mkBrand('flagP', 'Flagpool Fizz', 'rtd');
    const fp = await mkPeople('flagP', ['Brand Marketing Intern', 'Marketing Director', 'Head of Partnerships', 'Events Lead']);
    const intern = await prisma.target.create({ data: { brandId: 'flagP', contactId: fp[0].id, status: 'queued' } });
    const pp = await data('planAddBrands', { date: today, brandIds: ['flagP'], preview: true });
    assert.deepEqual(pp.results[0].people.map(x => x.title).sort(), ['Events Lead', 'Head of Partnerships', 'Marketing Director'], 'the preview: the three buyers');
    await data('queueBrandTargets', { brandId: 'flagP' });
    const pq = await prisma.target.findMany({ where: { brandId: 'flagP', queuedFor: { not: null } }, include: { contact: true } });
    assert.deepEqual(pq.map(t => t.contact.title).sort(), ['Events Lead', 'Head of Partnerships', 'Marketing Director'], 'the queue: the three buyers');
    const it = await prisma.target.findUnique({ where: { id: intern.id } });
    assert.deepEqual([it.shelved, it.shelvedHow, it.queuedFor], [true, 'cap', null], 'the intern waits next in line');
    ok('flags before executives: the founder goes; a flagged person waiting stays next in line behind the buyers');

    // ---- M. Undo of a day moved onto today ---------------------------------
    await mkBrand('undoA', 'Undo Ale', 'rtd');
    const ua = await mkPeople('undoA', BUYERS.slice(0, 2));
    for (const c of ua) await prisma.target.create({ data: { brandId: 'undoA', contactId: c.id, status: 'queued', queuedFor: new Date() } });
    await mkBrand('undoB', 'Undo Bitters', 'rtd');
    const ub = await mkPeople('undoB', BUYERS.slice(0, 2));
    await prisma.target.create({ data: { brandId: 'undoB', contactId: ub[0].id, status: 'sent', sentAt: new Date(), queuedFor: new Date() } });
    const ubListed = await prisma.target.create({ data: { brandId: 'undoB', contactId: ub[1].id, status: 'queued', queuedFor: new Date() } });
    let mFrom = shift(today, 1);
    while (!regular(mFrom) || mFrom === fut) mFrom = shift(mFrom, 1);
    const curM = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    curM[today] = { category: curM[today]?.category ?? null, brandIds: [...(curM[today]?.brandIds ?? []), 'undoA', 'undoB'] };
    await setting('outreachPlan', curM);
    const skipsM = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachSkipDays' } })).value);
    await setting('outreachSkipDays', { ...skipsM, [mFrom]: skipLog({ to: today, pins: ['undoA', 'undoB'], moved: ['undoA', 'undoB'] }) });
    const um = await data('undoMoveDay', { date: mFrom, preview: true });
    assert.deepEqual([um.back, um.stay.map(x => [x.name, x.on]), um.unqueue], [['Undo Ale'], [['Undo Bitters', today]], [{ brand: 'Undo Ale', people: 2 }]], JSON.stringify(um));
    assert.equal(um.closeTo, false, 'today stays a sending day');
    const umApply = await data('undoMoveDay', { date: mFrom });
    assert.equal(umApply.unqueued, 2);
    assert.equal(await prisma.target.count({ where: { brandId: 'undoA', queuedFor: { not: null } } }), 0, 'Undo Ale out of today\'s list');
    assert.ok((await prisma.target.findUnique({ where: { id: ubListed.id } })).queuedFor, 'Undo Bitters (sent today) keeps its listed person');
    const planM = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.deepEqual([planM[mFrom]?.brandIds, planM[today].brandIds.includes('undoB'), planM[today].brandIds.includes('undoA')], [['undoA'], true, false]);
    ok('Undo onto today: its brands\' people come out of today\'s list, a brand that sent today stays');

    // ---- N. Move this day to…: the preview reads the apply's calendar -----
    plan = await data('getOutreachPlan');
    const later2 = plan.days.map(d => d.date).filter(k => k > today);
    const [nA, nB] = later2;
    await mkBrand('mvH', 'Movehalf Mead', 'rtd');
    const mh = await mkPeople('mvH', BUYERS);
    await prisma.target.create({ data: { brandId: 'mvH', contactId: mh[0].id, status: 'sent', sentAt: new Date() } });
    for (const c of mh.slice(1)) await prisma.target.create({ data: { brandId: 'mvH', contactId: c.id, status: 'queued' } });
    const pinH = await data('planAddBrands', { date: nA, brandIds: ['mvH'] });
    assert.equal(pinH.results[0].added, true, 'the rest of it on its next sending day');
    const mvp = await data('moveDay', { from: nA, to: nB, preview: true });
    const hRes = mvp.results.find(r => r.brandId === 'mvH');
    assert.deepEqual([hRes.added, hRes.state, hRes.going], [true, 'going', 2], 'the preview: it goes on ' + nB + ' (the day it really finishes)');
    const mva = await data('moveDay', { from: nA, to: nB, confirm: true, expect: mvp.expect });
    assert.ok(mva.ok && mva.results.find(r => r.brandId === 'mvH').added, 'the apply does what the preview said');
    await data('undoMoveDay', { date: nA });
    ok('Move this day to…: the preview judges a part-sent brand by the calendar the move makes');

    // ---- P. A deal changes the Schedule's stamp ----------------------------
    let s1 = (await data('getOutreachPlan')).stamp;
    if (!(await data('getOutreachPlan', { since: s1 })).unchanged) s1 = (await data('getOutreachPlan')).stamp;
    await prisma.deal.create({ data: { brandId: 'oldw', name: 'Oldway deal' } });
    assert.ok(!(await data('getOutreachPlan', { since: s1 })).unchanged, 'a new deal is a change (Ready for a second try reads deals)');
    ok('a deal changes the Schedule\'s stamp');

    // ---- Q. A big brand already in today's list on a Best fit day ---------
    await unstampAll();
    const curQ = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    curQ[today] = { category: null, brandIds: [] };
    await setting('outreachPlan', curQ);
    await mkBrand('bigH', 'Bighold Brew', 'energy', { liMembers: 800 });
    const bh = await mkPeople('bigH', [...BUYERS, 'Partnerships Manager', 'Events Manager']);
    for (const [i, c] of bh.entries()) await prisma.target.create({ data: { brandId: 'bigH', contactId: c.id, status: 'queued', queuedFor: i === 0 ? new Date() : null } });
    plan = await data('getOutreachPlan');
    const qCol = plan.days.find(d => d.date === today);
    const bigRow = qCol.brands.find(r => r.id === 'bigH');
    tq = await data('getTodayQueue');
    const bigNow = tq.targets.filter(t => t.brandId === 'bigH').length;
    assert.equal(bigNow, 5, 'the queue tops it up to its number');
    assert.equal(bigRow && bigRow.going, bigNow, 'the Schedule\'s today column says the same: ' + JSON.stringify(bigRow));
    ok('a big brand in today\'s list on a Best fit day: the Schedule says what the queue stamps');

    // ---- O. LinkedIn's week used up ----------------------------------------
    await mkBrand('heavy', 'Heavyweek Co', 'beauty', { passedAt: new Date() });
    const hv = [];
    for (let i = 0; i < 100; i++) hv.push({ id: 'hvc' + i, brandId: 'heavy', name: 'Heavy ' + i, title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/hv' + i });
    await prisma.contact.createMany({ data: hv });
    await prisma.target.createMany({ data: hv.map((c, i) => ({ brandId: 'heavy', contactId: c.id, status: 'sent', sentAt: noonNY(shift(today, -1 - (i % 5))) })) });
    tq = await data('getTodayQueue');
    assert.deepEqual([tq.dayCap, tq.openSpots], [0, 0], 'nothing left for automatic picks');
    assert.ok(tq.handSpots > 0, 'hand adds keep the flat 30: ' + tq.handSpots);
    const fw = await data('fillToday');
    assert.deepEqual([fw.weekFull, fw.added, fw.dayCap], [true, 0, 0], 'Fill says the week is used up: ' + JSON.stringify(fw));
    ok('LinkedIn\'s week used up: Fill says so, hand adds keep the flat 30');

    console.log('queue e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
