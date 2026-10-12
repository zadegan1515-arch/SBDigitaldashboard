// scripts/test-chat-add-e2e.js — the "Add a brand" chat's handler
// (chatAddBrand) against the real /api/data on a throwaway local Postgres.
// E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-chat-add-e2e.js

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
// Its own port: test-today-e2e runs just before it in CI on 3461, and its
// dev server can still hold that port for a moment after it's told to stop.
const PORT = Number(process.env.E2E_PORT || 3462);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const M = 1000000 * 100; // $1M in cents

const data = async (fn, args, timeoutMs) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
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
    let lastErr = '';
    for (;;) {
      // A request that hangs gives up after 60 s and is tried again.
      try { await data('categoryReach', {}, 60000); break; } catch (e) { lastErr = String(e && e.message || e); }
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered (last try: ' + lastErr + '):\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // The "Add a brand" chat (docs/add-a-brand-chat.md) through the real handler.
    await prisma.brand.create({ data: { id: 'b_poppi', name: 'Poppi', category: 'beverage', website: 'https://drinkpoppi.com' } });
    await prisma.brand.create({ data: { id: 'b_ld', name: 'Liquid Death', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death-mountain-water/' } });

    const pv = await data('chatAddBrand', { brand: { name: 'Olipop', category: 'beverage', website: 'drinkolipop.com', instagram: '@drinkolipop' } });
    assert.equal(pv.preview, true);
    assert.deepEqual(pv.matches, []);
    assert.equal(await prisma.brand.count({ where: { name: 'Olipop' } }), 0, 'a preview writes nothing');
    // The facts as the card will show them — exactly what a yes writes.
    const pvf = await data('chatAddBrand', { brand: { name: 'Olipop' }, facts: { us: 'yes', funding: '$50M', sponsorsCollege: 'unknown' } });
    assert.deepEqual(pvf.facts.map(f => f.label).sort(), ['In the US', 'Raised'], JSON.stringify(pvf.facts));
    assert.ok(pvf.facts.some(f => /50/.test(f.value)), 'the amount is on the card: ' + JSON.stringify(pvf.facts));
    await assert.rejects(data('chatAddBrand', { brand: { name: 'Olipop' }, facts: { funding: 'lots' } }), /funding "lots" is not an amount/);
    ok('preview: cleaned card, no matches, the facts as they\'d be written, nothing written');

    await assert.rejects(data('chatAddBrand', { brand: { name: 'X Brand', category: 'snacks' } }), /category/i);
    ok('an unknown category is refused');

    const dup = await data('chatAddBrand', { brand: { name: 'LD Water', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' } });
    assert.equal(dup.matches[0].name, 'Liquid Death');
    await assert.rejects(data('chatAddBrand', { apply: true, brand: { name: 'LD Water', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' } }), /Already on the roster as "Liquid Death"/);
    await assert.rejects(data('chatAddBrand', { apply: true, notSame: true, brand: { name: 'poppi', website: 'drinkpoppi.com' } }), /Already on the roster/);
    ok('a possible duplicate is refused; an exact name even with notSame');

    const olipop = {
      brand: { name: 'Olipop', category: 'beverage', tier: 'growth', website: 'drinkolipop.com', aka: 'Olipop Soda', about: 'Prebiotic soda', instagram: 'drinkolipop', note: 'Seen on IG' },
      facts: { us: 'yes', funding: '$50M', sponsorsCollege: 'unknown' },
    };
    const card = await data('chatAddBrand', olipop);
    // Facts that aren't the card's are refused: the yes was to the card.
    await assert.rejects(data('chatAddBrand', { ...olipop, apply: true }), /aren’t the ones on the card/);
    await assert.rejects(data('chatAddBrand', { ...olipop, facts: { ...olipop.facts, funding: '$60M' }, apply: true, expect: card.expect }), /aren’t the ones on the card/);
    assert.equal(await prisma.brand.count({ where: { name: 'Olipop' } }), 0);
    const made = await data('chatAddBrand', { ...olipop, apply: true, expect: card.expect });
    const b = await prisma.brand.findUnique({ where: { id: made.created.id } });
    assert.equal(b.source, 'chat');
    assert.equal(b.category, 'beverage');
    assert.equal(b.aka, 'Olipop Soda');
    assert.equal(b.website, 'https://drinkolipop.com/');
    assert.match(b.notes, /Add a brand" chat[\s\S]*Seen on IG[\s\S]*@drinkolipop/);
    // Leo's yes is the review (Oct 12 2026): the facts go straight on.
    assert.equal(Number(b.fundingCents), 50000000 * 100);
    assert.equal(b.usStatus, 'yes');
    assert.equal(b.sponsorsCollege, null, 'unknown stays unknown');
    assert.ok(b.researchedAt, 'researched — off the research list');
    assert.equal(made.factsWritten, 2);
    const staged = await data('researchImport', { staged: true });
    assert.ok(!(staged.rows || []).some(r => r.brandId === b.id || (r.brand && r.brand.id === b.id)), 'nothing waits on Stock take');
    assert.ok(made.link.endsWith('#brand/' + b.id));
    ok('apply: brand made (source chat, notes, aka) with exactly the facts on the card Leo said yes to, nothing on Stock take, link back');

    const bare = await data('chatAddBrand', { apply: true, brand: { name: 'Bare Co', category: 'beverage' } });
    const bb = await prisma.brand.findUnique({ where: { id: bare.created.id } });
    assert.deepEqual({ written: bare.factsWritten, researched: bb.researchedAt, us: bb.usStatus }, { written: 0, researched: null, us: null });
    ok('no facts sent: nothing written, not marked researched');

    const again = await data('chatAddBrand', { brand: { name: 'Olipop Soda' } });
    assert.equal(again.matches[0].name, 'Olipop');
    ok('the new brand is found by its also-known-as next time');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
