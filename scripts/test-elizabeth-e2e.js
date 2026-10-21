// scripts/test-elizabeth-e2e.js — the Elizabeth tab against the real handlers
// and a throwaway Postgres (wiped): her week (the brand list, putting brands on
// days, the spread and its Undo), today's list (whole brands, best people first,
// email before LinkedIn, nobody who said they don't want to continue, never
// topped up), every step and Back a step, switching channel, Take off (names
// first), follow-ups, results, the brand panel, adding a person, templates, her
// Reached tag, merges keeping her rows — and an account marked as hers opening
// only her part (a real signed-in session).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-elizabeth-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-elizabeth-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3473);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const SECRET = 'e2e-only-secret';
const LEO = 'leo@sb.test', LIZ = 'liz@sb.test';

const call = async (fn, args, cookie) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      cookie ? { Cookie: 'next-auth.session-token=' + cookie } : { Authorization: 'Bearer ' + DASHBOARD_TOKEN }),
    body: JSON.stringify({ fn, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  return { status: r.status, j };
};
const data = async (fn, args, cookie) => {
  const { status, j } = await call(fn, args, cookie);
  if (!j.ok) throw new Error(fn + ': ' + (j.error || status));
  return j.data;
};
const refused = async (fn, args, re, cookie) => {
  try { await data(fn, args, cookie); } catch (e) { assert.match(e.message, re); return; }
  throw new Error(fn + ' should have been refused');
};

let n = 0;
const ok = (name) => { n++; console.log('  ok — ' + name); };
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayKey = () => NY.format(new Date());
const dow = (k) => new Date(k + 'T12:00:00Z').getUTCDay();

(async () => {
  let server = null, prisma = null;
  try {
    const env = { ...process.env, DATABASE_URL: DB };
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { cwd: ROOT, env, stdio: 'pipe' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });
    const { encode } = require('next-auth/jwt');
    const leo = await encode({ token: { email: LEO, name: 'Leo Z' }, secret: SECRET });
    const liz = await encode({ token: { email: LIZ, name: 'Elizabeth Q' }, secret: SECRET });

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DASHBOARD_TOKEN, NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: BASE, ALLOWED_EMAILS: LEO + ',' + LIZ, NEXT_TELEMETRY_DISABLED: '1' },
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

    const L = (s) => 'https://www.linkedin.com/in/' + s;
    await prisma.brand.create({ data: { id: 'ba', name: 'Alpha Hydrate', category: 'electrolytes', fundingCents: BigInt(20_000_000_00) } });
    await prisma.brand.create({ data: { id: 'bb', name: 'Beta Beer', category: 'rtd', salesCents: BigInt(50_000_000_00) } });
    await prisma.brand.create({ data: { id: 'bs', name: 'Stop Soda', category: 'beverage', stoppedAt: new Date() } });
    await prisma.brand.create({ data: { id: 'bn', name: 'No One Co', category: 'beverage' } });
    await prisma.brand.create({ data: { id: 'bp', name: 'Pat Person', kind: 'person' } });
    await prisma.brand.create({ data: { id: 'bd', name: 'Alpha Hydrate Dupe', category: 'electrolytes' } });
    const C = (id, brandId, name, title, email, link, extra) => prisma.contact.create({ data: Object.assign({ id, brandId, name, title, email, linkedinUrl: link ? L(link) : null }, extra || {}) });
    await C('a1', 'ba', 'Ann Able', 'Head of Partnerships', 'ann@alpha.com', 'annable');
    await C('a2', 'ba', 'Ben Bright', 'Marketing Manager', null, 'benbright');
    await C('a3', 'ba', 'Cy Cole', 'Events Director', 'cy@alpha.com', null);
    await C('a4', 'ba', 'Di Dunn', 'Sales Associate', 'di@alpha.com', null);
    await C('a5', 'ba', 'Ed Ely', 'VP Partnerships', 'ed@alpha.com', 'edely', { doNotContactAt: new Date() });
    await C('b1', 'bb', 'Flo Fay', 'Brand Manager', null, 'flofay');
    await C('b2', 'bb', 'Gus Gray', 'CMO', 'gus@beta.com', 'gusgray');
    await C('s1', 'bs', 'Hal Hart', 'CMO', 'hal@stop.com', null);
    await C('d1', 'bd', 'Ivy Ingram', 'Partnerships Lead', 'ivy@alpha.com', 'ivyingram');

    const today = todayKey();
    const sending = [2, 3, 4].includes(dow(today));

    // 1. Her week
    let w = await data('elWeek');
    assert.ok(w.days.length >= 3, 'this week and next');
    assert.ok(w.days.every(d => [2, 3, 4].includes(dow(d.date)) && d.date >= today), 'Tue–Thu from today on');
    const bankIds = w.bank.map(b => b.id);
    assert.ok(bankIds.includes('ba') && bankIds.includes('bb'), 'brands she can reach are on the list');
    assert.ok(!bankIds.includes('bs') && !bankIds.includes('bp') && !bankIds.includes('bn'), 'not a stopped brand, a person or a brand with nobody to reach');
    const alpha = w.bank.find(b => b.id === 'ba');
    assert.equal(alpha.size, 3, 'Alpha opens with 3 (Ed said no)');
    assert.equal(alpha.emails, 3);
    ok('her week: Tue–Thu, the brand list by Brand Fit, the stopped brand and people left out');

    const day0 = w.days[0].date;
    await data('elPlan', { op: 'add', brandId: 'ba', day: day0 });
    await data('elPlan', { op: 'add', brandId: 'bb', day: day0 });
    await refused('elPlan', { op: 'add', brandId: 'bs', day: day0 }, /don't want to continue/);
    await refused('elPlan', { op: 'add', brandId: 'bp', day: day0 }, /person/);
    let fri = today; while (dow(fri) !== 5) fri = new Date(new Date(fri + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
    await refused('elPlan', { op: 'add', brandId: 'bn', day: fri }, /Tuesday, Wednesday or Thursday/);
    w = await data('elWeek');
    assert.deepEqual(w.days[0].brands.map(b => b.id), ['ba', 'bb']);
    assert.equal(w.days[0].count, 5, '3 at Alpha + 2 at Beta');
    assert.ok(!w.bank.some(b => b.id === 'ba'), 'a planned brand leaves the list');
    await data('elPlan', { op: 'add', brandId: 'bb', day: day0, index: 0 });
    w = await data('elWeek');
    assert.deepEqual(w.days[0].brands.map(b => b.id), ['bb', 'ba'], 'reordered');
    await data('elPlan', { op: 'add', brandId: 'bb', day: day0, index: 1 });
    ok('brands go on a day, in order; stopped / person / a Friday refused');

    // 2. Today's list
    let t = await data('elToday');
    assert.equal(t.cap, 30);
    if (sending && day0 === today) {
      const names = t.brands.map(g => g.name);
      assert.deepEqual(names, ['Alpha Hydrate', 'Beta Beer'], 'plan order');
      const a = t.brands[0].rows;
      assert.deepEqual(a.map(r => [r.name, r.channel]), [['Ann Able', 'email'], ['Cy Cole', 'email'], ['Ben Bright', 'linkedin']],
        'best buyers first, email when there is one; the clerk and the one who said no left out');
      assert.equal(t.count, 5);
      const again = await data('elToday');
      assert.equal(again.brands.reduce((s, g) => s + g.rows.length, 0), 5, 'a reload adds nobody');
      ok('today\'s list: whole brands in plan order, best people first, email before LinkedIn, never topped up');
    } else {
      assert.ok(!t.sending || day0 !== today);
      assert.ok(t.next && t.next.brands.length >= 1, 'an off day shows the next sending day');
      // Put the people on by hand so the steps below have rows.
      await data('elQueuePeople', { brandId: 'ba', contactIds: ['a1', 'a3', 'a2'] });
      await data('elQueuePeople', { brandId: 'bb', contactIds: ['b2', 'b1'] });
      ok('an off day: nothing made, the next sending day shown (' + today + ')');
    }
    let rows = await prisma.repOutreach.findMany({ orderBy: { createdAt: 'asc' } });
    assert.equal(rows.length, 5);
    assert.ok(!rows.some(r => r.contactId === 'a5' || r.contactId === 'a4'));
    const row = (name) => rows.find(r => r.name === name);

    // 3. Steps
    const ann = row('Ann Able'), ben = row('Ben Bright'), cy = row('Cy Cole');
    let s = await data('elStep', { id: ann.id, step: 'sent' });
    assert.equal(s.row.status, 'sent');
    await refused('elStep', { id: ann.id, step: 'sent' }, /Already/);
    await refused('elStep', { id: ann.id, step: 'accepted' }, /LinkedIn/);
    s = await data('elStep', { id: ann.id, step: 'back' });
    assert.equal(s.row.status, 'queued', 'Back a step');
    assert.equal(s.row.sentAt, null);
    await data('elStep', { id: ann.id, step: 'sent' });
    s = await data('elStep', { id: ann.id, step: 'follow' });
    assert.ok(s.row.followAt);
    s = await data('elStep', { id: ann.id, step: 'replied' });
    assert.equal(s.row.group, 'replied');
    await refused('elStep', { id: ann.id, step: 'call' }, /day/);
    const callDay = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    s = await data('elStep', { id: ann.id, step: 'call', callDay });
    assert.equal(s.row.status, 'call');
    ok('email: sent → follow-up → replied → call booked; Back a step; out-of-order steps refused');

    await refused('elStep', { id: ben.id, step: 'accepted' }, /sent first/);
    await data('elStep', { id: ben.id, step: 'sent' });
    s = await data('elStep', { id: ben.id, step: 'accepted' });
    assert.equal(s.row.stage, 'dmDue');
    await refused('elStep', { id: ben.id, step: 'follow' }, /first message/);
    s = await data('elStep', { id: ben.id, step: 'dm' });
    assert.equal(s.row.stage, 'finalDue');
    ok('LinkedIn: invite → accepted → text them → the final reach-out next');

    // Switch channel (waiting only); her own wording.
    await refused('elStep', { id: cy.id, step: 'channel' }, /No LinkedIn link/);
    const gus = row('Gus Gray');
    s = await data('elStep', { id: gus.id, step: 'channel' });
    assert.equal(s.row.channel, gus.channel === 'email' ? 'linkedin' : 'email');
    s = await data('elStep', { id: gus.id, step: 'save', subject: 'Hey Gus', body: 'Custom body' });
    assert.equal(s.row.subject, 'Hey Gus');
    s = await data('elStep', { id: gus.id, step: 'save', subject: '', body: '' });
    assert.equal(s.row.subject, null, 'empty = back to the template');
    await data('elStep', { id: cy.id, step: 'passed' });
    s = await data('elStep', { id: cy.id, step: 'unpass' });
    assert.equal(s.row.status, 'queued');
    ok('switch channel, her own wording and back to the template, Leave out and back');

    // Someone marked on Zach's list since: blocked.
    await prisma.contact.update({ where: { id: 'b1' }, data: { doNotContactAt: new Date() } });
    await refused('elStep', { id: row('Flo Fay').id, step: 'sent' }, /don't want to continue/);
    ok('a person who said they don\'t want to continue can\'t be marked sent');

    // 4. Take off: names first.
    let off = await data('elTakeOff', { brandId: 'bb' });
    assert.equal(off.applied, false);
    assert.deepEqual(off.people.sort(), ['Flo Fay', 'Gus Gray']);
    off = await data('elTakeOff', { brandId: 'bb', confirm: true });
    assert.equal(off.applied, true);
    assert.equal(await prisma.repOutreach.count({ where: { brandId: 'bb' } }), 0);
    w = await data('elWeek');
    assert.ok(!w.days.some(d => d.brands.some(b => b.id === 'bb')), 'off her week too');
    ok('Take off names who comes off first, then removes them and the brand from her week');

    // 5. Follow-ups and results
    const f = await data('elFollow');
    const byName = Object.fromEntries(f.rows.map(r => [r.name, r]));
    assert.equal(byName['Ann Able'].group, 'call');
    assert.equal(byName['Ben Bright'].group, 'waiting');
    assert.ok(!byName['Cy Cole'], 'waiting rows are on Today, not follow-ups');
    const res = await data('elResults');
    assert.equal(res.week.emails, 1);
    assert.equal(res.week.invites, 1);
    assert.equal(res.week.accepted, 1);
    assert.equal(res.week.calls, 1);
    assert.deepEqual(res.brands.map(b => [b.name, b.stage]), [['Alpha Hydrate', 'r']]);
    ok('follow-ups grouped by where each stands; results count her week');

    // 6. Brand panel, add a person, templates
    const bp = await data('elBrand', { brandId: 'ba' });
    assert.match(bp.people[0].title, /Partnerships/, 'best title first');
    assert.ok(bp.people.find(p => p.name === 'Ed Ely').stopped, 'the one who said no is marked');
    assert.equal(bp.people.find(p => p.name === 'Ann Able').rows[0].status, 'call');
    await refused('elAddPerson', { brandId: 'ba', name: 'Ann Able', email: 'other@alpha.com' }, /already on file/);
    await refused('elAddPerson', { brandId: 'ba', name: 'Nobody Here' }, /LinkedIn link or email/);
    await refused('elAddPerson', { brandId: 'bd', name: 'Ed Again', linkedinUrl: L('edely') }, /don't want to continue/);
    const added = await data('elAddPerson', { brandId: 'ba', name: 'Jo Jones', title: 'Partnerships Manager', linkedinUrl: 'linkedin.com/in/jojones/', queue: true });
    assert.equal(added.queued.added[0], 'Jo Jones');
    const jo = await prisma.contact.findUnique({ where: { id: added.contact.id } });
    assert.equal(jo.linkedinUrl, L('jojones'));
    assert.equal(jo.source, 'elizabeth');
    const tp = await data('elTemplates');
    assert.match(tp.templates.email.body, /Elizabeth/);
    await data('elSaveTemplate', { kind: 'email', subject: 'Hi (BRAND)', body: 'Hello (NAME)' });
    assert.equal((await data('elTemplates')).templates.email.subject, 'Hi (BRAND)');
    await data('elSaveTemplate', { kind: 'email', reset: true });
    assert.match((await data('elTemplates')).templates.email.body, /Elizabeth/);
    ok('the brand panel, + Add a person (dupes and stopped people refused), templates saved and reset');

    // 7. Her Reached tag (Zach's map untouched)
    const rb = await data('reachedBrands');
    assert.ok(rb.el.ba, 'her tag');
    assert.ok(!rb.brands.ba, 'Zach never reached it — his tag stays off');
    ok('her own Reached tag, Zach\'s unchanged');

    // 8. The spread and its Undo
    await prisma.brand.create({ data: { id: 'bx', name: 'Xeno Energy', category: 'energy', salesCents: BigInt(30_000_000_00) } });
    await C('x1', 'bx', 'Kim Key', 'Partnerships', 'kim@xeno.com', null);
    const prev = await data('elSpread', { seed: 7 });
    assert.equal(prev.applied, false);
    const put = prev.put.flatMap(p => p.brands.map(b => b.id));
    assert.ok(put.includes('bx'), 'the spread deals the best brands onto open days');
    const ap = await data('elSpread', { apply: true, seed: 7, expect: prev.expect });
    assert.equal(ap.applied, true);
    w = await data('elWeek');
    assert.ok(w.days.some(d => d.brands.some(b => b.id === 'bx')));
    const un = await data('elSpreadUndo');
    assert.ok(un.goes.some(g => g.id === 'bx'));
    await data('elSpreadUndo', { confirm: true });
    w = await data('elWeek');
    assert.ok(!w.days.some(d => d.brands.some(b => b.id === 'bx')), 'Undo took it off');
    ok('Fill my week: preview, apply with the same seed, Undo names what comes off');

    // 9. A merge keeps her rows
    await data('mergeBrands', { fromId: 'ba', toId: 'bd', confirm: true });
    assert.equal(await prisma.repOutreach.count({ where: { brandId: 'bd' } }), await prisma.repOutreach.count());
    const del = await data('deleteBrand', { brandId: 'bd' });
    assert.ok(del.summary.elizabeth >= 1, 'a delete names her rows');
    ok('mergeBrands moves her rows to the brand that stays; deleteBrand names them');

    // 9b. The same person twice: her row goes with the copy that stays, and
    // back with Undo.
    await prisma.brand.create({ data: { id: 'bm', name: 'Mono Mints', category: 'nicotine' } })
    await C('m1', 'bm', 'Lu Lane', 'Head of Marketing', null, 'lulane')
    await C('m2', 'bm', 'Lu Lane', 'Marketing', 'lu@mono.com', null)
    await data('elQueuePeople', { brandId: 'bm', contactIds: ['m2'] })
    const before = await prisma.repOutreach.findFirst({ where: { brandId: 'bm' } })
    assert.equal(before.contactId, 'm2')
    const mp = await data('mergePeople', { brandId: 'bm' })
    assert.equal(mp.people.length, 1)
    await data('mergePeople', { brandId: 'bm', confirm: true, expect: mp.expect })
    const kept = mp.people[0].keepId
    assert.equal((await prisma.repOutreach.findUnique({ where: { id: before.id } })).contactId, kept, 'moved to the person who stays')
    await data('undoMergePeople', { brandId: 'bm', confirm: true })
    assert.equal((await prisma.repOutreach.findUnique({ where: { id: before.id } })).contactId, 'm2', 'back with Undo')
    ok('Merge… on the same person keeps her row (and Undo puts it back)')

    // 10. An account marked as hers opens only her part
    const me1 = await data('getMe', {}, liz);
    assert.equal(me1.rep, null, 'not marked yet');
    await data('listBrands', {}, liz);
    await refused('setRepAccount', { email: LEO }, /Not your own account/, leo);
    await refused('setRepAccount', { email: LEO }, /founding members/);
    await data('setRepAccount', { email: LIZ, on: true }, leo);
    const team = await data('listTeam', {}, leo);
    assert.ok(team.reps[LIZ]);
    const me2 = await data('getMe', {}, liz);
    assert.equal(me2.rep, 'Elizabeth');
    const blocked = await call('listBrands', {}, liz);
    assert.equal(blocked.status, 403);
    assert.match(blocked.j.error, /only Elizabeth/);
    await data('elToday', {}, liz);
    await data('reachedBrands', {}, liz);
    const g = await fetch(BASE + '/api/google/start', { headers: { Cookie: 'next-auth.session-token=' + liz }, redirect: 'manual' });
    assert.equal(g.status, 403, 'no Gmail / Drive connect from her account');
    await data('listBrands', {}, leo);
    await data('setRepAccount', { email: LIZ, on: false }, leo);
    await new Promise(r => setTimeout(r, 200));
    ok('marked on Team: her account opens only her outreach (403 elsewhere, Google connect refused); Leo keeps everything');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('✗', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
