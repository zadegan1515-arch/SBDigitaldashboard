// scripts/test-brand-fit-e2e.js — Brand Fit for real: the /api/data
// handlers on a local `next dev`, backed by a throwaway Postgres.
//
// Covers what the pure rules (test-brand-fit.mjs) can't: BigInt money
// columns reaching the page as plain numbers, the brand page's facts
// edit, Hide too small in the Brands list / Stock take / Fill box /
// Plan my week, the research list → staged research → reviewed import →
// Undo, and suggest Archive → Undo (queued people shelved, off the
// Schedule, back again).
//
// Needs a throwaway LOCAL Postgres — it is wiped:
//   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-brand-fit-e2e.js
// ~1 min, most of it `next dev` compiling the route.

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
const PORT = Number(process.env.E2E_PORT || 3458);
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

    // The roster.
    const people = (brandId, k) => Array.from({ length: k }, (_, i) => ({
      brandId, name: brandId + ' person ' + i, title: 'Brand Marketing Manager',
      linkedinUrl: 'https://www.linkedin.com/in/' + brandId + '-' + i + '/',
    }));
    await prisma.brand.create({ data: { id: 'b_big', name: 'Big Funded Energy', category: 'energy', salesCents: 263n * BigInt(M), fundingCents: 120n * BigInt(M), lastRoundAt: new Date('2025-06-01'), usStatus: 'yes', sponsorsCollege: true, liMembers: 400 } });
    await prisma.brand.create({ data: { id: 'b_tiny', name: 'Tiny Seltzer', category: 'rtd', liMembers: 6 } });
    await prisma.brand.create({ data: { id: 'b_poor', name: 'Poor Sales Apparel', category: 'apparel', salesCents: BigInt(40000000), liMembers: 300 } });
    await prisma.brand.create({ data: { id: 'b_mid', name: 'Middle Snacks', category: 'cpg' } });
    await prisma.brand.create({ data: { id: 'b_euro', name: 'Euro Only Soda', category: 'beverage' } });
    await prisma.brand.create({ data: { id: 'b_talk', name: 'In Talks Co', category: 'energy', usStatus: 'no' } });
    await prisma.brand.create({ data: { id: 'b_nous', name: 'NoUS Energy', category: 'energy', usStatus: 'no' } });
    await prisma.brand.create({ data: { id: 'b_shut', name: 'Shut Down Drinks', category: 'energy', bizStatus: 'closed' } });
    await prisma.brand.create({ data: { id: 'b_kid', name: 'Ketel One', category: 'spirits', liMembers: 4 } });
    for (const id of ['b_big', 'b_tiny', 'b_poor', 'b_mid', 'b_euro', 'b_talk', 'b_nous', 'b_shut', 'b_kid']) await prisma.contact.createMany({ data: people(id, 4) });
    // Queued pool people at the brand confirmed not in the US: the daily
    // rotation must never pick them.
    for (const c of await prisma.contact.findMany({ where: { brandId: 'b_nous' } })) {
      await prisma.target.create({ data: { brandId: 'b_nous', contactId: c.id, status: 'queued' } });
    }
    const talker = await prisma.contact.findFirst({ where: { brandId: 'b_talk' } });
    await prisma.target.create({ data: { brandId: 'b_talk', contactId: talker.id, status: 'replied', sentAt: new Date(), repliedAt: new Date() } });
    const euroP = await prisma.contact.findFirst({ where: { brandId: 'b_euro' } });
    const euroT = await prisma.target.create({ data: { brandId: 'b_euro', contactId: euroP.id, status: 'queued' } });

    // 1. Brands list: fit per row, BigInt money as plain numbers.
    const list = await data('listBrands', { fit: true });
    const big = list.find(b => b.id === 'b_big');
    assert.equal(big.salesCents, 263 * M, 'BigInt sales reach the page as a number');
    assert.equal(typeof big.fundingCents, 'number');
    assert.ok(big.fit.score >= 80, 'big funded energy brand scores high: ' + big.fit.score);
    assert.equal(list.find(b => b.id === 'b_tiny').fit.tooSmall, true, '6 people on LinkedIn = too small');
    assert.equal(list.find(b => b.id === 'b_poor').fit.tooSmall, true, '$400K sales = too small');
    assert.equal(list.find(b => b.id === 'b_mid').fit.tooSmall, false, 'nothing known = not hidden');
    assert.equal(list.find(b => b.id === 'b_mid').fit.usUnknown, true);
    assert.equal((await data('listBrands', {}))[0].fit, undefined, 'the pickers don\'t pay for fit');
    assert.equal(list.find(b => b.id === 'b_kid').fit.tooSmall, false, 'a parent company\'s brand is never too small by its own page');
    assert.deepEqual([list.find(b => b.id === 'b_shut').fit.ruledOut, list.find(b => b.id === 'b_shut').fit.bizNote], [null, 'out of business']);
    assert.equal(list.find(b => b.id === 'b_nous').fit.ruledOut, 'not sold in the US');
    ok('Brands list: fit on every row, money as numbers, too small by sales or headcount');

    // 2. Brand page: reasons + facts edit through the research rules.
    let page = await data('getBrand', { brandId: 'b_mid' });
    assert.ok(page.fit.reasons.length >= 5 && page.fit.reasons.every(r => typeof r.text === 'string'));
    await data('updateBrand', { brandId: 'b_mid', facts: { sales: '12,345,678.50', funding: '$30M', lastRound: '2024-03', us: 'yes', sponsorsCollege: 'no', sponsorNote: '', status: '', acquiredBy: '', note: 'Crunchbase' } });
    let mid = await prisma.brand.findUnique({ where: { id: 'b_mid' } });
    assert.equal(mid.salesCents, 1234567850n);
    assert.equal(mid.fundingCents, 3000000000n);
    assert.equal(mid.lastRoundAt.toISOString().slice(0, 10), '2024-03-01');
    assert.equal(mid.usStatus, 'yes');
    assert.equal(mid.sponsorsCollege, false);
    assert.equal(mid.researchNote, 'Crunchbase');
    assert.ok(mid.researchedAt, 'a change stamps researchedAt');
    const stamped = mid.researchedAt.getTime();
    // The page sends every field back on every Save, in its own spelling.
    page = await data('getBrand', { brandId: 'b_mid' });
    const resend = { sales: (page.brand.salesCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }), funding: (page.brand.fundingCents / 100).toLocaleString('en-US'), lastRound: String(page.brand.lastRoundAt).slice(0, 10), us: 'yes', sponsorsCollege: 'no', sponsorNote: '', status: '', acquiredBy: '', note: 'Crunchbase' };
    await data('updateBrand', { brandId: 'b_mid', notes: 'hello', facts: resend });
    mid = await prisma.brand.findUnique({ where: { id: 'b_mid' } });
    assert.equal(mid.researchedAt.getTime(), stamped, 'nothing changed → not stamped again');
    assert.equal(mid.salesCents, 1234567850n, 'round trip is exact');
    await assert.rejects(data('updateBrand', { brandId: 'b_mid', facts: { sales: 'lots' } }), /not an amount/);
    await data('updateBrand', { brandId: 'b_big', facts: { sponsorNote: 'Rolling Loud' } });
    const bigNow = await prisma.brand.findUnique({ where: { id: 'b_big' } });
    assert.ok(bigNow.researchedAt, 'money + sponsorships known → researched');
    await data('updateBrand', { brandId: 'b_tiny', facts: { us: 'yes' } });
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_tiny' } })).researchedAt, null, 'one fact in passing is not research');
    ok('brand page: reasons, facts saved exactly, a re-save changes nothing, junk refused');

    // 3. Stock take: hide too small.
    const st0 = await data('brandStock', {});
    const st1 = await data('brandStock', { hideSmall: true });
    assert.equal(st1.totals.small, 2, 'Tiny Seltzer and Poor Sales Apparel hidden');
    assert.equal(st0.totals.total - st1.totals.total, 2);
    const names = st1.lanes.concat(st1.others).flatMap(r => r.brands.map(b => b.name));
    assert.ok(!names.includes('Tiny Seltzer') && names.includes('Big Funded Energy'));
    ok('Stock take: Hide too small leaves the two small brands out and counts them');

    // 4. Fill box + Plan my week.
    const fill0 = await data('suggestForDay', { take: 40 });
    const fill1 = await data('suggestForDay', { take: 40, hideSmall: true });
    const ids = d => d.brands.concat(d.needPeople).map(b => b.id);
    assert.ok(ids(fill0).includes('b_tiny'), 'shown with the switch off');
    assert.ok(!ids(fill1).includes('b_tiny') && !ids(fill1).includes('b_poor'), 'hidden with it on');
    assert.equal(fill1.hiddenSmall, 2);
    assert.ok(!ids(fill0).includes('b_talk') && !ids(fill0).includes('b_nous'), 'a ruled-out brand is never offered');
    assert.ok(ids(fill0).includes('b_shut'), 'out of business is Leo\'s call on the Archive list, not hidden');
    const m = await data('matchBrandList', { text: 'NoUS Energy' });
    assert.deepEqual([m.lines[0].brand.status, m.lines[0].brand.action], ['notus', 'none'], 'the add box refuses it');
    // Today as an energy sending day, so the rotation really runs.
    const todayKey = nyKey(new Date());
    await data('setExtraSendingDay', { date: todayKey, on: true });
    await data('planSetCategory', { date: todayKey, category: 'energy' });
    const plan0 = await data('getOutreachPlan');
    const rotation = plan0.days.flatMap(d => (d.brands || []).map(b => b.id));
    assert.ok(!rotation.includes('b_nous'), 'the rotation never shows it');
    const tq = await data('getTodayQueue');
    assert.equal(tq.sendingDay, true, 'today is a sending day for this check');
    assert.ok(!(tq.targets || []).some(t => t.brandId === 'b_nous'), 'today\'s queue never stamps it');
    assert.equal(await prisma.target.count({ where: { brandId: 'b_nous', queuedFor: { not: null } } }), 0);
    const q = await data('queueBrandTargets', { brandId: 'b_nous' });
    assert.deepEqual([q.queued, q.reason], [false, 'notus'], 'not even by a click');
    const nb = await data('nextBestBrands', {});
    assert.ok(!JSON.stringify(nb).includes('b_nous'), 'never a next best');
    await prisma.brand.create({ data: { id: 'b_foreign', name: 'Foreign Energy', category: 'energy', usStatus: 'no' } });
    await prisma.contact.createMany({ data: people('b_foreign', 4) });
    await data('fillToday');
    assert.equal(await prisma.target.count({ where: { brandId: 'b_foreign' } }), 0, 'Fill to 30 never picks it');
    // Pinned to today, then found not to be sold in the US.
    await data('planAddBrands', { date: todayKey, brandIds: ['b_mid'] });
    const midStamped = await prisma.target.count({ where: { brandId: 'b_mid', queuedFor: { not: null } } });
    await prisma.brand.update({ where: { id: 'b_mid' }, data: { usStatus: 'no' } });
    const tq2 = await data('getTodayQueue');
    assert.ok(!(tq2.targets || []).some(t => t.brandId === 'b_mid'), 'its stamped people leave today\'s list');
    await prisma.target.updateMany({ where: { brandId: 'b_mid' }, data: { queuedFor: null } });
    await data('getTodayQueue');
    assert.equal(await prisma.target.count({ where: { brandId: 'b_mid', queuedFor: { not: null } } }), 0, 'the plan never stamps it again');
    assert.ok(midStamped >= 0);
    await prisma.brand.update({ where: { id: 'b_mid' }, data: { usStatus: 'yes' } });
    await data('planRemoveBrand', { date: todayKey, brandId: 'b_mid' });
    assert.equal(fill0.brands[0].id, 'b_big', 'best fit first');
    assert.ok(fill0.brands[0].fit && typeof fill0.brands[0].fit.score === 'number');
    const pw = await data('planWeek', { hideSmall: true });
    const planned = pw.days.flatMap(d => d.add.map(a => a.id));
    assert.ok(!planned.includes('b_tiny') && !planned.includes('b_poor'), 'Plan my week leaves them out');
    assert.equal(pw.hiddenSmall, 2);
    ok('Fill box and Plan my week: best fit first, too small left out on the switch, ruled out never offered');

    // 5. Research: list → staged → reviewed import → Undo.
    const tomorrow = nyKey(new Date(Date.now() + 36 * 3600e3));
    const planVal = JSON.stringify({ [tomorrow]: { category: null, brandIds: ['b_euro'] } });
    await prisma.setting.upsert({ where: { key: 'outreachPlan' }, create: { key: 'outreachPlan', value: planVal }, update: { value: planVal } });
    const rl = await data('researchList', {});
    assert.ok(rl.rows.some(r => r.id === 'b_euro'), 'the Schedule\'s next two weeks (pinned)');
    assert.ok(rl.rows.some(r => r.id === 'b_shut'), '…and the rotation shown on today');
    assert.ok(!rl.rows.some(r => r.id === 'b_nous' || r.id === 'b_big'), 'never one ruled out or researched');
    assert.match(rl.text, /Euro Only Soda/);
    assert.match(rl.text, /"id":"b_euro"/);
    const more = await data('researchList', { scope: 'more' });
    assert.ok(!more.rows.some(r => r.id === 'b_mid'), 'researched brands are skipped');
    const sig = (r) => JSON.stringify(r.changes.map(c => [c.field, c.fromRaw, c.raw]));
    let st = await data('researchStage', { rows: [
      { id: 'b_euro', name: 'Euro Only Soda', us: 'yes' },
      { name: 'Bad Row', sales: 'loads' },
      { name: 'Bad Month', lastRound: '2024-13' },
    ] });
    assert.deepEqual([st.staged, st.errors.length], [1, 2], 'bad money and an impossible month are refused row by row');
    st = await data('researchStage', { rows: [
      { id: 'b_euro', name: 'Euro Only Soda', us: 'no', note: 'only sold in the EU' },
      { name: 'tiny seltzer', sales: '$300K', sponsorsCollege: 'no' },
      { name: 'Nobody Brand', sales: '$5M' },
      { name: 'Middle Snacks', funding: '$30M' },
    ] });
    assert.equal(st.waiting, 4, 'joins the waiting batch; Euro\'s newer row replaces its older one');
    let rv = await data('researchImport', { staged: true });
    assert.equal(rv.rows.length, 3);
    assert.deepEqual(rv.unmatched.map(u => u.name), ['Nobody Brand']);
    const euroRow = rv.rows.find(r => r.brandId === 'b_euro');
    assert.deepEqual(euroRow.changes.map(c => c.label + ':' + c.from + '→' + c.to), ['In the US:—→no', 'Sources:—→only sold in the EU']);
    const midRow = rv.rows.find(r => r.brandId === 'b_mid');
    assert.deepEqual(midRow.changes, [], 'Middle Snacks: nothing new');
    const expect = { b_euro: sig(euroRow), b_mid: sig(midRow) };
    // More research lands while Leo is looking: his Save is refused.
    const seenAt = rv.staged.at;
    await data('researchStage', { rows: [{ id: 'b_euro', name: 'Euro Only Soda', us: 'yes' }] });
    await assert.rejects(data('researchImport', { staged: true, preview: false, stagedAt: seenAt, keep: ['b_euro'], expect }), /look again/);
    rv = await data('researchImport', { staged: true });
    const euro2 = rv.rows.find(r => r.brandId === 'b_euro');
    // An out-of-date signature (what he saw before) writes nothing for that brand.
    await assert.rejects(data('researchImport', { staged: true, preview: false, stagedAt: rv.staged.at, keep: ['b_euro'], expect }), /changed/);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_euro' } })).usStatus, null);
    // Back to "no" for the rest of the test, reviewed properly.
    await data('researchStage', { rows: [{ id: 'b_euro', name: 'Euro Only Soda', us: 'no', note: 'only sold in the EU' }] });
    rv = await data('researchImport', { staged: true });
    const keepIds = ['b_euro', 'b_mid']; // Leo unticks Tiny Seltzer.
    const exp = Object.fromEntries(rv.rows.filter(r => keepIds.includes(r.brandId)).map(r => [r.brandId, sig(r)]));
    const midBefore = (await prisma.brand.findUnique({ where: { id: 'b_mid' } })).researchedAt.getTime();
    const res = await data('researchImport', { staged: true, preview: false, stagedAt: rv.staged.at, keep: keepIds, expect: exp });
    assert.equal(res.updated, 2);
    assert.ok(euro2, 'saw the newer row');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_euro' } })).usStatus, 'no');
    assert.ok((await prisma.brand.findUnique({ where: { id: 'b_mid' } })).researchedAt.getTime() > midBefore, 'nothing new, ticked → marked researched');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_tiny' } })).salesCents, null, 'unticked = untouched');
    rv = await data('researchImport', { staged: true });
    assert.equal(rv.staged, null, 'the staged research is used up');
    assert.equal(rv.last.count, 2);
    await data('researchStage', { rows: [{ name: 'Tiny Seltzer', sponsorsCollege: 'no' }] });
    await data('researchDismiss', {});
    assert.equal((await data('researchImport', { staged: true })).staged, null, 'dismissed');
    // A hand edit after the review: that brand is skipped, never
    // overwritten, and stays waiting; the other brand is saved.
    await prisma.brand.update({ where: { id: 'b_poor' }, data: { salesCents: BigInt(40000000) } });
    await data('researchStage', { rows: [{ name: 'Poor Sales Apparel', sales: '$2M' }] });
    await data('researchStage', { rows: [{ id: 'b_poor', name: 'Poor Sales Apparel', sales: '$3M' }, { name: 'Tiny Seltzer', sponsorsCollege: 'no' }] });
    rv = await data('researchImport', { staged: true });
    assert.deepEqual(rv.rows.map(r => r.brandId).sort(), ['b_poor', 'b_tiny'], 'a row by id and one by name for the same brand: one row');
    assert.equal(rv.rows.find(r => r.brandId === 'b_poor').changes[0].to, '$3M', 'the newer row');
    const exp2 = Object.fromEntries(rv.rows.map(r => [r.brandId, sig(r)]));
    await data('updateBrand', { brandId: 'b_poor', facts: { sales: '2,500,000' } });
    const part = await data('researchImport', { staged: true, preview: false, stagedAt: rv.staged.at, keep: ['b_poor', 'b_tiny'], expect: exp2 });
    assert.deepEqual([part.updated, part.changedSince], [1, ['Poor Sales Apparel']]);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_poor' } })).salesCents, 250000000n, 'Leo\'s hand edit stands');
    rv = await data('researchImport', { staged: true });
    assert.deepEqual(rv.rows.map(r => r.brandId), ['b_poor'], 'the skipped brand is still waiting, the rest is done');
    await data('researchDismiss', {});
    await data('updateBrand', { brandId: 'b_poor', facts: { sales: '400,000' } });
    // Pasted research works the same way.
    const pasted = await data('researchImport', { text: '```json\n[{"name":"Middle Snacks","sponsorsCollege":"yes"}]\n```' });
    assert.equal(pasted.rows[0].changes[0].to, 'yes');
    ok('research: the Schedule\'s brands listed, Claude\'s rows staged, only ticked brands written');

    // 6. Suggest Archive → Undo.
    let fa = await data('fitArchive', {});
    assert.deepEqual(fa.brands.map(b => b.id).sort(), ['b_euro', 'b_foreign', 'b_nous', 'b_shut'], 'not in the US, out of business; In Talks Co never (it replied)');
    const euroA = fa.brands.find(b => b.id === 'b_euro');
    assert.equal(euroA.plannedOn, tomorrow);
    assert.equal(euroA.queued, 1);
    await assert.rejects(data('fitArchive', { preview: false, brandIds: ['b_big'] }), /Nothing ticked/);
    const arch = await data('fitArchive', { preview: false, brandIds: ['b_euro'] });
    assert.deepEqual([arch.archived, arch.shelved, arch.offDays], [1, 1, 1]);
    assert.ok((await prisma.brand.findUnique({ where: { id: 'b_euro' } })).passedAt);
    assert.equal((await prisma.target.findUnique({ where: { id: euroT.id } })).shelved, true);
    const planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.ok(!(planNow[tomorrow] && planNow[tomorrow].brandIds.includes('b_euro')), 'off the Schedule');
    fa = await data('fitArchive', {});
    assert.ok(!fa.brands.some(b => b.id === 'b_euro')); assert.equal(fa.last.count, 1);
    const undo = await data('fitArchiveUndo', { preview: false });
    assert.deepEqual(undo.back, ['Euro Only Soda']);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_euro' } })).passedAt, null);
    assert.equal((await prisma.target.findUnique({ where: { id: euroT.id } })).shelved, false);
    await assert.rejects(data('fitArchiveUndo', {}), /Nothing to undo/);
    ok('suggest Archive: archives the ticked brand, shelves its queue, takes it off the Schedule; Undo brings it back');

    // 7. Research Undo puts the old values back.
    // The last import was the partial save (Tiny Seltzer only).
    const ru = await data('researchUndo', { preview: false });
    assert.equal(ru.back, 1);
    const tiny = await prisma.brand.findUnique({ where: { id: 'b_tiny' } });
    assert.deepEqual([tiny.sponsorsCollege, tiny.researchedAt], [null, null]);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_euro' } })).usStatus, 'no', 'an earlier import is not touched');
    await assert.rejects(data('researchUndo', {}), /Nothing to undo/);
    assert.ok(midBefore > 0);
    ok('research Undo: the old values are back');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
