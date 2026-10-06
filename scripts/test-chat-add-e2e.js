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

    // The "Add a brand" chat (docs/add-a-brand-chat.md) through the real handler.
    await prisma.brand.create({ data: { id: 'b_poppi', name: 'Poppi', category: 'beverage', website: 'https://drinkpoppi.com' } });
    await prisma.brand.create({ data: { id: 'b_ld', name: 'Liquid Death', category: 'beverage', linkedinUrl: 'https://www.linkedin.com/company/liquid-death-mountain-water/' } });

    const pv = await data('chatAddBrand', { brand: { name: 'Olipop', category: 'beverage', website: 'drinkolipop.com', instagram: '@drinkolipop' } });
    assert.equal(pv.preview, true);
    assert.deepEqual(pv.matches, []);
    assert.equal(await prisma.brand.count({ where: { name: 'Olipop' } }), 0, 'a preview writes nothing');
    ok('preview: cleaned card, no matches, nothing written');

    await assert.rejects(data('chatAddBrand', { brand: { name: 'X Brand', category: 'snacks' } }), /category/i);
    ok('an unknown category is refused');

    const dup = await data('chatAddBrand', { brand: { name: 'LD Water', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' } });
    assert.equal(dup.matches[0].name, 'Liquid Death');
    await assert.rejects(data('chatAddBrand', { apply: true, brand: { name: 'LD Water', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' } }), /Already on the roster as "Liquid Death"/);
    await assert.rejects(data('chatAddBrand', { apply: true, notSame: true, brand: { name: 'poppi', website: 'drinkpoppi.com' } }), /Already on the roster/);
    ok('a possible duplicate is refused; an exact name even with notSame');

    const made = await data('chatAddBrand', {
      apply: true,
      brand: { name: 'Olipop', category: 'beverage', tier: 'growth', website: 'drinkolipop.com', aka: 'Olipop Soda', about: 'Prebiotic soda', instagram: 'drinkolipop', note: 'Seen on IG' },
      facts: { us: 'yes', funding: '$50M', sponsorsCollege: 'unknown' },
    });
    const b = await prisma.brand.findUnique({ where: { id: made.created.id } });
    assert.equal(b.source, 'chat');
    assert.equal(b.category, 'beverage');
    assert.equal(b.aka, 'Olipop Soda');
    assert.equal(b.website, 'https://drinkolipop.com/');
    assert.match(b.notes, /Add a brand" chat[\s\S]*Seen on IG[\s\S]*@drinkolipop/);
    assert.equal(b.fundingCents, null, 'facts never land straight on the brand');
    assert.equal(made.factsStaged, 1);
    const staged = await data('researchImport', { staged: true });
    const row = (staged.rows || []).find(r => r.brandId === b.id || (r.brand && r.brand.id === b.id));
    assert.ok(row, 'facts wait in the research review: ' + JSON.stringify(staged).slice(0, 400));
    assert.ok(made.link.endsWith('#brand/' + b.id));
    ok('apply: brand made (source chat, notes, aka), facts staged for review, link back');

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
