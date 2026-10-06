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

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
