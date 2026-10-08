// scripts/test-combine-e2e.js — one brand per parent company (Leo, Oct 8
// 2026: "make all of the brands under Diageo one big brand on the site and
// move all of the contacts there"): combineParent preview → apply →
// undoCombineParent, against the real handlers and a throwaway Postgres
// (wiped).
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-combine-e2e.js
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-combine-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
// Its own port: the other e2e runs in the same CI job use 3457–3463.
const PORT = Number(process.env.E2E_PORT || 3464);
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';

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
      try { await data('categoryReach', {}, 60000); break; } catch (e) { lastErr = String(e && e.message || e); }
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered (last try: ' + lastErr + '):\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    // Four Diageo labels, one brand that isn't Diageo's.
    await prisma.setting.create({ data: { key: 'liParentPages', value: JSON.stringify({ Diageo: 'diageo' }) } });
    await prisma.brand.create({ data: { id: 'ketel', name: 'Ketel One', category: 'spirits', notes: 'From the research list (Spirits).' } });
    await prisma.brand.create({ data: { id: 'bulleit', name: 'Bulleit', category: 'spirits', externalId: 'su-bulleit', about: 'Bourbon.' } });
    await prisma.brand.create({ data: { id: 'crown', name: 'Crown Royal', category: 'spirits', aka: 'The Crown: Royal Coffee Lab & Tasting Room', linkedinUrl: 'https://www.linkedin.com/company/thecrownoak/', liMembers: 12 } });
    await prisma.brand.create({ data: { id: 'guin', name: 'Guinness', category: 'rtd', salesCents: 5000000000n } });
    await prisma.brand.create({ data: { id: 'ld', name: 'Liquid Death', category: 'beverage' } });
    await prisma.contact.create({ data: { id: 'ld1', brandId: 'ld', name: 'Andy LD', title: 'CMO' } });

    // Ketel One: nine invited, one in today's list, one waiting for later.
    // Bulleit: one invited, one waiting. The same person at both (Ari).
    const person = async (id, brandId, name, title, t) => {
      await prisma.contact.create({ data: { id, brandId, name, title, linkedinUrl: 'https://www.linkedin.com/in/' + id + '/' } });
      if (t) await prisma.target.create({ data: { id: 't_' + id, brandId, contactId: id, ...t } });
    };
    for (let i = 0; i < 9; i++) await person('k' + i, 'ketel', 'Ketel Person ' + i, 'Brand Manager', { status: 'sent', sentAt: new Date(Date.now() - 864e5) });
    await person('ktoday', 'ketel', 'Kelly Today', 'Brand Manager', { status: 'drafted', queuedFor: new Date(), fitScore: 10 });
    await person('klater', 'ketel', 'Kim Later', 'Marketing Director', { status: 'queued', fitScore: 50 });
    // Ari, the real case: invited from the LinkedIn fill under Ketel One
    // (his own link), and on file from SponsorUnited under Bulleit with a
    // work email, a city, an older title and LinkedIn's default link.
    await prisma.contact.create({ data: { id: 'ari1', brandId: 'ketel', name: 'Ari Anderman', title: 'Head of Marketing', source: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/arianderman/' } });
    await prisma.target.create({ data: { id: 't_ari1', brandId: 'ketel', contactId: 'ari1', status: 'sent', sentAt: new Date(Date.now() - 3600e3) } });
    await person('b0', 'bulleit', 'Bea Sent', 'Brand Manager', { status: 'sent', sentAt: new Date(Date.now() - 2 * 864e5) });
    await person('blater', 'bulleit', 'Ben Later', 'Brand Manager', { status: 'queued', fitScore: 40 });
    await prisma.contact.create({ data: { id: 'ari2', brandId: 'bulleit', name: 'Ari Anderman', title: 'Marketing Director, Don Julio Tequila', source: 'sponsorunited', email: 'ari.anderman@diageo.com', location: 'New York, New York, United States', linkedinUrl: 'https://www.linkedin.com/in/ari-anderman-8743a831/' } });
    await prisma.deal.create({ data: { id: 'deal1', brandId: 'ketel', name: 'Ketel One x Spring' } });

    const before = await prisma.brand.count();
    const pv = await data('combineParent', { parent: 'diageo' });
    assert.equal(pv.applied, false);
    assert.equal(pv.parent, 'Diageo');
    assert.deepEqual(pv.brands.map(b => b.name).sort(), ['Bulleit', 'Crown Royal', 'Guinness', 'Ketel One']);
    assert.deepEqual(pv.keeper, { id: null, name: 'Diageo', category: 'spirits', tier: 'established', linkedinUrl: 'https://www.linkedin.com/company/diageo/', isNew: true });
    assert.equal(pv.contacts, 15);
    const ketel = pv.brands.find(b => b.name === 'Ketel One');
    assert.deepEqual({ contacts: ketel.contacts, invited: ketel.invited, today: ketel.today, waiting: ketel.waiting, deals: ketel.deals }, { contacts: 12, invited: 10, today: 1, waiting: 1, deals: 1 });
    assert.equal(pv.samePerson.length, 1);
    const ari = pv.samePerson[0];
    assert.deepEqual({ name: ari.name, at: ari.at, keep: ari.keepId, drop: ari.dropIds, takes: ari.takes },
      { name: 'Ari Anderman', at: ['Ketel One', 'Bulleit'], keep: 'ari1', drop: ['ari2'], takes: ['email', 'location'] });
    assert.equal(ari.keep.status, 'sent');
    assert.equal(ari.lines.length, 2, 'the old title and the other link are noted');
    assert.deepEqual(pv.droppedAka, [{ brand: 'Crown Royal', aka: 'The Crown: Royal Coffee Lab & Tasting Room' }]);
    assert.deepEqual(pv.pagesNotKept, [{ brand: 'Crown Royal', url: 'https://www.linkedin.com/company/thecrownoak/' }]);
    assert.deepEqual(pv.work, { invited: 11, limit: 10, today: 1, waiting: 2, nextInLine: 2 });
    assert.deepEqual(pv.blocks, []);
    for (const nm of ['Ketel One', 'Bulleit', 'Crown Royal', 'Guinness', 'Lagavulin', 'DeLeon']) assert.ok(pv.akaAfter.split(', ').includes(nm), nm);
    assert.equal(await prisma.brand.count(), before, 'a preview writes nothing');
    ok('preview: the four Diageo labels (not Liquid Death), a new Diageo on its own LinkedIn page, Ari twice (to merge), the coffee shop page left out, who becomes next in line');

    const stale = await data('combineParent', { parent: 'Diageo', confirm: true, expect: 'old' });
    assert.equal(stale.stale, true);
    assert.equal(await prisma.brand.count(), before);
    ok('apply with an out-of-date preview: nothing written, shown again');

    const done = await data('combineParent', { parent: 'Diageo', confirm: true, expect: pv.expect });
    assert.equal(done.applied, true);
    assert.equal(done.shelved, 2);
    const d = await prisma.brand.findUnique({ where: { id: done.keeperId } });
    assert.equal(d.name, 'Diageo');
    assert.equal(d.category, 'spirits');
    assert.equal(d.linkedinUrl, 'https://www.linkedin.com/company/diageo/');
    assert.equal(d.about, null, 'Bulleit\'s about is Bulleit\'s, not Diageo\'s');
    assert.equal(d.liMembers, null, 'a label\'s headcount isn\'t the company\'s');
    assert.equal(d.salesCents, null, 'nor its sales');
    assert.equal(d.externalId, 'su-bulleit', 'the SponsorUnited link follows, so a re-sync finds Diageo');
    assert.match(d.notes, /^Combined into Diageo .*: (Ketel One|Bulleit|Crown Royal|Guinness)/);
    assert.ok(!d.aka.includes('Coffee Lab'));
    assert.equal(await prisma.brand.count({ where: { id: { in: ['ketel', 'bulleit', 'crown', 'guin'] } } }), 0);
    assert.equal(await prisma.contact.count({ where: { brandId: d.id } }), 14, 'Ari is one row');
    assert.deepEqual(done.merged, ['Ari Anderman']);
    const ariNow = await prisma.contact.findUnique({ where: { id: 'ari1' } });
    assert.equal(ariNow.email, 'ari.anderman@diageo.com');
    assert.equal(ariNow.location, 'New York, New York, United States');
    assert.equal(ariNow.title, 'Head of Marketing');
    assert.equal(ariNow.linkedinUrl, 'https://www.linkedin.com/in/arianderman/');
    assert.match(ariNow.notes, /also on file as “Marketing Director, Don Julio Tequila” \(sponsorunited\); other LinkedIn link https:\/\/www\.linkedin\.com\/in\/ari-anderman-8743a831\//);
    assert.equal(await prisma.contact.count({ where: { id: 'ari2' } }), 0);
    assert.equal((await prisma.target.findUnique({ where: { contactId: 'ari1' } })).status, 'sent');
    assert.equal(await prisma.contact.count({ where: { brandId: 'ld' } }), 1, 'Liquid Death untouched');
    assert.equal(await prisma.deal.count({ where: { brandId: d.id } }), 1);
    const tt = Object.fromEntries((await prisma.target.findMany({ where: { brandId: d.id } })).map(t => [t.id, t]));
    assert.equal(tt.t_ktoday.shelved, false, 'today\'s list keeps its person for today');
    assert.equal(tt.t_klater.shelved, true);
    assert.equal(tt.t_klater.shelvedHow, 'cap', 'next in line, not shelved on purpose');
    assert.equal(tt.t_blater.shelvedHow, 'cap');
    assert.equal(tt.t_k0.status, 'sent', 'an invite stays an invite');
    ok('apply: one Diageo brand with every contact, deal and invite, Ari merged into one row; nothing about one label on it; past its number, the people waiting are next in line');

    const page = await data('getBrand', { brandId: d.id });
    assert.equal(page.brand ? page.brand.name : page.name, 'Diageo');
    const found = await data('searchPlanBrands', { q: 'Ketel One' });
    const rows = found.rows || found.brands || found;
    assert.equal((Array.isArray(rows) ? rows : [])[0].name, 'Diageo', 'Ketel One finds Diageo now: ' + JSON.stringify(found).slice(0, 300));
    ok('the brand page opens; the old names find Diageo');

    const none = await data('combineParent', { parent: 'Diageo' });
    assert.equal(none.brands.length, 0);
    assert.equal(none.keeper.isNew, false);
    await assert.rejects(data('combineParent', { parent: 'Diageo', confirm: true, expect: none.expect }), /No brands under Diageo/);
    ok('a second run: nothing left to combine');

    const up = await data('undoCombineParent', {});
    assert.equal(up.applied, false);
    assert.deepEqual(up.brands.sort(), ['Bulleit', 'Crown Royal', 'Guinness', 'Ketel One']);
    assert.equal(up.back.contact, 15, 'Ari\'s second copy comes back too');
    assert.equal(up.movedSince, 0);
    assert.deepEqual(up.unmerge, ['Ari Anderman']);
    assert.deepEqual(up.blocks, []);
    const undone = await data('undoCombineParent', { confirm: true });
    assert.equal(undone.applied, true);
    assert.equal(await prisma.brand.count({ where: { name: 'Diageo' } }), 0, 'the Diageo the combine made is gone again');
    const k = await prisma.brand.findUnique({ where: { id: 'ketel' } });
    assert.equal(k.notes, 'From the research list (Spirits).');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'bulleit' } })).externalId, 'su-bulleit');
    assert.equal((await prisma.brand.findUnique({ where: { id: 'crown' } })).liMembers, 12);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'guin' } })).salesCents, 5000000000n);
    assert.equal(await prisma.contact.count({ where: { brandId: 'ketel' } }), 12);
    assert.equal(await prisma.contact.count({ where: { brandId: 'bulleit' } }), 3);
    const ari2 = await prisma.contact.findUnique({ where: { id: 'ari2' } });
    assert.deepEqual({ brand: ari2.brandId, email: ari2.email, title: ari2.title }, { brand: 'bulleit', email: 'ari.anderman@diageo.com', title: 'Marketing Director, Don Julio Tequila' });
    const ari1 = await prisma.contact.findUnique({ where: { id: 'ari1' } });
    assert.deepEqual({ brand: ari1.brandId, email: ari1.email, location: ari1.location, notes: ari1.notes }, { brand: 'ketel', email: null, location: null, notes: null });
    assert.equal(await prisma.deal.count({ where: { brandId: 'ketel' } }), 1);
    const kl = await prisma.target.findUnique({ where: { id: 't_klater' } });
    assert.deepEqual({ shelved: kl.shelved, how: kl.shelvedHow }, { shelved: false, how: null });
    await assert.rejects(data('undoCombineParent', {}), /Nothing to undo/);
    ok('undo: the four brands back as they were (same ids, notes, SponsorUnited link, facts), their people and deal back, Ari two rows again, next in line undone');

    // Combine again; the LinkedIn fill adds someone to Diageo; undo keeps
    // Diageo for them.
    const pv2 = await data('combineParent', { parent: 'Diageo' });
    const d2 = await data('combineParent', { parent: 'Diageo', confirm: true, expect: pv2.expect });
    await prisma.contact.create({ data: { id: 'new1', brandId: d2.keeperId, name: 'New Person', title: 'Head of Partnerships' } });
    await data('undoCombineParent', { confirm: true });
    const kept = await prisma.brand.findUnique({ where: { id: d2.keeperId } });
    assert.ok(kept, 'Diageo stays: someone new is on it');
    assert.equal(kept.aka, null);
    assert.equal(await prisma.contact.count({ where: { brandId: d2.keeperId } }), 1);
    assert.equal(await prisma.contact.count({ where: { brandId: 'ketel' } }), 12);
    ok('undo after someone new landed on Diageo: they stay on it, the four brands come back');

    // A Diageo already on the roster is the one kept.
    const pv3 = await data('combineParent', { parent: 'Diageo' });
    assert.equal(pv3.keeper.id, d2.keeperId);
    assert.equal(pv3.keeper.isNew, false);
    const d3 = await data('combineParent', { parent: 'Diageo', confirm: true, expect: pv3.expect });
    assert.equal(d3.keeperId, d2.keeperId);
    assert.equal(await prisma.contact.count({ where: { brandId: d2.keeperId } }), 15, 'Ari merged again');
    ok('a Diageo already on the roster is the brand they go into');

    // The same person twice at one brand, outside any combine: both with
    // an outreach row. The sent one stays; the queued one's note moves onto it.
    await prisma.brand.create({ data: { id: 'solo', name: 'Solo Co', category: 'energy' } });
    await prisma.contact.create({ data: { id: 'dana1', brandId: 'solo', name: 'Dana Cruz', title: 'Brand Manager', linkedinUrl: 'https://www.linkedin.com/in/danacruz/', phone: '555-0100', createdAt: new Date('2026-09-01') } });
    await prisma.contact.create({ data: { id: 'dana2', brandId: 'solo', name: 'Dana Cruz', title: 'Senior Brand Manager', email: 'dana@solo.co', linkedinUrl: 'https://www.linkedin.com/in/danacruz/', createdAt: new Date('2026-10-01') } });
    await prisma.target.create({ data: { id: 't_dana1', brandId: 'solo', contactId: 'dana1', status: 'queued', handNote: 'call Tue' } });
    await prisma.target.create({ data: { id: 't_dana2', brandId: 'solo', contactId: 'dana2', status: 'sent', sentAt: new Date() } });
    await prisma.draft.create({ data: { id: 'dr2', targetId: 't_dana2', variant: 'woman', connectionNote: 'Hi Dana (sent one)', firstMessage: 'Thanks', createdAt: new Date(Date.now() - 3600e3) } });
    await prisma.draft.create({ data: { id: 'dr1', targetId: 't_dana1', variant: 'man', connectionNote: 'Hi Dana', firstMessage: 'Thanks for connecting' } });
    await prisma.targetEvent.create({ data: { id: 'ev2', targetId: 't_dana2', kind: 'sent' } });
    // Two people who share a name, each with their own email: left alone.
    await prisma.contact.create({ data: { id: 'chris1', brandId: 'solo', name: 'Chris Lee', email: 'chris@solo.co' } });
    await prisma.contact.create({ data: { id: 'chris2', brandId: 'solo', name: 'Chris Lee', email: 'clee@solo.co' } });
    // A shared inbox: two people, never merged.
    await prisma.contact.create({ data: { id: 'inbox1', brandId: 'solo', name: 'Jane Doe', email: 'partnerships@solo.co' } });
    await prisma.contact.create({ data: { id: 'inbox2', brandId: 'solo', name: 'John Roe', email: 'partnerships@solo.co' } });

    const page0 = await data('getBrand', { brandId: 'solo' });
    assert.deepEqual(page0.samePeople.map(p => p.name), ['Dana Cruz']);
    const mp = await data('mergePeople', { brandId: 'solo' });
    assert.equal(mp.applied, false);
    assert.equal(mp.people.length, 1);
    assert.deepEqual({ keep: mp.people[0].keepId, drop: mp.people[0].dropIds, takes: mp.people[0].takes }, { keep: 'dana2', drop: ['dana1'], takes: ['phone'] });
    assert.equal(await prisma.contact.count({ where: { brandId: 'solo' } }), 6, 'a preview writes nothing');
    assert.equal((await data('mergePeople', { brandId: 'solo', confirm: true, expect: 'old' })).stale, true);
    const mDone = await data('mergePeople', { brandId: 'solo', confirm: true, expect: mp.expect });
    assert.equal(mDone.merged, 1);
    const dana = await prisma.contact.findUnique({ where: { id: 'dana2' } });
    assert.deepEqual({ phone: dana.phone, email: dana.email, title: dana.title }, { phone: '555-0100', email: 'dana@solo.co', title: 'Senior Brand Manager' });
    assert.match(dana.notes, /also on file as “Brand Manager”/);
    assert.equal(await prisma.contact.count({ where: { id: 'dana1' } }), 0);
    assert.equal(await prisma.target.count({ where: { id: 't_dana1' } }), 0);
    const dr1m = await prisma.draft.findUnique({ where: { id: 'dr1' } });
    assert.equal(dr1m.targetId, 't_dana2', 'the queued row\'s note moves onto the invite');
    assert.ok(dr1m.createdAt < (await prisma.draft.findUnique({ where: { id: 'dr2' } })).createdAt, 'the invite\'s own note stays the newest');
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dana2' } })).handNote, 'call Tue', 'Leo\'s note on the copy that went is kept');
    assert.equal(await prisma.contact.count({ where: { id: { in: ['inbox1', 'inbox2'] } } }), 2, 'a shared inbox is two people');
    assert.equal(await prisma.contact.count({ where: { name: 'Chris Lee' } }), 2);
    const page1 = await data('getBrand', { brandId: 'solo' });
    assert.deepEqual(page1.samePeople, []);
    assert.deepEqual(page1.peopleMergeUndo.people, ['Dana Cruz']);
    await assert.rejects(data('mergePeople', { brandId: 'solo', confirm: true, expect: '' }), /Nobody is on file twice/);
    ok('mergePeople: Dana twice at one brand → one row with the invite, her phone and the queued note; two Chris Lees with their own emails left alone');

    const mu = await data('undoMergePeople', {});
    assert.deepEqual(mu.people, ['Dana Cruz']);
    assert.deepEqual(mu.blocks, []);
    await data('undoMergePeople', { confirm: true });
    const d1 = await prisma.contact.findUnique({ where: { id: 'dana1' } });
    assert.deepEqual({ phone: d1.phone, title: d1.title }, { phone: '555-0100', title: 'Brand Manager' });
    const d2r = await prisma.contact.findUnique({ where: { id: 'dana2' } });
    assert.deepEqual({ phone: d2r.phone, notes: d2r.notes }, { phone: null, notes: null });
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dana1' } })).contactId, 'dana1');
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dana1' } })).status, 'queued');
    assert.equal((await prisma.draft.findUnique({ where: { id: 'dr1' } })).targetId, 't_dana1');
    assert.ok((await prisma.draft.findUnique({ where: { id: 'dr1' } })).createdAt > (await prisma.draft.findUnique({ where: { id: 'dr2' } })).createdAt, 'its date back');
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dana2' } })).handNote, null);
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dana1' } })).handNote, 'call Tue');
    assert.equal((await prisma.targetEvent.findUnique({ where: { id: 'ev2' } })).targetId, 't_dana2');
    await assert.rejects(data('undoMergePeople', {}), /Nothing to undo/);
    ok('undo: both Dana rows back with their own outreach rows and note');

    // The queued copy is the further one when the other was only queued
    // too and has nothing: the row with the outreach wins either way round.
    await prisma.target.update({ where: { id: 't_dana2' }, data: { status: 'queued', sentAt: null } });
    await prisma.target.update({ where: { id: 't_dana1' }, data: { status: 'accepted', sentAt: new Date() } });
    const mp2 = await data('mergePeople', { brandId: 'solo' });
    assert.equal(mp2.people[0].keepId, 'dana1');
    await data('mergePeople', { brandId: 'solo', confirm: true, expect: mp2.expect });
    assert.equal((await prisma.target.findUnique({ where: { contactId: 'dana1' } })).status, 'accepted');
    assert.equal((await prisma.targetEvent.findUnique({ where: { id: 'ev2' } })).targetId, 't_dana1');
    assert.equal((await prisma.contact.findUnique({ where: { id: 'dana1' } })).email, 'dana@solo.co');
    ok('the accepted copy stays when it\'s the further one; the other\'s history moves onto it');

    // Something edited after the merge stays as it is on undo, and says so.
    await prisma.contact.update({ where: { id: 'dana1' }, data: { email: 'dana.new@solo.co' } });
    await assert.rejects(data('undoMergePeople', { brandId: 'ketel' }), /The last merge was at Solo Co, not this brand/);
    const mu2 = await data('undoMergePeople', { brandId: 'solo' });
    assert.deepEqual(mu2.staysAsIs, ['Dana Cruz: email']);
    await data('undoMergePeople', { brandId: 'solo', confirm: true });
    assert.equal((await prisma.contact.findUnique({ where: { id: 'dana1' } })).email, 'dana.new@solo.co', 'the new address stays');
    assert.equal((await prisma.contact.findUnique({ where: { id: 'dana2' } })).email, 'dana@solo.co');
    ok('undo leaves a field edited since the merge as it is (named first), and only undoes its own brand');

    // "Not the same person": remembered, never offered again; can be taken back.
    await prisma.contact.create({ data: { id: 'pat1', brandId: 'solo', name: 'Pat Kim', title: 'CMO' } });
    await prisma.contact.create({ data: { id: 'pat2', brandId: 'solo', name: 'Pat Kim', title: 'Events Lead' } });
    const withPat = (await data('getBrand', { brandId: 'solo' })).samePeople.map(p => p.name);
    assert.ok(withPat.includes('Pat Kim'));
    await data('notSamePerson', { ids: ['pat1', 'pat2'] });
    assert.ok(!(await data('getBrand', { brandId: 'solo' })).samePeople.some(p => p.name === 'Pat Kim'));
    assert.ok(!(await data('mergePeople', { brandId: 'solo' })).people.some(p => p.name === 'Pat Kim'));
    await data('notSamePerson', { ids: ['pat1', 'pat2'], undo: true });
    assert.ok((await data('getBrand', { brandId: 'solo' })).samePeople.some(p => p.name === 'Pat Kim'));
    // Merge only the ticked one
    const mp3 = await data('mergePeople', { brandId: 'solo' });
    const patPlan = mp3.people.find(p => p.name === 'Pat Kim');
    await data('mergePeople', { brandId: 'solo', confirm: true, expect: mp3.expect, only: [patPlan.keepId] });
    assert.equal(await prisma.contact.count({ where: { name: 'Pat Kim' } }), 1);
    assert.equal(await prisma.contact.count({ where: { name: 'Dana Cruz' } }), 2, 'Dana wasn\'t ticked');
    ok('"Not the same person" keeps two rows apart until taken back; Merge takes only the ticked people');

    // The live Diageo case: the combine left Ari twice, he was merged
    // afterwards on the company — the combine's Undo puts both back home.
    await data('undoCombineParent', { confirm: true });
    assert.equal((await prisma.contact.findUnique({ where: { id: 'ari2' } })).brandId, 'bulleit');
    await data('notSamePerson', { ids: ['ari1', 'ari2'] });
    const pv4 = await data('combineParent', { parent: 'Diageo' });
    assert.deepEqual(pv4.samePerson, []);
    const d4 = await data('combineParent', { parent: 'Diageo', confirm: true, expect: pv4.expect });
    assert.equal(await prisma.contact.count({ where: { name: 'Ari Anderman', brandId: d4.keeperId } }), 2);
    await data('notSamePerson', { ids: ['ari1', 'ari2'], undo: true });
    const mp4 = await data('mergePeople', { brandId: d4.keeperId });
    await data('mergePeople', { brandId: d4.keeperId, confirm: true, expect: mp4.expect });
    assert.equal(await prisma.contact.count({ where: { id: 'ari2' } }), 0);
    const up4 = await data('undoCombineParent', {});
    assert.deepEqual(up4.unmerge, ['Ari Anderman']);
    assert.equal(up4.movedSince, 0, 'Ari\'s second copy is counted as coming back');
    await data('undoCombineParent', { confirm: true });
    const a2 = await prisma.contact.findUnique({ where: { id: 'ari2' } });
    assert.deepEqual({ brand: a2.brandId, email: a2.email }, { brand: 'bulleit', email: 'ari.anderman@diageo.com' });
    const a1 = await prisma.contact.findUnique({ where: { id: 'ari1' } });
    assert.deepEqual({ brand: a1.brandId, email: a1.email }, { brand: 'ketel', email: null });
    await assert.rejects(data('undoMergePeople', {}), /Nothing to undo/, 'the later merge was undone with the combine');
    ok('a merge on the company after the combine: the combine\'s Undo puts both copies back at their own brands');

    console.log(n + ' checks passed');
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch (e) {} }
  }
})();
