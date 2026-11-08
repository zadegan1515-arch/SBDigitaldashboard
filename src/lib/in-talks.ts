// In talks (Leo, Oct 18 2026: "for the brands where the call has been
// scheduled i want u to put them there … notes for each brand … the
// person/people we reached out to and accepted … a link to the website and
// brand socials like instagram and tiktok … an overview on the brand … not
// more than 4 sentences … an activation idea … editable … a copy button that
// we can paste into a new chat"). His picks: a call booked puts a brand here
// by itself and Add to In talks puts any other; its own top tab; a list +
// profile layout; Claude's daily check writes the overview and the idea (no
// API spend).
//
// Leo, Nov 8 2026: "every brand that has replied … I want their stage to be
// laid out clearly … the deal flow doesn't really incorporate everything that
// happens … I should be able to edit it and make notes, I want dates of when
// things happen". His picks: every brand that replied goes in by itself (Add
// still puts any other), a stage bar Replied → Call booked → Call done →
// Proposal sent → Negotiating → Verbal yes → Contract signed → Won (+ Lost,
// Gone quiet), each stage with the day it was reached, and a dated log he can
// add to and edit (TalksEvent).
//
// Pure rules here; the handlers (listInTalks, setInTalks, saveTalksProfile,
// addBrandNote, editBrandNote, deleteBrandNote, listTalksToFill,
// setTalksStage, addTalksEvent, editTalksEvent, deleteTalksEvent, talksLog)
// are in src/app/api/data/route.ts. node scripts/test-in-talks.mjs

import { acceptedStage, isAccepted, type AcceptedInput } from './accepted'

// ---- who's in ---------------------------------------------------

export type TalksFacts = {
  addedAt: Date | null       // Brand.talksAddedAt — Add to In talks
  removedAt: Date | null     // Brand.talksRemovedAt — Take off In talks
  callsBooked: Date[]        // every Target.callBookedAt at the brand
  // Every reply at the brand (Zach's rows, an email back, Elizabeth's rows).
  // Left out = the old rule (a call or a hand add only) — Every brand
  // reached's own "In talks" step still reads it that way.
  replies?: Date[]
}

export type TalksState = { on: boolean; why: 'call' | 'hand' | 'reply' | null; since: Date | null }

// A call booked, a hand add or (when given) a reply puts a brand in; taking
// it off wins over anything older, and a newer call, add or reply brings it
// back.
export function talksState(f: TalksFacts): TalksState {
  const after = (d: Date | null) => !!d && (!f.removedAt || d.getTime() > f.removedAt.getTime())
  const calls = f.callsBooked.filter(after)
  const hand = after(f.addedAt)
  const replies = (f.replies ?? []).filter(after)
  if (!calls.length && !hand && !replies.length) return { on: false, why: null, since: null }
  const times = [...calls, ...(hand ? [f.addedAt as Date] : []), ...replies].map(d => d.getTime())
  return { on: true, why: calls.length ? 'call' : hand ? 'hand' : 'reply', since: new Date(Math.min(...times)) }
}

// A brand that replied but isn't in talks: offered as "+ Add" until it's
// added or Not now (talksRemovedAt) — a newer reply offers it again.
export function suggestTalks(f: { replies: Date[]; removedAt: Date | null; on: boolean; stopped: boolean }): boolean {
  if (f.on || f.stopped || !f.replies.length) return false
  const last = Math.max(...f.replies.map(d => d.getTime()))
  return !f.removedAt || last > f.removedAt.getTime()
}

// ---- people -----------------------------------------------------

export type TalksPersonInput = AcceptedInput & { callBookedAt: Date | null }

// The people we reached out to who answered: accepted on LinkedIn, replied
// anywhere (email too), or a call booked with them.
export function isTalksPerson(t: TalksPersonInput): boolean {
  return isAccepted(t) || t.status === 'replied' || t.status === 'converted' || !!t.repliedAt || !!t.callAt || !!t.callBookedAt
}

// Their stage, one word (Home → Accepted's words: call booked / had a call /
// replied / messaged / accepted / said no / doesn't want to continue).
export function talksPersonStage(t: TalksPersonInput, now = new Date()) {
  return acceptedStage(t, now)
}

// Stage order for the people list: the furthest along first.
const STAGE_RANK: Record<string, number> = { call: 0, converted: 1, replied: 2, messaged: 3, accepted: 4, declined: 5, stopped: 6 }
export const stageRank = (s: string) => STAGE_RANK[s] ?? 9

// ---- how we got here ---------------------------------------------

export type JourneyPerson = {
  invitedAt: Date | null; acceptedAt: Date | null; accepted: boolean
  repliedAt: Date | null; replied: boolean; callBookedAt: Date | null; callAt: Date | null
}
export type JourneyStep = { key: 'invited' | 'accepted' | 'replied' | 'call' | 'deal'; label: string; done: boolean; at: Date | null }

const earliest = (ds: (Date | null)[]) => {
  const t = ds.filter((d): d is Date => !!d).map(d => d.getTime())
  return t.length ? new Date(Math.min(...t)) : null
}

// One line across the top of a profile: Invited → Accepted → Replied → Call
// booked → Deal, each with the first date anyone there reached it.
export function talksJourney(people: JourneyPerson[], deal: { stage: string; createdAt: Date } | null): JourneyStep[] {
  const any = (f: (p: JourneyPerson) => boolean) => people.some(f)
  const invitedAt = earliest(people.map(p => p.invitedAt))
  const acceptedAt = earliest(people.map(p => p.acceptedAt))
  const repliedAt = earliest(people.map(p => p.repliedAt))
  const callBookedAt = earliest(people.map(p => p.callBookedAt ?? (p.callAt ? p.callAt : null)))
  const dealOpen = !!deal && deal.stage !== 'lost'
  return [
    { key: 'invited', label: 'Invited', done: !!invitedAt || any(p => p.accepted || p.replied), at: invitedAt },
    { key: 'accepted', label: 'Accepted', done: any(p => p.accepted) || !!acceptedAt, at: acceptedAt },
    { key: 'replied', label: 'Replied', done: any(p => p.replied) || !!repliedAt, at: repliedAt },
    { key: 'call', label: 'Call booked', done: !!callBookedAt, at: callBookedAt },
    { key: 'deal', label: dealOpen ? 'Deal · ' + deal!.stage : 'Deal', done: dealOpen, at: dealOpen ? deal!.createdAt : null },
  ]
}

// ---- the stage (Leo, Nov 8 2026) --------------------------------------

export type TalksStageKey = 'replied' | 'call_booked' | 'call_done' | 'proposal' | 'negotiating' | 'verbal' | 'contract' | 'won' | 'lost' | 'quiet'

// The way forward, in order, then the two ways out.
export const TALKS_STAGES: Array<{ key: TalksStageKey; label: string }> = [
  { key: 'replied', label: 'Replied' },
  { key: 'call_booked', label: 'Call booked' },
  { key: 'call_done', label: 'Call done' },
  { key: 'proposal', label: 'Proposal sent' },
  { key: 'negotiating', label: 'Negotiating' },
  { key: 'verbal', label: 'Verbal yes' },
  { key: 'contract', label: 'Contract signed' },
  { key: 'won', label: 'Won' },
]
export const TALKS_ENDS: Array<{ key: TalksStageKey; label: string }> = [
  { key: 'lost', label: 'Lost' },
  { key: 'quiet', label: 'Gone quiet' },
]
const ALL_STAGES = [...TALKS_STAGES, ...TALKS_ENDS]
export const isTalksStage = (k: unknown): k is TalksStageKey => ALL_STAGES.some(s => s.key === k)
export const talksStageLabel = (k: string) => ALL_STAGES.find(s => s.key === k)?.label ?? k
export const isEndStage = (k: string) => k === 'lost' || k === 'quiet'
// 1..8 along the way; the ways out 0.
export const talksStageRank = (k: string) => TALKS_STAGES.findIndex(s => s.key === k) + 1

// The Deals board's stage a talks stage moves the brand's deal to (the
// stages before a proposal leave the deal alone; Gone quiet too).
export const DEAL_OF_STAGE: Partial<Record<TalksStageKey, string>> = {
  proposal: 'proposal', negotiating: 'proposal', verbal: 'verbal', contract: 'verbal', won: 'closed', lost: 'lost',
}
// And the other way: a deal moved on the Deals board shows on the bar.
const STAGE_OF_DEAL: Record<string, TalksStageKey> = { proposal: 'proposal', verbal: 'verbal', closed: 'won', lost: 'lost' }

// One dated mark of where a brand got to: set by hand on the stage bar
// (hand), or read from what happened (a reply, a call booked, a call's day
// gone by, the deal's stage, the brand saying stop).
export type StageMark = {
  stage: TalksStageKey; at: Date; hand: boolean
  by?: string | null; id?: string; createdAt?: Date; why?: string
}

export type AutoStageFacts = {
  replies: Date[]               // every reply
  callsBooked: Date[]           // when each call was booked
  calls: Date[]                 // each call's day (people still in play)
  deal: { stage: string; at: Date } | null   // the deal the profile shows
  stoppedAt: Date | null        // the brand doesn't want to continue
}

export function autoStageMarks(f: AutoStageFacts, now = new Date()): StageMark[] {
  const out: StageMark[] = []
  const seen = new Set<string>()
  const push = (stage: TalksStageKey, at: Date, why: string) => {
    const k = stage + '|' + at.getTime()
    if (seen.has(k)) return
    seen.add(k)
    out.push({ stage, at, hand: false, why })
  }
  for (const d of f.replies) push('replied', d, 'they replied')
  for (const d of f.callsBooked) push('call_booked', d, 'call booked')
  for (const d of f.calls) if (d.getTime() <= now.getTime()) push('call_done', d, 'the call’s day went by')
  const ds = f.deal ? STAGE_OF_DEAL[f.deal.stage] : undefined
  if (f.deal && ds) push(ds, f.deal.at, 'the deal on the Deals board')
  if (f.stoppedAt) push('lost', f.stoppedAt, 'said they don’t want to continue')
  return out
}

// Where a brand is now. Marks are read oldest first: a stage set by hand
// always takes; what happened takes only when it's another stage and further along (a later
// reply never winds Proposal sent back to Replied), when the brand is at a
// way out (a reply after Gone quiet brings it back), or when it's a way out
// itself (they said stop after the proposal).
export function currentTalksStage(marks: StageMark[]): StageMark | null {
  const sorted = [...marks].sort((a, b) => a.at.getTime() - b.at.getTime() ||
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || Number(a.hand) - Number(b.hand))
  let cur: StageMark | null = null
  for (const m of sorted) {
    if (m.hand || !cur) { cur = m; continue }
    // The same stage again (a deal moved by the bar itself) changes nothing.
    if (m.stage === cur.stage) continue
    if (isEndStage(cur.stage) || isEndStage(m.stage) || talksStageRank(m.stage) > talksStageRank(cur.stage)) cur = m
  }
  return cur
}

// The day each stage was first reached (for the bar).
export function stageDates(marks: StageMark[]): Partial<Record<TalksStageKey, Date>> {
  const out: Partial<Record<TalksStageKey, Date>> = {}
  for (const m of marks) if (!out[m.stage] || m.at < (out[m.stage] as Date)) out[m.stage] = m.at
  return out
}

// ---- the log (TalksEvent) ---------------------------------------------

// What Leo can log by hand, each with its day. A stage set on the bar is a
// log line too (kind 'stage').
export const LOG_KINDS: Array<{ key: string; label: string }> = [
  { key: 'call', label: 'Call' },
  { key: 'email_out', label: 'Email sent' },
  { key: 'email_in', label: 'Email from them' },
  { key: 'message', label: 'LinkedIn message' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'proposal', label: 'Deck / proposal sent' },
  { key: 'contract', label: 'Contract' },
  { key: 'other', label: 'Other' },
]
export const isLogKind = (k: unknown): k is string => LOG_KINDS.some(x => x.key === k)
export const logKindLabel = (k: string) => k === 'stage' ? 'Stage' : LOG_KINDS.find(x => x.key === k)?.label ?? k
export const LOG_TEXT_MAX = 2000

// A day key → the moment a log line sits at: now for today (so a stage set
// today comes after anything earlier today), else noon New York that day.
// Refuses a day that hasn't come yet.
export function logMoment(day: unknown, now = new Date(), todayKey?: string): Date {
  const today = todayKey ?? now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  if (day == null || day === '') return now
  const k = String(day)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || Number.isNaN(Date.parse(k + 'T12:00:00Z'))) throw new Error('Pick a day')
  if (k > today) throw new Error('That day hasn’t come yet — log it when it happens')
  if (k === today) return now
  // Noon in New York is 16:00 or 17:00 UTC; 16:30 keeps the day the same.
  return new Date(k + 'T16:30:00Z')
}

// ---- the list's order ----------------------------------------------

export type TalksRow = { name: string; stopped: boolean; nextCallAt: Date | null; lastAt: Date | null }

// Calls coming up first (soonest first), then the rest by latest activity,
// brands that said they don't want to continue last.
export function compareTalks(a: TalksRow, b: TalksRow): number {
  if (a.stopped !== b.stopped) return a.stopped ? 1 : -1
  const an = a.nextCallAt?.getTime() ?? null, bn = b.nextCallAt?.getTime() ?? null
  if ((an == null) !== (bn == null)) return an == null ? 1 : -1
  if (an != null && bn != null && an !== bn) return an - bn
  const al = a.lastAt?.getTime() ?? 0, bl = b.lastAt?.getTime() ?? 0
  if (al !== bl) return bl - al
  return a.name.localeCompare(b.name)
}

// ---- links ------------------------------------------------------

export type LinkKind = 'website' | 'instagram' | 'tiktok'

// What a box on the profile saves as. '' = "they have none" (typed "none"),
// which Claude's daily check doesn't look up again; null = cleared, so it
// does. Throws with the words to show when it isn't that kind of link.
export function cleanLink(kind: LinkKind, raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^(none|n\/a|-)$/i.test(s)) return ''
  if (kind === 'website') {
    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s
    let u: URL
    try { u = new URL(withProto) } catch { throw new Error('That isn’t a web address') }
    if (!/\./.test(u.hostname) || /\s/.test(s)) throw new Error('That isn’t a web address')
    if (/(^|\.)(instagram|tiktok)\.com$/i.test(u.hostname)) throw new Error('That’s a social link — put it in its own box')
    return withProto.replace(/\/+$/, '')
  }
  const host = kind === 'instagram' ? 'instagram.com' : 'tiktok.com'
  const name = kind === 'instagram' ? 'Instagram' : 'TikTok'
  let handle = ''
  if (/^@?[A-Za-z0-9._]+$/.test(s)) handle = s.replace(/^@/, '')
  else {
    let u: URL
    try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s) } catch { throw new Error(`That isn’t an ${name} link`) }
    if (!new RegExp('(^|\\.)' + host.replace('.', '\\.') + '$', 'i').test(u.hostname)) throw new Error(`That isn’t an ${name} link`)
    const first = u.pathname.split('/').filter(Boolean)[0] || ''
    handle = first.replace(/^@/, '')
  }
  const ok = kind === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9._]{2,24}$/
  if (!ok.test(handle) || /^(p|reel|reels|explore|stories|video|tag|discover)$/i.test(handle)) throw new Error(`That isn’t an ${name} account link`)
  return kind === 'instagram' ? `https://www.instagram.com/${handle}/` : `https://www.tiktok.com/@${handle}`
}

// "@handle" for a saved social link (null when there isn't one).
export function socialHandle(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /(?:instagram\.com\/|tiktok\.com\/@)([A-Za-z0-9._]+)/i.exec(url)
  return m ? '@' + m[1] : null
}

// ---- the overview ----------------------------------------------------

export const OVERVIEW_MAX_SENTENCES = 4
export const OVERVIEW_MAX_CHARS = 1200
export const IDEA_MAX_CHARS = 4000
export const NOTE_MAX_CHARS = 4000

// Abbreviations whose full stop doesn't end a sentence ("Dr. Squatch",
// "E. & J. Gallo", "the U.S. market").
const ABBREV = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|Inc|Co|Corp|Ltd|LLC|vs|etc|e\.g|i\.e|U\.S|U\.K|No|approx|[A-Z])\.$/

// How many sentences a piece of text has (a full stop, ! or ? followed by a
// space and a capital or digit, or the end).
export function sentenceCount(text: string): number {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return 0
  let n = 0
  const re = /[.!?]+["”’)]?(?=\s+["“(]?[A-Z0-9$]|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const upto = s.slice(0, m.index + 1)
    if (m[0] === '.' && ABBREV.test(upto)) continue
    n++
  }
  // Text that never ends in a stop is still one sentence.
  return Math.max(n, 1)
}

// ---- Claude's daily check ---------------------------------------------

export type FillField = 'overview' | 'idea' | 'website' | 'instagram' | 'tiktok'

// What the daily check still has to write for a brand: only fields never
// filled (null). '' (none found / typed "none") and anything a person wrote
// stay as they are.
export function missingFields(b: { overview: string | null; activationIdea: string | null; website: string | null; instagramUrl: string | null; tiktokUrl: string | null }): FillField[] {
  const out: FillField[] = []
  if (b.overview == null) out.push('overview')
  if (b.activationIdea == null) out.push('idea')
  if (b.website == null) out.push('website')
  if (b.instagramUrl == null) out.push('instagram')
  if (b.tiktokUrl == null) out.push('tiktok')
  return out
}
