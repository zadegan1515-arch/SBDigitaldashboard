// scripts/test-in-talks-e2e.js — the In talks tab against the real handlers and
// a throwaway Postgres (wiped): who's in (a call booked, a hand add, a removal),
// replied brands offered, the people and the journey, saveTalksProfile (links
// cleaned, Claude's 4 sentences, onlyEmpty, "none"), notes (delete asks first),
// listTalksToFill, getBrand's line, merges and deletes carrying the notes, and
// Claude's day wording (src/lib/in-talks.ts, route.ts).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-in-talks-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-in-talks-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3471);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

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
const refused = async (fn, args, re) => {
  try { await data(fn, args); } catch (e) { assert.match(e.message, re); return; }
  throw new Error(fn + ' should have been refused');
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

    const D = (days) => new Date(Date.now() - days * 864e5);
    await prisma.brand.create({ data: { id: 'ba', name: 'Alpha Hydrate', category: 'electrolytes', website: 'alphahydrate.com', boardCode: 'ALPHA-1' } });
    await prisma.brand.create({ data: { id: 'bb', name: 'Beta Beer', category: 'rtd' } });
    await prisma.brand.create({ data: { id: 'bc', name: 'Gamma Cola', category: 'beverage' } });
    await prisma.brand.create({ data: { id: 'bp', name: 'Pat Person', kind: 'person' } });
    const mk = async (brandId, name, title, email, t, accept) => {
      const c = await prisma.contact.create({ data: { brandId, name, title, email, linkedinUrl: 'https://www.linkedin.com/in/' + name.toLowerCase().replace(/\W+/g, '') } });
      const row = await prisma.target.create({ data: Object.assign({ brandId, contactId: c.id }, t) });
      if (accept) await prisma.targetEvent.create({ data: { targetId: row.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: accept } });
      return row;
    };
    await mk('ba', 'Ann Able', 'VP Marketing', 'ann@alpha.com', { status: 'replied', sentAt: D(20), repliedAt: D(6), callAt: new Date(Date.now() + 3 * 864e5), callBookedAt: D(2) }, D(15));
    await mk('ba', 'Ben Bright', 'Brand Manager', null, { status: 'accepted', sentAt: D(19) }, D(14));
    await mk('ba', 'Cy Cole', 'Events', null, { status: 'sent', sentAt: D(10) }, null);
    await mk('ba', 'Di Dunn', 'Intern', null, { status: 'queued' }, null);
    await mk('bb', 'Ed Ely', 'Partnerships', 'ed@beta.com', { status: 'replied', sentAt: D(9), repliedAt: D(1) }, D(5));
    await mk('bc', 'Flo Fay', 'CMO', null, { status: 'accepted', sentAt: D(9) }, D(4));

    // 1. Who's in
    let r = await data('listInTalks');
    assert.deepEqual(r.brands.map(b => b.id), ['ba'], 'only the brand with a call booked');
    const a = r.brands[0];
    assert.equal(a.why, 'call');
    assert.ok(a.nextCall && a.nextCall.name === 'Ann Able');
    assert.deepEqual(a.people.map(p => [p.name, p.stage, p.email]), [['Ann Able', 'call', 'ann@alpha.com'], ['Ben Bright', 'accepted', null]]);
    assert.deepEqual(a.invited.map(p => p.name), ['Cy Cole']);
    assert.equal(a.others, 1, 'the queued person is "on file"');
    assert.deepEqual(a.journey.map(s => s.done), [true, true, true, true, false]);
    assert.equal(a.board.code, 'ALPHA-1');
    assert.equal(typeof a.fit, 'number');
    assert.deepEqual(r.suggestions.map(s => s.id), ['bb'], 'Beta replied — offered; Gamma only accepted; the person never');
    assert.match(r.suggestions[0].who, /Ed Ely — Partnerships/);
    ok('a call booked puts a brand in by itself, with its people, invited-no-answer, journey and board code; replied brands offered');

    // 2. Hand add / removal
    r = await data('setInTalks', { brandId: 'bb', on: true });
    assert.deepEqual(r, { brandId: 'bb', brandName: 'Beta Beer', on: true });
    r = await data('listInTalks');
    assert.deepEqual(r.brands.map(b => b.id).sort(), ['ba', 'bb']);
    assert.equal(r.brands.find(b => b.id === 'bb').why, 'hand');
    assert.equal(r.brands.find(b => b.id === 'bb').addedBy, 'Claude', 'a Claude session reads as Claude');
    assert.deepEqual(r.suggestions, []);
    await data('setInTalks', { brandId: 'ba', on: false });
    r = await data('listInTalks');
    assert.deepEqual(r.brands.map(b => b.id), ['bb'], 'taking it off wins over the older call');
    assert.deepEqual(r.suggestions, [], 'and its older reply isn’t offered again');
    await prisma.target.updateMany({ where: { brandId: 'ba', callBookedAt: { not: null } }, data: { callBookedAt: new Date() } });
    r = await data('listInTalks');
    assert.ok(r.brands.some(b => b.id === 'ba'), 'a newer call brings it back');
    assert.equal(r.brands[0].id, 'ba', 'a call coming up sorts first');
    assert.deepEqual((await data('getBrand', { brandId: 'ba' })).talks.on, true);
    assert.deepEqual((await data('getBrand', { brandId: 'bc' })).talks.on, false);
    ok('hand add and Take off; a removal wins over older, a newer call brings it back; getBrand says which');

    // 3. The profile
    r = await data('saveTalksProfile', { brandId: 'bb', instagramUrl: 'instagram.com/betabeer?igsh=1', tiktokUrl: '@betabeer', website: 'betabeer.com' });
    assert.deepEqual(r.saved, ['website', 'Instagram', 'TikTok']);
    assert.deepEqual([r.profile.website, r.profile.instagramUrl, r.profile.tiktokUrl], ['https://betabeer.com', 'https://www.instagram.com/betabeer/', 'https://www.tiktok.com/@betabeer']);
    await refused('saveTalksProfile', { brandId: 'bb', instagramUrl: 'https://www.tiktok.com/@x' }, /isn’t an Instagram link/);
    await refused('saveTalksProfile', { brandId: 'bb', overview: 'One. Two. Three. Four. Five.' }, /5 sentences — keep it to 4/);
    r = await data('saveTalksProfile', { brandId: 'bb', overview: 'Beta Beer is a light lager. It is growing fast.', activationIdea: 'Open the Garage\n\nA pop-up at 21+ shows.' });
    assert.deepEqual(r.saved, ['overview', 'activation idea']);
    assert.equal(r.profile.overviewBy, 'Claude');
    r = await data('saveTalksProfile', { brandId: 'bb', onlyEmpty: true, overview: 'Something else.', tiktokUrl: 'none' });
    assert.deepEqual(r.saved, []);
    assert.deepEqual(r.kept.sort(), ['TikTok', 'overview']);
    await data('saveTalksProfile', { brandId: 'bb', tiktokUrl: 'none' });
    const bb = await prisma.brand.findUnique({ where: { id: 'bb' } });
    assert.equal(bb.tiktokUrl, '', '"none" = they have none');
    r = await data('saveTalksProfile', { brandId: 'bb', tiktokUrl: 'none' });
    assert.equal(r.noop, true, 'the same value again changes nothing');
    ok('links cleaned (Instagram / TikTok / website), wrong links refused, Claude keeps to 4 sentences, onlyEmpty keeps what’s there, "none"');

    // 4. Notes
    const n1 = (await data('addBrandNote', { brandId: 'bb', text: 'First call went well.' })).note;
    await new Promise(r2 => setTimeout(r2, 20));
    const n2 = (await data('addBrandNote', { brandId: 'bb', text: '  Budget lands in January.  ' })).note;
    assert.equal(n2.text, 'Budget lands in January.');
    assert.equal(n1.by, 'Claude');
    await refused('addBrandNote', { brandId: 'bb', text: '   ' }, /Write the note first/);
    r = await data('editBrandNote', { id: n2.id, text: 'Budget lands in February.' });
    assert.ok(r.note.editedAt);
    r = await data('deleteBrandNote', { id: n1.id });
    assert.equal(r.deleted, false, 'without confirm it only says which');
    assert.equal(r.note.text, 'First call went well.');
    assert.equal(await prisma.brandNote.count({ where: { brandId: 'bb' } }), 2);
    r = await data('listInTalks');
    assert.deepEqual(r.brands.find(b => b.id === 'bb').notes.map(x => x.text), ['Budget lands in February.', 'First call went well.'], 'newest first');
    await data('deleteBrandNote', { id: n1.id, confirm: true });
    assert.equal(await prisma.brandNote.count({ where: { brandId: 'bb' } }), 1);
    ok('notes add (trimmed, by Claude), edit, and delete only with confirm; newest first');

    // 5. What the daily check still fills
    r = await data('listTalksToFill');
    const fa = r.brands.find(b => b.id === 'ba');
    assert.deepEqual(fa.missing, ['overview', 'idea', 'instagram', 'tiktok']);
    assert.ok(fa.people.some(p => /Ann Able — VP Marketing \(call /.test(p)));
    assert.equal(r.brands.find(b => b.id === 'bb'), undefined, 'Beta has everything (TikTok "none" counts)');
    assert.equal(r.rules.overviewMaxSentences, 4);
    ok('listTalksToFill: only what was never filled, with the people and notes');

    // 6. Claude's day
    const acts = await prisma.claudeAction.findMany({ orderBy: { at: 'asc' } });
    const texts = acts.map(x => x.text);
    assert.ok(texts.includes('Put Beta Beer on In talks'), texts.join(' | '));
    assert.ok(texts.includes('Took Alpha Hydrate off In talks'));
    assert.ok(texts.some(t => /^Wrote Beta Beer's In talks website, Instagram, TikTok$/.test(t)));
    assert.ok(texts.includes('Added a note on Beta Beer (In talks)'));
    assert.equal(texts.filter(t => /Deleted a note/.test(t)).length, 1, 'the preview isn’t logged, the delete is');
    assert.ok(!acts.some(x => x.fn === 'listInTalks' || x.fn === 'listTalksToFill'), 'reads aren’t logged');
    ok('Claude’s day words every In talks change; reads and previews aren’t logged');

    // 7. Merge and delete carry the notes
    await data('addBrandNote', { brandId: 'bc', text: 'Gamma note' });
    r = await data('mergeBrands', { fromId: 'bb', toId: 'bc' });
    assert.equal(r.summary.notes, 1);
    await data('mergeBrands', { fromId: 'bb', toId: 'bc', confirm: true });
    const gc = await prisma.brand.findUnique({ where: { id: 'bc' }, include: { brandNotes: true } });
    assert.deepEqual(gc.brandNotes.map(x => x.text).sort(), ['Budget lands in February.', 'Gamma note']);
    assert.equal(gc.instagramUrl, 'https://www.instagram.com/betabeer/');
    assert.match(gc.overview, /light lager/);
    assert.ok(gc.talksAddedAt, 'the hand add comes along');
    r = await data('listInTalks');
    assert.ok(r.brands.some(b => b.id === 'bc'), 'the keeper is in talks');
    r = await data('deleteBrand', { brandId: 'bc' });
    assert.equal(r.summary.notes, 2, 'delete names the notes that go');
    ok('merging moves the notes and fills the profile; delete names the notes first');
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
  console.log(`\nin-talks e2e: all ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
