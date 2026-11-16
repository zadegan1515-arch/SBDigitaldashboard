// Cold email through Instantly (Leo, Nov 16 2026: "get the emails from
// Hunter, connect that to Instantly, and run cold outreach through Instantly
// … build it connected").
//
// The dashboard stays in the middle: it is the one place that knows who said
// they don't want to continue. So
//   · people go to Instantly only from Outreach → Email → Send to Instantly
//     (a signed-in click, every person named first) — never by themselves,
//     never from a key or Claude's token, never from the cron;
//   · Instantly does the sending. The dashboard's own send paths stay off
//     (src/lib/no-send.ts is untouched);
//   · what Instantly did comes back (webhook as it happens, a daily sync as
//     the net): an email sent, a reply, a bounce, an unsubscribe;
//   · what changed here goes the other way: someone who stopped, accepted or
//     answered on LinkedIn, or whose brand was archived, is taken back out of
//     Instantly — and a stop also goes on Instantly's block list.
//
// Pure here: who can be handed over, what a lead looks like, how an event
// and a lead's status read, who must come back out.
// API calls: instantly-api.ts. Database: instantly-db.ts.
// node scripts/test-instantly.mjs

import { cleanEmail, looksLikeEmail, mailDomain, sigOf, splitName } from './find-emails'
import { isRoleInbox } from './same-person'
import { websiteDomain } from './duplicates'

export const INSTANTLY_KEY_ENV = 'INSTANTLY_API_KEY'
export const CAMPAIGN_KEY = 'instantlyCampaign'     // Setting { id, name, at, by }
export const HOOK_KEY = 'instantlyHook'             // Setting { id, secret, url, at } — the secret never leaves the server
export const SYNC_KEY = 'instantlySync'             // Setting — the last sync, in numbers
export const PUSH_LAST_KEY = 'instantlyPushLast'    // Setting — the last Send, for its Undo
export const HOOK_HEADER = 'x-sb-hook'
export const VIA = 'instantly'
// The scopes the key needs (Instantly → Settings → Integrations → API Keys).
// (campaigns:all since the templates: the dashboard writes each group's emails into its campaign.)
export const KEY_SCOPES = ['campaigns:all', 'leads:all', 'emails:read', 'webhooks:all', 'block_list_entries:all']
// Instantly takes up to 1,000 leads a call; smaller keeps a call well inside a request.
export const PUSH_CHUNK = 200
export const PUSH_MAX = 1000

// ---- campaigns -------------------------------------------------------

export const CAMPAIGN_STATUS: Record<string, string> = {
  '0': 'Draft', '1': 'Active', '2': 'Paused', '3': 'Completed', '4': 'Running subsequences',
  '-99': 'Account suspended', '-1': 'Accounts unhealthy', '-2': 'Bounce protect',
}
export const campaignWord = (status: unknown) => CAMPAIGN_STATUS[String(status)] ?? 'Unknown'
// Active (or running its subsequences): a lead added now gets emailed on the
// campaign's next sending slot. Anything else: nothing goes until it's started in Instantly.
export const campaignSends = (status: unknown) => Number(status) === 1 || Number(status) === 4

export type Campaign = {
  id: string; name: string; status: number
  daily_limit?: number | null; stop_on_reply?: boolean | null; stop_for_company?: boolean | null
  open_tracking?: boolean | null; link_tracking?: boolean | null; text_only?: boolean | null
  email_list?: string[] | null; sequences?: unknown
}
// What the page shows of a campaign, and the settings worth a second look
// before a first send (the advice from the set-up: stop on reply, no
// tracking, plain text, 30 a day an inbox).
export function campaignView(c: Campaign) {
  const inboxes = Array.isArray(c.email_list) ? c.email_list.length : 0
  const steps = Array.isArray(c.sequences) && c.sequences[0] && Array.isArray((c.sequences[0] as any).steps) ? (c.sequences[0] as any).steps.length : null
  const warn: string[] = []
  if (c.stop_on_reply === false) warn.push('“Stop sending on reply” is off — turn it on')
  if (c.open_tracking) warn.push('Open tracking is on — off lands in more inboxes')
  if (c.link_tracking) warn.push('Link tracking is on — off lands in more inboxes')
  if (!inboxes) warn.push('No sending inbox is attached to it yet')
  if (steps === 0) warn.push('It has no email written yet')
  const perInbox = inboxes && c.daily_limit ? Math.ceil(Number(c.daily_limit) / inboxes) : null
  if (perInbox && perInbox > 30) warn.push('Its daily limit is ' + c.daily_limit + ' across ' + inboxes + (inboxes === 1 ? ' inbox' : ' inboxes') + ' — 30 an inbox is the safe ceiling')
  return {
    id: c.id, name: c.name || 'Untitled campaign', status: Number(c.status), statusWord: campaignWord(c.status), sends: campaignSends(c.status),
    dailyLimit: c.daily_limit ?? null, inboxes, steps, warn,
  }
}

// ---- who can be handed over ------------------------------------------

// Where the address on file came from, by the line Hunter's file left in the
// person's notes (find-emails.ts foundNote).
export type EmailSource = 'verified' | 'unverified' | 'file' | 'onfile'
export function emailSource(notes: unknown): EmailSource {
  const lines = String(notes ?? '').split('\n').filter(l => /^Email added from Hunter’s file/.test(l.trim()))
  const last = lines[lines.length - 1]
  if (!last) return 'onfile'
  return /\(verified\)/.test(last) ? 'verified' : /\(not verified\)/.test(last) ? 'unverified' : 'file'
}
export const SOURCE_WORDS: Record<EmailSource, string> = {
  verified: 'Verified by Hunter', unverified: 'Hunter couldn’t verify it', file: 'From Hunter’s file', onfile: 'Already on file',
}

export type PushPerson = {
  targetId: string | null; contactId: string; name: string; first?: string | null; last?: string | null; title?: string | null
  email: string | null; linkedinUrl?: string | null; notes?: string | null
  brandId: string; brandName: string; website?: string | null; domain?: string | null; group?: string | null
  handed?: boolean          // already has an InstantlyLead
  stopped?: string | null   // why they're never contacted, in words
  // Which template their brand's category gets (cold-templates.ts) and the
  // Instantly campaign that template lives in: null = that campaign isn't
  // set up yet, so they can't go; left out = no routing (one campaign).
  tpl?: string | null; tplLabel?: string | null; campaignId?: string | null
}
export type PushAction = 'send' | 'handed' | 'bad' | 'stopped' | 'nocamp'
export type PushLine = {
  targetId: string | null; contactId: string; name: string; title: string | null; brandId: string; brandName: string; email: string
  source: EmailSource; action: PushAction; why: string; tick: boolean; group: string | null
  tpl: string | null; tplLabel: string | null; campaignId: string | null
}
export type PushPlan = { lines: PushLine[]; counts: Record<PushAction, number> & { ticked: number; brands: number; fresh: number }; sig: string }
// The group of someone at a brand nobody has reached out to yet (find-emails.ts).
export const FRESH_GROUP = 'fresh'

// Everyone with an address who hasn't been emailed: who can go, and who is
// ticked to begin with. Unticked: an address Hunter couldn't verify and a
// shared inbox like info@ (those bounce or land on nobody's desk) — and
// anyone at a brand not reached on LinkedIn yet: an email makes the brand
// "reached", and the LinkedIn queue only picks brands nobody has reached, so
// that's Leo's call, brand by brand or the whole group. Lines are keyed by
// the person (contactId): someone with no outreach row yet gets one when
// they're sent (targetId null until then).
export function planPush(people: PushPerson[]): PushPlan {
  const lines: PushLine[] = []
  const used = new Set<string>()
  for (const p of people) {
    const email = cleanEmail(p.email)
    const source = emailSource(p.notes)
    const base = {
      targetId: p.targetId, contactId: p.contactId, name: p.name, title: p.title ?? null, brandId: p.brandId, brandName: p.brandName, email, source, group: p.group ?? null,
      tpl: p.tpl ?? null, tplLabel: p.tplLabel ?? null, campaignId: p.campaignId ?? null,
    }
    const put = (action: PushAction, why: string, tick = false) => lines.push({ ...base, action, why, tick })
    if (p.handed) { put('handed', 'Already in Instantly'); continue }
    if (!looksLikeEmail(email)) { put('bad', 'Not an email address'); continue }
    if (p.stopped) { put('stopped', p.stopped); continue }
    if (used.has(email)) { put('bad', 'Someone else on the list has this address'); continue }
    used.add(email)
    if (p.campaignId === null) { put('nocamp', 'No Instantly campaign for ' + (p.tplLabel || 'their template') + ' yet — set it up under Templates'); continue }
    const role = isRoleInbox(email)
    const free = !mailDomain(email)
    const fresh = p.group === FRESH_GROUP
    const why = (role ? 'A shared inbox (' + email.split('@')[0] + '@) — not a person'
      : source === 'unverified' ? SOURCE_WORDS.unverified
      : free ? SOURCE_WORDS[source] + ' · a personal address'
      : SOURCE_WORDS[source]) + (fresh ? ' · brand not reached on LinkedIn yet' : '')
    put('send', why, !role && source !== 'unverified' && !fresh)
  }
  const counts = { send: 0, handed: 0, bad: 0, stopped: 0, nocamp: 0, ticked: 0, brands: 0, fresh: 0 } as PushPlan['counts']
  const brands = new Set<string>()
  for (const l of lines) {
    counts[l.action] += 1
    if (l.action !== 'send') continue
    brands.add(l.brandId)
    if (l.tick) counts.ticked += 1
    if (l.group === FRESH_GROUP) counts.fresh += 1
  }
  counts.brands = brands.size
  return { lines, counts, sig: sigOf(lines.filter(l => l.action === 'send').map(l => l.contactId + ':' + l.email + (l.campaignId ? ':' + l.campaignId : ''))) }
}

// The lead Instantly gets. Only what a cold email needs: the address, the
// name, the company, the title, the website, their own Show Board link — and
// our id for the person, which comes back on every event. Nothing else
// about them leaves.
export type InstantlyLeadIn = {
  email: string; first_name?: string; last_name?: string; company_name?: string; job_title?: string; website?: string
  custom_variables?: Record<string, string>
}
export function leadFor(p: { name: string; first?: string | null; last?: string | null; title?: string | null; email: string; brandName: string; website?: string | null; domain?: string | null; contactId: string; boardLink?: string | null }): InstantlyLeadIn {
  const nm = p.first ? { first: p.first, last: p.last ?? '' } : splitName(p.name)
  const first = nm?.first || String(p.name ?? '').trim().split(/\s+/)[0] || ''
  const site = websiteDomain(p.website) || p.domain || mailDomain(p.email) || ''
  const out: InstantlyLeadIn = { email: cleanEmail(p.email) }
  if (first) out.first_name = first
  if (nm?.last) out.last_name = nm.last
  if (p.brandName) out.company_name = p.brandName
  if (p.title) out.job_title = String(p.title).slice(0, 200)
  if (site) out.website = site
  out.custom_variables = { sb_id: p.contactId }
  // Their own Show Board link — the template's (BOARD), {{board_link}} in Instantly.
  if (p.boardLink) out.custom_variables.board_link = p.boardLink
  return out
}

// ---- what Instantly tells us -----------------------------------------

export type EventKind = 'sent' | 'reply' | 'autoreply' | 'bounce' | 'unsub' | 'open' | 'click' | 'other'
const EVENT_KIND: Record<string, EventKind> = {
  email_sent: 'sent', reply_received: 'reply', auto_reply_received: 'autoreply', lead_out_of_office: 'autoreply',
  email_bounced: 'bounce', lead_unsubscribed: 'unsub', email_opened: 'open', email_link_clicked: 'click', link_clicked: 'click',
}
export type InstantlyEvent = {
  kind: EventKind; type: string; email: string; campaignId: string | null; at: Date
  step: number | null; emailId: string | null; subject: string | null; text: string | null; account: string | null
}
const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
// A webhook body (guides/webhook-events): the parts we keep. Null when it
// names no lead — a campaign or account event.
export function readEvent(body: unknown, now: Date = new Date()): InstantlyEvent | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const type = String(b.event_type ?? '').trim()
  const email = cleanEmail(b.lead_email ?? b.email)
  if (!type || !looksLikeEmail(email)) return null
  const kind = EVENT_KIND[type] ?? 'other'
  const when = new Date(String(b.timestamp ?? ''))
  // A clock ahead of ours is read as now; never a time to come.
  const at = isNaN(when.getTime()) || when.getTime() > now.getTime() + 5 * 60000 ? now : when
  const step = Number(b.step)
  const reply = kind === 'reply' || kind === 'autoreply'
  return {
    kind, type, email, campaignId: str(b.campaign_id, 80), at,
    step: isFinite(step) && step > 0 ? Math.round(step) : null,
    emailId: str(b.email_id, 120),
    subject: str(reply ? (b.reply_subject ?? b.email_subject) : b.email_subject, 300),
    text: str(reply ? (b.reply_text ?? b.reply_text_snippet) : b.email_text, 20000),
    account: str(b.email_account, 200),
  }
}

// The dashboard's row for a lead.
export type LeadState = 'waiting' | 'sent' | 'replied' | 'bounced' | 'unsubscribed' | 'done' | 'removed'
export const ACTIVE_STATES: LeadState[] = ['waiting', 'sent']
export const isActive = (state: unknown) => state === 'waiting' || state === 'sent'
export const STATE_WORDS: Record<LeadState, string> = {
  waiting: 'In Instantly, not emailed yet', sent: 'Emailed', replied: 'Replied', bounced: 'Bounced',
  unsubscribed: 'Unsubscribed', done: 'Finished, no answer', removed: 'Taken out',
}
// How far a row got — a later read never moves it backwards.
const STATE_RANK: Record<LeadState, number> = { waiting: 0, sent: 1, done: 2, removed: 2, bounced: 3, replied: 4, unsubscribed: 5 }
export const stateBeats = (next: LeadState, cur: LeadState) => STATE_RANK[next] > STATE_RANK[cur]

// A lead as Instantly lists it (POST /api/v2/leads/list), the parts we read.
export type InstantlyLeadOut = {
  id: string; email?: string | null; campaign?: string | null; status?: number | null
  email_reply_count?: number | null; email_open_count?: number | null
  timestamp_last_contact?: string | null; timestamp_last_reply?: string | null; timestamp_created?: string | null
  lt_interest_status?: number | null; payload?: Record<string, unknown> | null
  status_summary?: { lastStep?: { stepID?: string | null; timestamp_executed?: string | null } | null } | null
}
const when = (v: unknown): Date | null => { const d = v ? new Date(String(v)) : null; return d && !isNaN(d.getTime()) ? d : null }
// What a listed lead says happened. `replied` is only a maybe: an
// out-of-office counts as a reply there, so the sync reads the email itself
// before it believes one (instantly-db.ts).
export function leadFacts(l: InstantlyLeadOut) {
  const status = Number(l.status ?? 0)
  const replies = Number(l.email_reply_count ?? 0) || 0
  const contacted = when(l.timestamp_last_contact) ?? when(l.status_summary?.lastStep?.timestamp_executed)
  return {
    email: cleanEmail(l.email), leadId: String(l.id || ''), campaignId: l.campaign ? String(l.campaign) : null,
    bounced: status === -1, unsubscribed: status === -2, skipped: status === -3, completed: status === 3,
    contactedAt: contacted, maybeReplied: replies > 0 && Number(l.lt_interest_status) !== 0, repliedAt: when(l.timestamp_last_reply),
    sbId: typeof l.payload?.sb_id === 'string' ? (l.payload.sb_id as string) : null,
  }
}
// The state a listed lead puts the row in (a reply is settled apart).
export function stateOfLead(f: ReturnType<typeof leadFacts>): LeadState {
  if (f.unsubscribed) return 'unsubscribed'
  if (f.bounced) return 'bounced'
  if (f.completed) return 'done'
  if (f.skipped) return 'removed'
  return f.contactedAt ? 'sent' : 'waiting'
}

// ---- who comes back out ----------------------------------------------

export type BackFacts = {
  state: string; handedEmail: string; emailNow: string | null
  contactStopped: boolean; declined: boolean; brandStopped: boolean
  brandArchived: boolean; brandNoEmail: boolean
  status: string                    // the outreach row's status
  callBooked: boolean
  // Someone else at the brand wrote back, said no or has a call (Reach out
  // again's rule: "if someone has replied then we prob shouldnt reach out to
  // their company again").
  brandAnswered: boolean
}
// A lead still being emailed that shouldn't be. `block` = also put the
// address on Instantly's block list, so no campaign of his ever writes to
// them (a stop). Null = leave it where it is.
export function pullBackWhy(f: BackFacts): { why: string; block: boolean } | null {
  if (!isActive(f.state)) return null
  if (f.contactStopped || f.declined) return { why: 'They said they don’t want to continue', block: true }
  if (f.brandStopped) return { why: 'The brand said it doesn’t want to continue', block: true }
  if (!f.emailNow || cleanEmail(f.emailNow) !== cleanEmail(f.handedEmail)) return { why: 'Their email was changed on the dashboard', block: false }
  if (f.callBooked) return { why: 'A call is booked with them', block: false }
  if (f.status === 'accepted') return { why: 'They accepted on LinkedIn — on Zach’s list now', block: false }
  if (['replied', 'converted', 'declined'].includes(f.status)) return { why: 'They answered on LinkedIn', block: false }
  if (f.brandArchived) return { why: 'The brand was archived', block: false }
  if (f.brandNoEmail) return { why: 'The brand is marked do not email', block: false }
  if (f.brandAnswered) return { why: 'Someone else at the brand answered', block: false }
  return null
}

// ---- small things ----------------------------------------------------

// An email's place in the sequence → the kind the dashboard files it under
// (the brand page's words: intro, follow-up). Never 'followup2' — that one
// feeds the dashboard's own "went quiet" list.
export const kindOfStep = (step: number | null | undefined) => (step && step > 1 ? 'followup' : 'intro')

// The emails API gives the step as text. Only the "sequence_step_variant"
// form ("0_1_0" = the second email) is read; anything else is left to the
// order the emails arrive in (the first is the intro).
export function stepOfEmail(step: unknown): number | null {
  const m = String(step ?? '').match(/^\d+_(\d+)(?:_\d+)?$/)
  return m ? Number(m[1]) + 1 : null
}

// The line a bounce leaves in the person's notes.
export const bounceNote = (email: string, day: string) => 'Email to ' + email + ' bounced (Instantly, ' + day + ')'

// A new batch id: sortable by time, unique enough for an Undo.
export const batchId = (now: Date = new Date()) => 'ib' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 7)
