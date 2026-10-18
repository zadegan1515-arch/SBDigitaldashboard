// scripts/test-week-plan-e2e.js — Outreach → Week plan (Leo, Oct 18 2026)
// against the real handlers and a throwaway Postgres (wiped):
//
//   • the list = the brands a Best fit day would pick, best Brand Fit
//     first — never a brand reached, archived, a held giant or a Skip
//     category — up to its number; hand adds count toward it; one taken off
//     stays off until put back;
//   • the spread: a preview writes nothing; each brand on one day, every
//     day within its room, the top three on three different days; Apply
//     pins exactly the preview and those days take only the list — no
//     automatic rows, nothing off theme, Plan my week leaves them alone, the
//     Fill box offers the list;
//   • Undo takes the spread back off and the days fill with Best fit again;
//   • today kept to the list: nothing automatic in today's list, Fill to 30
//     takes from the list (top first), and Best fit again once let go;
//   • Reach out again: a brand reached a week+ ago that nobody answered,
//     with decision makers never contacted, is recommended (not under a
//     week, not after an accept); reachAgain puts exactly those people on
//     the day (chosen), refuses under a week, and onto today queues them.
//
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-week-plan-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-week-plan-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3471);
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

    // A roster: twelve never-reached brands with three LinkedIn buyers
    // each, money spread so their Brand Fit differs; then the ones the
    // list must never pick by itself.
    const TITLES = ['Head of Partnerships', 'Brand Manager', 'Marketing Director'];
    const mk = async (id, name, category, facts = {}, people = 3) => {
      await prisma.brand.create({ data: { id, name, category, tier: 'growth', liMembers: 120, usStatus: 'yes', ...facts } })
      for (let i = 0; i < people; i++) {
        await prisma.contact.create({ data: { brandId: id, name: name + ' P' + i, title: TITLES[i % 3], linkedinUrl: 'https://www.linkedin.com/in/' + id + i, isDecisionMaker: i === 0 } })
      }
    };
    const SALES = [200, 150, 120, 90, 60, 40, 30, 20, 8, 5, 3, 2]
    for (let i = 0; i < 12; i++) {
      await mk('b' + (i + 1), 'Brand ' + String(i + 1).padStart(2, '0'), i % 2 ? 'energy' : 'electrolytes', { salesCents: BigInt(SALES[i] * M) });
    }
    await mk('big', 'Big Brew', 'electrolytes', { liMembers: 900, salesCents: BigInt(300 * M) });
    await mk('giant', 'Gatorade', 'electrolytes', { salesCents: BigInt(5000 * M) });
    await mk('bet', 'Bet Co', 'betting', { salesCents: BigInt(100 * M) });
    await mk('arch', 'Archived Co', 'electrolytes', { salesCents: BigInt(100 * M), passedAt: new Date() });
    await mk('reach', 'Reached Co', 'electrolytes', { salesCents: BigInt(100 * M) });
    const rc = await prisma.contact.findFirst({ where: { brandId: 'reach' } });
    await prisma.target.create({ data: { brandId: 'reach', contactId: rc.id, status: 'sent', sentAt: new Date(Date.now() - 3 * 864e5) } });

    // 0. The Reached tag's map (reachedBrands) ------------------------------
    const rb = await data('reachedBrands', {});
    assert.deepEqual(Object.keys(rb.brands), ['reach'], 'only the brand reached out to');
    const three = nyKey(new Date(Date.now() - 3 * 864e5));
    assert.deepEqual(rb.brands.reach, [three, three, 'i', 1, 0], 'its first and last day, invite out, one invited');
    ok('reachedBrands: the brands reached out to, with when and how');

    // 1. The list ------------------------------------------------------
    let wb = await data('weekBank', {});
    const ids = () => wb.bank.rows.map(r => r.id);
    assert.equal(wb.bank.size, 100, 'holds 100 by default');
    for (const id of ['giant', 'bet', 'arch', 'reach']) assert.ok(!ids().includes(id), id + ' is never picked by itself');
    assert.equal(wb.bank.rows.length, 13, 'every brand Best fit would pick');
    const fits = wb.bank.rows.map(r => r.fit);
    assert.deepEqual(fits, [...fits].sort((a, b) => b - a), 'best Brand Fit first');
    assert.deepEqual(wb.bank.rows.map(r => r.rank), wb.bank.rows.map((_, i) => i + 1), 'ranked 1..n');
    assert.ok(wb.bank.rows.every(r => r.where === 'waiting' && r.going === 3), 'all waiting, three people each');
    assert.ok(wb.weeks.length >= 1 && wb.days.length === wb.weeks.find(w => w.start === wb.week).days.length, 'the week’s sending days are its columns');
    const today = nyKey(new Date());
    assert.ok(wb.days.every(d => d.date > today), 'today is never a column');
    ok('the list: Best fit’s own picks, best Brand Fit first, never reached / archived / giant / Skip');

    await data('weekBankSize', { size: 3 });
    wb = await data('weekBank', {});
    assert.equal(wb.bank.size, 10, 'never under 10');
    await data('weekBankSize', { size: 5000 });
    wb = await data('weekBank', {});
    assert.equal(wb.bank.size, 300, 'never over 300');
    await data('weekBankSize', { size: 10 });
    wb = await data('weekBank', {});
    assert.equal(wb.bank.rows.length, 10, 'the number holds it to 10');
    assert.equal(wb.bank.autoLeft, 3, 'three more past the number');
    const top = ids().slice(0, 10);

    // Hand adds: one reached brand, resting; an archived one refused; a giant OK'd.
    let add = await data('weekBankAdd', { brandIds: ['reach', 'arch'] });
    assert.deepEqual(add.added.map(a => a.id), ['reach'], 'the reached brand goes on the list');
    assert.deepEqual(add.refused.map(a => a.id), ['arch'], 'an archived one is refused');
    add = await data('weekBankAdd', { brandIds: ['giant'], allowGiants: ['giant'] });
    assert.deepEqual(add.added.map(a => a.id), ['giant'], 'a giant with Add anyway');
    wb = await data('weekBank', {});
    assert.equal(wb.bank.rows.length, 10, 'hand adds count toward the number');
    const reach = wb.bank.rows.find(r => r.id === 'reach');
    assert.ok(reach && reach.how === 'hand' && reach.where === 'cant' && /rests a week/.test(reach.why), 'the reached one: added by hand, resting');
    assert.equal(wb.bank.rows.find(r => r.id === 'giant')?.where, 'waiting', 'the OK’d giant can go');
    assert.equal(wb.bank.autoLeft, 5, 'two hand adds pushed two system picks past the number');

    // Taken off, put back.
    await data('weekBankRemove', { brandIds: [top[0]] });
    wb = await data('weekBank', {});
    assert.ok(!ids().includes(top[0]), 'taken off');
    assert.deepEqual(wb.bank.removed.map(r => r.id), [top[0]], 'listed as taken off');
    await data('weekBankPutBack', { brandIds: [top[0]] });
    await data('weekBankRemove', { brandIds: ['reach', 'giant'] });
    await data('weekBankSize', { size: 100 });
    wb = await data('weekBank', {});
    assert.equal(wb.bank.rows[0].id, top[0], 'back on top');
    assert.equal(wb.bank.rows.length, 13, 'the system picks again (the hand adds taken off)');
    ok('the number (10–300), hand adds count toward it, refused / resting / OK’d giant, taken off and put back');

    const browse = await data('weekBankBrowse', { category: 'electrolytes', day: wb.days[0]?.date });
    assert.ok(browse.brands.some(b => b.id === 'reach' && b.action === 'none') === false, 'a resting brand isn’t offered as addable');
    assert.ok(browse.brands.every(b => b.category === 'electrolytes'), 'that category only');
    assert.ok(browse.setAside >= 1, 'archived / resting counted, not listed');
    ok('browse a category');

    // 2. The spread ----------------------------------------------------------
    const planBefore = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } });
    const pv = await data('weekSpread', { week: wb.week, seed: 42 });
    assert.equal((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } }))?.value ?? null, planBefore?.value ?? null, 'a preview writes nothing');
    const pv2 = await data('weekSpread', { week: wb.week, seed: 42 });
    assert.deepEqual(pv2.days.map(d => d.add.map(a => a.id)), pv.days.map(d => d.add.map(a => a.id)), 'the same seed deals the same');
    const placed = pv.days.flatMap(d => d.add.map(a => a.id));
    assert.equal(new Set(placed).size, placed.length, 'each brand on one day');
    assert.equal(placed.length, 13, 'all 13 fit (13 × 3 < the week’s room)');
    for (const d of pv.days) assert.ok(d.addPeople <= d.room, d.date + ' within its room');
    if (pv.days.length >= 3) {
      const dayOf = (rank) => pv.days.find(d => d.add.some(a => a.rank === rank)).date;
      assert.equal(new Set([1, 2, 3].map(dayOf)).size, 3, '#1–#3 on three different days');
      assert.ok(pv.days.every(d => d.add.filter(a => a.big).length <= 1), 'one big company a day');
    }
    const days = pv.days.map(d => ({ date: d.date, brandIds: d.add.map(a => a.id) }));
    const ap = await data('weekSpread', { apply: true, days });
    assert.equal(ap.days.reduce((s, d) => s + d.added, 0), 13, 'all 13 put on');
    const plan = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    for (const d of days) assert.deepEqual(plan[d.date].brandIds, d.brandIds, d.date + ' holds exactly the preview, in its order');
    let op = await data('getOutreachPlan', {});
    for (const d of days) {
      const col = op.days.find(x => x.date === d.date);
      assert.ok(col && col.list === true, d.date + ' takes only the list');
      assert.deepEqual(col.brands, [], d.date + ': no automatic rows');
      assert.equal(col.offTheme, 0, d.date + ': nothing off theme');
    }
    wb = await data('weekBank', {});
    assert.ok(wb.bank.rows.every(r => r.where === 'day'), 'every list brand now sits on a day');
    assert.ok(wb.days.every(d => d.list), 'the columns say list');
    assert.ok(wb.spreadLast, 'Undo is offered');
    // Plan my week leaves those days alone.
    const pw = await data('planWeek', {});
    for (const d of pw.days) if (days.some(x => x.date === d.date)) {
      assert.equal(d.source, 'list', d.date + ': Plan my week reads it as the list’s');
      assert.deepEqual(d.add, [], d.date + ': Plan my week adds nothing');
    }
    ok('the spread: preview writes nothing, same seed same deal, one day each, within room, top 3 apart; Apply = the preview; list days get nothing automatic');

    // 3. Moving, then Undo ----------------------------------------------------
    const mover = days[0].brandIds[0];
    if (days.length > 1) {
      const r = await data('planMoveBrand', { brandId: mover, from: days[0].date, to: days[1].date });
      assert.ok(r.ok, 'moved to another day');
    }
    const un = await data('undoWeekSpread', { preview: true });
    assert.equal(un.preview, true);
    assert.equal(un.off.length, days.length > 1 ? 12 : 13, 'Undo takes off what still sits where it put it');
    assert.equal(un.stays.length, days.length > 1 ? 1 : 0, 'one Leo moved since stays');
    assert.equal((await prisma.setting.findUnique({ where: { key: 'weekSpreadLast' } })) !== null, true, 'the preview changes nothing');
    await data('undoWeekSpread', {});
    const plan2 = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } }))?.value || '{}');
    const left = Object.values(plan2).flatMap(d => d.brandIds || []);
    assert.deepEqual(left, days.length > 1 ? [mover] : [], 'only the moved one is still pinned');
    op = await data('getOutreachPlan', {});
    for (const d of days) {
      const col = op.days.find(x => x.date === d.date);
      if (!col) continue;
      assert.notEqual(col.list, true, d.date + ' is Best fit again');
    }
    // (13 brands × 3 people: the first days take them all.)
    assert.ok(op.days.some(x => days.some(d => d.date === x.date) && x.brands.length > 0), 'Best fit fills them again by itself');
    ok('Undo: off what still sits where it put it, a moved one stays, the days are Best fit again');
    if (days.length > 1) await data('planRemoveBrand', { date: days[1].date, brandId: mover });

    // 4. A day kept to the list: the Fill box offers the list ------------------
    const d0 = days[0].date;
    await data('setListDay', { date: d0, on: true });
    op = await data('getOutreachPlan', { suggest: true });
    const c0 = op.days.find(x => x.date === d0);
    assert.ok(c0 && c0.list && c0.brands.length === 0, 'kept to the list, nothing automatic');
    assert.ok(c0.suggest?.data?.list, 'its Fill box is the list');
    assert.equal(c0.suggest.data.brands[0].id, wb.bank.rows[0].id, 'best first');
    const sf = await data('suggestForDay', { date: d0, take: 24 });
    assert.equal(sf.list, true, 'suggestForDay says the list too');
    await data('setListDay', { date: d0, on: false });
    op = await data('getOutreachPlan', {});
    assert.ok(op.days.find(x => x.date === d0).brands.length > 0, 'let go: Best fit again');
    ok('a day kept to the list: its Fill box is the list; let go, Best fit again');

    // 5. Today kept to the list ----------------------------------------------
    // Today opened as a sending day, so today's LinkedIn list is in play.
    await data('setExtraSendingDay', { date: today, on: true });
    await data('setListDay', { date: today, on: true });
    let tq = await data('getTodayQueue', {});
    assert.equal(tq.listDay, true, 'today takes only the list');
    assert.equal(tq.targets.length, 0, 'nothing automatic in today’s list');
    assert.ok(tq.moreBrands.length > 0 && tq.moreBrands[0].brandId === wb.bank.rows[0].id, 'Ready if you have room = the list, best first');
    const fill = await data('fillToday', {});
    assert.ok(fill.added > 0, 'Fill to 30 takes from the list');
    tq = await data('getTodayQueue', {});
    const listed = new Set(tq.targets.map(t => t.brandId));
    assert.ok(listed.has(wb.bank.rows[0].id), 'the top of the list first');
    assert.ok([...listed].every(id => wb.bank.rows.some(r => r.id === id)), 'only brands from the list');
    assert.ok(tq.targets.length <= 30, 'never past the day’s 30');
    // The list drops what is in today's list.
    const wb2 = await data('weekBank', {});
    assert.ok(![...listed].some(id => wb2.bank.rows.some(r => r.id === id && r.where === 'waiting')), 'today’s brands aren’t waiting on the list any more');
    ok('today kept to the list: nothing automatic, Fill to 30 from the list, top first');

    // 6. Reach out again ---------------------------------------------------
    // Reached 9 days ago (two invites, nobody answered), with two people who
    // decide there never contacted — and one who doesn't decide.
    const mkAgain = async (id, name, daysAgo, opts = {}) => {
      await prisma.brand.create({ data: { id, name, category: 'energy', tier: 'growth', liMembers: 120, usStatus: 'yes', salesCents: BigInt(80 * M) } });
      const people = [['Head of Partnerships', true], ['Brand Manager', true], ['Events Manager', false], ['VP Marketing', false], ['Sales Associate', false]];
      for (let i = 0; i < people.length; i++) {
        const c = await prisma.contact.create({ data: { brandId: id, name: name + ' ' + people[i][0], title: people[i][0], linkedinUrl: 'https://www.linkedin.com/in/' + id + i } });
        if (people[i][1]) {
          await prisma.target.create({ data: { brandId: id, contactId: c.id, status: i === 0 && opts.accepted ? 'accepted' : 'sent', sentAt: new Date(Date.now() - daysAgo * 864e5) } });
        }
      }
    };
    await mkAgain('ag', 'Again Co', 9);
    await mkAgain('ag2', 'Today Again', 10);
    await mkAgain('soon', 'Soon Co', 3);
    await mkAgain('acc', 'Accepted Co', 9, { accepted: true });
    wb = await data('weekBank', {});
    const ag = wb.again.rows.find(r => r.id === 'ag');
    assert.ok(ag, 'reached 9 days ago with decision makers never contacted: recommended');
    assert.equal(ag.state, 'due', 'due (1 to 2 weeks)');
    assert.equal(ag.daysSince, 9);
    assert.deepEqual(ag.fresh.map(c => c.title), ['Events Manager', 'VP Marketing'], 'the decision makers nobody contacted, events first; never the sales associate');
    assert.equal(ag.going, 2, 'both go');
    assert.equal(ag.invited, 2);
    for (const id of ['soon', 'acc', 'reach']) assert.ok(!wb.again.rows.some(r => r.id === id), id + ': not recommended (under a week, or someone accepted)');
    assert.ok(!wb.bank.rows.some(r => r.id === 'ag'), 'never on the list by itself (reached)');
    ok('Reach out again: a week or more since the last outreach, nobody answered, decision makers never contacted — not under a week, not after an accept');

    const no = await data('reachAgain', { brandId: 'soon', date: wb.days[0].date });
    assert.equal(no.ok, false);
    assert.equal(no.why, 'soon', 'under a week: refused, says why');
    assert.match(no.text, /less than a week ago/);
    const day = wb.days[0].date;
    const ra = await data('reachAgain', { brandId: 'ag', date: day });
    assert.equal(ra.ok, true, 'put on ' + day);
    assert.deepEqual(ra.people.map(p => p.name).sort(), ['Again Co Events Manager', 'Again Co VP Marketing']);
    const plan3 = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.ok(plan3[day].brandIds.includes('ag'), 'pinned on that day');
    const newRows = await prisma.target.findMany({ where: { brandId: 'ag', status: 'queued' }, include: { contact: true } });
    assert.deepEqual(newRows.map(t => t.contact.title).sort(), ['Events Manager', 'VP Marketing'], 'a waiting row for each, nobody else');
    const chosen = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachChosen' } })).value);
    assert.ok(newRows.every(t => chosen[t.id]), 'chosen people (they go first and all go)');
    op = await data('getOutreachPlan', {});
    const card = op.days.find(x => x.date === day)?.pinned.find(p => p.id === 'ag');
    assert.ok(card && card.state === 'going', 'the Schedule says it goes');
    assert.deepEqual(card.people.map(p => p.name).sort(), ['Again Co Events Manager', 'Again Co VP Marketing'], 'exactly them — though the brand has invites out');
    wb = await data('weekBank', {});
    assert.equal(wb.again.rows.find(r => r.id === 'ag')?.pinnedOn, day, 'the card says where it is');
    ok('reachAgain: those people on that day (chosen, so they go though the brand has invites out); under a week refused');

    // Onto today (opened above): they're in today's LinkedIn list now.
    const rt = await data('reachAgain', { brandId: 'ag2', date: today });
    assert.equal(rt.ok, true);
    tq = await data('getTodayQueue', {});
    const ag2Rows = await prisma.target.findMany({ where: { brandId: 'ag2', status: { in: ['queued', 'drafted'] } }, include: { contact: true } });
    assert.deepEqual(ag2Rows.map(t => t.contact.title).sort(), ['Events Manager', 'VP Marketing'], 'rows for the two never contacted');
    assert.deepEqual(tq.targets.filter(t => t.brandId === 'ag2').map(t => t.id).sort(), ag2Rows.map(t => t.id).sort(), 'in today’s list: exactly them');
    ok('reachAgain onto today: straight into today’s LinkedIn list');

    console.log('week plan e2e: all ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
