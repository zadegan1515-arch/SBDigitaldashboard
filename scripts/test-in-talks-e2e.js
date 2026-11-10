// scripts/test-in-talks-e2e.js — the In talks tab against the real handlers and
// a throwaway Postgres (wiped): who's in (a call booked, a reply — Nov 8 2026 —
// a hand add, a removal; Elizabeth's replies too), the stage (from what
// happened, set on the bar, the deal following, Undo), the log (add / edit /
// delete, talksLog), Zach's tab (zachOverview), the Outreached / Accepted
// tag's accept day, the people and the journey, saveTalksProfile (links
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
    assert.deepEqual(r.brands.map(b => b.id), ['ba', 'bb'], 'the brand with a call booked (first: a call coming up) and the one that replied');
    const a = r.brands[0];
    assert.equal(a.why, 'call');
    assert.equal(r.brands[1].why, 'reply');
    assert.equal(a.stage.key, 'call_booked');
    assert.equal(a.stage.hand, false);
    assert.equal(r.brands[1].stage.key, 'replied');
    assert.ok(a.stageDates.replied && a.stageDates.call_booked);
    assert.equal(r.stageCounts.call_booked, 1);
    assert.equal(r.stageCounts.replied, 1);
    assert.equal(r.suggestions, undefined, 'no "Replied, not in talks" list any more');
    assert.ok(a.nextCall && a.nextCall.name === 'Ann Able');
    assert.deepEqual(a.people.map(p => [p.name, p.stage, p.email]), [['Ann Able', 'call', 'ann@alpha.com'], ['Ben Bright', 'accepted', null]]);
    assert.deepEqual(a.invited.map(p => p.name), ['Cy Cole']);
    assert.equal(a.others, 1, 'the queued person is "on file"');
    assert.deepEqual(a.journey.map(s => s.done), [true, true, true, true, false]);
    assert.equal(a.board.code, 'ALPHA-1');
    assert.equal(typeof a.fit, 'number');
    ok('a call booked or a reply puts a brand in by itself (Gamma only accepted: not; the person never), with its stage, people, journey, board code');

    // 2. Hand add / removal
    r = await data('setInTalks', { brandId: 'bb', on: true });
    assert.deepEqual(r, { brandId: 'bb', brandName: 'Beta Beer', on: true });
    r = await data('listInTalks');
    assert.deepEqual(r.brands.map(b => b.id).sort(), ['ba', 'bb']);
    assert.equal(r.brands.find(b => b.id === 'bb').why, 'hand');
    assert.equal(r.brands.find(b => b.id === 'bb').addedBy, 'Claude', 'a Claude session reads as Claude');
    await data('setInTalks', { brandId: 'ba', on: false });
    r = await data('listInTalks');
    assert.deepEqual(r.brands.map(b => b.id), ['bb'], 'taking it off wins over the older call and the older reply');
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
    // The brand page's profile (Nov 10 2026) reads the same notes the same way,
    // with the profile's words and links; its older note saves alone.
    const gb = await data('getBrand', { brandId: 'bb' });
    assert.deepEqual(gb.notes, r.brands.find(b => b.id === 'bb').notes, 'the brand page and the In talks profile get one note the same way');
    assert.deepEqual([gb.brand.website, gb.brand.instagramUrl, gb.brand.tiktokUrl], ['https://betabeer.com', 'https://www.instagram.com/betabeer/', '']);
    assert.equal(gb.brand.overview, 'Beta Beer is a light lager. It is growing fast.');
    assert.match(gb.brand.activationIdea, /^Open the Garage\n\nA pop-up/);
    assert.deepEqual((await data('getBrand', { brandId: 'bc' })).notes, [], 'a brand with no notes: an empty list');
    const before = await prisma.brand.findUnique({ where: { id: 'bb' } });
    await data('updateBrand', { brandId: 'bb', notes: 'Met at BevNET.' });
    const after = await prisma.brand.findUnique({ where: { id: 'bb' } });
    assert.equal(after.notes, 'Met at BevNET.');
    assert.deepEqual([after.website, after.category, after.tier, after.overview, after.activationIdea], [before.website, before.category, before.tier, before.overview, before.activationIdea], 'nothing else on the brand moved');
    await data('updateBrand', { brandId: 'bb', notes: '' });
    assert.equal((await prisma.brand.findUnique({ where: { id: 'bb' } })).notes, null);
    await data('deleteBrandNote', { id: n1.id, confirm: true });
    assert.equal(await prisma.brandNote.count({ where: { brandId: 'bb' } }), 1);
    ok('notes add (trimmed, by Claude), edit, and delete only with confirm; newest first; the brand page reads them too');

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

    // 7. Merge and delete carry the notes and the log
    await data('addBrandNote', { brandId: 'bc', text: 'Gamma note' });
    await data('addTalksEvent', { brandId: 'bb', kind: 'call', text: 'Intro call' });
    r = await data('mergeBrands', { fromId: 'bb', toId: 'bc' });
    assert.equal(r.summary.notes, 1);
    assert.equal(r.summary.talksLog, 1);
    await data('mergeBrands', { fromId: 'bb', toId: 'bc', confirm: true });
    const gc = await prisma.brand.findUnique({ where: { id: 'bc' }, include: { brandNotes: true } });
    assert.deepEqual(gc.brandNotes.map(x => x.text).sort(), ['Budget lands in February.', 'Gamma note']);
    assert.equal(gc.instagramUrl, 'https://www.instagram.com/betabeer/');
    assert.match(gc.overview, /light lager/);
    assert.ok(gc.talksAddedAt, 'the hand add comes along');
    r = await data('listInTalks');
    assert.ok(r.brands.some(b => b.id === 'bc'), 'the keeper is in talks');
    assert.equal(await prisma.talksEvent.count({ where: { brandId: 'bc' } }), 1, 'the log line moved too');
    r = await data('deleteBrand', { brandId: 'bc' });
    assert.equal(r.summary.notes, 2, 'delete names the notes that go');
    assert.equal(r.summary.talksLog, 1, 'and the log lines');
    ok('merging moves the notes and the log and fills the profile; delete names them first');

    // 8. The stage bar (Leo, Nov 8 2026). Replied brands are in by themselves;
    // one not in talks opens for a look and goes in when a stage is set.
    await prisma.brand.create({ data: { id: 'bd', name: 'Delta Pouch', category: 'nicotine' } })
    await prisma.brand.create({ data: { id: 'be', name: 'Echo Energy', category: 'energy' } })
    await prisma.brand.create({ data: { id: 'bf', name: 'Fox Fizz', category: 'beverage' } })
    await mk('bd', 'Gil Gold', 'Brand Manager', 'gil@delta.com', { status: 'replied', sentAt: D(8), repliedAt: D(2) }, D(6))
    await mk('be', 'Hal Hart', 'Marketing', null, { status: 'replied', sentAt: D(8), repliedAt: D(3) }, D(6))
    await mk('bf', 'Ivy Ink', 'Marketing', null, { status: 'accepted', sentAt: D(8) }, D(5))
    r = await data('listInTalks', { preview: 'bf' })
    assert.ok(r.brands.some(b => b.id === 'bd') && r.brands.some(b => b.id === 'be'), 'replied: in by themselves')
    assert.ok(!r.brands.some(b => b.id === 'bf'), 'only accepted: not in')
    assert.equal(r.preview.id, 'bf')
    assert.equal(r.preview.stage, null)
    assert.equal((await data('listInTalks', { preview: 'bd' })).preview, null, 'a brand on the list is no preview')
    r = await data('setTalksStage', { brandId: 'bf', stage: 'call_done' })
    assert.deepEqual([r.addedToTalks, r.deal, r.label], [true, null, 'Call done'], 'a stage before Proposal sent leaves the deal alone')
    r = await data('listInTalks')
    assert.equal(r.brands.find(b => b.id === 'bf').stage.key, 'call_done')
    assert.equal(r.brands.find(b => b.id === 'bf').stage.by, 'Claude')
    // Proposal sent starts the deal; Negotiating leaves it; Contract signed moves it.
    r = await data('setTalksStage', { brandId: 'bd', stage: 'proposal' })
    assert.deepEqual([r.deal.created, r.deal.to, r.addedToTalks], [true, 'proposal', false])
    r = await data('setTalksStage', { brandId: 'bd', stage: 'negotiating' })
    assert.equal(r.deal, null)
    r = await data('setTalksStage', { brandId: 'bd', stage: 'contract' })
    assert.deepEqual([r.deal.from, r.deal.to], ['proposal', 'verbal'])
    assert.equal(await prisma.deal.count({ where: { brandId: 'bd' } }), 1, 'the same deal moves')
    let dd = (await data('listInTalks')).brands.find(b => b.id === 'bd')
    assert.equal(dd.stage.key, 'contract')
    assert.equal(dd.deal.stage, 'verbal')
    assert.ok(dd.stageDates.replied && dd.stageDates.proposal && dd.stageDates.negotiating && dd.stageDates.contract)
    // Undo the last one: its line goes and the deal goes back.
    let pv = await data('deleteTalksEvent', { id: r.event.id })
    assert.equal(pv.deleted, false)
    assert.deepEqual([pv.dealBack.from, pv.dealBack.to], ['verbal', 'proposal'])
    await data('deleteTalksEvent', { id: r.event.id, confirm: true })
    dd = (await data('listInTalks')).brands.find(b => b.id === 'bd')
    assert.deepEqual([dd.stage.key, dd.deal.stage], ['negotiating', 'proposal'])
    // A day gone by; never a day to come; Lost never starts a deal.
    const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    r = await data('setTalksStage', { brandId: 'be', stage: 'call_booked', day: dayKey(D(1)) })
    assert.equal(dayKey(new Date(r.at)), dayKey(D(1)))
    await refused('setTalksStage', { brandId: 'be', stage: 'won', day: dayKey(new Date(Date.now() + 2 * 864e5)) }, /hasn’t come yet/)
    r = await data('setTalksStage', { brandId: 'be', stage: 'lost' })
    assert.equal(r.deal, null)
    assert.equal(await prisma.deal.count({ where: { brandId: 'be' } }), 0, 'no deal made just to lose it')
    // A newer reply after Gone quiet brings it back to Replied.
    // (A stage dated before the latest one sits behind it — the timeline decides.)
    await data('setTalksStage', { brandId: 'bd', stage: 'quiet', day: dayKey(D(1)) })
    assert.equal((await data('listInTalks')).brands.find(b => b.id === 'bd').stage.key, 'negotiating', 'a day before Negotiating: Negotiating stays')
    await data('setTalksStage', { brandId: 'bd', stage: 'quiet' })
    assert.equal((await data('listInTalks')).brands.find(b => b.id === 'bd').stage.key, 'quiet')
    await prisma.target.updateMany({ where: { brandId: 'bd' }, data: { repliedAt: new Date(Date.now() + 1000) } })
    assert.equal((await data('listInTalks')).brands.find(b => b.id === 'bd').stage.key, 'replied', 'a reply after Gone quiet brings it back')
    // A deal synced from Notion stays; the stage is still set.
    await prisma.deal.create({ data: { brandId: 'ba', name: 'Alpha show', stage: 'verbal', source: 'notion' } })
    r = await data('setTalksStage', { brandId: 'ba', stage: 'won' })
    assert.match(r.dealSkipped, /Notion/)
    assert.equal((await prisma.deal.findFirst({ where: { brandId: 'ba', source: 'notion' } })).stage, 'verbal')
    await refused('setTalksStage', { brandId: 'bd', stage: 'maybe' }, /Unknown stage/)
    await refused('setTalksStage', { brandId: 'bp', stage: 'proposal' }, /person/)
    ok('the stage bar: a brand not in talks goes in; Proposal sent starts the deal, later stages move it, Undo puts it back; a past day, never a future one; Lost makes no deal; a reply after Gone quiet; synced deals stay')

    // 9. The log: add / edit / delete, and what the site saw.
    const e1 = (await data('addTalksEvent', { brandId: 'bd', kind: 'email_out', day: dayKey(D(4)), text: '  Sent the deck  ' })).event
    assert.deepEqual([e1.label, e1.text, e1.by, dayKey(new Date(e1.at))], ['Email sent', 'Sent the deck', 'Claude', dayKey(D(4))])
    await refused('addTalksEvent', { brandId: 'bd', kind: 'stage' }, /Pick what happened/)
    await refused('addTalksEvent', { brandId: 'bd', kind: 'other' }, /Say what happened/)
    await refused('addTalksEvent', { brandId: 'bd', kind: 'call', day: dayKey(new Date(Date.now() + 864e5)) }, /hasn’t come yet/)
    await new Promise(r2 => setTimeout(r2, 1100))   // "edited" = changed a second or more after it was made
    r = await data('editTalksEvent', { id: e1.id, kind: 'proposal', day: dayKey(D(5)), text: 'Sent the deck + pricing' })
    assert.deepEqual([r.event.label, r.event.text, dayKey(new Date(r.event.at))], ['Deck / proposal sent', 'Sent the deck + pricing', dayKey(D(5))])
    assert.ok(r.event.editedAt)
    assert.equal((await data('editTalksEvent', { id: e1.id, text: 'Sent the deck + pricing' })).noop, true)
    const stageLine = await prisma.talksEvent.findFirst({ where: { brandId: 'bd', kind: 'stage' } })
    await refused('editTalksEvent', { id: stageLine.id, kind: 'call' }, /stays a stage/)
    const tlog = await data('talksLog', { brandId: 'bd' })
    const labels = tlog.items.map(x => x.label)
    assert.ok(labels.includes('Deck / proposal sent') && labels.includes('Moved to Negotiating'), labels.join(' | '))
    assert.ok(tlog.items.some(x => !x.hand && x.label === 'Accepted' && /Gil Gold/.test(x.text)), 'what the site saw: the accept')
    assert.ok(tlog.items.every((x, i) => i === 0 || tlog.items[i - 1].at >= x.at), 'newest first')
    const callLog = await data('talksLog', { brandId: 'ba' })
    assert.ok(callLog.items.some(x => x.label === 'Call coming up' && x.upcoming && /Ann Able/.test(x.text)), 'a call to come, on its day')
    pv = await data('deleteTalksEvent', { id: e1.id })
    assert.equal(pv.deleted, false)
    await data('deleteTalksEvent', { id: e1.id, confirm: true })
    assert.equal(await prisma.talksEvent.count({ where: { id: e1.id } }), 0)
    const words = (await prisma.claudeAction.findMany({ where: { fn: { in: ['setTalksStage', 'addTalksEvent', 'editTalksEvent', 'deleteTalksEvent'] } }, orderBy: { at: 'asc' } })).map(x => x.text)
    assert.ok(words.includes('Moved Delta Pouch to Proposal sent (In talks) — its deal to proposal'), words.join(' | '))
    assert.ok(words.includes('Logged email sent on Delta Pouch (In talks)'))
    assert.equal(words.filter(w => /^Deleted a line/.test(w)).length, 2, 'the previews aren’t logged')
    assert.ok(!(await prisma.claudeAction.findMany({ where: { fn: 'talksLog' } })).length, 'the read isn’t logged')
    ok('the log: lines with their day added, edited, deleted after a preview; what the site saw read-only; Claude’s day words each change')

    // 10. Elizabeth's replies count; a reply after Take off brings a brand back.
    await prisma.brand.create({ data: { id: 'bg', name: 'Golf Gum', category: 'beverage' } })
    await prisma.repOutreach.create({ data: { rep: 'elizabeth', brandId: 'bg', brandName: 'Golf Gum', name: 'Jo Jay', title: 'CMO', channel: 'email', day: dayKey(D(6)), status: 'replied', sentAt: D(6), repliedAt: D(1) } })
    r = await data('listInTalks')
    const g = r.brands.find(b => b.id === 'bg')
    assert.ok(g, 'her reply puts it in')
    assert.deepEqual(g.people.map(p => [p.name, p.by, p.stage]), [['Jo Jay', 'elizabeth', 'replied']])
    assert.equal(g.stage.key, 'replied')
    await data('setInTalks', { brandId: 'be', on: false })
    assert.ok(!(await data('listInTalks')).brands.some(b => b.id === 'be'))
    await prisma.target.updateMany({ where: { brandId: 'be' }, data: { repliedAt: new Date(Date.now() + 1000) } })
    assert.ok((await data('listInTalks')).brands.some(b => b.id === 'be'), 'a newer reply brings it back')
    assert.equal((await data('getBrand', { brandId: 'bg' })).talks.why, 'reply')
    ok('Elizabeth’s replies count, with her person on the profile; a newer reply brings back a brand taken off; the brand page says why');

    // 11. The tag's accept day and Zach's tab.
    const rb = await data('reachedBrands')
    assert.equal(rb.brands.ba[5], dayKey(D(14)), 'the latest accept at Alpha (Ben, 14 days ago)')
    assert.equal(rb.brands.bf[5], dayKey(D(5)))
    const zo = await data('zachOverview')
    const it = await data('listInTalks')
    assert.equal(zo.talks.total, it.brands.length)
    assert.equal(zo.outreach.invites, await prisma.target.count({ where: { OR: [{ sentAt: { not: null } }, { status: { in: ['sent', 'accepted', 'replied', 'converted'] } }] } }))
    assert.equal(zo.outreach.brands, Object.keys(rb.brands).length + Object.keys(rb.el || {}).filter(id => !rb.brands[id]).length)
    // Every brand reached, whole (the Overview draws its tiles and cards from it), each brand with its deal flow.
    const tr = await data('outreachTracker')
    assert.deepEqual(zo.tracker.stages.map(x => x.key), tr.stages.map(x => x.key), 'the seven steps, Out included')
    assert.deepEqual(zo.tracker.counts, tr.counts)
    assert.equal(zo.tracker.brands.length, tr.brands.length)
    const inTalksIds = new Set(it.brands.map(b => b.id))
    assert.ok(zo.tracker.brands.every(b => b.onTalks === inTalksIds.has(b.id)), 'each card knows whether it is on In talks')
    assert.ok(zo.tracker.brands.filter(b => b.onTalks && it.brands.find(x => x.id === b.id).stage)
      .every(b => b.talkStage && b.talkStage.key === it.brands.find(x => x.id === b.id).stage.key), 'and its deal flow, the same as In talks')
    const offRow = zo.tracker.brands.find(b => b.id === 'ba')
    assert.ok(!offRow || offRow.onTalks || offRow.talksRemovedAt, 'a brand taken off says when')
    assert.ok(zo.deals.openCount >= 1 && typeof zo.deals.openCents === 'number')
    assert.equal(zo.board.visits, 0)
    assert.ok(zo.week.now && zo.week.goals.invites)
    assert.equal(zo.brands.total, await prisma.brand.count({ where: { OR: [{ kind: null }, { kind: { not: 'person' } }] } }))
    assert.ok(!(await prisma.claudeAction.findMany({ where: { fn: 'zachOverview' } })).length, 'Zach’s tab is a read')
    ok('the tag’s accept day; Zach’s tab adds up with the tabs it opens');
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
  console.log(`\nin-talks e2e: all ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
