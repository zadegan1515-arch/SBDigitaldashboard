// scripts/test-plan-brands-e2e.js — the Schedule's roster loader
// (src/lib/plan-brands.ts, roster-loader) against a throwaway Postgres
// (wiped): loadPlanBrands must answer exactly what the nested
// prisma.brand.findMany({ select: PLAN_BRAND_SELECT }) does — the same
// brands, rows, order, values and key order — for the whole roster and
// for a filtered read, at the real roster's size — and sends the nested
// read's own statements for brands, contacts and targets (so the order
// Postgres's plan gives is the same for both).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-plan-brands-e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-plan-brands-e2e.js');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };

// The same rows, and the same JSON (key order included: replies are
// built by spreading these objects).
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? 'big:' + x : x));
function same(a, b, what) {
  assert.deepEqual(a, b, what);
  assert.equal(json(a), json(b), what + ' (JSON)');
}

(async () => {
  const env = { ...process.env, DATABASE_URL: DB };
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { cwd: ROOT, env, stdio: 'pipe' });
  // Compiled on its own; its @prisma/client resolves through a link to
  // the repo's node_modules.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-brands-'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(out, 'node_modules'));
  execSync('npx tsc src/lib/plan-brands.ts --outDir ' + out + ' --target es2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck',
    { cwd: ROOT, stdio: 'inherit' });
  const { loadPlanBrands, PLAN_BRAND_SELECT } = require(path.join(out, 'plan-brands.js'));
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  try {
    const day = (d) => new Date(Date.UTC(2026, 9, 1 + d, 15));
    // A roster with every shape the loader has to rebuild.
    await prisma.brand.create({ data: { id: 'b1', name: 'Alpha Water', category: 'electrolytes', tier: 'growth', aka: 'Alpha, AW',
      salesCents: 250000000000n, fundingCents: 120000000n, liMembers: 80, usStatus: 'yes', sponsorsCollege: true, lastRoundAt: day(-90) } });
    await prisma.brand.create({ data: { id: 'b2', name: 'Beta Energy', category: 'energy', passedAt: day(-3), doNotEmail: true, workPeople: 2 } });
    await prisma.brand.create({ data: { id: 'b3', name: 'Gamma Gin', category: 'spirits', tier: 'established' } }); // nobody on file
    await prisma.brand.create({ data: { id: 'b4', name: 'Delta Snacks', category: 'cpg', passedUntil: day(10), passedTodayAt: day(0) } });
    const people = [];
    for (const [brandId, k] of [['b1', 5], ['b2', 3], ['b4', 4]]) {
      for (let i = 0; i < k; i++) {
        people.push(await prisma.contact.create({ data: { brandId, name: brandId + ' Person ' + i, title: i % 2 ? 'Brand Manager' : null,
          email: i % 3 ? null : brandId + i + '@x.com', linkedinUrl: i % 2 ? 'https://www.linkedin.com/in/' + brandId + i : null, isDecisionMaker: i === 1 } }));
      }
    }
    const t = async (c, data) => prisma.target.create({ data: { brandId: c.brandId, contactId: c.id, ...data } });
    const t1 = await t(people[0], { status: 'sent', sentAt: day(-5), fitScore: 80 });
    const t2 = await t(people[1], { status: 'accepted', sentAt: day(-9), repliedAt: null, emailedAt: day(-2) });
    await t(people[2], { status: 'queued', queuedFor: day(0), shelved: false });
    await t(people[3], { status: 'queued', shelved: true, shelvedHow: 'cap' });
    const t5 = await t(people[5], { status: 'replied', sentAt: day(-20), repliedAt: day(-18) });
    // A target under b4 whose person is on file at b1 now (moved): its
    // contact is still read.
    const moved = await prisma.target.create({ data: { brandId: 'b4', contactId: people[4].id, status: 'drafted' } });
    // Emails: two sent (the first date counts), one draft (doesn't), one
    // sent with no date (counts, no date), one inbound (doesn't).
    const em = (targetId, data) => prisma.emailMessage.create({ data: { targetId, direction: 'out', kind: 'intro', status: 'sent', ...data } });
    await em(t1.id, { sentAt: day(-4) });
    await em(t1.id, { sentAt: day(-6) });
    await em(t1.id, { status: 'draft', sentAt: day(-8) });
    await em(t2.id, { sentAt: null });
    await em(t5.id, { direction: 'in', status: 'received', sentAt: day(-19) });
    await em(moved.id, { sentAt: day(-1) });

    const nested = await prisma.brand.findMany({ select: PLAN_BRAND_SELECT });
    const flat = await loadPlanBrands(prisma);
    same(flat, nested, 'whole roster');
    assert.equal(flat.length, 4);
    const b1 = flat.find(b => b.id === 'b1');
    assert.equal(b1.targets.find(x => x.id === t1.id)._count.emails, 2);
    assert.deepEqual(b1.targets.find(x => x.id === t1.id).emails, [{ sentAt: day(-6) }]);
    assert.deepEqual(b1.targets.find(x => x.id === t2.id).emails, [{ sentAt: null }]);
    assert.equal(b1.targets.find(x => x.id === t2.id)._count.emails, 1);
    assert.deepEqual(flat.find(b => b.id === 'b3').contacts, []);
    ok('the whole roster: the same brands, people, targets, email counts and first-email dates as the nested read');

    for (const [where, what] of [
      [{ id: { in: ['b4', 'b1'] } }, 'by id'],
      [{ category: 'cpg' }, 'by category (a moved person still named)'],
      [{ passedAt: null, targets: { none: { status: 'replied' } } }, 'a relation filter'],
      [{ id: 'nobody' }, 'nothing matches'],
    ]) {
      same(await loadPlanBrands(prisma, where), await prisma.brand.findMany({ where, select: PLAN_BRAND_SELECT }), what);
    }
    ok('a filtered read answers the same as the nested read');

    // A roster the size of the real one (1,500 brands), made in a shuffled
    // order, so the read order comes from the table and the plan Postgres
    // picks for a roster that size, not from the order rows were made in.
    const N = 1500;
    const ids = Array.from({ length: N }, (_, i) => 'r' + String((i * 37) % N).padStart(4, '0'));
    await prisma.brand.createMany({ data: ids.map((id, i) => ({ id, name: 'Roster ' + id, category: ['energy', 'spirits', null][i % 3] })) });
    const rows = [];
    ids.forEach((id, i) => { for (let j = 0; j < (i % 7); j++) rows.push({ id: id + 'c' + j, brandId: id, name: 'P ' + id + j, title: j % 2 ? 'CMO' : 'Founder', linkedinUrl: j % 3 ? null : 'https://x/' + id + j }); });
    for (let i = rows.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    await prisma.contact.createMany({ data: rows });
    await prisma.target.createMany({ data: rows.filter((_, i) => i % 2).map((c, i) => ({ id: c.id + 't', brandId: c.brandId, contactId: c.id, status: i % 5 ? 'queued' : 'sent', sentAt: i % 5 ? null : day(-i % 30), fitScore: (i * 13) % 100 })) });
    // Sent emails on some, and rows changed since (an update moves a row
    // in the table): a filtered read's targets come back in the order the
    // sent-email count's join gives them, which the loader must match.
    const tIds = (await prisma.target.findMany({ select: { id: true } })).map(t => t.id).sort();
    await prisma.emailMessage.createMany({ data: tIds.filter((_, i) => i % 3 === 0).map((targetId, i) => ({ targetId, direction: 'out', kind: 'intro', status: 'sent', sentAt: day(-(i % 20)) })) });
    await prisma.target.updateMany({ where: { id: { in: tIds.filter((_, i) => i % 4 === 1) } }, data: { fitScore: { increment: 1 } } });
    await prisma.contact.updateMany({ where: { id: { in: rows.filter((_, i) => i % 5 === 2).map(c => c.id) } }, data: { title: 'Head of Partnerships' } });
    // With the table statistics a live database has (autovacuum): the plan
    // — and so the order — the real roster gets.
    await prisma.$executeRawUnsafe('ANALYZE');
    same(await loadPlanBrands(prisma), await prisma.brand.findMany({ select: PLAN_BRAND_SELECT }), 'shuffled roster');
    const BEST_FIT_LIKE = { passedAt: null, doNotEmail: false, contacts: { some: {} }, targets: { none: { OR: [{ sentAt: { not: null } }, { emails: { some: { direction: 'out', status: 'sent' } } }] } } };
    for (const [w, what] of [[{ category: 'energy' }, 'by category'], [BEST_FIT_LIKE, 'Best fit\'s filter'], [{ id: { in: ids.slice(40, 90) } }, 'fifty by id']]) {
      same(await loadPlanBrands(prisma, w), await prisma.brand.findMany({ where: w, select: PLAN_BRAND_SELECT }), 'shuffled, ' + what);
    }
    ok('a shuffled roster of 1,500 brands, with sent emails and rows changed since, reads back identically, whole and filtered');

    // The order rows come back in is Postgres's plan's, not a promise —
    // so the loader sends the nested read's very statements for the
    // brands, their contacts and their targets: whatever plan a database
    // picks, both get it.
    const logged = new PrismaClient({ datasources: { db: { url: DB } }, log: [{ emit: 'event', level: 'query' }] });
    let tag = '';
    const sql = { nested: [], flat: [] };
    logged.$on('query', (e) => { if (tag) sql[tag].push(e.query.replace(/\$[0-9]+(,\$[0-9]+)*/g, '$…')); });
    try {
      for (const w of [undefined, { category: 'energy' }, BEST_FIT_LIKE]) {
        sql.nested = []; sql.flat = [];
        tag = 'nested'; await logged.brand.findMany({ ...(w ? { where: w } : {}), select: PLAN_BRAND_SELECT });
        tag = 'flat'; await loadPlanBrands(logged, w);
        tag = '';
        const pick = (l, re) => l.filter((q) => re.test(q));
        for (const re of [/^SELECT "public"."Brand"/, /FROM "public"."Contact" WHERE "public"."Contact"."brandId" IN/, /FROM "public"."Target" LEFT JOIN/]) {
          assert.ok(pick(sql.flat, re).length === 1, 'one ' + re + ' query');
          assert.deepEqual(pick(sql.flat, re), pick(sql.nested, re), 'the same statement: ' + re);
        }
      }
    } finally { await logged.$disconnect(); }
    ok('the loader sends the nested read\'s own statements for brands, contacts and targets');

    console.log(n + ' checks passed');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
