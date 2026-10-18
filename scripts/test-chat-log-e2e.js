// scripts/test-chat-log-e2e.js — Home → Your chats against the real handlers
// and a throwaway Postgres (wiped): chatLog (prompt / reply / question /
// summary), ticks carried over, an older post never winding a chat back,
// dayRecap / claudeDay reading it, listChatLogs, and no ClaudeAction row for it.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-chat-log-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-chat-log-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3463);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

const call = async (fn, args) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHBOARD_TOKEN },
    body: JSON.stringify({ fn, args: args || {} }),
  });
  return r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
};
const data = async (fn, args) => {
  const j = await call(fn, args);
  if (!j.ok) throw new Error(fn + ': ' + (j.error || '?'));
  return j.data;
};
const nyKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const shift = (k, n) => new Date(new Date(k + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

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
      try { await data('listChatLogs'); break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    const today = nyKey(new Date());
    const S = 'cse_01HfnTwnbPnSCv3BvLWgsbiJ';
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

    // 1. Leo sends a message: the chat is working on it, named by what he asked.
    let r = await data('chatLog', { session: S, event: 'prompt', firstAsk: 'can you look into mug root beer and how to pitch them', ask: 'can you look into mug root beer and how to pitch them', at: iso(600000) })
    assert.equal(r.status, 'working')
    let row = await prisma.workLog.findFirst({ where: { sessionId: 'session_01HfnTwnbPnSCv3BvLWgsbiJ' } })
    assert.equal(row.day, today)
    assert.equal(row.source, 'session')
    assert.equal(row.url, 'https://claude.ai/code/session_01HfnTwnbPnSCv3BvLWgsbiJ')
    assert.equal(row.title, 'can you look into mug root beer and how to pitch them')
    assert.equal(JSON.parse(row.asks).length, 1)
    ok('a message: one row for the chat today, working, named by the first ask, a link to open it')

    // 2. Its reply: done lines, the NEED, the question it ends on; secrets hidden.
    const reply = 'Mug has no ambassador program, so pitch one.\n\n**What they do**\n- TikTok Lives\n- Set DASHBOARD_TOKEN=abc123secretvalue\n\n' +
      '**NEED: Mug’s people on the dashboard**\n1. Search PepsiCo people for MUG\n2. Send to dashboard\n\nWant me to write the pitch next?'
    r = await data('chatLog', { session: S, event: 'reply', reply, at: iso(500000) })
    assert.deepEqual([r.status, r.needs, r.question], ['needs', 1, 'Want me to write the pitch next?'])
    row = await prisma.workLog.findUnique({ where: { id: row.id } })
    const p = JSON.parse(row.parsed)
    assert.deepEqual(p.done, ['Mug has no ambassador program, so pitch one.', 'TikTok Lives', 'Set DASHBOARD_TOKEN=[hidden]'])
    assert.deepEqual(p.needs, [{ label: 'Mug’s people on the dashboard', steps: ['Search PepsiCo people for MUG', 'Send to dashboard'] }])
    assert.equal(/abc123secretvalue/.test(row.raw), false, 'no secret kept')
    assert.equal(row.title, 'can you look into mug root beer and how to pitch them', 'name kept')
    ok('a reply: what it did, its NEED with steps, the question — the secret hidden')

    // 3. Leo ticks the need; the next reply repeats it with a new one: the tick stays on its words.
    await data('setWorkNeedDone', { id: row.id, index: 0, done: true })
    await data('chatLog', { session: S, event: 'prompt', ask: 'yes write it', at: iso(400000) })
    row = await prisma.workLog.findUnique({ where: { id: row.id } })
    assert.deepEqual([row.status, row.question, row.ask], ['working', null, 'yes write it'])
    r = await data('chatLog', { session: S, event: 'reply', at: iso(300000),
      reply: 'Wrote the pitch.\n\n**NEED: Approve the pitch**\n1. Read it\n\n**NEED: Mug’s people on the dashboard**\n1. Search PepsiCo' })
    row = await prisma.workLog.findUnique({ where: { id: row.id } })
    assert.deepEqual(JSON.parse(row.needsDone), [1])
    assert.deepEqual([r.status, r.needs, r.question], ['needs', 1, null])
    assert.equal(JSON.parse(row.asks).length, 2)
    ok('a tick carries to the same need in the next reply; a message clears the old question')

    // 4. A post older than the chat's latest never winds it back.
    r = await data('chatLog', { session: S, event: 'prompt', ask: 'stale', at: iso(900000) })
    assert.equal(r.skipped, 'older')
    row = await prisma.workLog.findUnique({ where: { id: row.id } })
    assert.equal(row.ask, 'yes write it')
    ok('an older post is skipped')

    // 5. A question in a picker; then a review's summary for another chat.
    r = await data('chatLog', { session: S, event: 'question', question: 'Which spring shows should the pitch name?', at: iso(200000) })
    assert.equal(r.status, 'needs')
    const S2 = 'session_01WZePPfhwZT3jjnyZLtgUMS'
    r = await data('chatLog', { session: S2, event: 'summary', title: 'Brands reappearing after dismissal', about: 'Why dismissed Discover brands came back',
      asks: [{ at: iso(3600000), ask: 'why do dismissed brands come back' }], did: ['Dismissed brands stay dismissed now', 'Pushed to main'],
      needs: [{ label: 'Check Discover', steps: ['Open Brands → Discover'] }], question: '', at: iso(100000) })
    assert.deepEqual([r.status, r.title, r.needs], ['needs', 'Brands reappearing after dismissal', 1])
    ok('a question marks it needs you; a summary fills another chat whole')

    // 6. The day reads them; chatLog is never a "change Claude made".
    const rec = await data('dayRecap', {})
    const mine = rec.chats.find(c => c.sessionId === 'session_01HfnTwnbPnSCv3BvLWgsbiJ')
    assert.deepEqual([mine.status, mine.question, mine.url, mine.asks.length], ['needs', 'Which spring shows should the pitch name?', 'https://claude.ai/code/session_01HfnTwnbPnSCv3BvLWgsbiJ', 2])
    assert.deepEqual(mine.needs.map(x => [x.label, x.done]), [['Approve the pitch', false], ['Mug’s people on the dashboard', true]])
    const other = rec.chats.find(c => c.sessionId === S2)
    assert.equal(other.about, 'Why dismissed Discover brands came back')
    assert.equal(await prisma.claudeAction.count({ where: { fn: 'chatLog' } }), 0)
    ok('dayRecap carries each chat (status, question, link, asks, ticks); no ClaudeAction rows')

    // 7. Claude's day: yesterday's needs from a chat that logged again today are dropped.
    await prisma.workLog.create({ data: { day: shift(today, -1), title: 'Mug yesterday', raw: 'x', source: 'session', sessionId: 'session_01HfnTwnbPnSCv3BvLWgsbiJ',
      parsed: JSON.stringify({ done: [], needs: [{ label: 'Old Mug need', steps: [] }], ideas: [] }) } })
    await prisma.workLog.create({ data: { day: shift(today, -1), title: 'Quiet chat', raw: 'x', source: 'session', sessionId: 'session_01QuietChatAbcdefgh',
      parsed: JSON.stringify({ done: [], needs: [{ label: 'Still open', steps: [] }], ideas: [] }) } })
    const cd = await data('claudeDay', {})
    assert.deepEqual(cd.olderNeeds.map(o => o.title), ['Quiet chat'])
    assert.equal(cd.chats.filter(c => c.source === 'session').length, 2)
    ok('Claude’s day: a chat’s older needs give way to its latest day; a quiet chat’s stay')

    // 8. The review's read, a bad id, and pastes unchanged.
    const l = await data('listChatLogs', {})
    assert.equal(l.chats.length, 4)
    assert.equal(l.chats[0].sessionId, S2, 'latest first')
    const bad = await call('chatLog', { session: 'x y', event: 'prompt' })
    assert.equal(bad.ok, false)
    const bad2 = await call('chatLog', { session: S, event: 'nope' })
    assert.equal(bad2.ok, false)
    const pasted = await data('addWorkLog', { text: 'Pasted report\n- Did a thing' })
    assert.equal(pasted.saved, 1)
    const pr = await prisma.workLog.findFirst({ where: { title: 'Pasted report' } })
    assert.deepEqual([pr.source, pr.sessionId], ['paste', null])
    ok('listChatLogs latest first; junk refused; a paste is still a paste')

    console.log(`chat-log e2e: all ${n} passed`)
  } catch (e) {
    console.error('✗', e && e.stack || e)
    process.exitCode = 1
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {})
    if (server) { try { process.kill(-server.pid, 'SIGTERM') } catch (e) {} }
  }
})()
