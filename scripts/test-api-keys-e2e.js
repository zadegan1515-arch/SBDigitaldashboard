// scripts/test-api-keys-e2e.js — keys for other tools, end to end: the real
// middleware and /api/data (next dev) on a throwaway local Postgres, with real
// signed-in sessions for the people and real keys for the tools. Who can make
// a key, that it's shown once and only its hash is kept, what it can do (add a
// brand, a person, a note, a stage — under its own name), what it can't, the
// list of what it changed on Team, and Revoke.
//   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-api-keys-e2e.js
const { spawn, execSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-api-keys-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3487);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const SECRET = 'e2e-only-secret';
const LEO = 'leo@sb.test', MIA = 'mia@sb.test';

// who: { cookie } a signed-in person · { bearer } a key or Claude's token · {} nobody.
const call = async (fn, args, who) => {
  const w = who || {};
  const r = await fetch(BASE + '/api/data', {
    method: 'POST', redirect: 'manual',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      w.cookie ? { Cookie: 'next-auth.session-token=' + w.cookie } : {},
      w.bearer ? { Authorization: 'Bearer ' + w.bearer } : {}),
    body: JSON.stringify({ fn, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  return { status: r.status, j };
};
const data = async (fn, args, who) => {
  const { status, j } = await call(fn, args, who);
  if (!j.ok) throw new Error(fn + ': ' + (j.error || status));
  return j.data;
};
const refused = async (fn, args, who, status, re) => {
  const r = await call(fn, args, who);
  assert.equal(r.j.ok, false, fn + ' should have been refused');
  assert.equal(r.status, status, fn + ' → ' + r.status + ' ' + (r.j.error || ''));
  if (re) assert.match(String(r.j.error), re);
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
    const { encode } = require('next-auth/jwt');
    const leo = { cookie: await encode({ token: { email: LEO, name: 'Leo Z' }, secret: SECRET }) };
    const mia = { cookie: await encode({ token: { email: MIA, name: 'Mia T' }, secret: SECRET }) };
    const claude = { bearer: DASHBOARD_TOKEN };
    await prisma.allowedEmail.create({ data: { email: MIA, addedBy: LEO } });

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DASHBOARD_TOKEN, NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: BASE, ALLOWED_EMAILS: LEO, SITE_URL: BASE, NEXT_TELEMETRY_DISABLED: '1' },
    });
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    const t0 = Date.now();
    for (;;) {
      try { await data('categoryReach', {}, claude); break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    const keysStored = async () => (await prisma.setting.findUnique({ where: { key: 'apiKeys' } }))?.value ?? '';
    const brandCount = () => prisma.brand.count();

    // 1. Without a session, a token or a key: nothing.
    let r = await call('createBrand', { name: 'Nobody Cola' });
    assert.ok([302, 307, 401].includes(r.status), 'turned away at the gate (' + r.status + ')');
    // A key-shaped token that isn't a key: through the gate's shape check, stopped by the real one.
    const fake = 'sbk_' + 'A'.repeat(43);
    await refused('createBrand', { name: 'Nobody Cola' }, { bearer: fake }, 401, /isn’t valid/);
    await refused('noSuchFunction', {}, { bearer: fake }, 401, /isn’t valid/);
    await refused('whoAmI', {}, { bearer: fake }, 401);
    // Not key-shaped and not Claude's token: stopped at the gate, as before.
    r = await call('createBrand', { name: 'Nobody Cola' }, { bearer: 'sbk_short' });
    assert.ok([302, 307, 401].includes(r.status));
    r = await call('createBrand', { name: 'Nobody Cola' }, { bearer: DASHBOARD_TOKEN + 'x' });
    assert.ok([302, 307, 401].includes(r.status));
    assert.equal(await brandCount(), 0, 'nothing was added');
    ok('no session, no token, a made-up key: nothing runs');

    // 2. Only a signed-in founding member makes a key.
    await refused('createApiKey', { name: 'Maya' }, mia, 500, /founding members/);
    await refused('createApiKey', { name: 'Maya' }, claude, 500, /founding members/);
    await refused('createApiKey', { name: '' }, leo, 500, /name/);
    await refused('createApiKey', { name: 'CLI' }, leo, 500, /Claude/);
    assert.equal(await keysStored(), '', 'no key was made');
    const made = await data('createApiKey', { name: '  Maya ' }, leo);
    assert.match(made.key, /^sbk_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.row.name, 'Maya'); assert.equal(made.row.createdBy, LEO);
    assert.ok(!('hash' in made.row));
    const maya = { bearer: made.key };
    const stored = await keysStored();
    assert.ok(stored.includes('"name":"Maya"') && !stored.includes(made.key) && !stored.includes(made.key.slice(4, 30)), 'only the hash is kept');
    await refused('createApiKey', { name: 'maya' }, leo, 500, /already a key called/);
    ok('a founding member makes a key; it is shown once and only its hash is kept');

    // 3. The key works, under its own name.
    let me = await data('whoAmI', {}, maya);
    assert.equal(me.name, 'Maya'); assert.equal(me.via, 'key');
    // Nothing the caller sends can change who it is.
    me = await data('whoAmI', { __key: { name: 'Leo' }, __user: 'CLI' }, maya);
    assert.equal(me.name, 'Maya'); assert.equal(me.via, 'key');
    assert.equal((await data('whoAmI', {}, claude)).via, 'token');
    assert.equal((await data('whoAmI', {}, leo)).via, 'sign-in');
    const guide = await data('apiGuide', {}, maya);
    assert.match(guide.text, new RegExp('POST ' + BASE.replace(/[.]/g, '\\.') + '/api/data'));
    assert.ok(guide.functions.includes('createBrand') && guide.functions.includes('upsertContact'));
    for (const fn of ['listTeam', 'createApiKey', 'listAttendees', 'sendTestEmail', 'listOps']) assert.ok(!guide.functions.includes(fn), fn + ' is not offered');
    ok('the key answers whoAmI as itself and gets its instructions');

    // 4. It adds things: a brand, a person, a note, a stage — signed with its name.
    const look = await data('brandLookup', { q: 'Poppi' }, maya);
    assert.equal(look.exact, false);
    const b = await data('createBrand', { name: 'Poppi', category: 'beverage', website: 'drinkpoppi.com' }, maya);
    assert.equal(b.created, true);
    const again = await data('createBrand', { name: 'Poppi', category: 'beverage' }, maya);
    assert.equal(again.created, false, 'never added twice');
    const person = await data('upsertContact', { brandId: b.brand.id, name: 'Ann Able', title: 'Head of Partnerships', email: 'ann@poppi.test' }, maya);
    assert.equal(person.name, 'Ann Able');
    const note = await data('addBrandNote', { brandId: b.brand.id, text: 'Met them at BevNet Live.' }, maya);
    assert.equal(note.note.by, 'Maya');
    const stage = await data('setTalksStage', { brandId: b.brand.id, stage: 'replied' }, maya);
    assert.equal(stage.event.by, 'Maya');
    await data('updateBrand', { brandId: b.brand.id, linkedinUrl: 'https://www.linkedin.com/company/poppi' }, maya);
    const got = await data('getBrand', { brandId: b.brand.id }, maya);
    assert.equal(got.brand.contacts.length, 1); assert.equal(got.notes[0].by, 'Maya');
    await refused('createBrand', { name: 'Bad Cat', category: 'not-a-category' }, maya, 500);
    await refused('toString', {}, maya, 400, /Unknown function/);
    await refused('constructor', {}, claude, 400, /Unknown function/);
    ok('the key adds a brand, a person, a note and a stage, signed "Maya"');

    // 5. What a key can never do.
    const team = await prisma.allowedEmail.count();
    await refused('listTeam', {}, maya, 403, /access/);
    await refused('addTeamEmail', { email: 'evil@sb.test' }, maya, 403, /access/);
    await refused('createApiKey', { name: 'More' }, maya, 403, /access/);
    await refused('revokeApiKey', { id: made.row.id }, maya, 403, /access/);
    await refused('listAttendees', {}, maya, 403, /Attendee records/);
    await refused('listAudienceEvents', {}, maya, 403, /Attendee records/);
    await refused('importAttendees', { rows: [] }, maya, 403, /Attendee records/);
    await refused('sendTestEmail', { to: 'x@sb.test' }, maya, 403, /never sends email/);
    await refused('sendApprovedEmails', {}, maya, 403, /never sends email/);
    await refused('listOps', {}, maya, 403, /mailbox/);
    await refused('disconnectGoogle', {}, maya, 403, /Google/);
    assert.equal(await prisma.allowedEmail.count(), team, 'nobody was let in');
    // The key opens /api/data and nothing else.
    const page = await fetch(BASE + '/app.html', { redirect: 'manual', headers: { Authorization: 'Bearer ' + made.key } });
    assert.ok([302, 307, 401].includes(page.status), 'the site itself still needs a sign-in (' + page.status + ')');
    ok('a key can\'t touch access, attendees, email, the ops mailbox or Google — or open the site');

    // 6. Team lists what the key changed (reads, previews and "already there" aren't changes).
    let t = await data('listTeam', {}, leo);
    assert.equal(t.canManage, true);
    let row = t.keys.list.find(k => k.id === made.row.id);
    assert.ok(row && !('hash' in row) && !JSON.stringify(t).includes(made.key));
    assert.equal(row.changes, 5);
    assert.deepEqual(row.log.map(l => l.fn), ['updateBrand', 'setTalksStage', 'addBrandNote', 'upsertContact', 'createBrand']);
    assert.match(row.log[4].text, /Added Poppi/); assert.match(row.log[3].text, /Added Ann Able/);
    assert.ok(row.lastUsedAt, 'last used is set');
    assert.match(t.keys.guide, /ADDING THINGS WITH A KEY/);
    // Not Claude's day: that's for Claude's own token.
    assert.equal(await prisma.claudeAction.count(), 0, 'a key\'s change is not a ClaudeAction');
    await data('createBrand', { name: 'Olipop', category: 'beverage' }, claude);
    assert.equal(await prisma.claudeAction.count(), 1);
    t = await data('listTeam', {}, leo);
    assert.equal(t.keys.list.find(k => k.id === made.row.id).changes, 5, 'Claude\'s change isn\'t the key\'s');
    // Someone added from Team (not a founding member) doesn't see keys.
    const tm = await data('listTeam', {}, mia);
    assert.equal(tm.canManage, false); assert.equal(tm.keys, null);
    ok('Team lists each change under the key; only founding members see keys');

    // 7. Revoke: off at once; what it added stays.
    await refused('revokeApiKey', { id: made.row.id }, mia, 500, /founding members/);
    await refused('revokeApiKey', { id: made.row.id }, claude, 500, /founding members/);
    assert.equal((await data('whoAmI', {}, maya)).name, 'Maya', 'still on');
    const rev = await data('revokeApiKey', { id: made.row.id }, leo);
    assert.ok(rev.row.revokedAt); assert.equal(rev.row.revokedBy, LEO);
    await refused('whoAmI', {}, maya, 401, /isn’t valid/);
    await refused('createBrand', { name: 'After Revoke' }, maya, 401);
    assert.equal(await prisma.brand.count({ where: { name: 'After Revoke' } }), 0);
    assert.equal(await prisma.brand.count({ where: { name: 'Poppi' } }), 1, 'what it added stays');
    t = await data('listTeam', {}, leo);
    row = t.keys.list.find(k => k.id === made.row.id);
    assert.ok(row.revokedAt && row.changes === 5 && row.log.length === 5, 'still listed, with what it changed');
    await refused('revokeApiKey', { id: 'nope' }, leo, 500, /isn’t on the list/);
    // The name is free again, and the new key is a different key.
    const made2 = await data('createApiKey', { name: 'Maya' }, leo);
    assert.notEqual(made2.key, made.key);
    assert.equal((await data('whoAmI', {}, { bearer: made2.key })).name, 'Maya');
    await refused('whoAmI', {}, maya, 401);
    t = await data('listTeam', {}, leo);
    assert.deepEqual(t.keys.list.map(k => [k.name, !!k.revokedAt]), [['Maya', false], ['Maya', true]], 'live keys first');
    ok('Revoke switches the key off at once; what it added stays; the name is free again');

    // 8. Claude's own token is as it was.
    assert.equal((await data('whoAmI', {}, claude)).name, 'Claude');
    await refused('listTeam', {}, { bearer: fake }, 401);
    const lt = await data('listTeam', {}, claude);
    assert.equal(lt.canManage, false); assert.equal(lt.keys, null);
    ok('Claude\'s own token works as before and sees no keys');

    console.log('api keys e2e: ' + n + ' passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) {} }
  }
})();
