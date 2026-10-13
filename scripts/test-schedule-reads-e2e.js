// scripts/test-schedule-reads-e2e.js — the faster Schedule (Oct 2026,
// batch 5 of "make the schedule as efficient as possible": the same
// answers, fewer and lighter reads) against the real /api/data handlers on
// a local `next dev` and a throwaway Postgres (wiped):
//
//   1. getOutreachPlan carries a stamp; the same stamp back (since) answers
//      { unchanged } — its own writes (the days it showed) don't count — and
//      any change, or a `__` argument from the wire, doesn't.
//   2. suggest: every day with open spots carries exactly what suggestForDay
//      answers for it, today and a later day.
//   3. planApplyCategory applyIfNone: nothing to take off → applied in the
//      one call; something to take off → only the preview.
//   4. setBrandPassed unpin: off its day in the same call (and passed for
//      today when that day is today); without it, nothing else changes.
//   5. listTargets sentBefore: the same rows the page cut itself.
//   6. The LinkedIn tab's first open drafts everyone in one go: two drafts
//      each, man then woman, drafted once with one event; a second open
//      makes none. New people are made in pick order.
//   7. categoryCoverage leaves a person out; matchBrandList still matches.
//
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-schedule-reads-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-schedule-reads-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3469);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

const post = (fn, args) => fetch(BASE + '/api/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN },
  body: JSON.stringify({ fn, args: args || {} }),
});
const data = async (fn, args) => {
  const r = await post(fn, args);
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) throw new Error(fn + ': ' + (j.error || r.status));
  return j.data;
};

const nyKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const shift = (key, n) => new Date(new Date(key + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const noonNY = (key) => new Date(key + 'T16:00:00Z');

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
    const setting = async (key, value) => {
      const v = JSON.stringify(value);
      await prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
    };
    const mkBrand = async (id, name, category, o = {}) =>
      prisma.brand.create({ data: { id, name, category, tier: 'growth', liMembers: 120, usStatus: 'yes', ...o } });
    const mkPeople = async (brandId, k) => {
      const out = [];
      for (let i = 0; i < k; i++) {
        out.push(await prisma.contact.create({ data: {
          brandId, name: brandId + ' Person ' + i, title: ['Brand Manager', 'Head of Partnerships', 'Marketing Director', 'Events Lead'][i % 4],
          linkedinUrl: 'https://www.linkedin.com/in/' + brandId + i, isDecisionMaker: i === 0,
        } }));
      }
      return out;
    };
    // Today sends (an extra day when it isn't Tue–Thu); "Move what's left"
    // closed it, so it has open spots and a Fill box. A later day is given
    // a category with too few brands to fill it.
    await data('setExtraSendingDay', { date: today, on: true });
    const op0 = await data('getOutreachPlan', {});
    const later = op0.days.find(d => d.date > today).date;
    const after = op0.days.filter(d => d.date > later)[0].date;
    for (let i = 0; i < 8; i++) {
      await mkBrand('e' + i, 'Energy Co ' + i, 'energy', { salesCents: BigInt(1 + i) * 1000000000n });
      await mkPeople('e' + i, 3);
    }
    await mkBrand('sp1', 'Spirit One', 'spirits'); await mkPeople('sp1', 3);
    await mkBrand('sp2', 'Spirit Two', 'spirits'); await mkPeople('sp2', 4);
    await mkBrand('pin1', 'Pinned Later', 'beauty'); await mkPeople('pin1', 3);
    await mkBrand('pin2', 'Pinned Today', 'beauty'); await mkPeople('pin2', 3);
    await mkBrand('who', 'A Person', null, { kind: 'person', passedAt: new Date(), doNotEmail: true });
    // Invites a week and more old, and two from yesterday (Going stale).
    const old = await mkBrand('old', 'Old Invites Co', 'cpg');
    const oldPeople = await mkPeople('old', 5);
    for (const [i, c] of oldPeople.entries()) {
      await prisma.target.create({ data: { brandId: 'old', contactId: c.id, status: 'sent', fitScore: 60 + i, sentAt: noonNY(shift(today, i < 3 ? -9 - i : -1)) } });
    }
    await setting('outreachPlan', { [today]: { category: null, brandIds: ['pin2'] }, [later]: { category: 'spirits', brandIds: [] }, [after]: { category: null, brandIds: ['pin1'] } });
    await setting('outreachDayClosed', { day: today, to: later });

    // 1. The stamp ----------------------------------------------------------
    const p1 = await data('getOutreachPlan', {});
    assert.ok(p1.stamp && p1.days.length >= 3, 'a stamp and the days');
    const again = await data('getOutreachPlan', { since: p1.stamp });
    assert.deepEqual(again, { unchanged: true, stamp: p1.stamp }, 'the same stamp back: unchanged (its own shown-days write doesn\'t count)');
    await prisma.contact.update({ where: { id: (await prisma.contact.findFirst({ where: { brandId: 'e1' } })).id }, data: { title: 'Partnerships Lead' } });
    const p2 = await data('getOutreachPlan', { since: p1.stamp });
    assert.ok(!p2.unchanged && p2.days && p2.stamp !== p1.stamp, 'a changed person: the whole answer, a new stamp');
    await prisma.setting.upsert({ where: { key: 'liRunReports' }, create: { key: 'liRunReports', value: '[]' }, update: { value: '[1]' } });
    assert.equal((await data('getOutreachPlan', { since: p2.stamp })).unchanged, true, 'a setting the Schedule doesn\'t read changes nothing');
    await setting('categoryPriority', { cpg: 'top' });
    assert.ok(!(await data('getOutreachPlan', { since: p2.stamp })).unchanged, 'one it reads does');
    await setting('categoryPriority', {});
    const wire = await data('getOutreachPlan', { __roster: [] });
    assert.ok(wire.days.find(d => d.date === after).pinned.some(p => p.id === 'pin1'), 'a __roster from the wire is dropped');
    const r1 = await post('getOutreachPlan', {});
    assert.match(r1.headers.get('server-timing') || '', /^getOutreachPlan;dur=\d+$/, 'Server-Timing says how long');
    ok('a stamp; since = the same → { unchanged }; a person, or a setting it reads, changes it; __ args never come from the wire; Server-Timing');

    // 2. suggest ----------------------------------------------------------
    const ps = await data('getOutreachPlan', { suggest: true, hideSmall: true });
    const withSug = ps.days.filter(d => d.suggest);
    assert.ok(withSug.some(d => d.date === today), 'today (closed, open spots) carries its list: ' + JSON.stringify(ps.days.map(d => [d.date, d.cap, d.total])));
    assert.ok(withSug.some(d => d.date === later), 'the spirits day too');
    for (const d of ps.days) {
      const open = d.cap - d.total > 0;
      assert.equal(!!d.suggest, open, d.date + ': a list exactly when there are open spots');
      if (!open) continue;
      const cat = d.category === 'bestfit' ? '' : d.category;
      assert.equal(d.suggest.category, cat);
      const own = await data('suggestForDay', { date: d.date, category: cat, take: 24, hideSmall: true });
      assert.deepEqual(d.suggest.data, own, d.date + ': the same as suggestForDay');
    }
    assert.ok(withSug.find(d => d.date === later).suggest.data.brands.some(b => b.id === 'sp1'), 'spirits listed on the spirits day');
    assert.equal((await data('getOutreachPlan', {})).days.some(d => d.suggest), false, 'only when asked');
    ok('suggest: each day with open spots carries exactly suggestForDay\'s answer (today and a category day)');

    // 3. applyIfNone --------------------------------------------------------
    const none = await data('planApplyCategory', { date: after, category: 'energy', applyIfNone: true });
    assert.equal(none.applied, undefined, 'a pin to take off (Pinned Later is beauty): only the preview');
    assert.ok(none.changes > 0 && none.unpin.some(u => u.id === 'pin1'));
    assert.equal(JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)[after].category, null, 'nothing written');
    const yes = await data('planApplyCategory', { date: later, category: 'energy', applyIfNone: true });
    assert.equal(yes.applied, true, 'nothing to take off: applied in the one call');
    assert.equal(JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)[later].category, 'energy');
    await data('planApplyCategory', { date: later, category: 'spirits', preview: false });
    ok('applyIfNone: applied at once when nothing comes off, a preview otherwise');

    // 4. setBrandPassed unpin -------------------------------------------------
    await data('setBrandPassed', { brandId: 'pin1', passed: true });
    assert.deepEqual(JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value)[after].brandIds, ['pin1'], 'without unpin: still on its day');
    await data('setBrandPassed', { brandId: 'pin1', passed: false });
    const up = await data('setBrandPassed', { brandId: 'pin1', passed: true, unpin: true });
    assert.deepEqual(up.unpinned, [after]);
    const planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.ok(!(planNow[after]?.brandIds ?? []).includes('pin1'), 'off its day');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'pin1' } })).passedTodayAt, null, 'a later day: not passed for today');
    const upT = await data('setBrandPassed', { brandId: 'pin2', passed: true, unpin: true });
    assert.deepEqual(upT.unpinned, [today]);
    assert.ok((await prisma.brand.findUnique({ where: { id: 'pin2' } })).passedTodayAt, 'off today: passed for today too, as planRemoveBrand did');
    ok('Archive with unpin: off its day in the one call (and passed for today on today); without it nothing else changes');

    // 5. Going stale ----------------------------------------------------------
    const cut = Date.now() - 7 * 864e5;
    const all = await data('listTargets', { status: 'sent' });
    const stale = await data('listTargets', { status: 'sent', sentBefore: new Date(cut).toISOString() });
    const mine = all.filter(t => t.sentAt && new Date(t.sentAt).getTime() <= cut);
    assert.deepEqual(stale.map(t => t.id), mine.map(t => t.id), 'the same rows, same order');
    assert.equal(stale.length, 3);
    assert.equal(all.length, 5);
    ok('listTargets sentBefore: exactly the rows the page cut, in order');

    // 6. The first open of the LinkedIn tab ---------------------------------
    await prisma.setting.deleteMany({ where: { key: 'outreachDayClosed' } })
    const q1 = await data('getTodayQueue', {});
    const queued = q1.targets.filter(t => ['queued', 'drafted'].includes(t.status));
    assert.ok(queued.length >= 6, 'the fill took brands: ' + queued.length);
    for (const t of queued) {
      assert.equal(t.status, 'drafted', t.id + ' drafted');
      assert.deepEqual(t.drafts.map(d => d.variant), ['man', 'woman'], 'man, then woman');
    }
    const ids = queued.map(t => t.id);
    const drafts = await prisma.draft.findMany({ where: { targetId: { in: ids } }, orderBy: { createdAt: 'desc' } });
    assert.equal(drafts.length, ids.length * 2, 'two drafts each');
    for (const id of ids) {
      const two = drafts.filter(d => d.targetId === id);
      assert.deepEqual(two.map(d => d.variant), ['woman', 'man'], 'newest first reads woman, man — as the one-at-a-time creates left them');
    }
    const events = await prisma.targetEvent.findMany({ where: { targetId: { in: ids }, kind: 'drafted' } });
    assert.equal(events.length, ids.length, 'one drafted event each');
    const fresh = await prisma.target.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { brandId: true, createdAt: true, queuedFor: true } });
    const byBrand = {};
    for (const t of fresh) (byBrand[t.brandId] = byBrand[t.brandId] || []).push(t);
    for (const list of Object.values(byBrand)) {
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].createdAt > list[i - 1].createdAt, 'a brand\'s new people each a moment apart, in pick order');
        assert.ok(list[i].queuedFor > list[i - 1].queuedFor);
      }
    }
    await data('getTodayQueue', {});
    assert.equal(await prisma.draft.count({ where: { targetId: { in: ids } } }), ids.length * 2, 'a second open makes no drafts');
    assert.equal(await prisma.targetEvent.count({ where: { targetId: { in: ids }, kind: 'drafted' } }), ids.length);
    ok('the first open drafts everyone at once (man then woman, drafted once, one event each); new people in pick order; a second open writes none');

    // 7. Coverage and paste-a-list ---------------------------------------------
    const cov = await data('categoryCoverage', { weeks: 6 });
    const brandsCounted = cov.rows.reduce((k, r) => k + r.brands, 0);
    assert.equal(brandsCounted, await prisma.brand.count({ where: { kind: null } }), 'every brand once, the person left out');
    assert.ok(cov.rows.find(r => r.category === 'cpg').lastSent, 'the last invite per category');
    const m = await data('matchBrandList', { text: 'Spirit One\nEnergy Co 3\nSpirt Two\nNothing Like It', date: after });
    assert.deepEqual(m.lines.map(l => l.confidence === 'exact' ? [l.confidence, l.brand.id] : l.confidence), [['exact', 'sp1'], ['exact', 'e3'], m.lines[2].confidence, 'none']);
    assert.ok([m.lines[2].brand, ...m.lines[2].suggestions].some(b => b && b.id === 'sp2'), 'a spelling slip offers the brand: ' + JSON.stringify(m.lines[2]));
    assert.ok(m.lines[0].brand.label && m.lines[0].brand.text, 'rows come whole');
    ok('categoryCoverage leaves the person out; matchBrandList still matches and rows come whole');

    console.log(n + ' checks passed');
  } finally {
    if (prisma) await prisma.$disconnect();
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
