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
// Pure rules here; the handlers (listInTalks, setInTalks, saveTalksProfile,
// addBrandNote, editBrandNote, deleteBrandNote, listTalksToFill) are in
// src/app/api/data/route.ts. node scripts/test-in-talks.mjs

import { acceptedStage, isAccepted, type AcceptedInput } from './accepted'

// ---- who's in ---------------------------------------------------

export type TalksFacts = {
  addedAt: Date | null       // Brand.talksAddedAt — Add to In talks
  removedAt: Date | null     // Brand.talksRemovedAt — Take off In talks
  callsBooked: Date[]        // every Target.callBookedAt at the brand
}

export type TalksState = { on: boolean; why: 'call' | 'hand' | null; since: Date | null }

// A call booked or a hand add puts a brand in; taking it off wins over
// anything older, and a newer call or add brings it back.
export function talksState(f: TalksFacts): TalksState {
  const after = (d: Date | null) => !!d && (!f.removedAt || d.getTime() > f.removedAt.getTime())
  const calls = f.callsBooked.filter(after)
  const hand = after(f.addedAt)
  if (!calls.length && !hand) return { on: false, why: null, since: null }
  const times = [...calls, ...(hand ? [f.addedAt as Date] : [])].map(d => d.getTime())
  return { on: true, why: calls.length ? 'call' : 'hand', since: new Date(Math.min(...times)) }
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
