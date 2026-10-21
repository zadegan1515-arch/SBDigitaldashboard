// Elizabeth's outreach (Leo, Oct 21 2026: "a new outreach tab for Elizabeth
// to use her email to outreach to some brands … a different part to the site
// soley for Elizabeth and I want the brands and the same structure for
// outreach to carry over"). His picks: LinkedIn invites from her LinkedIn AND
// emails from her own Gmail; any brand; no rules between her and Zach (the
// same person can hear from both); Tue–Thu, 30 a day; her own sign-in sees
// only her part (Operations → Team marks the account).
//
// The same shape as Zach's outreach, kept simple: a week plan (brands on her
// sending days), today's list (whole brands, best people first), follow-ups
// on Zach's list's cadence, results. Her rows live in RepOutreach, apart from
// Zach's Target rows. Nothing sends from the site: an email is Open in Gmail
// (her own account) + "Email sent ✓".
//
// Pure: the routes load the rows and write what comes back.
// node scripts/test-rep-outreach.mjs

import { buyerRank, personProblem } from './queue-check'

export const REP = 'elizabeth'
export const REP_NAME = 'Elizabeth'
export const REP_DAILY = 30
// One LinkedIn account caps near 100 invites a rolling week (her own).
export const REP_LI_WEEK = 100
// Tue / Wed / Thu, like Zach.
export const REP_DOWS = [2, 3, 4]
// The cadence (Zach's list's, Oct 5 2026; email like the email machine's
// first follow-up, a day later so it lands on her next sending day).
export const REP_DAYS = { dm: 2, final: 10, quiet: 7, emailFollow: 4, emailQuiet: 7, oldInvite: 21 }

// Settings.
export const REP_PLAN_KEY = 'repPlan:' + REP           // { day: brandIds[] }
export const REP_PLAN_LAST_KEY = 'repPlanLast:' + REP  // the plan before the last spread (its Undo)
export const REP_TPL_KEY = 'repTemplates:' + REP       // { kind: { subject, body, savedAt, savedBy } }
export const REP_ACCOUNTS_KEY = 'repAccounts'          // { email: { rep, at, by } }
// Kept this many days back (the roll reads past days; older ones are pruned).
export const PLAN_KEEP_DAYS = 21

export type Channel = 'linkedin' | 'email'
export type Plan = Record<string, string[]>

// ── Days ─────────────────────────────────────────────────────────────
export function addDays(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}
export function dowOf(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay()
}
export function isSendingKey(key: string): boolean {
  return REP_DOWS.includes(dowOf(key))
}
// The first sending day on or after `key` (a due date on Fri–Mon moves to
// Tuesday, Zach's list's rule).
export function onSendingDay(key: string): string {
  let k = key
  for (let i = 0; i < 7 && !isSendingKey(k); i++) k = addDays(k, 1)
  return k
}
export function nextSendingAfter(key: string): string {
  return onSendingDay(addDays(key, 1))
}
// Her week plan's days: this week's sending days from today on (today too,
// when it is one), and next week's.
export function weekDays(today: string): Array<{ start: string; which: 'this' | 'next'; days: string[] }> {
  const dow = dowOf(today)
  const thisStart = addDays(today, dow === 0 ? -6 : 1 - dow)
  const nextStart = addDays(thisStart, 7)
  const daysOf = (start: string) => Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter(k => k >= today && isSendingKey(k))
  const out: Array<{ start: string; which: 'this' | 'next'; days: string[] }> = []
  const mine = daysOf(thisStart)
  if (mine.length) out.push({ start: thisStart, which: 'this', days: mine })
  out.push({ start: nextStart, which: 'next', days: daysOf(nextStart) })
  return out
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5)
}

// ── Who she reaches, and how ──────────────────────────────────────────
export type Reach = { email?: string | null; linkedinUrl?: string | null }
function hasEmail(p: Reach) { return !!(p.email && /@/.test(p.email)) }
function hasLink(p: Reach) { return !!(p.linkedinUrl && /linkedin\.com\/in\//i.test(p.linkedinUrl)) }
// Email when we have an address (it's her own inbox — the reason she has
// this tab), else a LinkedIn invite; `prefer` = the row's switch.
export function channelFor(p: Reach, prefer?: Channel | null): Channel | null {
  if (prefer === 'linkedin' && hasLink(p)) return 'linkedin'
  if (prefer === 'email' && hasEmail(p)) return 'email'
  return hasEmail(p) ? 'email' : hasLink(p) ? 'linkedin' : null
}
export function otherChannel(p: Reach, ch: Channel): Channel | null {
  const o: Channel = ch === 'email' ? 'linkedin' : 'email'
  return o === 'email' ? (hasEmail(p) ? o : null) : (hasLink(p) ? o : null)
}

export type Person = Reach & { id: string; name: string; title: string | null; doNotContactAt?: Date | string | null }
// Best first: a buyer the title rules don't flag, partnerships > events >
// marketing = founder, then an email (her own channel), then a LinkedIn link.
export function comparePeople(a: Person, b: Person, names?: string[]): number {
  return Number(!!personProblem(a.title, names)) - Number(!!personProblem(b.title, names)) ||
    buyerRank(b.title) - buyerRank(a.title) ||
    Number(hasEmail(b)) - Number(hasEmail(a)) ||
    Number(hasLink(b)) - Number(hasLink(a))
}
export function sortPeople<T extends Person>(list: T[], names?: string[]): T[] {
  return list.map((p, i) => ({ p, i })).sort((x, y) => comparePeople(x.p, y.p, names) || x.i - y.i).map(x => x.p)
}
// Who goes out at a brand: up to `n` people she can reach and hasn't yet
// (`taken` = contact ids she has a row for), nobody who said they don't
// want to be contacted, flagged titles only when there is nobody else.
function pickPool(people: Person[], taken: ReadonlySet<string>, names?: string[]): Person[] {
  const cands = sortPeople(people.filter(p => !p.doNotContactAt && !taken.has(p.id) && channelFor(p)), names)
  const clean = cands.filter(p => !personProblem(p.title, names))
  return clean.length ? clean : cands
}
export function pickPeople(people: Person[], taken: ReadonlySet<string>, n: number, names?: string[]): Array<{ person: Person; channel: Channel }> {
  return pickPool(people, taken, names).slice(0, Math.max(0, n)).map(person => ({ person, channel: channelFor(person) as Channel }))
}
// How many she could still send to there — the people pickPeople would
// choose from (for the week plan's counts, so they match today's list).
export function reachableLeft(people: Person[], taken: ReadonlySet<string>, names?: string[]): number {
  return pickPool(people, taken, names).length
}

// ── A day's list ──────────────────────────────────────────────────────
// Whole brands in plan order while they fit the room; one that doesn't fit
// waits (a smaller one after it can still go) and the roll moves it on.
export function fillDay(brands: Array<{ id: string; size: number }>, room: number): { take: string[]; waits: string[]; none: string[] } {
  let left = Math.max(0, room)
  const take: string[] = [], waits: string[] = [], none: string[] = []
  for (const b of brands) {
    if (!(b.size > 0)) { none.push(b.id); continue }
    if (b.size <= left) { take.push(b.id); left -= b.size }
    else waits.push(b.id)
  }
  return { take, waits, none }
}

// The plan as stored → only day keys and string ids, each brand once (its
// earliest day wins).
export function cleanPlan(v: unknown): Plan {
  const out: Plan = {}
  if (!v || typeof v !== 'object') return out
  const seen = new Set<string>()
  for (const day of Object.keys(v as any).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort()) {
    const ids = (v as any)[day]
    if (!Array.isArray(ids)) continue
    const list = ids.filter((x: unknown) => typeof x === 'string' && x && !seen.has(x)) as string[]
    list.forEach(id => seen.add(id))
    if (list.length) out[day] = list
  }
  return out
}
export function dayOf(plan: Plan, brandId: string): string | null {
  for (const [d, ids] of Object.entries(plan)) if (ids.includes(brandId)) return d
  return null
}
// Put a brand on a day (at `index`, else the end); off any other day.
export function planPut(plan: Plan, brandId: string, day: string, index?: number | null): Plan {
  const out: Plan = {}
  for (const [d, ids] of Object.entries(plan)) {
    const list = ids.filter(id => id !== brandId)
    if (list.length) out[d] = list
  }
  const list = out[day] ? [...out[day]] : []
  const at = index == null || index < 0 || index > list.length ? list.length : index
  list.splice(at, 0, brandId)
  out[day] = list
  return out
}
export function planRemove(plan: Plan, brandId: string): Plan {
  const out: Plan = {}
  for (const [d, ids] of Object.entries(plan)) {
    const list = ids.filter(id => id !== brandId)
    if (list.length) out[d] = list
  }
  return out
}

// Unsent work rolls forward (Leo's rule for Zach, Sep 26 2026). A brand
// planned on a past day that never made it onto that day's list (`built` =
// "day|brandId" for every brand a list was made for) goes first on `to` —
// the next sending day from today on — older days first. A brand already on
// a later day stays there. Brands whose list was made stay on their day as
// history; rows still unsent carry themselves (today's list shows them).
// Days older than PLAN_KEEP_DAYS are dropped.
export function rollPlan(plan: Plan, today: string, built: ReadonlySet<string>): { plan: Plan; moved: Array<{ id: string; from: string; to: string }> } {
  const to = onSendingDay(today)
  const keepFrom = addDays(today, -PLAN_KEEP_DAYS)
  const later = new Set<string>()
  for (const [d, ids] of Object.entries(plan)) if (d >= today) ids.forEach(id => later.add(id))
  const out: Plan = {}
  const front: string[] = []
  const moved: Array<{ id: string; from: string; to: string }> = []
  for (const d of Object.keys(plan).sort()) {
    const ids = plan[d]
    if (d >= today) { out[d] = [...(out[d] ?? []), ...ids]; continue }
    const stay: string[] = []
    for (const id of ids) {
      if (built.has(d + '|' + id)) stay.push(id)
      else if (!later.has(id) && !front.includes(id)) { front.push(id); moved.push({ id, from: d, to }) }
    }
    if (stay.length && d >= keepFrom) out[d] = stay
  }
  if (front.length) out[to] = [...front, ...(out[to] ?? []).filter(id => !front.includes(id))]
  return { plan: out, moved }
}

// ── Where a row stands (her follow-ups) ───────────────────────────────
export type RowLike = {
  channel: string; status: string; day?: string | null
  sentAt?: Date | string | null; acceptedAt?: Date | string | null; dmAt?: Date | string | null
  followAt?: Date | string | null; repliedAt?: Date | string | null; callAt?: Date | string | null
  callBookedAt?: Date | string | null; doneAt?: Date | string | null
}
export type Group = 'list' | 'todo' | 'waiting' | 'replied' | 'call' | 'noreply' | 'done'
export type Stage =
  | 'queued' | 'invited' | 'oldInvite' | 'dmDue' | 'finalDue' | 'finalOut'
  | 'emailed' | 'followDue' | 'followOut' | 'noreply'
  | 'replied' | 'call' | 'declined' | 'passed' | 'withdrawn'
export type Standing = { stage: Stage; group: Group; due: string | null; late: boolean; next: string }

const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
export function nyKey(d: Date | string): string {
  return NY_DAY.format(typeof d === 'string' ? new Date(d) : d)
}
function keyOf(v: Date | string | null | undefined): string | null {
  return v ? nyKey(v) : null
}
function dueStanding(stage: Stage, due: string, today: string, next: string): Standing {
  return { stage, group: due <= today ? 'todo' : 'waiting', due, late: due < today, next }
}

export function standing(r: RowLike, today: string): Standing {
  const at = { sent: keyOf(r.sentAt), acc: keyOf(r.acceptedAt), dm: keyOf(r.dmAt), fol: keyOf(r.followAt) }
  if (r.status === 'queued') return { stage: 'queued', group: 'list', due: r.day ?? null, late: !!r.day && r.day < today, next: 'On your list' }
  if (r.status === 'passed') return { stage: 'passed', group: 'done', due: null, late: false, next: 'Left out' }
  if (r.status === 'withdrawn') return { stage: 'withdrawn', group: 'done', due: null, late: false, next: 'Invite withdrawn' }
  if (r.status === 'declined') return { stage: 'declined', group: 'done', due: null, late: false, next: 'Doesn’t want to continue' }
  if (r.status === 'call') return { stage: 'call', group: 'call', due: keyOf(r.callAt), late: false, next: 'Call booked' }
  if (r.status === 'replied') return { stage: 'replied', group: 'replied', due: keyOf(r.repliedAt), late: false, next: 'They replied — book a call' }
  if (r.channel === 'linkedin') {
    if (r.status === 'sent' || !at.acc) {
      const since = at.sent ?? today
      const old = addDays(since, REP_DAYS.oldInvite)
      if (old <= today) return { stage: 'oldInvite', group: 'todo', due: old, late: old < today, next: 'Old invite — withdraw it on LinkedIn' }
      return { stage: 'invited', group: 'waiting', due: null, late: false, next: 'Invite out — waiting for them to accept' }
    }
    if (!at.dm) return dueStanding('dmDue', onSendingDay(addDays(at.acc, REP_DAYS.dm)), today, 'Text them on LinkedIn')
    if (!at.fol) return dueStanding('finalDue', onSendingDay(addDays(at.dm, REP_DAYS.final)), today, 'Send the final reach-out')
    const quiet = addDays(at.fol, REP_DAYS.quiet)
    if (quiet <= today) return { stage: 'noreply', group: 'noreply', due: quiet, late: false, next: 'No response' }
    return { stage: 'finalOut', group: 'waiting', due: quiet, late: false, next: 'Final reach-out sent — waiting' }
  }
  // email
  const sent = at.sent ?? today
  if (!at.fol) return dueStanding('followDue', onSendingDay(addDays(sent, REP_DAYS.emailFollow)), today, 'Send a follow-up email')
  const quiet = addDays(at.fol, REP_DAYS.emailQuiet)
  if (quiet <= today) return { stage: 'noreply', group: 'noreply', due: quiet, late: false, next: 'No response' }
  return { stage: 'followOut', group: 'waiting', due: quiet, late: false, next: 'Follow-up sent — waiting' }
}
// Earliest step first, then the longest waiting (Zach's list's order).
const STAGE_ORDER: Stage[] = ['dmDue', 'followDue', 'finalDue', 'oldInvite', 'replied', 'invited', 'emailed', 'followOut', 'finalOut', 'call', 'noreply', 'queued', 'declined', 'withdrawn', 'passed']
export function compareStanding(a: Standing, b: Standing): number {
  return STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
    String(a.due ?? '9999').localeCompare(String(b.due ?? '9999'))
}

// ── Steps ─────────────────────────────────────────────────────────────
export type StepName = 'sent' | 'accepted' | 'dm' | 'follow' | 'replied' | 'call' | 'declined' | 'withdrawn' | 'passed' | 'unpass'
export type StepEntry = { s: StepName; at: string; by: string | null; before: Record<string, unknown> }
export const STEP_FIELDS = ['status', 'sentAt', 'acceptedAt', 'dmAt', 'followAt', 'repliedAt', 'callAt', 'callBookedAt', 'doneAt'] as const
type FullRow = RowLike & { steps?: unknown }

const SENT_LIKE = ['sent', 'accepted', 'replied', 'call']
// What a step writes, or why it can't. `callDay` = YYYY-MM-DD for 'call'.
export function stepData(r: FullRow, step: StepName, now: Date, opts: { callDay?: string | null } = {}): { data: Record<string, unknown> } | { refuse: string } {
  const st = r.status
  const li = r.channel === 'linkedin'
  switch (step) {
    case 'sent':
      if (st !== 'queued') return { refuse: 'Already marked ' + (st === 'passed' ? 'left out' : 'sent') }
      return { data: { status: 'sent', sentAt: now } }
    case 'accepted':
      if (!li) return { refuse: 'Only a LinkedIn invite is accepted' }
      if (st !== 'sent') return { refuse: st === 'queued' ? 'Mark the invite sent first' : 'Already past that step' }
      return { data: { status: 'accepted', acceptedAt: now } }
    case 'dm':
      if (!li || st !== 'accepted') return { refuse: 'The LinkedIn message comes after they accept' }
      if (r.dmAt) return { refuse: 'Already messaged' }
      return { data: { dmAt: now } }
    case 'follow':
      if (li) {
        if (st !== 'accepted' || !r.dmAt) return { refuse: 'The final reach-out comes after the first message' }
      } else if (st !== 'sent') return { refuse: 'The follow-up comes after the email' }
      if (r.followAt) return { refuse: 'Already followed up' }
      return { data: { followAt: now } }
    case 'replied':
      if (!['sent', 'accepted'].includes(st)) return { refuse: st === 'queued' ? 'Nothing has gone to them yet' : 'Already past that step' }
      return { data: { status: 'replied', repliedAt: now, ...(li && !r.acceptedAt ? { acceptedAt: now } : {}) } }
    case 'call': {
      if (!SENT_LIKE.includes(st)) return { refuse: 'Nothing has gone to them yet' }
      const d = String(opts.callDay ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { refuse: 'Pick the call’s day' }
      return { data: { status: 'call', callAt: new Date(`${d}T16:00:00Z`), callBookedAt: now, ...(r.repliedAt ? {} : { repliedAt: now }) } }
    }
    case 'declined':
      if (!SENT_LIKE.includes(st)) return { refuse: 'Nothing has gone to them yet — use Leave out' }
      return { data: { status: 'declined', doneAt: now } }
    case 'withdrawn':
      if (!li || st !== 'sent') return { refuse: 'Only an invite they haven’t accepted can be withdrawn' }
      return { data: { status: 'withdrawn', doneAt: now } }
    case 'passed':
      if (st !== 'queued') return { refuse: 'Already sent — use Doesn’t want to continue' }
      return { data: { status: 'passed', doneAt: now } }
    case 'unpass':
      if (st !== 'passed') return { refuse: 'Not left out' }
      return { data: { status: 'queued', doneAt: null } }
  }
  return { refuse: 'Unknown step' }
}
export function readSteps(v: unknown): StepEntry[] {
  return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && typeof (x as any).s === 'string') as StepEntry[] : []
}
// The step and what it changed, for Back a step.
export function stepEntry(r: FullRow & Record<string, unknown>, step: StepName, data: Record<string, unknown>, now: Date, by: string | null): StepEntry {
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(data)) {
    const v = (r as any)[k]
    before[k] = v instanceof Date ? v.toISOString() : v ?? null
  }
  return { s: step, at: now.toISOString(), by, before }
}
// Back a step: the latest step's fields as they were.
export function backData(r: FullRow): { data: Record<string, unknown>; steps: StepEntry[]; undone: StepName } | { refuse: string } {
  const steps = readSteps(r.steps)
  const last = steps[steps.length - 1]
  if (!last) return { refuse: 'Nothing to take back' }
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(last.before)) {
    data[k] = typeof v === 'string' && k !== 'status' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v
  }
  return { data, steps: steps.slice(0, -1), undone: last.s }
}
export const STEP_WORD: Record<StepName, string> = {
  sent: 'Marked sent', accepted: 'They accepted', dm: 'Messaged on LinkedIn', follow: 'Followed up',
  replied: 'They replied', call: 'Call booked', declined: 'Doesn’t want to continue', withdrawn: 'Invite withdrawn',
  passed: 'Left out', unpass: 'Back on the list',
}

// ── Templates ────────────────────────────────────────────────────────
export type TplKind = 'note' | 'dm' | 'final' | 'email' | 'follow'
export const TPL_KINDS: TplKind[] = ['email', 'follow', 'note', 'dm', 'final']
export const TPL_DEFAULTS: Record<TplKind, { subject: string; body: string }> = {
  // The LinkedIn invite note (300 characters at most once filled).
  note: {
    subject: '',
    body: 'Hi (NAME), I’m Elizabeth with SB Agency — we book top artist talent for fraternities and sororities across the country. ' +
      'Would love to connect and see if (BRAND) wants to activate at these events.',
  },
  // The first LinkedIn message after they accept (Leo's LinkedIn DM).
  dm: {
    subject: '',
    body: 'Hey (NAME), great to be connected. Would love to share ideas and put something together with (BRAND). ' +
      'Do you have 15 minutes for a quick chat later this week?',
  },
  final: {
    subject: '',
    body: 'Hi (NAME), one last note from me so I don’t clutter your inbox. If a college activation for (BRAND) is ever on the table, ' +
      'I’d love to show you what we’re putting together this season. Happy to send the deck whenever it’s useful. Thanks!',
  },
  email: {
    subject: 'SB Agency × (BRAND)',
    body: [
      'Hi (NAME),',
      '',
      'I’m Elizabeth with SB Agency — we book top artist talent for fraternity and sorority events across the country and build brand activations around those shows.',
      '',
      'Would love to share some ideas and put something together with (BRAND) around our college events. Do you have 15 minutes for a quick call later this week?',
      '',
      'Thanks!',
      'Elizabeth',
      'SB Agency',
    ].join('\n'),
  },
  follow: {
    subject: 'Re: SB Agency × (BRAND)',
    body: [
      'Hi (NAME),',
      '',
      'Just bumping this up in case it got buried. Happy to send over this semester’s show list, or grab 15 minutes if that’s easier — whatever works best.',
      '',
      'Thanks!',
      'Elizabeth',
    ].join('\n'),
  },
}
export const NOTE_MAX = 300
// (NAME) / (FIRST NAME) → first name, (BRAND) / (COMPANY), (TITLE); [Name]
// and [Brand] too — the same as Zach's templates.
export function fillTemplate(text: string, p: { name: string; brand: string; title?: string | null }): string {
  const first = String(p.name || '').trim().split(/\s+/)[0] || 'there'
  return String(text || '')
    .replace(/[(\[](?:first\s*)?name[)\]]/gi, first)
    .replace(/[(\[](?:brand|company)[)\]]/gi, p.brand || '')
    .replace(/[(\[]title[)\]]/gi, p.title || '')
}
export function cleanTemplates(v: unknown): Record<TplKind, { subject: string; body: string; saved: boolean; savedAt: string | null; savedBy: string | null }> {
  const out: any = {}
  for (const k of TPL_KINDS) {
    const s = v && typeof v === 'object' ? (v as any)[k] : null
    const ok = s && typeof s.body === 'string' && s.body.trim()
    out[k] = ok
      ? { subject: String(s.subject ?? ''), body: String(s.body), saved: true, savedAt: s.savedAt ?? null, savedBy: s.savedBy ?? null }
      : { ...TPL_DEFAULTS[k], saved: false, savedAt: null, savedBy: null }
  }
  return out
}

// ── Accounts that see only her part ───────────────────────────────────
export type RepAccount = { rep: string; at: string; by: string | null }
export function cleanAccounts(v: unknown): Record<string, RepAccount> {
  const out: Record<string, RepAccount> = {}
  if (!v || typeof v !== 'object') return out
  for (const [email, a] of Object.entries(v as any)) {
    const e = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+$/.test(e) || !a || typeof a !== 'object') continue
    if ((a as any).rep !== REP) continue
    out[e] = { rep: REP, at: String((a as any).at ?? ''), by: (a as any).by ?? null }
  }
  return out
}

// ── Results ──────────────────────────────────────────────────────────
export type Counts = { invites: number; accepted: number; emails: number; replied: number; calls: number; acceptRate: number | null; replyRate: number | null }
export function countRows(rows: RowLike[], from: string | null, today: string): Counts {
  const inWin = (v: Date | string | null | undefined) => { const k = keyOf(v); return !!k && (!from || k >= from) && k <= today }
  const sent = rows.filter(r => inWin(r.sentAt))
  const invites = sent.filter(r => r.channel === 'linkedin')
  const emails = sent.filter(r => r.channel === 'email')
  const accepted = invites.filter(r => !!r.acceptedAt).length
  const repliedOf = sent.filter(r => !!r.repliedAt).length
  return {
    invites: invites.length,
    accepted: rows.filter(r => r.channel === 'linkedin' && inWin(r.acceptedAt)).length,
    emails: emails.length,
    replied: rows.filter(r => inWin(r.repliedAt)).length,
    calls: rows.filter(r => inWin(r.callBookedAt)).length,
    // Of what went out in the window, how much was answered.
    acceptRate: invites.length ? accepted / invites.length : null,
    replyRate: sent.length ? repliedOf / sent.length : null,
  }
}
// The last `n` days, newest first: what went out and what came back each day.
export function byDay(rows: RowLike[], today: string, n = 14): Array<{ day: string; invites: number; emails: number; accepted: number; replied: number }> {
  const out = []
  for (let i = 0; i < n; i++) {
    const day = addDays(today, -i)
    const on = (v: Date | string | null | undefined) => keyOf(v) === day
    out.push({
      day,
      invites: rows.filter(r => r.channel === 'linkedin' && on(r.sentAt)).length,
      emails: rows.filter(r => r.channel === 'email' && on(r.sentAt)).length,
      accepted: rows.filter(r => on(r.acceptedAt)).length,
      replied: rows.filter(r => on(r.repliedAt)).length,
    })
  }
  return out
}
// LinkedIn invites in the 7 days ending today (her account's weekly limit).
export function invitesThisWeek(rows: RowLike[], today: string): number {
  const from = addDays(today, -6)
  return rows.filter(r => r.channel === 'linkedin' && keyOf(r.sentAt) && (keyOf(r.sentAt) as string) >= from && (keyOf(r.sentAt) as string) <= today).length
}
// The brand's stage for her tag: r = replied / call, a = accepted, i =
// invite out, e = emailed. null = she hasn't reached it.
export function brandStageOf(rows: RowLike[]): 'r' | 'a' | 'i' | 'e' | null {
  const out = rows.filter(r => r.sentAt)
  if (!out.length) return null
  if (out.some(r => ['replied', 'call'].includes(r.status) || r.repliedAt)) return 'r'
  if (out.some(r => r.acceptedAt)) return 'a'
  if (out.some(r => r.channel === 'linkedin')) return 'i'
  return 'e'
}
