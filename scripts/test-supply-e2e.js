// scripts/test-supply-e2e.js — Brands → All brands' "What the queue has to
// work with" (Leo, Nov 5 2026; src/lib/supply.ts) against the real handlers
// and a throwaway Postgres (wiped): brandSupply's counts (ready, short, held
// back by each rule, the LinkedIn fill's kinds, Reach out again), the Too
// small switch (the queue's own picks take them once it's on), the fill's
// order (brands the queue could pick that are short on people first, `wide`;
// a brand read in full and still short back once, `reread`), and Archive dead
// weight (preview, apply, Undo).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-supply-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-supply-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3473);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const INGEST_TOKEN = 'e2e-ingest-token-0123456789abcdef';

const call = async (url, body, auth) => {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) };
};
const data = async (fn, args) => {
  const { status, json } = await call('/api/data', { fn, args: args || {} }, DASHBOARD_TOKEN);
  if (!json.ok) throw new Error(fn + ': ' + (json.error || status));
  return json.data;
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
      env: { ...env, DASHBOARD_TOKEN, INGEST_TOKEN, NEXTAUTH_SECRET: 'e2e-only', NEXT_TELEMETRY_DISABLED: '1' },
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

    // Money in the sweet spot and a Top category: Brand Fit well over 50.
    const SALES = BigInt(50_000_000 * 100);
    const brand = (id, name, o) => prisma.brand.create({
      data: Object.assign({ id, name, category: 'electrolytes', tier: 'growth', salesCents: SALES, liMembers: 120,
        linkedinUrl: 'https://www.linkedin.com/company/' + id.toLowerCase() + '/' }, o || {}),
    });
    const people = async (brandId, k, o) => {
      const out = [];
      for (let i = 0; i < k; i++) {
        out.push(await prisma.contact.create({ data: Object.assign({
          brandId, name: brandId + ' Person ' + i, title: i === 0 ? 'Head of Partnerships' : 'Brand Marketing Manager',
          linkedinUrl: 'https://www.linkedin.com/in/' + brandId.toLowerCase() + '-' + i,
        }, o || {}) }));
      }
      return out;
    };
    await brand('bReady', 'Ready Hydration'); await people('bReady', 5);
    // Read in full before the founders & events search, enough people now.
    await brand('bFull', 'Full Hydration'); await people('bFull', 5);
    await brand('bShort', 'Short Hydration'); await people('bShort', 1);
    await brand('bNone', 'Nobody Hydration'); await people('bNone', 2, { linkedinUrl: null });
    await brand('bGiant', 'Giant Hydration', { liMembers: 2400 }); await people('bGiant', 5);
    await brand('bSmall', 'Small Hydration', { liMembers: 8, salesCents: null }); await people('bSmall', 5);
    await brand('bSkip', 'Skip Bets', { category: 'betting' }); await people('bSkip', 5);
    // Reached ten days ago, nobody answered, a buyer there never contacted.
    await brand('bAgain', 'Again Hydration');
    const [a0] = await people('bAgain', 3);
    await prisma.target.create({ data: { brandId: 'bAgain', contactId: a0.id, status: 'sent', sentAt: new Date(Date.now() - 10 * 864e5) } });
    // Dead weight.
    await brand('bNotUs', 'Faraway Drinks', { usStatus: 'no' }); await people('bNotUs', 2);
    await brand('bSeller', 'Metro Hydration League'); await people('bSeller', 2);
    await brand('bDead', 'Empty Hydration');
    // Nov 7 2026 ("i want these brands to be ran"): low Brand Fit (a Low category,
    // money not known) — one short on people, one with people but no buyer title,
    // one with its buyers (the floor still holds that one); and a high-fit brand
    // read in full with founders & events searched, still short.
    const low = { category: 'apparel', salesCents: null };
    await brand('bLowShort', 'Low Short Threads', low); await people('bLowShort', 1);
    await brand('bLowNoBuyer', 'Low Nobuyer Threads', low); await people('bLowNoBuyer', 5, { title: 'Store Associate' });
    await brand('bLowOk', 'Low Fine Threads', low); await people('bLowOk', 5);
    await brand('bWideShort', 'Wide Short Hydration'); await people('bWideShort', 1);
    // The fill's visit log: bNone and bDead read in full; bDead read again since.
    const at = new Date(Date.now() - 20 * 864e5).toISOString();
    await prisma.setting.create({ data: { key: 'liSweepLog', value: JSON.stringify({
      bNone: { at, seen: 30, added: 0, v: 2, clean: true, issue: null, sn: true },
      bFull: { at, seen: 30, added: 5, v: 2, clean: true, issue: null, sn: true },
      bDead: { at, seen: 30, added: 0, v: 2, clean: true, issue: null, sn: true, reread: true },
      bWideShort: { at, seen: 12, added: 1, v: 2, clean: true, issue: null, sn: true, wide: true, shown: 12, checked: true },
    }) } });

    // ---- the counts ----
    let s = await data('brandSupply', { minFit: 0 });
    const has = (list, id) => (list || []).includes(id);
    assert.ok(has(s.ids.ready, 'bReady'), 'enough people: ready');
    assert.ok(has(s.ids.short, 'bShort') && has(s.ids.short, 'bNone'), 'short on people');
    assert.ok(has(s.ids.none, 'bNone') && !has(s.ids.none, 'bShort'), 'nobody to reach');
    assert.ok(has(s.ids.giant, 'bGiant') && has(s.ids.small, 'bSmall') && has(s.ids.skip, 'bSkip'), 'each rule holds its brand');
    assert.ok(!has(s.ids.ready, 'bAgain') && !has(s.ids.short, 'bAgain'), 'a reached brand is not the queue’s own pick');
    assert.ok(!has(s.ids.ready, 'bNotUs') && !has(s.ids.short, 'bNotUs'), 'not sold in the US is off');
    assert.equal(s.switches.smallOn, false);
    assert.ok(s.lets.small >= 1 && s.lets.giant >= 1, 'each switch lets in what that rule alone holds');
    assert.ok(s.skipCats.some(c => c.key === 'betting'), 'Skip categories named');
    assert.ok(s.readyPeople >= 4, 'about how many people are ready');
    ok('counts: ready, short, nobody to reach, held by giants / too small / Skip, reached and off left out');

    assert.ok(has(s.again.ids, 'bAgain'), 'reach out again: reached 10 days ago, a decision maker never contacted');
    const ar = s.again.rows.find(r => r.id === 'bAgain');
    assert.equal(ar.state, 'due');
    assert.ok(ar.freshTotal >= 2 && s.days.length >= 1, 'its people and the days to put it on');
    ok('Reach out again: the brand, who would go, the sending days');

    // ---- the fill ----
    assert.ok(has(s.fill.ids.reread, 'bNone'), 'read in full and still short: one more read');
    assert.ok(has(s.fill.ids.reread, 'bFull'), 'read in full before founders & events, enough people: one more read too (Nov 6 2026)');
    assert.ok(has(s.fill.ids.new, 'bShort') && has(s.fill.ids.new, 'bReady'), 'never read: new');
    assert.ok(!has(s.fill.ids.new, 'bDead') && !has(s.fill.ids.reread, 'bDead'), 're-read already: never again by itself');
    const sched = await data('fillSchedule', { minFit: 0, research: false });
    const order = [].concat(...sched.days.map(d => d.rows)).map(r => r.brandId);
    assert.ok(order.indexOf('bShort') >= 0 && order.indexOf('bReady') >= 0);
    assert.ok(order.indexOf('bShort') < order.indexOf('bReady') && order.indexOf('bNone') < order.indexOf('bReady'),
      'short brands the queue could pick go before ready ones: ' + order.join(', '));
    assert.ok(order.indexOf('bReady') < order.indexOf('bFull'), 'a brand not read yet goes before one more read of a ready brand: ' + order.join(', '));
    // The run's own list says which reads take the founders & events search.
    const li = await call('/api/ingest', { action: 'liList', token: INGEST_TOKEN, reader: 2, minFit: 0, salesNav: true }, INGEST_TOKEN);
    assert.ok(li.json.ok !== false && Array.isArray(li.json.items), 'liList answered: ' + JSON.stringify(li.json).slice(0, 200));
    const item = (id) => li.json.items.find(i => i.brandId === id);
    assert.equal(item('bShort').wide, true);
    assert.equal(item('bNone').wide, true);
    assert.equal(item('bNone').reread, true);
    assert.equal(item('bReady').wide, true, 'every read searches founders & events');
    assert.deepEqual([item('bFull').reread, item('bFull').wide, item('bFull').kind], [true, true, 'reread']);
    assert.ok(li.json.shortFirst >= 2 && li.json.reread >= 2);
    ok('the fill: short brands first, every read wider, each brand read in full before back once');

    // Its one more read lands (script 1.44 sends wide): the brand is re-read for good.
    const sw = await call('/api/ingest', { action: 'liSwept', token: INGEST_TOKEN, reader: 2, brandId: 'bNone', run: 'r1', name: 'Nobody Hydration',
      seen: 20, added: 0, salesNav: true, done: true, issue: null, wide: true, reread: true, snOn: true, key: 'r1:0:bNone' }, INGEST_TOKEN);
    assert.ok(sw.status < 300, 'liSwept saved: ' + JSON.stringify(sw.json).slice(0, 200));
    const mark = JSON.parse((await prisma.setting.findUnique({ where: { key: 'liSweepLog' } })).value).bNone;
    assert.equal(mark.reread, true); assert.equal(mark.wide, true);
    s = await data('brandSupply', { minFit: 0 });
    assert.ok(!has(s.fill.ids.reread, 'bNone') && !has(s.fill.ids.new, 'bNone') && !has(s.fill.ids.again, 'bNone'), 'off the fill once read again');
    ok('the wider read marks the brand re-read: it leaves the fill');

    // The floor the LinkedIn Fill app's run asked with is the card's floor.
    const floorList = await call('/api/ingest', { action: 'liList', token: INGEST_TOKEN, reader: 2, minFit: 57, salesNav: true }, INGEST_TOKEN);
    assert.ok(floorList.json.ok !== false);
    s = await data('brandSupply', {});
    assert.deepEqual([s.minFit, s.appFloor && s.appFloor.minFit], [57, 57]);
    assert.equal((await data('brandSupply', { minFit: 0 })).minFit, 0, 'a floor typed on the card wins for that count');
    ok('the card counts at the floor the fill app\u2019s run uses');

    // Brands that need people are read whatever their Brand Fit; the floor holds
    // the rest. One read in full that still needs people gets one more read.
    const at57 = (await call('/api/ingest', { action: 'liList', token: INGEST_TOKEN, reader: 2, minFit: 57, salesNav: true }, INGEST_TOKEN)).json;
    const it57 = (id) => at57.items.find(i => i.brandId === id);
    assert.ok(it57('bLowShort') && it57('bLowShort').belowFloor && it57('bLowShort').needs, 'short on people, under the floor: on the fill');
    assert.ok(it57('bLowNoBuyer') && it57('bLowNoBuyer').belowFloor, 'no buyer on file, under the floor: on the fill');
    assert.ok(!it57('bLowOk'), 'has its people, under the floor: still left off');
    assert.ok(!it57('bSkip'), 'a Skip category stays off');
    assert.deepEqual([it57('bWideShort').reread, it57('bWideShort').rereadWhy, it57('bWideShort').kind], [true, 'needs', 'reread'],
      'read in full with founders & events, still short: one more read');
    const s57 = await data('brandSupply', { minFit: 57 });
    assert.ok(s57.fill.needsUnderFloor >= 2 && has(s57.fill.ids.new, 'bLowShort') && has(s57.fill.ids.reread, 'bWideShort'), JSON.stringify(s57.fill).slice(0, 300));
    await call('/api/ingest', { action: 'liSwept', token: INGEST_TOKEN, reader: 2, brandId: 'bWideShort', run: 'r2', name: 'Wide Short Hydration',
      seen: 12, added: 0, salesNav: true, done: true, issue: null, wide: true, reread: true, snOn: true, shown: 12, emptyChecked: true, key: 'r2:0:bWideShort' }, INGEST_TOKEN);
    const again57 = (await call('/api/ingest', { action: 'liList', token: INGEST_TOKEN, reader: 2, minFit: 57, salesNav: true }, INGEST_TOKEN)).json;
    assert.ok(!again57.items.some(i => i.brandId === 'bWideShort'), 'its one more read done: off the fill');
    ok('brands that need people are on the fill whatever their Brand Fit; one read in full and still short gets one more read, once');

    // ---- the Too small switch ----
    const bankIds = async () => (await data('weekBank', {})).bank.rows.map(r => r.id);
    assert.ok(!(await bankIds()).includes('bSmall'), 'held back: not on Week plan’s list (Best fit’s picks)');
    await data('setSmallOn', { on: true });
    s = await data('brandSupply', { minFit: 0 });
    assert.equal(s.switches.smallOn, true);
    assert.ok(has(s.ids.ready, 'bSmall') && !has(s.ids.small, 'bSmall'), 'let in: ready');
    assert.ok((await bankIds()).includes('bSmall'), 'let in: the queue picks it');
    await data('setSmallOn', { on: false });
    assert.ok(!(await bankIds()).includes('bSmall'), 'held back again');
    ok('Too small: held back, let in (the queue picks it), held back again');

    // ---- Archive dead weight ----
    const plan = { [s.days[s.days.length - 1].date]: { category: null, brandIds: ['bSeller'] } };
    await prisma.setting.upsert({ where: { key: 'outreachPlan' }, create: { key: 'outreachPlan', value: JSON.stringify(plan) }, update: { value: JSON.stringify(plan) } });
    const pv = await data('deadWeight', { preview: true });
    const why = Object.fromEntries(pv.brands.map(b => [b.id, b.why]));
    assert.equal(why.bNotUs, 'notus');
    assert.equal(why.bSeller, 'seller');
    assert.equal(why.bDead, 'nobody');
    assert.equal(why.bNone, 'nobody', 'its wider read found nobody either');
    assert.ok(!why.bReady && !why.bShort && !why.bAgain, 'brands that can still go out stay');
    assert.ok(pv.brands.find(b => b.id === 'bSeller').plannedLabel, 'says it comes off a Schedule day');
    assert.equal(await prisma.brand.count({ where: { passedAt: { not: null } } }), 0, 'a preview changes nothing');
    ok('Archive dead weight’s preview: not in the US, sells sponsorships, nobody after a full read — nothing written');

    const done = await data('deadWeight', { preview: false, brandIds: ['bNotUs', 'bSeller', 'bReady'] });
    assert.equal(done.archived, 2, 'only ticked brands still on the list: ' + JSON.stringify(done));
    assert.equal(done.offDays, 1);
    const arch = await prisma.brand.findMany({ where: { passedAt: { not: null } }, select: { id: true } });
    assert.deepEqual(arch.map(b => b.id).sort(), ['bNotUs', 'bSeller']);
    const planNow = JSON.parse((await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })).value);
    assert.ok(!JSON.stringify(planNow).includes('bSeller'), 'off its Schedule day');
    s = await data('brandSupply', { minFit: 0 });
    assert.equal(s.dead.last.count, 2);
    ok('apply archives only what was ticked and still listed, and takes it off the Schedule');

    const up = await data('deadWeightUndo', { preview: true });
    assert.deepEqual(up.brands.sort(), ['Faraway Drinks', 'Metro Hydration League']);
    assert.equal(await prisma.brand.count({ where: { passedAt: { not: null } } }), 2, 'the Undo preview changes nothing');
    await data('deadWeightUndo', { preview: false });
    assert.equal(await prisma.brand.count({ where: { passedAt: { not: null } } }), 0);
    await assert.rejects(data('deadWeightUndo', { preview: true }), /Nothing to undo/);
    ok('Undo: names them first, then brings them back; once');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('✗', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
