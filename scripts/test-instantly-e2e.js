// scripts/test-instantly-e2e.js — cold email through Instantly (Leo, Nov 16
// 2026) against the real handlers, the real webhook route, a throwaway
// Postgres (wiped) and a fake Instantly that speaks API v2's paths: who can
// be handed over (a signed-in click only — never Claude's token), exactly
// what Instantly is given, the stale check, what comes back by webhook (sent,
// reply, bounce, unsubscribe — signed with the secret, once each) and by the
// sync, who is taken back out (a stop → deleted there and on its block list;
// someone else at the brand answered; deleted there by hand), an unsubscribe's
// stop and its Undo, the Undo of a send, leads added in Instantly by hand,
// and what a bad key or a lapsed plan reads as.
// Run: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-instantly-e2e.js
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const assert = require('assert/strict');

const DB = process.env.E2E_DATABASE_URL || '';
let host = '';
try { host = new URL(DB).hostname; } catch (e) {}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error('E2E_DATABASE_URL must be a throwaway Postgres on this machine (it gets wiped). ' +
    'In Claude\'s cloud sessions: E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-instantly-e2e.js');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3487);
const FAKE_PORT = PORT + 1;
const BASE = 'http://127.0.0.1:' + PORT;
const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef';
const SECRET = 'e2e-only-secret';
const LEO = 'leo@example.com';
const FAKE_KEY = 'fake-instantly-key-for-tests';

// ---- a fake Instantly ---------------------------------------------------
const F = {
  campaigns: [
    { id: 'camp-cold', name: 'Cold — no answer on LinkedIn', status: 1, daily_limit: 30, stop_on_reply: true, open_tracking: false, link_tracking: false, email_list: ['zach@sboyagency.co'], sequences: [{ steps: [{}, {}, {}] }] },
    { id: 'camp-draft', name: 'Draft one', status: 0, daily_limit: 30, stop_on_reply: true, email_list: [], sequences: [{ steps: [] }] },
  ],
  leads: [], emails: [], hooks: [], block: [], calls: [], fail: 0, n: 0,
};
const fakeLead = (email) => F.leads.find(l => l.email === email);
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) {}
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    F.calls.push({ method: req.method, path: u.pathname, body, query: Object.fromEntries(u.searchParams) });
    if (req.headers.authorization !== 'Bearer ' + FAKE_KEY) return send(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid API key' });
    if (F.fail) return send(F.fail, { statusCode: F.fail, error: 'Nope', message: 'forced by the test' });
    const p = u.pathname, m = req.method;
    const page = (all, idOf) => {
      const limit = Number(u.searchParams.get('limit') || (body && body.limit) || 100);
      const after = u.searchParams.get('starting_after') || (body && body.starting_after) || '';
      const from = after ? all.findIndex(x => idOf(x) === after) + 1 : 0;
      const items = all.slice(from, from + limit);
      return { items, ...(from + limit < all.length ? { next_starting_after: idOf(items[items.length - 1]) } : {}) };
    };
    if (m === 'GET' && p === '/api/v2/campaigns') return send(200, page(F.campaigns, x => x.id));
    if (m === 'POST' && p === '/api/v2/campaigns') {
      if (F.failWrite) return send(F.failWrite, { statusCode: F.failWrite, error: 'Forbidden', message: 'API key is missing scope campaigns:create' });
      const c = Object.assign({ id: 'camp-made-' + (++F.n), status: 0, email_list: [] }, body);
      F.campaigns.push(c);
      return send(200, c);
    }
    if (m === 'PATCH' && p.startsWith('/api/v2/campaigns/')) {
      if (F.failWrite) return send(F.failWrite, { statusCode: F.failWrite, error: 'Forbidden', message: 'API key is missing scope campaigns:update' });
      const c = F.campaigns.find(x => x.id === decodeURIComponent(p.split('/').pop()));
      if (!c) return send(404, { statusCode: 404, error: 'Not Found', message: 'Campaign not found' });
      Object.assign(c, body);
      return send(200, c);
    }
    if (m === 'GET' && p.startsWith('/api/v2/campaigns/')) {
      const c = F.campaigns.find(x => x.id === decodeURIComponent(p.split('/').pop()));
      return c ? send(200, c) : send(404, { statusCode: 404, error: 'Not Found', message: 'Campaign not found' });
    }
    if (m === 'POST' && p === '/api/v2/leads/add') {
      const out = { status: 'success', total_sent: body.leads.length, leads_uploaded: 0, in_blocklist: 0, blocklist_used: null, duplicated_leads: 0, skipped_count: 0, invalid_email_count: 0, incomplete_count: 0, duplicate_email_count: 0, remaining_in_plan: 24000, created_leads: [] };
      body.leads.forEach((l, index) => {
        if (F.block.includes(l.email)) { out.in_blocklist++; return; }
        if (body.skip_if_in_campaign && F.leads.some(x => x.email === l.email && x.campaign)) { out.skipped_count++; return; }
        const lead = { id: 'L' + (++F.n), email: l.email, campaign: body.campaign_id, status: 1, first_name: l.first_name, last_name: l.last_name, company_name: l.company_name, payload: l.custom_variables || {}, email_reply_count: 0, timestamp_last_contact: null };
        F.leads.push(lead);
        out.leads_uploaded++;
        out.created_leads.push({ index, id: lead.id, email: lead.email });
      });
      return send(200, out);
    }
    if (m === 'POST' && p === '/api/v2/leads/list') {
      let all = F.leads.slice();
      if (body.campaign) all = all.filter(l => l.campaign === body.campaign);
      if (body.contacts) all = all.filter(l => body.contacts.includes(l.email));
      return send(200, page(all, x => x.id));
    }
    if (m === 'DELETE' && p === '/api/v2/leads') { F.leads = F.leads.filter(l => !(body.ids || []).includes(l.id)); return send(200, { ok: true }); }
    if (m === 'DELETE' && p.startsWith('/api/v2/leads/')) {
      const id = decodeURIComponent(p.split('/').pop());
      if (!F.leads.some(l => l.id === id)) return send(404, { statusCode: 404, error: 'Not Found', message: 'Lead not found' });
      F.leads = F.leads.filter(l => l.id !== id);
      return send(200, { id });
    }
    if (m === 'POST' && p === '/api/v2/block-lists-entries/bulk-create') { F.block.push(...body.bl_values); return send(200, { items: body.bl_values }); }
    if (m === 'GET' && p === '/api/v2/emails') {
      const type = u.searchParams.get('email_type'), since = u.searchParams.get('min_timestamp_created');
      const all = F.emails.filter(e => e.campaign_id === u.searchParams.get('campaign_id') && (type === 'sent' ? e.ue_type === 1 : e.ue_type === 2) && (!since || e.timestamp_created >= since));
      return send(200, page(all, x => x.id));
    }
    if (m === 'GET' && p === '/api/v2/webhooks') return send(200, { items: F.hooks });
    if (m === 'POST' && p === '/api/v2/webhooks') {
      const h = { id: 'W' + (++F.n), organization: 'org', timestamp_created: new Date().toISOString(), status: 1, ...body };
      F.hooks.push(h);
      return send(200, h);
    }
    if (m === 'DELETE' && p.startsWith('/api/v2/webhooks/')) { F.hooks = F.hooks.filter(h => h.id !== decodeURIComponent(p.split('/').pop())); return send(200, {}); }
    send(404, { statusCode: 404, error: 'Not Found', message: 'no such path in the fake: ' + m + ' ' + p });
  });
});

// who: { cookie } a signed-in person · nothing = Claude's token.
const call = async (who, fn, args) => {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, who && who.cookie ? { Cookie: 'next-auth.session-token=' + who.cookie } : { Authorization: 'Bearer ' + DASHBOARD_TOKEN }),
    body: JSON.stringify({ fn, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  return { status: r.status, ok: !!j.ok, data: j.data, error: j.error };
};
const data = async (who, fn, args) => {
  const r = await call(who, fn, args);
  if (!r.ok) throw new Error(fn + ': ' + (r.error || r.status));
  return r.data;
};
const hook = async (body, secret) => {
  const r = await fetch(BASE + '/api/instantly/webhook', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, secret ? { 'x-sb-hook': secret } : {}), body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
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
    await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
    const { encode } = require('next-auth/jwt');
    const leo = { cookie: await encode({ token: { email: LEO, name: 'Leo Z' }, secret: SECRET }) };

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DASHBOARD_TOKEN, NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: BASE, ALLOWED_EMAILS: LEO, SITE_URL: BASE, NEXT_TELEMETRY_DISABLED: '1',
        INSTANTLY_API_KEY: FAKE_KEY, INSTANTLY_API_URL: 'http://127.0.0.1:' + FAKE_PORT,
        // A mailbox "configured", so the dashboard's own drafting runs (nothing can send: no-send.ts).
        EMAIL_USER: 'drafts@example.com', EMAIL_APP_PASSWORD: 'not-a-real-password' },
    });
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    const t0 = Date.now();
    for (;;) {
      try { await data(null, 'categoryReach'); break; } catch (e) {}
      if (Date.now() - t0 > 240000) throw new Error('next dev never answered:\n' + log.slice(-3000));
      await new Promise(r => setTimeout(r, 1500));
    }
    ok('the dashboard runs locally (' + Math.round((Date.now() - t0) / 1000) + ' s to first answer)');

    const D = (days) => new Date(Date.now() - days * 864e5);
    const VER = 'Email added from Hunter’s file, Nov 16, 2026 (verified)';
    // (Notes on every brand: the dashboard's own drafting passes over a brand whose notes are empty.)
    const brand = (id, name, extra) => prisma.brand.create({ data: Object.assign({ id, name, category: 'energy', website: 'https://www.' + id.slice(2) + '.com', notes: 'Seeded for the test' }, extra || {}) });
    const mk = async (id, brandId, name, email, notes, t) => {
      const c = await prisma.contact.create({ data: { id, brandId, name, title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/' + id, email, notes: notes || null } });
      const row = await prisma.target.create({ data: Object.assign({ id: 't_' + id.slice(2), brandId, contactId: c.id, status: 'sent', sentAt: D(30) }, t || {}) });
      return { c, row };
    };
    await brand('b_cold', 'Cold Co');
    await mk('c_ann', 'b_cold', 'Dr. Ann Lee, MBA', 'Ann@Cold.com', VER);
    await mk('c_bo', 'b_cold', 'Bo Chen', 'bo@cold.com', 'Email added from Hunter’s file, Nov 16, 2026 (not verified)');
    await mk('c_inf', 'b_cold', 'Ivy Inbox', 'partnerships@cold.com', null);
    await mk('c_cy', 'b_cold', 'Cy Day', 'cy@cold.com', 'From SponsorUnited');
    await mk('c_non', 'b_cold', 'Nora None', null, null);                       // no address: Hunter's list, never this one
    await brand('b_two', 'Second Co');
    await mk('c_dee', 'b_two', 'Dee Two', 'dee@two.com', VER);
    await brand('b_fay', 'Fay Co');
    await mk('c_fay', 'b_fay', 'Fay Stop', 'fay@fayco.com', VER);
    await brand('b_gh', 'Gus and Hal');
    await mk('c_gus', 'b_gh', 'Gus Sent', 'gus@gh.com', VER);
    await mk('c_hal', 'b_gh', 'Hal Wait', 'hal@gh.com', VER);
    await brand('b_ivy', 'Ivy Co');
    await mk('c_ivy', 'b_ivy', 'Ivy Hand', 'ivy@ivyco.com', VER);
    await brand('b_del', 'Del Co');
    await mk('c_del', 'b_del', 'Del Gone', 'del@delco.com', VER);
    await brand('b_jo', 'Jo Co');
    await mk('c_jo', 'b_jo', 'Jo Deleted', 'jo@joco.com', VER);
    await brand('b_blk', 'Block Co');
    await mk('c_k1', 'b_blk', 'Kit Fine', 'kit@block.com', VER);
    await mk('c_k2', 'b_blk', 'Kat Blocked', 'kat@block.com', VER);
    await mk('c_k3', 'b_blk', 'Kim Already', 'kim@block.com', VER);
    // A brand where someone accepted and is still being worked: not on the list at all.
    await brand('b_acc', 'Accepted Co');
    const acc = await mk('c_acc', 'b_acc', 'Al Accepted', 'al@accepted.com', VER, { status: 'accepted' });
    await prisma.targetEvent.create({ data: { targetId: acc.row.id, kind: 'status', fromStatus: 'sent', toStatus: 'accepted', createdAt: D(1) } });
    // A brand nobody has reached out to: its person has an address and no outreach row at all.
    await brand('b_nova', 'Nova Pouch', { category: 'nicotine' });
    await prisma.contact.create({ data: { id: 'c_nia', brandId: 'b_nova', name: 'Nia New', title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/c_nia', email: 'nia@nova.com', notes: VER } });
    // A brand not reached yet that the queue holds back (a giant): on Hunter's list since "every brand on the file", and here like any brand not reached yet.
    await brand('b_redbull', 'Red Bull');
    await prisma.contact.create({ data: { id: 'c_gil', brandId: 'b_redbull', name: 'Gil Giant', title: 'Head of Partnerships', linkedinUrl: 'https://www.linkedin.com/in/c_gil', email: 'gil@redbull.com', notes: VER } });
    // Dee's other copy at another brand (the same address): a stop marks it too. (Archived, so it isn't a brand to email.)
    await brand('b_twin', 'Twin Co', { passedAt: D(2) });
    await mk('c_dee2', 'b_twin', 'Dee Two', 'dee@two.com', null, { status: 'queued', sentAt: null });

    // 1. The card before anything: connected, campaigns listed, nothing handed.
    let st = await data(leo, 'instantlyStatus', { live: true });
    assert.equal(st.connected, true);
    assert.equal(st.error, null);
    assert.deepEqual(st.campaigns.map(c => [c.id, c.statusWord, c.sends]), [['camp-cold', 'Active', true], ['camp-draft', 'Draft', false]]);
    // A row per campaign key Leo picked, none with a campaign yet; each one's first email is a template on Email → Templates.
    assert.deepEqual(st.templates.groups.map(g => [g.key, g.state, g.linked, g.own, g.first, g.hasBoard, g.main]),
      ['energy', 'alcohol', 'nicotine', 'beauty', 'cpg', 'general'].map(k => [k, 'none', null, false, k === 'general' ? 'intro' : 'cat:' + k, true, true]));
    assert.deepEqual(st.templates.groups.find(g => g.key === 'alcohol').also, ['rtd', 'spirits']);
    assert.deepEqual(st.templates.groups.find(g => g.key === 'cpg').also, ['beverage', 'electrolytes', 'qsr']);
    const goesWith = Object.fromEntries(st.templates.others.map(o => [o.key, o.goesWith]));
    assert.deepEqual([goesWith.rtd, goesWith.qsr, goesWith.tech, goesWith.fintech, goesWith.energy], ['alcohol', 'cpg', 'general', 'general', undefined]);
    assert.equal(st.templates.signature, '', 'no footer until Leo writes one');
    assert.equal(st.counts.total, 0);
    assert.equal(st.hook.on, false);
    assert.ok(st.campaigns[1].warn.length >= 2, 'the draft with no inbox and no email is flagged');
    assert.ok(!JSON.stringify(st).includes(FAKE_KEY), 'the key never comes back');
    ok('the page reads Instantly: connected, its campaigns, a row per campaign key with no campaign yet, nothing handed over');

    // 2. Who could go — a preview, nothing written, nothing sent to Instantly.
    const before = F.calls.filter(c => c.path === '/api/v2/leads/add').length;
    let pv = await data(leo, 'sendToInstantly', {});
    assert.equal(pv.preview, true);
    const line = (name) => pv.lines.find(l => l.name === name);
    assert.deepEqual(pv.lines.map(l => l.name).sort(),
      ['Bo Chen', 'Cy Day', 'Dee Two', 'Del Gone', 'Dr. Ann Lee, MBA', 'Fay Stop', 'Gus Sent', 'Hal Wait', 'Ivy Hand', 'Ivy Inbox', 'Jo Deleted', 'Kit Fine', 'Kat Blocked', 'Kim Already', 'Nia New', 'Gil Giant'].sort());
    // Each goes with their brand's template — and no template has a campaign yet, so nobody can go.
    assert.deepEqual([line('Dr. Ann Lee, MBA').tpl, line('Dr. Ann Lee, MBA').tplLabel, line('Nia New').tpl], ['energy', 'Energy drinks', 'nicotine']);
    assert.ok(pv.lines.every(l => l.action === 'nocamp' && !l.tick));
    assert.match(line('Nia New').why, /No Instantly campaign for Nicotine yet/);
    assert.deepEqual(pv.campaigns.map(c => [c.group, c.id, c.canGo, c.people > 0]), [['energy', null, 0, true], ['nicotine', null, 0, true]]);
    // Al's brand is on Hunter's list now (its own group) — but someone there accepted on LinkedIn, so he is never handed to a campaign.
    const hunter = await data(leo, 'noAnswerList', { minDays: 0 });
    assert.deepEqual(hunter.ready.filter(p => p.contactId === 'c_acc').map(p => p.group), ['working']);
    assert.ok(!line('Nora None') && !line('Al Accepted'), 'nobody without an address, nobody at a brand being worked on LinkedIn');
    assert.equal(line('Dr. Ann Lee, MBA').email, 'ann@cold.com');
    assert.equal(F.calls.filter(c => c.path === '/api/v2/leads/add').length, before);
    assert.equal(await prisma.instantlyLead.count(), 0);
    ok('the preview names everyone with an address who was never emailed, each with the campaign their category goes to — and with no campaign yet, nobody can go');

    // 3. No campaign, no send; Claude's token can give a template its campaign but never send.
    const T = (name) => line(name).contactId;
    let r = await call(leo, 'sendToInstantly', { ids: [T('Dr. Ann Lee, MBA')], confirm: true, expect: pv.expect });
    assert.equal(r.ok, false); assert.match(r.error, /Nobody is ticked to send/);
    r = await call(leo, 'setInstantlyCampaign', { campaignId: 'nope', group: 'energy' });
    assert.equal(r.ok, false);
    r = await call(leo, 'setInstantlyCampaign', { campaignId: 'camp-cold', group: 'not-a-template' });
    assert.equal(r.ok, false);
    // A campaign Leo made in Instantly himself, given to the Energy template.
    const set = await data(null, 'setInstantlyCampaign', { campaignId: 'camp-cold', group: 'energy' });
    assert.deepEqual([set.group, set.label, set.campaign.name], ['energy', 'Energy drinks', 'Cold — no answer on LinkedIn']);
    r = await call(leo, 'setInstantlyCampaign', { campaignId: 'camp-cold', group: 'beauty' });
    assert.equal(r.ok, false); assert.match(r.error, /already the one for Energy drinks/);
    pv = await data(leo, 'sendToInstantly', {});
    // Now the Energy people can go. Not reached on LinkedIn yet (or held back by the queue): unticked.
    assert.deepEqual([line('Dr. Ann Lee, MBA').action, line('Dr. Ann Lee, MBA').tick, line('Dr. Ann Lee, MBA').campaignId], ['send', true, 'camp-cold']);
    assert.equal(line('Bo Chen').tick, false);
    assert.equal(line('Ivy Inbox').tick, false);
    assert.equal(line('Cy Day').tick, true);
    assert.deepEqual([line('Gil Giant').action, line('Gil Giant').tick, line('Gil Giant').group], ['send', false, 'fresh']);
    assert.match(line('Gil Giant').why, /brand not reached on LinkedIn yet/);
    assert.deepEqual([line('Nia New').action, line('Nia New').group, line('Nia New').targetId], ['nocamp', 'fresh', null]);
    assert.equal(pv.counts.fresh, 1);
    r = await call(null, 'sendToInstantly', { ids: [T('Dr. Ann Lee, MBA')], confirm: true, expect: pv.expect });
    assert.equal(r.ok, false); assert.match(r.error, /Only someone signed in/);
    r = await call(null, 'undoSendToInstantly', { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(F.calls.filter(c => c.path === '/api/v2/leads/add').length, 0);
    ok('people need a campaign to go to (checked with Instantly, one campaign key each); Claude’s token can preview and link, never send');

    // 4. A stale preview sends nobody.
    pv = await data(leo, 'sendToInstantly', {});
    assert.deepEqual(pv.campaigns.find(c => c.group === 'energy'), { group: 'energy', label: 'Energy drinks', people: pv.campaigns.find(c => c.group === 'energy').people,
      canGo: pv.campaigns.find(c => c.group === 'energy').canGo, id: 'camp-cold', name: 'Cold — no answer on LinkedIn', statusWord: 'Active', sends: true });
    const stale = await data(leo, 'sendToInstantly', { ids: [T('Dr. Ann Lee, MBA')], confirm: true, expect: '0.x' });
    assert.equal(stale.stale, true); assert.equal(stale.applied, false);
    assert.equal(F.leads.length, 0);
    ok('a send whose preview is out of date changes nothing and shows the list again');

    // 5. Send three. Instantly gets exactly the lead fields — nothing else about them.
    const ids = ['Dr. Ann Lee, MBA', 'Cy Day', 'Dee Two'].map(T);
    const sent = await data(leo, 'sendToInstantly', { ids, confirm: true, expect: pv.expect });
    assert.equal(sent.applied, true); assert.equal(sent.sent, 3); assert.equal(sent.brands, 2); assert.equal(sent.sends, true); assert.equal(sent.remaining, 24000);
    const add = F.calls.filter(c => c.path === '/api/v2/leads/add').pop().body;
    assert.equal(add.campaign_id, 'camp-cold');
    assert.equal(add.skip_if_in_campaign, true);
    assert.ok(add.idempotency_key && add.idempotency_key.length <= 128);
    const annLead = add.leads.find(l => l.email === 'ann@cold.com');
    const coldCode = (await prisma.brand.findUnique({ where: { id: 'b_cold' } })).boardCode;
    assert.match(coldCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'the brand got its Show Board code at the send');
    assert.match(annLead.custom_variables.board_link, new RegExp('/partnerships\\?code=' + coldCode + '&p=[A-Z2-9]{6}$'));
    assert.deepEqual({ ...annLead, custom_variables: { sb_id: annLead.custom_variables.sb_id } },
      { email: 'ann@cold.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Cold Co', job_title: 'Head of Partnerships', website: 'cold.com', custom_variables: { sb_id: 'c_ann' } });
    for (const l of add.leads) {
      assert.deepEqual(Object.keys(l).sort(), ['company_name', 'custom_variables', 'email', 'first_name', 'job_title', 'last_name', 'website'].sort());
      assert.deepEqual(Object.keys(l.custom_variables).sort(), ['board_link', 'sb_id']);
    }
    // Two people at one brand share its code and differ by their own key.
    const cyLead = add.leads.find(l => l.email === 'cy@cold.com');
    assert.equal(cyLead.custom_variables.board_link.split('&p=')[0], annLead.custom_variables.board_link.split('&p=')[0]);
    assert.notEqual(cyLead.custom_variables.board_link, annLead.custom_variables.board_link);
    const rows = await prisma.instantlyLead.findMany({ orderBy: { email: 'asc' } });
    assert.deepEqual(rows.map(x => [x.email, x.state, x.campaignId, !!x.leadId, x.pushedBy, !!x.batch]),
      [['ann@cold.com', 'waiting', 'camp-cold', true, 'Leo', true], ['cy@cold.com', 'waiting', 'camp-cold', true, 'Leo', true], ['dee@two.com', 'waiting', 'camp-cold', true, 'Leo', true]]);
    assert.equal(await prisma.emailMessage.count(), 0, 'the dashboard itself sent nothing');
    ok('Send hands the ticked people to the campaign their category goes to: name, title, company, website, email, their own Show Board link and our id — and the dashboard sends nothing');

    // 6. They leave "ready"; the card counts them.
    const na = await data(leo, 'noAnswerList', {});
    assert.ok(!na.ready.some(x => ['c_ann', 'c_cy', 'c_dee'].includes(x.contactId)));
    assert.equal(na.counts.handed, 3);
    assert.equal(na.counts.have, na.ready.length);
    st = await data(leo, 'instantlyStatus', {});
    assert.equal(st.counts.waiting, 3); assert.equal(st.counts.emailed, 0);
    assert.equal(st.last.count, 3); assert.equal(st.last.waiting, 3); assert.equal(st.last.by, 'Leo');
    pv = await data(leo, 'sendToInstantly', {});
    assert.ok(!pv.lines.some(l => ['Dr. Ann Lee, MBA', 'Cy Day', 'Dee Two'].includes(l.name)), 'never offered twice');
    ok('people handed over leave the ready list and show on the card as waiting');

    // 6b. The dashboard's own email machine leaves them — and their brands — alone.
    const drafted = await data(leo, 'draftEmails', { limit: 6 });
    assert.ok(drafted.drafted >= 1, 'the machine ran and drafted for brands not in Instantly: ' + JSON.stringify(drafted));
    const drafts = await prisma.emailMessage.findMany({ where: { status: 'draft' }, select: { target: { select: { id: true, brandId: true } } } });
    assert.ok(drafts.length >= 1);
    assert.ok(!drafts.some(d => ['b_cold', 'b_two'].includes(d.target.brandId)), 'never a brand with anyone handed to Instantly');
    await prisma.emailMessage.deleteMany({ where: { status: 'draft' } });
    ok('the dashboard’s own drafting never writes to a brand that has anyone in Instantly');

    // 7. The webhook: nothing without the secret, nothing before live updates are on.
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'ann@cold.com' }, 'guess')).status, 401);
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'ann@cold.com' })).status, 401);
    const on = await data(leo, 'setInstantlyHook', { on: true });
    assert.equal(on.on, true);
    assert.equal(F.hooks.length, 1);
    assert.equal(F.hooks[0].target_hook_url, BASE + '/api/instantly/webhook');
    assert.equal(F.hooks[0].event_type, 'all_events');
    const HOOK = F.hooks[0].headers['x-sb-hook'];
    assert.match(HOOK, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(on).includes(HOOK), 'the secret is never sent to the page');
    st = await data(leo, 'instantlyStatus', { live: true });
    assert.deepEqual([st.hook.on, st.hook.working], [true, true]);
    assert.ok(!JSON.stringify(st).includes(HOOK));
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'ann@cold.com' }, 'guess')).status, 401);
    assert.equal(await prisma.emailMessage.count(), 0);
    // Turning it on again replaces ours, never stacks a second.
    await data(leo, 'setInstantlyHook', { on: true });
    assert.equal(F.hooks.length, 1);
    const HOOK2 = F.hooks[0].headers['x-sb-hook'];
    assert.notEqual(HOOK2, HOOK);
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'ann@cold.com' }, HOOK)).status, 401, 'the old secret no longer opens it');
    ok('live updates: one webhook in Instantly with a secret the dashboard made; a delivery without it changes nothing');

    // 8. An email sent — once, however many times Instantly says so.
    const sentAt = new Date(Date.now() - 3600e3).toISOString();
    const ev = { timestamp: sentAt, event_type: 'email_sent', workspace: 'w', campaign_id: 'camp-cold', campaign_name: 'Cold', lead_email: 'ann@cold.com', email_account: 'zach@sboyagency.co', step: 1, variant: 1, email_id: 'em-1', email_subject: 'Cold Co x SB', email_text: 'Hi Ann' };
    let h = await hook(ev, HOOK2);
    assert.deepEqual([h.status, h.json.applied], [200, 'sent']);
    h = await hook(ev, HOOK2);
    assert.deepEqual([h.status, h.json.applied], [200, null]);
    let mails = await prisma.emailMessage.findMany({ where: { targetId: 't_ann' } });
    assert.equal(mails.length, 1);
    assert.deepEqual([mails[0].direction, mails[0].kind, mails[0].status, mails[0].via, mails[0].externalId, mails[0].toEmail, mails[0].fromEmail, mails[0].subject, mails[0].sentAt.toISOString()],
      ['out', 'intro', 'sent', 'instantly', 'em-1', 'ann@cold.com', 'zach@sboyagency.co', 'Cold Co x SB', sentAt]);
    let ann = await prisma.instantlyLead.findUnique({ where: { targetId: 't_ann' } });
    assert.deepEqual([ann.state, ann.steps, ann.sentAt.toISOString()], ['sent', 1, sentAt]);
    // The second email in the sequence is a follow-up.
    await hook({ ...ev, timestamp: new Date(Date.now() - 1800e3).toISOString(), step: 2, email_id: 'em-2', email_subject: 'Re: Cold Co x SB' }, HOOK2);
    mails = await prisma.emailMessage.findMany({ where: { targetId: 't_ann' }, orderBy: { sentAt: 'asc' } });
    assert.deepEqual(mails.map(m => m.kind), ['intro', 'followup']);
    ann = await prisma.instantlyLead.findUnique({ where: { targetId: 't_ann' } });
    assert.equal(ann.steps, 2);
    // The rest of the site sees an email went out: the tracker dates it, the Reached tag counts it.
    const tr = await data(leo, 'outreachTracker', {});
    const annRow = tr.brands.find(b => b.id === 'b_cold').people.find(p => p.contactId === 'c_ann');
    assert.equal(annRow.emailedAt, sentAt);
    assert.equal((await data(leo, 'noAnswerList', {})).counts.emailed >= 1, true);
    ok('“email sent” lands once on the person’s row (intro, then follow-up), dated as Instantly sent it — and the tracker sees it');

    // 9. Events about nobody we know, opens and clicks: accepted, nothing written.
    const mailsBefore = await prisma.emailMessage.count();
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'stranger@nowhere.com', campaign_id: 'camp-cold' }, HOOK2)).json.applied, null);
    assert.equal((await hook({ event_type: 'email_opened', lead_email: 'ann@cold.com' }, HOOK2)).json.applied, null);
    assert.equal((await hook({ event_type: 'auto_reply_received', lead_email: 'ann@cold.com', reply_text: 'Out of office' }, HOOK2)).json.applied, null);
    assert.equal((await hook({ event_type: 'campaign_completed', campaign_id: 'camp-cold' }, HOOK2)).status, 200);
    assert.equal((await hook('not json at all', HOOK2)).status, 200);
    assert.equal(await prisma.emailMessage.count(), mailsBefore);
    assert.equal((await prisma.target.findUnique({ where: { id: 't_ann' } })).status, 'sent', 'an out-of-office is not a reply');
    ok('a stranger, an open, an out-of-office, a campaign event: answered 200, nothing changes');

    // 10. A reply: on the person's row, the brand answers — and Cy, still being emailed there, comes out.
    const repAt = new Date(Date.now() - 600e3).toISOString();
    h = await hook({ timestamp: repAt, event_type: 'reply_received', campaign_id: 'camp-cold', lead_email: 'ann@cold.com', email_id: 'em-r1', reply_subject: 'Re: Cold Co x SB', reply_text: 'Sure — send me the deck.', reply_text_snippet: 'Sure' }, HOOK2);
    assert.equal(h.json.applied, 'reply');
    assert.equal((await hook({ timestamp: repAt, event_type: 'reply_received', campaign_id: 'camp-cold', lead_email: 'ann@cold.com', email_id: 'em-r1', reply_subject: 'Re: Cold Co x SB', reply_text: 'Sure — send me the deck.' }, HOOK2)).json.applied, null);
    const annT = await prisma.target.findUnique({ where: { id: 't_ann' } });
    assert.equal(annT.status, 'replied');
    assert.equal(annT.repliedAt.toISOString(), repAt);
    const inbound = await prisma.emailMessage.findMany({ where: { targetId: 't_ann', direction: 'in' } });
    assert.equal(inbound.length, 1);
    assert.deepEqual([inbound[0].via, inbound[0].body, inbound[0].fromEmail, inbound[0].status], ['instantly', 'Sure — send me the deck.', 'ann@cold.com', 'received']);
    assert.equal((await prisma.instantlyLead.findUnique({ where: { targetId: 't_ann' } })).state, 'replied');
    const talks = await data(leo, 'listInTalks', {});
    assert.ok(talks.brands.some(b => b.id === 'b_cold'), 'a reply puts the brand in talks');
    assert.ok(fakeLead('cy@cold.com'), 'Cy is still in Instantly until the sync');
    let sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.ok, true);
    assert.equal(sync.pulledBack, 1);
    assert.equal(fakeLead('cy@cold.com'), undefined, 'deleted from the campaign');
    assert.ok(!F.block.includes('cy@cold.com'), 'not blocked — nobody asked to stop');
    const cy = await prisma.instantlyLead.findUnique({ where: { targetId: 't_cy' } });
    assert.deepEqual([cy.state, cy.note], ['removed', 'Someone else at the brand answered']);
    assert.ok(fakeLead('ann@cold.com'), 'the one who replied stays there, for the conversation');
    ok('a reply marks the person replied (what they wrote is kept), the brand goes in talks, and a colleague still being emailed is taken out');

    // 11. Unsubscribed = doesn't want to continue, the moment it arrives; the sync finishes it (their other copy).
    h = await hook({ timestamp: new Date().toISOString(), event_type: 'lead_unsubscribed', campaign_id: 'camp-cold', lead_email: 'dee@two.com' }, HOOK2);
    assert.equal(h.json.applied, 'unsub');
    let dee = await prisma.contact.findUnique({ where: { id: 'c_dee' } });
    let deeT = await prisma.target.findUnique({ where: { id: 't_dee' } });
    assert.ok(dee.doNotContactAt && deeT.handDeclinedAt);
    assert.equal(dee.doNotContactAt.getTime(), deeT.handDeclinedAt.getTime(), 'one time on both — the Undo clears by it');
    assert.equal(dee.doNotContactBy, 'Instantly');
    assert.equal(deeT.handDeclinedScope, 'person');
    assert.equal(deeT.status, 'sent', 'they were reached: the status stays');
    assert.equal((await prisma.instantlyLead.findUnique({ where: { targetId: 't_dee' } })).state, 'unsubscribed');
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_dee2' } })).doNotContactAt, null, 'the copy waits for the sync');
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.twins, 1);
    const twin = await prisma.contact.findUnique({ where: { id: 'c_dee2' } });
    assert.equal(twin.doNotContactAt.getTime(), dee.doNotContactAt.getTime());
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dee2' } })).shelved, true, 'their waiting row is set aside');
    // Nobody can put them back in a queue.
    r = await call(leo, 'queueContact', { contactId: 'c_dee' });
    assert.equal(r.ok, false);
    // The stop's own Undo takes all of it back.
    const undone = await data(leo, 'undoStopContact', { targetId: 't_dee' });
    assert.equal(undone.ok, true);
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_dee' } })).doNotContactAt, null);
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_dee2' } })).doNotContactAt, null);
    assert.equal((await prisma.target.findUnique({ where: { id: 't_dee' } })).handDeclinedAt, null);
    ok('an unsubscribe marks them “doesn’t want to continue” at once; the sync marks their other copy; the stop’s Undo clears both');

    // 12. A stop made on the dashboard reaches Instantly right away: deleted there, and on its block list.
    pv = await data(leo, 'sendToInstantly', {});
    const pick = (names) => names.map(x => pv.lines.find(l => l.name === x).contactId);
    await data(leo, 'sendToInstantly', { ids: pick(['Fay Stop']), confirm: true, expect: pv.expect });
    assert.ok(fakeLead('fay@fayco.com'));
    const stopped = await data(leo, 'handStep', { targetId: 't_fay', step: 'declined', on: true, scope: 'person' });
    assert.equal(stopped.ok, true);
    assert.equal(fakeLead('fay@fayco.com'), undefined);
    assert.ok(F.block.includes('fay@fayco.com'));
    const fay = await prisma.instantlyLead.findUnique({ where: { targetId: 't_fay' } });
    assert.deepEqual([fay.state, fay.note], ['removed', 'They said they don’t want to continue']);
    // And Instantly would refuse her if anyone tried again; the dashboard doesn't even offer her.
    pv = await data(leo, 'sendToInstantly', {});
    assert.ok(!pv.lines.some(l => l.name === 'Fay Stop'));
    ok('“doesn’t want to continue” on the dashboard takes them out of Instantly at once and puts the address on its block list');

    // 13. A bounce: the row says so, and the person's notes.
    await data(leo, 'sendToInstantly', { ids: pick(['Del Gone']), confirm: true, expect: pv.expect });
    h = await hook({ timestamp: new Date().toISOString(), event_type: 'email_bounced', campaign_id: 'camp-cold', lead_email: 'del@delco.com' }, HOOK2);
    assert.equal(h.json.applied, 'bounce');
    assert.equal((await prisma.instantlyLead.findUnique({ where: { targetId: 't_del' } })).state, 'bounced');
    const del = await prisma.contact.findUnique({ where: { id: 'c_del' } });
    assert.match(del.notes, /Email to del@delco\.com bounced \(Instantly, /);
    assert.equal(del.email, 'del@delco.com', 'the address is left for Leo to fix — never wiped');
    await hook({ timestamp: new Date().toISOString(), event_type: 'email_bounced', campaign_id: 'camp-cold', lead_email: 'del@delco.com' }, HOOK2);
    assert.equal((await prisma.contact.findUnique({ where: { id: 'c_del' } })).notes.match(/bounced/g).length, 1);
    ok('a bounce is noted on the row and in the person’s notes, once; the address stays for Leo to fix');

    // 14. The Undo of a send: whoever Instantly hasn't emailed comes back out; one emailed stays.
    pv = await data(leo, 'sendToInstantly', {});
    const two = await data(leo, 'sendToInstantly', { ids: pick(['Gus Sent', 'Hal Wait']), confirm: true, expect: pv.expect });
    assert.equal(two.sent, 2);
    // Instantly emailed Gus and the webhook missed it: the Undo's preview reads Instantly first.
    F.emails.push({ id: 'em-g1', campaign_id: 'camp-cold', ue_type: 1, lead: 'gus@gh.com', eaccount: 'zach@sboyagency.co', subject: 'Gus and Hal x SB', step: '0_0_0', body: { text: 'Hi Gus' }, timestamp_email: new Date(Date.now() - 120e3).toISOString(), timestamp_created: new Date(Date.now() - 120e3).toISOString() });
    fakeLead('gus@gh.com').timestamp_last_contact = new Date(Date.now() - 120e3).toISOString();
    const up = await data(leo, 'undoSendToInstantly', {});
    assert.equal(up.preview, true);
    assert.deepEqual(up.goes.map(g => g.name), ['Hal Wait']);
    assert.deepEqual(up.stays.map(g => [g.name, g.why]), [['Gus Sent', 'already emailed']]);
    assert.ok(fakeLead('hal@gh.com'), 'a preview takes nobody out');
    const ud = await data(leo, 'undoSendToInstantly', { confirm: true });
    assert.equal(ud.removed, 1);
    assert.equal(fakeLead('hal@gh.com'), undefined);
    assert.ok(fakeLead('gus@gh.com'));
    assert.equal(await prisma.instantlyLead.findUnique({ where: { targetId: 't_hal' } }), null);
    assert.ok((await data(leo, 'noAnswerList', {})).ready.some(x => x.contactId === 'c_hal'), 'Hal is ready to send again');
    const gusMail = await prisma.emailMessage.findMany({ where: { targetId: 't_gus' } });
    assert.deepEqual(gusMail.map(m => [m.kind, m.via, m.externalId, m.subject]), [['intro', 'instantly', 'em-g1', 'Gus and Hal x SB']]);
    r = await call(leo, 'undoSendToInstantly', {});
    assert.equal(r.ok, false); assert.match(r.error, /Nothing to undo/);
    ok('Undo of a send reads Instantly first, names who comes back and who stays (already emailed), and takes out only the first');

    // 15. The sync alone (no webhook): a reply and an unsubscribe it finds in Instantly.
    F.emails.push({ id: 'em-g2', campaign_id: 'camp-cold', ue_type: 2, lead: 'gus@gh.com', subject: 'Re: Gus and Hal x SB', is_auto_reply: 1, body: { text: 'I am out of office' }, timestamp_email: new Date(Date.now() - 60e3).toISOString(), timestamp_created: new Date(Date.now() - 60e3).toISOString() });
    sync = await data(leo, 'instantlySync', {});
    assert.equal((await prisma.target.findUnique({ where: { id: 't_gus' } })).status, 'sent', 'an auto-reply is not a reply');
    F.emails.push({ id: 'em-g3', campaign_id: 'camp-cold', ue_type: 2, lead: 'gus@gh.com', subject: 'Re: Gus and Hal x SB — yes', is_auto_reply: 0, body: { text: 'Back now — yes, let’s talk.' }, timestamp_email: new Date(Date.now() - 30e3).toISOString(), timestamp_created: new Date(Date.now() - 30e3).toISOString() });
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.replies, 1);
    assert.equal((await prisma.target.findUnique({ where: { id: 't_gus' } })).status, 'replied');
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.replies, 0, 'read again, counted once');
    assert.equal(await prisma.emailMessage.count({ where: { targetId: 't_gus', direction: 'in' } }), 1);
    ok('with no webhook the sync reads the same things from Instantly: an email sent, a real reply (never an auto-reply), each once');

    // 16. A lead Leo added in Instantly by hand: taken on as it stands — and only ever taken out for a stop.
    F.leads.push({ id: 'L-hand', email: 'ivy@ivyco.com', campaign: 'camp-cold', status: 1, payload: {}, email_reply_count: 0, timestamp_last_contact: null });
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.adopted, 1);
    let ivy = await prisma.instantlyLead.findUnique({ where: { targetId: 't_ivy' } });
    assert.deepEqual([ivy.state, ivy.batch, ivy.leadId, ivy.note], ['waiting', null, 'L-hand', 'Added in Instantly, not from the dashboard']);
    await prisma.brand.update({ where: { id: 'b_ivy' }, data: { passedAt: new Date() } });       // archived on the dashboard
    sync = await data(leo, 'instantlySync', {});
    assert.ok(fakeLead('ivy@ivyco.com'), 'not ours to take out for that');
    await prisma.brand.update({ where: { id: 'b_ivy' }, data: { passedAt: null } });
    await data(leo, 'handStep', { targetId: 't_ivy', step: 'declined', on: true, scope: 'person' });
    assert.equal(fakeLead('ivy@ivyco.com'), undefined, 'a stop always is');
    assert.ok(F.block.includes('ivy@ivyco.com'));
    ok('a lead added in Instantly by hand is taken on by the sync, left alone for soft reasons, and taken out for a stop');

    // 17. Deleted in Instantly by hand: the row says so (not while it's minutes old).
    pv = await data(leo, 'sendToInstantly', {});
    assert.ok(!pv.lines.some(l => l.name === 'Hal Wait'), 'Gus replied: nobody else at his brand is offered any more');
    await data(leo, 'sendToInstantly', { ids: pick(['Jo Deleted']), confirm: true, expect: pv.expect });
    F.leads = F.leads.filter(l => l.email !== 'jo@joco.com');
    await data(leo, 'instantlySync', {});
    assert.equal((await prisma.instantlyLead.findUnique({ where: { targetId: 't_jo' } })).state, 'waiting', 'just sent: Instantly may not list it yet');
    await prisma.instantlyLead.update({ where: { targetId: 't_jo' }, data: { pushedAt: new Date(Date.now() - 3600e3) } });
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.gone, 1);
    const jo = await prisma.instantlyLead.findUnique({ where: { targetId: 't_jo' } });
    assert.deepEqual([jo.state, jo.note], ['removed', 'Deleted in Instantly']);
    ok('a lead deleted in Instantly by hand reads as taken out — and a colleague of someone who replied is never offered');

    // 18. Instantly's block list refuses someone; someone already in one of its campaigns isn't added twice.
    F.block.push('kat@block.com');
    F.leads.push({ id: 'L-other', email: 'kim@block.com', campaign: 'camp-draft', status: 1, payload: {}, email_reply_count: 0, timestamp_last_contact: null });
    pv = await data(leo, 'sendToInstantly', {});
    const three = await data(leo, 'sendToInstantly', { ids: pick(['Kit Fine', 'Kat Blocked', 'Kim Already']), confirm: true, expect: pv.expect });
    assert.equal(three.sent, 1);
    assert.deepEqual(three.refused.map(x => x.name), ['Kat Blocked']);
    assert.deepEqual(three.already.map(x => x.name), ['Kim Already']);
    assert.equal(await prisma.instantlyLead.findUnique({ where: { targetId: 't_k2' } }), null, 'refused: still ready on the dashboard');
    const kim = await prisma.instantlyLead.findUnique({ where: { targetId: 't_k3' } });
    assert.deepEqual([kim.campaignId, kim.leadId, kim.batch, kim.note], ['camp-draft', 'L-other', null, 'Already in Instantly when it was sent']);
    assert.equal(F.leads.filter(l => l.email === 'kim@block.com').length, 1);
    ok('someone on Instantly’s block list is named as refused; someone already in one of its campaigns is taken on, not added twice');

    // 18b. An intro Instantly sent days ago: its sequence follows up — the dashboard never drafts one on top.
    await hook({ timestamp: new Date(Date.now() - 5 * 864e5).toISOString(), event_type: 'email_sent', campaign_id: 'camp-cold', lead_email: 'kit@block.com', step: 1, email_id: 'em-k1', email_subject: 'Block Co x SB' }, HOOK2);
    assert.equal((await prisma.instantlyLead.findUnique({ where: { targetId: 't_k1' } })).state, 'sent');
    await data(leo, 'draftEmails', { limit: 6 });
    assert.equal(await prisma.emailMessage.count({ where: { targetId: 't_k1', status: 'draft' } }), 0);
    assert.equal(await prisma.emailMessage.count({ where: { kind: { in: ['followup', 'followup2'] }, status: 'draft' } }), 0);
    await prisma.emailMessage.deleteMany({ where: { status: 'draft' } });
    const es = await data(leo, 'getEmailStatus', {});
    assert.equal(es.sentToday, 0, 'the dashboard’s own cap never counts an Instantly email');
    assert.equal(es.totalSent, 0);
    ok('the dashboard never drafts a follow-up on top of Instantly’s sequence, and its cap and stats don’t count Instantly’s emails');

    // 18c. The emails are Email → Templates'; a campaign key's three emails (its first email, then the Follow-up
    //      and Last follow-up every category shares) are written into its Instantly campaign. Claude's token can
    //      save a template on the dashboard but never send one to Instantly.
    const NIC_BODY = 'Hi (NAME),\n\nYour board: (BOARD)\n\nBest,\nZach';
    await data(null, 'saveEmailTemplate', { key: 'cat:nicotine', subject: '(BRAND) x SB Agency', body: NIC_BODY });
    r = await call(null, 'pushInstantlyTemplate', { key: 'nicotine' });
    assert.equal(r.ok, false); assert.match(r.error, /Only someone signed in/);
    r = await call(null, 'saveInstantlyFooter', { signature: 'x', push: true });
    assert.equal(r.ok, false); assert.match(r.error, /Only someone signed in/);
    r = await call(leo, 'pushInstantlyTemplate', { key: 'cat:nicotine' });
    assert.equal(r.ok, false); assert.match(r.error, /Which template/);
    // A key that can't write campaigns: said in words, nothing made.
    F.failWrite = 403;
    r = await call(leo, 'pushInstantlyTemplate', { key: 'nicotine' });
    assert.equal(r.ok, false); assert.match(r.error, /missing a permission/);
    F.failWrite = 0;
    assert.equal(F.campaigns.length, 2);
    // Leo pushes it: a new draft campaign in Instantly, holding the three emails in Instantly's own form.
    const pushed = await data(leo, 'pushInstantlyTemplate', { key: 'nicotine' });
    assert.deepEqual([pushed.pushed[0].created, pushed.pushed[0].campaign.name], [true, 'SB cold · Nicotine']);
    const made = F.campaigns.find(c => c.name === 'SB cold · Nicotine');
    assert.deepEqual([made.status, made.daily_limit, made.stop_on_reply, made.open_tracking, made.link_tracking, made.text_only], [0, 30, true, false, false, true]);
    assert.deepEqual(made.campaign_schedule.schedules[0].days, { 0: false, 1: false, 2: true, 3: true, 4: true, 5: false, 6: false });
    assert.deepEqual(made.sequences[0].steps.map(x => [x.delay, x.variants[0].subject]), [[3, '{{companyName}} x SB Agency'], [4, ''], [0, '']]);
    assert.equal(made.sequences[0].steps[0].variants[0].body, 'Hi {{firstName}},<br/><br/>Your board: {{board_link}}<br/><br/>Best,<br/>Zach');
    assert.match(made.sequences[0].steps[1].variants[0].body, /^Hi \{\{firstName\}\},<br\/><br\/>Wanted to float this back to the top of your inbox/);
    assert.match(made.sequences[0].steps[2].variants[0].body, /Last note from me/);
    const grp = async (k) => (await data(leo, 'instantlyStatus', { live: true })).templates.groups.find(g => g.key === k);
    let nic = await grp('nicotine');
    assert.deepEqual([nic.state, nic.linked.name, nic.campaign.statusWord, nic.campaign.sends, nic.own, nic.first], ['match', 'SB cold · Nicotine', 'Draft', false, true, 'cat:nicotine']);
    assert.ok(nic.campaign.warn.some(w => /No sending inbox/.test(w)), 'the draft still needs its inbox');
    assert.equal((await grp('energy')).state, 'empty', 'the campaign Leo made by hand has no email of ours in it yet');
    // Email → Templates says where each email goes in Instantly.
    let lib = await data(leo, 'listEmailTemplates', {});
    const tplOf = (k) => [...lib.general, ...lib.categories].find(t => t.key === k);
    assert.deepEqual(tplOf('cat:nicotine').instantly, { key: 'nicotine', campaign: 'SB cold · Nicotine' });
    assert.deepEqual(tplOf('cat:energy').instantly, { key: 'energy', campaign: 'Cold — no answer on LinkedIn' });
    assert.deepEqual(tplOf('followup').instantly, { campaigns: 2 });
    assert.deepEqual(tplOf('cat:rtd').instantly, { goesWith: 'alcohol', label: 'Alcohol', has: false });
    assert.deepEqual(tplOf('cat:tech').instantly, { goesWith: 'general', label: 'Everyone else', has: false });
    assert.equal(tplOf('intro').instantly, null);
    assert.equal(tplOf('cat:alcohol').instantly, null, 'a family’s own email with no campaign yet');
    // Every standard first email carries the Show Board link.
    assert.ok([tplOf('intro'), tplOf('cat:energy'), tplOf('cat:tech')].every(t => /\n\(BOARD\)\n/.test(t.body)));
    // A wait Leo changes in Instantly isn't a change of words.
    made.sequences[0].steps[0].delay = 2;
    assert.equal((await grp('nicotine')).state, 'match');
    // Edited on Templates: the two differ in the first email, the dashboard's is newer; pushing it updates the same campaign and keeps his wait.
    await data(leo, 'saveEmailTemplate', { key: 'cat:nicotine', subject: 'Quick one, (NAME)', body: NIC_BODY });
    nic = await grp('nicotine');
    assert.deepEqual([nic.state, nic.newer, nic.parts], ['differs', 'dashboard', { first: true, follow: false }]);
    const again = await data(leo, 'pushInstantlyTemplate', { key: 'nicotine' });
    assert.equal(again.pushed[0].created, false);
    assert.equal(F.campaigns.filter(c => c.name === 'SB cold · Nicotine').length, 1, 'never a second campaign');
    assert.equal(made.sequences[0].steps[0].variants[0].subject, 'Quick one, {{firstName}}');
    assert.equal(made.sequences[0].steps[0].delay, 2, 'his wait stays');
    assert.equal((await grp('nicotine')).state, 'match');
    // A follow-up every category shares, edited on Templates: every campaign is behind in its follow-ups; one push for all.
    await data(leo, 'saveEmailTemplate', { key: 'followup', subject: 're: SB Agency x (BRAND)', body: 'Hi (NAME),\n\nBumping this.\n\nBest,\nZach' });
    nic = await grp('nicotine');
    assert.deepEqual([nic.state, nic.newer, nic.parts], ['differs', 'dashboard', { first: false, follow: true }]);
    const all = await data(leo, 'pushInstantlyTemplate', { all: true });
    assert.deepEqual(all.pushed.map(x => x.group), ['energy', 'nicotine']);
    assert.equal(made.sequences[0].steps[1].variants[0].body, 'Hi {{firstName}},<br/><br/>Bumping this.<br/><br/>Best,<br/>Zach');
    assert.equal((await grp('energy')).state, 'match', 'Energy’s hand-made campaign now holds the Energy emails');
    const cold = F.campaigns.find(c => c.id === 'camp-cold');
    assert.match(cold.sequences[0].steps[0].variants[0].body, /Concerts are a natural sampling moment for \{\{companyName\}\}/);
    assert.match(cold.sequences[0].steps[0].variants[0].body, /<br\/>\{\{board_link\}\}<br\/>/);
    assert.equal(cold.sequences[0].steps.length, 3);
    // Edited in Instantly instead — its first email and its last follow-up: differs, Instantly's is newer; taking its
    // version brings the words back as our placeholders, each into its own template.
    made.sequences[0].steps[0].variants[0].body = '<div>Hey {{firstName}},</div><div><br></div><div>See {{board_link}}</div><div><br></div><div>Best,</div><div>Zach</div>';
    made.sequences[0].steps[2].variants[0].body = 'Hi {{firstName}},<br/><br/>Closing the loop.<br/><br/>Best,<br/>Zach';
    nic = await grp('nicotine');
    assert.deepEqual([nic.state, nic.newer, nic.parts], ['differs', 'instantly', { first: true, follow: true }]);
    const pulled = await data(leo, 'pullInstantlyTemplate', { key: 'nicotine' });
    assert.deepEqual(pulled.changed, ['cat:nicotine', 'final']);
    lib = await data(leo, 'listEmailTemplates', {});
    assert.deepEqual([tplOf('cat:nicotine').subject, tplOf('cat:nicotine').body], ['Quick one, (NAME)', 'Hey (NAME),\n\nSee (BOARD)\n\nBest,\nZach']);
    assert.deepEqual([tplOf('final').subject, tplOf('final').body, tplOf('final').own], ['re: SB Agency x (BRAND)', 'Hi (NAME),\n\nClosing the loop.\n\nBest,\nZach', true]);
    assert.equal(tplOf('followup').body, 'Hi (NAME),\n\nBumping this.\n\nBest,\nZach', 'what didn’t change there stays');
    assert.equal((await grp('nicotine')).state, 'match');
    // The last follow-up is everyone's: Energy's campaign is now behind the dashboard.
    const en = await grp('energy');
    assert.deepEqual([en.state, en.newer, en.parts], ['differs', 'dashboard', { first: false, follow: true }]);
    // A footer goes under every email of every campaign.
    const sig = await data(leo, 'saveInstantlyFooter', { signature: 'SB Agency · 1 Main St, Miami FL', push: true });
    assert.deepEqual(sig.pushed.map(x => x.group), ['energy', 'nicotine']);
    assert.match(made.sequences[0].steps[1].variants[0].body, /Best,<br\/>Zach<br\/><br\/>SB Agency · 1 Main St, Miami FL$/);
    assert.match(cold.sequences[0].steps[2].variants[0].body, /Closing the loop\.<br\/><br\/>Best,<br\/>Zach<br\/><br\/>SB Agency · 1 Main St, Miami FL$/);
    assert.equal((await grp('nicotine')).state, 'match');
    assert.equal((await grp('energy')).state, 'match');
    assert.equal((await data(leo, 'instantlyStatus', {})).templates.signature, 'SB Agency · 1 Main St, Miami FL');
    ok('a campaign’s three emails come from Email → Templates and are written into Instantly (a draft campaign the first time, Leo’s waits kept); the page says which part differs and whose is newer, either can be taken, a shared follow-up and the footer reach every campaign');

    // 18c2. Which campaign a category goes to: its own, else its family's; a family never gets the general email;
    //       everyone else goes with the general one.
    const niaLine = async () => (await data(leo, 'sendToInstantly', {})).lines.find(l => l.name === 'Nia New');
    await prisma.brand.update({ where: { id: 'b_nova' }, data: { category: 'rtd' } });
    let nl = await niaLine();
    assert.deepEqual([nl.action, nl.tpl, nl.tplLabel], ['nocamp', 'alcohol', 'Alcohol']);
    assert.match(nl.why, /No Instantly campaign for Alcohol yet/);
    await data(leo, 'pushInstantlyTemplate', { key: 'general' });
    assert.equal((await niaLine()).action, 'nocamp', 'a beer brand never gets the Everyone else email');
    await data(leo, 'pushInstantlyTemplate', { key: 'alcohol' });
    nl = await niaLine();
    assert.deepEqual([nl.action, nl.tpl, nl.campaignId], ['send', 'alcohol', F.campaigns.find(c => c.name === 'SB cold · Alcohol').id]);
    // Beer given a campaign of its own: its brands leave Alcohol's; it gets a row; Templates says so.
    await data(leo, 'pushInstantlyTemplate', { key: 'rtd' });
    nl = await niaLine();
    assert.deepEqual([nl.action, nl.tpl, nl.tplLabel, nl.campaignId], ['send', 'rtd', 'Beer, Seltzers & Canned Cocktails', F.campaigns.find(c => c.name === 'SB cold · Beer, Seltzers & Canned Cocktails').id]);
    st = await data(leo, 'instantlyStatus', { live: true });
    assert.deepEqual(st.templates.groups.map(g => [g.key, g.main]), [['energy', true], ['alcohol', true], ['nicotine', true], ['beauty', true], ['cpg', true], ['general', true], ['rtd', false]]);
    assert.deepEqual(st.templates.groups.find(g => g.key === 'alcohol').also, ['spirits']);
    assert.ok(!st.templates.others.some(o => o.key === 'rtd'));
    lib = await data(leo, 'listEmailTemplates', {});
    assert.deepEqual(tplOf('cat:rtd').instantly, { key: 'rtd', campaign: 'SB cold · Beer, Seltzers & Canned Cocktails' });
    assert.deepEqual(tplOf('cat:spirits').instantly, { goesWith: 'alcohol', label: 'Alcohol', has: true });
    assert.deepEqual(tplOf('intro').instantly, { key: 'general', campaign: 'SB cold · Everyone else' });
    // A category in no family goes with Everyone else.
    await prisma.brand.update({ where: { id: 'b_nova' }, data: { category: 'tech' } });
    nl = await niaLine();
    assert.deepEqual([nl.action, nl.tpl, nl.tplLabel], ['send', 'general', 'Everyone else']);
    assert.equal((await data(leo, 'sendToInstantly', {})).byCategory.tech, 1);
    await prisma.brand.update({ where: { id: 'b_nova' }, data: { category: 'nicotine' } });
    ok('a category goes to its own campaign, else its family’s; a family never falls to the general email; any category can be given a campaign of its own');

    // 18d. Someone at a brand not reached yet, with no outreach row: ticked by hand, she gets a row (next in line —
    //      the LinkedIn queue's numbers don't move), her own Show Board link, and goes to her template's campaign.
    assert.equal(await prisma.target.count({ where: { contactId: 'c_nia' } }), 0);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nova' } })).boardCode, null);
    pv = await data(leo, 'sendToInstantly', {});
    assert.deepEqual([line('Nia New').action, line('Nia New').tick, line('Nia New').campaignId], ['send', false, made.id]);
    assert.equal((await prisma.brand.findUnique({ where: { id: 'b_nova' } })).boardCode, null, 'a preview makes no code');
    const nia = await data(leo, 'sendToInstantly', { ids: pick(['Nia New']), confirm: true, expect: pv.expect });
    assert.equal(nia.sent, 1);
    assert.deepEqual(nia.campaigns.filter(c => c.sent).map(c => [c.group, c.name, c.sends]), [['nicotine', 'SB cold · Nicotine', false]]);
    assert.deepEqual(nia.waitingToStart, ['SB cold · Nicotine']);
    const niaT = await prisma.target.findFirst({ where: { contactId: 'c_nia' }, include: { instantly: true } });
    assert.deepEqual([niaT.status, niaT.shelved, niaT.shelvedHow, niaT.brandId, niaT.instantly.state, niaT.instantly.campaignId], ['queued', true, 'cap', 'b_nova', 'waiting', made.id]);
    const niaLead = F.calls.filter(c => c.path === '/api/v2/leads/add').pop().body;
    assert.equal(niaLead.campaign_id, made.id);
    const code = (await prisma.brand.findUnique({ where: { id: 'b_nova' } })).boardCode;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const link = niaLead.leads[0].custom_variables.board_link;
    assert.match(link, new RegExp('\\?code=' + code + '&p=[A-Z2-9]{6}$'));
    assert.equal(niaLead.leads[0].custom_variables.sb_id, 'c_nia');
    assert.ok(fakeLead('nia@nova.com'));
    assert.equal((await data(leo, 'reachedBrands', {})).brands['b_nova'], undefined, 'handed over is not reached yet');
    await hook({ timestamp: new Date().toISOString(), event_type: 'email_sent', campaign_id: made.id, lead_email: 'nia@nova.com', step: 1, email_id: 'em-n1', email_subject: 'Quick one, Nia' }, HOOK2);
    assert.ok((await data(leo, 'reachedBrands', {})).brands['b_nova'], 'once Instantly emails her, the brand carries the Reached tag');
    const nova = (await data(leo, 'outreachTracker', {})).brands.find(b => b.id === 'b_nova');
    assert.equal(nova.stage, 'reached');
    // She opens her link: the board logs the visit as hers, and the page counts it.
    st = await data(leo, 'instantlyStatus', {});
    assert.equal(st.counts.opened, 0);
    const q = new URL(link).search;
    await fetch(BASE + '/api/public/shows' + q).catch(() => null);
    const visit = await prisma.boardVisit.findFirst({ where: { brandId: 'b_nova' } });
    assert.deepEqual([visit.email, visit.code], ['nia@nova.com', code]);
    st = await data(leo, 'instantlyStatus', {});
    assert.equal(st.counts.opened, 1);
    assert.deepEqual(st.people.filter(x => x.state === 'opened').map(x => [x.name, x.brandName, x.email, x.note]), [['Nia New', 'Nova Pouch', 'nia@nova.com', '1 open · under a minute']]);
    // The brand's plain link (no key), a key that fits nobody there, and a key on another brand's code: the brand's visit, nobody's name.
    await prisma.boardVisit.deleteMany({});
    await fetch(BASE + '/api/public/shows?code=' + code).catch(() => null);
    await fetch(BASE + '/api/public/shows?code=' + code + '&p=ZZZZZZ', { headers: { 'x-forwarded-for': '10.0.0.2' } }).catch(() => null);
    assert.deepEqual((await prisma.boardVisit.findMany({ where: { brandId: 'b_nova' } })).map(v => v.email), [null, null]);
    assert.equal((await data(leo, 'instantlyStatus', {})).counts.opened, 0);
    ok('someone at a brand not reached yet goes when ticked: an outreach row (next in line), her category’s campaign, and her own Show Board link — opening it shows on the page as hers');

    // 19. A bad key, a lapsed plan: said in words, nothing breaks.
    F.fail = 401;
    st = await data(leo, 'instantlyStatus', { live: true });
    assert.match(st.error, /didn’t accept the key/);
    assert.equal(st.counts.total > 0, true, 'what the dashboard knows still shows');
    F.fail = 402;
    st = await data(leo, 'instantlyStatus', { live: true });
    assert.match(st.error, /no active paid plan/);
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.ok, false); assert.match(sync.error, /no active paid plan/);
    pv = await data(leo, 'sendToInstantly', {});
    r = await call(leo, 'sendToInstantly', { ids: pv.lines.filter(l => l.action === 'send').map(l => l.contactId), confirm: true, expect: pv.expect });
    assert.equal(r.ok, false);
    F.fail = 0;
    sync = await data(leo, 'instantlySync', {});
    assert.equal(sync.ok, true);
    ok('a refused key or a lapsed plan reads in plain words on the card; the next sync picks up where the last good one ended');

    // 20. Claude's day: picking the campaign is a change; a preview and a status read are not.
    const acts = await prisma.claudeAction.findMany({ orderBy: { at: 'asc' } });
    assert.deepEqual(acts.map(a => a.fn), ['setInstantlyCampaign', 'saveEmailTemplate']);
    assert.match(acts[0].text, /Set the Instantly campaign for Energy drinks: Cold/);
    assert.match(acts[1].text, /Saved the cat:nicotine email template/);
    ok('Claude’s day lists the campaign Claude linked and the template it saved — never a read, a preview or a refused send or push');

    // 21. Live updates off: our webhook leaves Instantly, and its secret opens nothing.
    const off = await data(leo, 'setInstantlyHook', { on: false });
    assert.equal(off.on, false);
    assert.equal(F.hooks.length, 0);
    assert.equal((await hook({ event_type: 'email_sent', lead_email: 'ann@cold.com' }, HOOK2)).status, 401);
    ok('turning live updates off removes the webhook from Instantly and closes the door');

    console.log('\n' + n + ' checks passed');
  } catch (err) {
    console.error('\nFAILED: ' + (err && err.stack || err));
    process.exitCode = 1;
  } finally {
    try { fake.close(); } catch (e) {}
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) {} }
  }
})();
