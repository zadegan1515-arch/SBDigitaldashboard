// node scripts/test-instantly.mjs — cold email through Instantly (Leo, Nov 16
// 2026; src/lib/instantly.ts): who can be handed over and who is ticked, the
// lead Instantly gets (and nothing more), how a webhook event and a listed
// lead read, how far a row got, and who must come back out of Instantly.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'instantly-test-'))
execSync('npx tsc src/lib/instantly.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const I = await import(pathToFileURL(join(out, 'instantly.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const NOW = new Date('2026-11-17T15:00:00Z')

// ---- campaigns
t('a campaign reads as running only when Active or on its subsequences', () => {
  assert.equal(I.campaignSends(1), true)
  assert.equal(I.campaignSends(4), true)
  for (const s of [0, 2, 3, -1, -2, -99, undefined]) assert.equal(I.campaignSends(s), false, String(s))
  assert.equal(I.campaignWord(2), 'Paused')
  assert.equal(I.campaignWord(0), 'Draft')
  assert.equal(I.campaignWord(77), 'Unknown')
})
t('a campaign’s settings worth a second look are named', () => {
  const ok = I.campaignView({ id: 'c1', name: 'Cold', status: 1, daily_limit: 30, stop_on_reply: true, open_tracking: false, link_tracking: false, email_list: ['z@sboyagency.co'], sequences: [{ steps: [{}, {}, {}] }] })
  assert.deepEqual(ok.warn, [])
  assert.equal(ok.sends, true)
  assert.equal(ok.steps, 3)
  assert.equal(ok.inboxes, 1)
  const bad = I.campaignView({ id: 'c2', name: '', status: 2, daily_limit: 100, stop_on_reply: false, open_tracking: true, link_tracking: true, email_list: [], sequences: [{ steps: [] }] })
  assert.equal(bad.name, 'Untitled campaign')
  assert.equal(bad.sends, false)
  assert.equal(bad.warn.length, 5)
  const fast = I.campaignView({ id: 'c3', name: 'Fast', status: 1, daily_limit: 100, email_list: ['a@x.co', 'b@x.co'] })
  assert.ok(fast.warn.some(w => /30 an inbox/.test(w)), 'fifty an inbox is flagged')
  const fine = I.campaignView({ id: 'c4', name: 'Fine', status: 1, daily_limit: 60, email_list: ['a@x.co', 'b@x.co'] })
  assert.ok(!fine.warn.some(w => /30 an inbox/.test(w)))
})

// ---- where an address came from
t('the line Hunter’s file left says whether the address is verified', () => {
  assert.equal(I.emailSource('Met at SXSW\nEmail added from Hunter’s file, Nov 16, 2026 (verified)'), 'verified')
  assert.equal(I.emailSource('Email added from Hunter’s file, Nov 16, 2026 (not verified)'), 'unverified')
  assert.equal(I.emailSource('Email added from Hunter’s file, Nov 16, 2026'), 'file')
  assert.equal(I.emailSource('From SponsorUnited'), 'onfile')
  assert.equal(I.emailSource(null), 'onfile')
  // The newest line wins.
  assert.equal(I.emailSource('Email added from Hunter’s file, Nov 1, 2026 (not verified)\nEmail added from Hunter’s file, Nov 16, 2026 (verified)'), 'verified')
})

// ---- who can go
const person = (o) => ({ targetId: 't_' + o.id, contactId: o.id, name: 'Ann Lee', title: 'Head of Partnerships', email: 'ann@coldco.com', brandId: 'b1', brandName: 'Cold Co', notes: 'Email added from Hunter’s file, Nov 16, 2026 (verified)', ...o })
t('a verified address goes, ticked; one Hunter couldn’t verify or a shared inbox goes unticked', () => {
  const p = I.planPush([
    person({ id: 'a' }),
    person({ id: 'b', email: 'bo@coldco.com', notes: 'Email added from Hunter’s file, Nov 16, 2026 (not verified)' }),
    person({ id: 'c', email: 'partnerships@coldco.com', notes: null }),
    person({ id: 'd', email: 'dee@gmail.com', notes: null }),
  ])
  assert.deepEqual(p.lines.map(l => [l.action, l.tick]), [['send', true], ['send', false], ['send', false], ['send', true]])
  assert.match(p.lines[1].why, /couldn’t verify/)
  assert.match(p.lines[2].why, /shared inbox/)
  assert.match(p.lines[3].why, /personal address/)
  assert.equal(p.counts.send, 4)
  assert.equal(p.counts.ticked, 2)
  assert.equal(p.counts.brands, 1)
})
t('never someone already in Instantly, stopped, with no outreach row, or a bad address', () => {
  const p = I.planPush([
    person({ id: 'a', handed: true }),
    person({ id: 'b', email: 'bo@coldco.com', stopped: 'Bo said they don’t want to continue' }),
    person({ id: 'c', email: 'cy@coldco.com', targetId: null }),
    person({ id: 'd', email: 'not an email' }),
    person({ id: 'e', email: 'eve@coldco.com' }),
    person({ id: 'f', email: 'EVE@coldco.com' }),
  ])
  assert.deepEqual(p.lines.map(l => l.action), ['handed', 'stopped', 'norow', 'bad', 'send', 'bad'])
  assert.match(p.lines[5].why, /Someone else on the list/)
  assert.equal(p.counts.send, 1)
})
t('the preview’s signature follows who would go and to which address', () => {
  const a = I.planPush([person({ id: 'a' }), person({ id: 'b', email: 'bo@coldco.com' })]).sig
  assert.equal(a, I.planPush([person({ id: 'b', email: 'bo@coldco.com' }), person({ id: 'a' })]).sig, 'order doesn’t matter')
  assert.notEqual(a, I.planPush([person({ id: 'a' })]).sig)
  assert.notEqual(a, I.planPush([person({ id: 'a', email: 'ann.lee@coldco.com' }), person({ id: 'b', email: 'bo@coldco.com' })]).sig)
  assert.notEqual(a, I.planPush([person({ id: 'a', stopped: 'stopped' }), person({ id: 'b', email: 'bo@coldco.com' })]).sig)
})

// ---- what Instantly gets
t('a lead carries the address, name, company, title, website and our id — nothing else', () => {
  const l = I.leadFor({ name: 'Dr. Ann Lee, MBA', title: 'Head of Partnerships', email: ' Ann@ColdCo.com ', brandName: 'Cold Co', website: 'https://www.coldco.com/shop', contactId: 'c_ann' })
  assert.deepEqual(l, { email: 'ann@coldco.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Cold Co', job_title: 'Head of Partnerships', website: 'coldco.com', custom_variables: { sb_id: 'c_ann' } })
  // A name that can't be split still greets by its first word; no website → the address's own domain.
  const m = I.leadFor({ name: 'Cher', email: 'cher@label.com', brandName: 'Label', contactId: 'c2' })
  assert.equal(m.first_name, 'Cher')
  assert.equal(m.last_name, undefined)
  assert.equal(m.website, 'label.com')
  // The split the list already made is used as it is.
  assert.equal(I.leadFor({ name: 'x', first: 'Jean-Luc', last: 'Picard', email: 'jl@e.com', brandName: 'E', contactId: 'c3' }).last_name, 'Picard')
  // A free mailbox is never given as the company's website.
  assert.equal(I.leadFor({ name: 'Dee Day', email: 'dee@gmail.com', brandName: 'Tiny', contactId: 'c4' }).website, undefined)
})

// ---- what Instantly tells us
t('a webhook event reads into what happened, to whom, when', () => {
  const sent = I.readEvent({ timestamp: '2026-11-17T14:00:00Z', event_type: 'email_sent', campaign_id: 'camp1', lead_email: ' Ann@ColdCo.com', email_account: 'zach@sboyagency.co', step: 2, email_id: 'e1', email_subject: 'Hi', email_text: 'Hello' }, NOW)
  assert.equal(sent.kind, 'sent'); assert.equal(sent.email, 'ann@coldco.com'); assert.equal(sent.step, 2); assert.equal(sent.emailId, 'e1')
  assert.equal(sent.subject, 'Hi'); assert.equal(sent.text, 'Hello'); assert.equal(sent.account, 'zach@sboyagency.co'); assert.equal(sent.at.toISOString(), '2026-11-17T14:00:00.000Z')
  const reply = I.readEvent({ timestamp: '2026-11-17T14:30:00Z', event_type: 'reply_received', lead_email: 'ann@coldco.com', email_subject: 'Hi', reply_subject: 'Re: Hi', reply_text: 'Tell me more', reply_text_snippet: 'Tell' }, NOW)
  assert.equal(reply.kind, 'reply'); assert.equal(reply.subject, 'Re: Hi'); assert.equal(reply.text, 'Tell me more')
  assert.equal(I.readEvent({ event_type: 'email_bounced', lead_email: 'a@b.co' }, NOW).kind, 'bounce')
  assert.equal(I.readEvent({ event_type: 'lead_unsubscribed', lead_email: 'a@b.co' }, NOW).kind, 'unsub')
  assert.equal(I.readEvent({ event_type: 'auto_reply_received', lead_email: 'a@b.co' }, NOW).kind, 'autoreply')
  assert.equal(I.readEvent({ event_type: 'lead_out_of_office', lead_email: 'a@b.co' }, NOW).kind, 'autoreply')
  assert.equal(I.readEvent({ event_type: 'email_link_clicked', lead_email: 'a@b.co' }, NOW).kind, 'click')
  assert.equal(I.readEvent({ event_type: 'lead_interested', lead_email: 'a@b.co' }, NOW).kind, 'other')
  assert.equal(I.readEvent({ event_type: 'My custom label', lead_email: 'a@b.co' }, NOW).kind, 'other')
})
t('an event with no lead, no type, or junk is nothing; a clock ahead of ours reads as now', () => {
  assert.equal(I.readEvent({ event_type: 'campaign_completed', campaign_id: 'c' }, NOW), null)
  assert.equal(I.readEvent({ lead_email: 'a@b.co' }, NOW), null)
  assert.equal(I.readEvent(null, NOW), null)
  assert.equal(I.readEvent('email_sent', NOW), null)
  assert.equal(I.readEvent({ event_type: 'email_sent', lead_email: 'not-an-email' }, NOW), null)
  assert.equal(I.readEvent({ event_type: 'email_sent', lead_email: 'a@b.co', timestamp: '2030-01-01T00:00:00Z' }, NOW).at.getTime(), NOW.getTime())
  assert.equal(I.readEvent({ event_type: 'email_sent', lead_email: 'a@b.co', timestamp: 'yesterday' }, NOW).at.getTime(), NOW.getTime())
  assert.equal(I.readEvent({ event_type: 'email_sent', lead_email: 'a@b.co', step: 'two' }, NOW).step, null)
})
t('a listed lead reads into where it stands', () => {
  const f = (o) => I.stateOfLead(I.leadFacts({ id: 'L1', email: 'Ann@ColdCo.com', campaign: 'camp1', status: 1, ...o }))
  assert.equal(f({}), 'waiting')
  assert.equal(f({ timestamp_last_contact: '2026-11-17T14:00:00Z' }), 'sent')
  assert.equal(f({ status_summary: { lastStep: { timestamp_executed: '2026-11-17T14:00:00Z' } } }), 'sent')
  assert.equal(f({ status: 3, timestamp_last_contact: '2026-11-10T14:00:00Z' }), 'done')
  assert.equal(f({ status: -1 }), 'bounced')
  assert.equal(f({ status: -2 }), 'unsubscribed')
  assert.equal(f({ status: -3 }), 'removed')
  const facts = I.leadFacts({ id: 'L1', email: 'Ann@ColdCo.com', campaign: 'camp1', status: 1, email_reply_count: 1, timestamp_last_reply: '2026-11-17T14:30:00Z', payload: { sb_id: 'c_ann' } })
  assert.equal(facts.email, 'ann@coldco.com'); assert.equal(facts.maybeReplied, true); assert.equal(facts.sbId, 'c_ann'); assert.equal(facts.leadId, 'L1')
  // An out-of-office isn't a reply.
  assert.equal(I.leadFacts({ id: 'L2', email: 'a@b.co', email_reply_count: 1, lt_interest_status: 0 }).maybeReplied, false)
})
t('a later read never moves a row backwards', () => {
  assert.equal(I.stateBeats('sent', 'waiting'), true)
  assert.equal(I.stateBeats('waiting', 'sent'), false)
  assert.equal(I.stateBeats('replied', 'sent'), true)
  assert.equal(I.stateBeats('replied', 'bounced'), true)
  assert.equal(I.stateBeats('bounced', 'replied'), false)
  assert.equal(I.stateBeats('unsubscribed', 'replied'), true)
  assert.equal(I.stateBeats('done', 'replied'), false)
  assert.equal(I.isActive('waiting') && I.isActive('sent'), true)
  for (const s of ['replied', 'bounced', 'unsubscribed', 'done', 'removed']) assert.equal(I.isActive(s), false, s)
})
t('an email’s place in the sequence files it as the intro or a follow-up — never the dashboard’s “went quiet” rung', () => {
  assert.equal(I.kindOfStep(1), 'intro'); assert.equal(I.kindOfStep(null), 'intro')
  assert.equal(I.kindOfStep(2), 'followup'); assert.equal(I.kindOfStep(5), 'followup')
  assert.equal(I.stepOfEmail('0_0_0'), 1); assert.equal(I.stepOfEmail('0_2_1'), 3); assert.equal(I.stepOfEmail('0_1'), 2)
  for (const s of ['2', '', null, 'step-two', 'a_b_c']) assert.equal(I.stepOfEmail(s), null, String(s))
})

// ---- who comes back out
const back = (o) => I.pullBackWhy({ state: 'sent', handedEmail: 'ann@coldco.com', emailNow: 'ann@coldco.com', contactStopped: false, declined: false, brandStopped: false, brandArchived: false, brandNoEmail: false, status: 'sent', callBooked: false, brandAnswered: false, ...o })
t('someone still being emailed with nothing changed stays in', () => {
  assert.equal(back({}), null)
  assert.equal(back({ state: 'waiting' }), null)
  assert.equal(back({ emailNow: 'Ann@ColdCo.com ' }), null, 'the same address, typed another way')
})
t('a stop takes them out and onto Instantly’s block list', () => {
  for (const o of [{ contactStopped: true }, { declined: true }, { brandStopped: true }]) {
    const w = back(o)
    assert.ok(w && w.block === true, JSON.stringify(o))
  }
  assert.match(back({ brandStopped: true }).why, /brand/)
})
t('answered or picked up on LinkedIn, archived, do not email, a changed address: out, not blocked', () => {
  const cases = [
    [{ status: 'accepted' }, /accepted on LinkedIn/], [{ status: 'replied' }, /answered on LinkedIn/], [{ status: 'declined' }, /answered on LinkedIn/],
    [{ callBooked: true }, /call is booked/], [{ brandArchived: true }, /archived/], [{ brandNoEmail: true }, /do not email/],
    [{ brandAnswered: true }, /Someone else at the brand answered/], [{ emailNow: 'ann.lee@coldco.com' }, /email was changed/], [{ emailNow: null }, /email was changed/],
  ]
  for (const [o, re] of cases) { const w = back(o); assert.ok(w && w.block === false, JSON.stringify(o)); assert.match(w.why, re) }
  // The stop is said first when both are true.
  assert.equal(back({ contactStopped: true, brandArchived: true }).block, true)
})
t('a row that already ended is never taken out again', () => {
  for (const state of ['replied', 'bounced', 'unsubscribed', 'done', 'removed']) assert.equal(back({ state, contactStopped: true, brandStopped: true }), null, state)
})

t('small things: the bounce note, a batch id, the scopes the key needs', () => {
  assert.equal(I.bounceNote('ann@coldco.com', 'Nov 17, 2026'), 'Email to ann@coldco.com bounced (Instantly, Nov 17, 2026)')
  const a = I.batchId(NOW), b = I.batchId(NOW)
  assert.match(a, /^ib[a-z0-9]+$/); assert.notEqual(a, b)
  assert.deepEqual(I.KEY_SCOPES, ['campaigns:read', 'leads:all', 'emails:read', 'webhooks:all', 'block_list_entries:all'])
  assert.equal(I.INSTANTLY_KEY_ENV, 'INSTANTLY_API_KEY')
})

console.log(n + ' checks passed')
