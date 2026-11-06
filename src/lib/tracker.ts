// In talks → Every brand (Leo, Nov 6 2026: "a tab that has all of the brands
// that were talking to / emailed out to … a clear way to keep track of every
// brand that we've reached out to, is accepted, and has responded to us, and
// wants to continue. And then we send out an email").
//
// Every brand we reached out to sits at one step — the furthest step anyone
// there got to who is still in play:
//   Reached out → Accepted → Replied → Wants to continue → Email sent → In talks
// and Out when everyone there said no, doesn't want to continue, or went
// quiet after the last follow-up. Zach's outreach (Target rows, Zach's list's
// steps) and Elizabeth's (RepOutreach rows) both count.
//
// Pure: the outreachTracker handler in route.ts loads the rows and the
// In talks / deal facts. Read-only — nothing here changes a step.
// node scripts/test-tracker.mjs

import { isAccepted } from './accepted'
import { addDays, nyKey, onSendingDay, standing } from './rep-outreach'

export type StageKey = 'reached' | 'accepted' | 'replied' | 'continue' | 'emailed' | 'talks' | 'out'

export const STAGES: Array<{ key: StageKey; label: string; hint: string }> = [
  { key: 'reached', label: 'Reached out', hint: 'Invite or email out — no answer yet' },
  { key: 'accepted', label: 'Accepted', hint: 'Accepted on LinkedIn — no reply yet' },
  { key: 'replied', label: 'Replied', hint: 'Wrote back — how do they want to continue?' },
  { key: 'continue', label: 'Wants to continue', hint: 'Asked for an email or a LinkedIn DM — send it' },
  { key: 'emailed', label: 'Email sent', hint: 'We sent it — next, book the call' },
  { key: 'talks', label: 'In talks', hint: 'Call booked, or a deal going' },
  { key: 'out', label: 'Out', hint: 'Said no, doesn’t want to continue, or never answered' },
]
const RANK: Record<StageKey, number> = { reached: 0, accepted: 1, replied: 2, continue: 3, emailed: 4, talks: 5, out: -1 }
export const stageRank = (s: StageKey) => RANK[s]

export type OutReason = 'stopped' | 'no' | 'quiet' | 'lost' | 'removed'
export const OUT_TEXT: Record<OutReason, string> = {
  stopped: 'Doesn’t want to continue',
  no: 'Said no',
  quiet: 'No response after the last follow-up',
  lost: 'Deal lost',
  removed: 'Taken off In talks',
}
// Which reason a brand shows when everyone there is out: the strongest one.
const OUT_ORDER: OutReason[] = ['stopped', 'no', 'lost', 'removed', 'quiet']

// Zach's list's cadence (route.ts HAND_DM_DAYS / HAND_NUDGE_DAYS /
// HAND_QUIET_DAYS): text them 2 days after the accept (on a Tue–Thu), the
// final reach-out 10 days after that, No response 7 days after the final.
export const CADENCE = { dm: 2, final: 10, quiet: 7 }

type When = Date | string | null | undefined
const dt = (v: When): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v))
const key = (v: When): string | null => (v == null ? null : nyKey(v))

// One person's outreach as the tracker sees it.
export type PersonStage = {
  stage: StageKey
  out: OutReason | null
  label: string          // where they are, a few words ("accepted", "wants an email")
  next: string           // what happens next, in plain words
  onUs: boolean          // the next step is ours to take
  due: string | null     // NY day the step is due (late when before today)
  at: Date | null        // when they reached this step
  lastAt: Date | null    // the latest dated step on the row
  callAt: Date | null    // a call booked with them (any day)
}

// ---- Zach's rows ----------------------------------------------------

export type ZachFacts = {
  status: string
  sentAt: When; repliedAt: When; updatedAt: When; createdAt?: When
  acceptedAt: When            // first TargetEvent to 'accepted'
  emailReply: boolean         // an inbound email on the row
  emailedAt: When             // a hand email (Zach's list, the brand page)
  machineEmailAt: When        // the email machine's first sent email
  dmSentAt: When; nudgedAt: When
  wantsEmailAt: When; liPathAt: When; liSentAt: When
  callAt: When; callBookedAt: When
  declinedAt: When            // Target.handDeclinedAt
  skippedAt?: When            // Target.handSkippedAt — "Not needed" (handled somewhere else)
  contactStopped: boolean     // Contact.doNotContactAt
  brandStopped: boolean       // Brand.stoppedAt
}

const REPLIED = ['replied', 'converted']

// Reached out at all — the Reached tag's rule (REACHED_WHERE in route.ts):
// an invite ever, an accept or reply, a hand or machine email.
export function zachReached(t: ZachFacts): boolean {
  return !!t.sentAt || ['accepted', 'replied', 'converted'].includes(t.status) || !!t.emailedAt || !!t.machineEmailAt
}

const latest = (...ds: When[]): Date | null => {
  let best: Date | null = null
  for (const v of ds) { const d = dt(v); if (d && (!best || d > best)) best = d }
  return best
}
const fmt = (v: When) => {
  const d = dt(v)
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : ''
}

export function zachStage(t: ZachFacts, now = new Date()): PersonStage {
  const today = nyKey(now)
  const lastAt = latest(t.sentAt, t.acceptedAt, t.repliedAt, t.emailedAt, t.machineEmailAt, t.dmSentAt, t.nudgedAt, t.wantsEmailAt, t.liPathAt, t.liSentAt, t.callBookedAt, t.declinedAt)
    ?? (t.status === 'accepted' ? dt(t.updatedAt) : null)
  const callAt = dt(t.callAt)
  const base = { lastAt, callAt, due: null as string | null }
  const out = (reason: OutReason, at: When): PersonStage => ({ ...base, stage: 'out', out: reason, label: OUT_TEXT[reason].toLowerCase(), next: OUT_TEXT[reason], onUs: false, at: dt(at) })
  if (t.contactStopped || t.declinedAt || t.brandStopped) return out('stopped', t.declinedAt ?? lastAt)
  if (t.status === 'declined') return out('no', t.repliedAt ?? lastAt)
  if (t.callAt || t.callBookedAt) {
    const c = dt(t.callAt)
    const upcoming = !!c && nyKey(c) >= today
    return {
      ...base, stage: 'talks', out: null, onUs: false, at: dt(t.callBookedAt) ?? c,
      label: !c ? 'call booked' : upcoming ? 'call booked' : 'had a call',
      next: !c ? 'Call booked' : upcoming ? 'Call ' + fmt(c) : 'Had a call ' + fmt(c),
    }
  }
  if (t.status === 'converted') return { ...base, stage: 'talks', out: null, onUs: false, at: dt(t.repliedAt) ?? lastAt, label: 'converted', next: 'Converted' }
  if (t.status === 'dead') return out('quiet', lastAt)

  const accepted = isAccepted({
    status: t.status, sentAt: dt(t.sentAt), repliedAt: dt(t.repliedAt), updatedAt: dt(t.updatedAt) ?? now,
    dmSentAt: dt(t.dmSentAt), callAt: null, handDeclinedAt: null, acceptedAt: dt(t.acceptedAt),
    emailReply: t.emailReply, contactStopped: false, brandStopped: false,
  })
  const replied = REPLIED.includes(t.status) || !!t.repliedAt || t.emailReply
  // Picking a path on Zach's list logs the reply; a hand email after an
  // accept means they asked for it.
  const answered = replied || (accepted && !!(t.wantsEmailAt || t.liPathAt || t.liSentAt || t.emailedAt))
  if (answered) {
    const emailTodo = !!t.wantsEmailAt && !t.emailedAt
    const dmTodo = !!t.liPathAt && !t.liSentAt
    if (emailTodo || dmTodo) {
      return {
        ...base, stage: 'continue', out: null, onUs: true, at: latest(t.wantsEmailAt, t.liPathAt),
        label: emailTodo ? 'wants an email' : 'wants a LinkedIn DM',
        next: emailTodo ? 'Send them the email' : 'Send them the LinkedIn DM',
      }
    }
    if (t.emailedAt || t.liSentAt) {
      const sentWhat = t.emailedAt ? 'Emailed ' + fmt(t.emailedAt) : 'DM sent ' + fmt(t.liSentAt)
      // Zach's list keeps "Call to book" under Waiting (Leo, Oct 6: not urgent).
      return { ...base, stage: 'emailed', out: null, onUs: false, at: latest(t.emailedAt, t.liSentAt), label: t.emailedAt ? 'emailed' : 'DM sent', next: sentWhat + ' — book the call' }
    }
    if (t.skippedAt) return { ...base, stage: 'replied', out: null, onUs: false, at: dt(t.repliedAt) ?? lastAt, label: 'replied', next: 'Replied — marked not needed on Zach’s list' }
    return {
      ...base, stage: 'replied', out: null, onUs: true, at: dt(t.repliedAt) ?? lastAt,
      label: t.emailReply ? 'replied by email' : 'replied',
      next: t.emailReply ? 'They answered our email — reply and book the call' : 'Find out how they want to continue — email or LinkedIn',
    }
  }
  if (accepted && t.skippedAt) {
    return { ...base, stage: 'accepted', out: null, onUs: false, at: dt(t.acceptedAt) ?? dt(t.updatedAt), label: 'accepted', next: 'Accepted — marked not needed on Zach’s list' }
  }
  if (accepted) {
    const acc = key(t.acceptedAt ?? t.sentAt) ?? key(t.updatedAt) ?? today
    if (!t.dmSentAt) {
      const due = onSendingDay(addDays(acc, CADENCE.dm))
      return { ...base, due, stage: 'accepted', out: null, onUs: due <= today, at: dt(t.acceptedAt) ?? dt(t.updatedAt), label: 'accepted', next: due <= today ? 'Text them on LinkedIn' : 'Text them ' + dayName(due) }
    }
    if (!t.nudgedAt) {
      const due = addDays(key(t.dmSentAt) as string, CADENCE.final)
      return { ...base, due, stage: 'accepted', out: null, onUs: due <= today, at: dt(t.acceptedAt) ?? dt(t.updatedAt), label: 'messaged', next: due <= today ? 'Send the final reach-out' : 'Messaged ' + fmt(t.dmSentAt) + ' — waiting' }
    }
    const quiet = addDays(key(t.nudgedAt) as string, CADENCE.quiet)
    if (quiet <= today) return out('quiet', t.nudgedAt)
    return { ...base, due: quiet, stage: 'accepted', out: null, onUs: false, at: dt(t.acceptedAt) ?? dt(t.updatedAt), label: 'final reach-out sent', next: 'Final reach-out sent ' + fmt(t.nudgedAt) + ' — waiting' }
  }
  // Reached, no answer yet.
  const firstOut = dt(t.sentAt) ?? dt(t.emailedAt) ?? dt(t.machineEmailAt)
  const how = t.sentAt
    ? (t.status === 'withdrawn' ? 'Invite from ' + fmt(t.sentAt) + ' withdrawn' : 'Invite sent ' + fmt(t.sentAt))
    : 'Emailed ' + fmt(t.emailedAt ?? t.machineEmailAt)
  return {
    ...base, stage: 'reached', out: null, onUs: false, at: firstOut,
    label: t.sentAt ? (t.status === 'withdrawn' ? 'invite withdrawn' : 'invited') : 'emailed',
    next: how + (t.status === 'withdrawn' ? '' : ' — no answer yet'),
  }
}

function dayName(k: string): string {
  return new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ---- Elizabeth's rows -------------------------------------------------

export type RepFacts = {
  channel: string; status: string
  sentAt: When; acceptedAt: When; dmAt: When; followAt: When; repliedAt: When
  callAt: When; callBookedAt: When; doneAt: When
}

export function repReached(r: RepFacts): boolean {
  return !!r.sentAt || ['accepted', 'replied', 'call'].includes(r.status)
}

export function repStage(r: RepFacts, now = new Date()): PersonStage {
  const today = nyKey(now)
  const lastAt = latest(r.sentAt, r.acceptedAt, r.dmAt, r.followAt, r.repliedAt, r.callBookedAt, r.doneAt)
  const callAt = dt(r.callAt)
  const base = { lastAt, callAt, due: null as string | null }
  const out = (reason: OutReason, at: When): PersonStage => ({ ...base, stage: 'out', out: reason, label: OUT_TEXT[reason].toLowerCase(), next: OUT_TEXT[reason], onUs: false, at: dt(at) })
  if (r.status === 'declined') return out('stopped', r.doneAt ?? lastAt)
  if (r.status === 'call' || r.callAt || r.callBookedAt) {
    const upcoming = !!callAt && nyKey(callAt) >= today
    return {
      ...base, stage: 'talks', out: null, onUs: false, at: dt(r.callBookedAt) ?? callAt,
      label: !callAt || upcoming ? 'call booked' : 'had a call',
      next: !callAt ? 'Call booked' : upcoming ? 'Call ' + fmt(callAt) : 'Had a call ' + fmt(callAt),
    }
  }
  if (r.status === 'replied' || r.repliedAt) {
    return { ...base, stage: 'replied', out: null, onUs: true, at: dt(r.repliedAt) ?? lastAt, label: 'replied', next: 'They replied to Elizabeth — book a call' }
  }
  const s = standing({ ...r, sentAt: dt(r.sentAt), acceptedAt: dt(r.acceptedAt), dmAt: dt(r.dmAt), followAt: dt(r.followAt), repliedAt: dt(r.repliedAt), callAt: dt(r.callAt), callBookedAt: dt(r.callBookedAt), doneAt: dt(r.doneAt) }, today)
  if (s.stage === 'noreply') return out('quiet', r.followAt ?? lastAt)
  const onUs = s.group === 'todo'
  if (r.channel === 'linkedin' && r.acceptedAt && r.status !== 'withdrawn') {
    return { ...base, due: s.due, stage: 'accepted', out: null, onUs, at: dt(r.acceptedAt), label: r.dmAt ? 'messaged' : 'accepted', next: s.next }
  }
  const withdrawn = r.status === 'withdrawn'
  return {
    ...base, due: withdrawn ? null : s.due, stage: 'reached', out: null, onUs: withdrawn ? false : onUs, at: dt(r.sentAt),
    label: r.channel === 'email' ? 'emailed' : withdrawn ? 'invite withdrawn' : 'invited',
    next: withdrawn ? 'Invite from ' + fmt(r.sentAt) + ' withdrawn' : r.channel === 'email' && s.stage === 'followDue' && onUs ? 'Send a follow-up email' : r.channel === 'email' ? 'Emailed ' + fmt(r.sentAt) + ' — no answer yet' : s.next,
  }
}

// ---- the brand -------------------------------------------------------

export type BrandFacts = {
  stopped: boolean                      // Brand.stoppedAt (Doesn't want to continue, whole brand)
  talksOn: boolean                      // on In talks (a call booked or a hand add, not taken off)
  talksWhy: 'call' | 'hand' | null
  deal: { stage: string } | null        // the deal the In talks profile shows (newest open, else newest)
}

export type BrandStage = {
  stage: StageKey
  out: OutReason | null
  next: string
  onUs: boolean
  lead: number                          // index of the person whose step the brand shows (-1: none)
  at: Date | null                       // when the brand reached its step
  lastAt: Date | null
  nextCallAt: Date | null               // a call coming up (soonest)
}

// Where a brand sits: In talks / an open deal first; else the furthest step
// anyone there is on who's still in play; else Out, for the strongest reason.
// A call on a brand taken off In talks counts as "taken off" (talksState is
// off only when the removal came after every call).
export function brandStage(people: PersonStage[], f: BrandFacts, now = new Date()): BrandStage {
  const today = nyKey(now)
  const lastAt = latest(...people.map(p => p.lastAt))
  const calls = people.filter(p => p.stage === 'talks' && p.callAt && nyKey(p.callAt) >= today).map(p => p.callAt as Date)
  const nextCallAt = calls.length ? new Date(Math.min(...calls.map(d => d.getTime()))) : null
  const ps = people.map(p => (p.stage === 'talks' && !f.talksOn
    ? { ...p, stage: 'out' as StageKey, out: 'removed' as OutReason, label: OUT_TEXT.removed.toLowerCase(), next: OUT_TEXT.removed, onUs: false }
    : p))
  const res = (stage: StageKey, out: OutReason | null, next: string, onUs: boolean, lead: number, at: Date | null): BrandStage =>
    ({ stage, out, next, onUs, lead, at, lastAt, nextCallAt: stage === 'talks' ? nextCallAt : null })
  const bestIn = (pred: (p: PersonStage) => boolean) => {
    let best = -1
    ps.forEach((p, i) => {
      if (!pred(p)) return
      if (best < 0) { best = i; return }
      const b = ps[best]
      const r = RANK[p.stage] - RANK[b.stage]
      // Same step: whoever's step is ours to take, then the latest.
      if (r > 0 || (r === 0 && ((p.onUs && !b.onUs) || (p.onUs === b.onUs && (p.lastAt?.getTime() ?? 0) > (b.lastAt?.getTime() ?? 0))))) best = i
    })
    return best
  }
  if (f.stopped) {
    const i = ps.findIndex(p => p.out === 'stopped')
    return res('out', 'stopped', OUT_TEXT.stopped, false, i, i >= 0 ? ps[i].at : null)
  }
  const dealOpen = !!f.deal && f.deal.stage !== 'lost'
  if (f.talksOn || dealOpen) {
    const i = bestIn(p => p.stage === 'talks')
    const next = nextCallAt ? 'Call ' + fmt(nextCallAt)
      : dealOpen ? 'Deal · ' + dealWord(f.deal!.stage)
      : i >= 0 ? ps[i].next
      : f.talksWhy === 'hand' ? 'Added to In talks' : 'In talks'
    return res('talks', null, next, false, i >= 0 ? i : bestIn(p => p.stage !== 'out'), i >= 0 ? ps[i].at : null)
  }
  if (f.deal && f.deal.stage === 'lost') return res('out', 'lost', OUT_TEXT.lost, false, bestIn(() => true), null)
  const live = bestIn(p => p.stage !== 'out')
  if (live >= 0) {
    const p = ps[live]
    return res(p.stage, null, p.next, ps.some(x => x.stage === p.stage && x.onUs), live, p.at)
  }
  for (const r of OUT_ORDER) {
    const i = ps.findIndex(p => p.out === r)
    if (i >= 0) return res('out', r, OUT_TEXT[r], false, i, ps[i].at)
  }
  return res('reached', null, '', false, -1, null)
}

const DEAL_WORD: Record<string, string> = { conversation: 'conversation', proposal: 'proposal sent', verbal: 'verbal yes', closed: 'won' }
export const dealWord = (s: string) => DEAL_WORD[s] ?? s

// ---- the list --------------------------------------------------------

export type TrackerRow = { name: string; stage: StageKey; onUs: boolean; due: string | null; lastAt: Date | null; nextCallAt: Date | null }

// Inside a step: ours to do first (the longest due first), calls coming up
// soonest first, then the latest activity.
export function compareTracker(a: TrackerRow, b: TrackerRow): number {
  if (a.onUs !== b.onUs) return a.onUs ? -1 : 1
  if (a.onUs && b.onUs && (a.due ?? '') !== (b.due ?? '')) return (a.due ?? '9999').localeCompare(b.due ?? '9999')
  const an = a.nextCallAt?.getTime() ?? null, bn = b.nextCallAt?.getTime() ?? null
  if ((an == null) !== (bn == null)) return an == null ? 1 : -1
  if (an != null && bn != null && an !== bn) return an - bn
  const al = a.lastAt?.getTime() ?? 0, bl = b.lastAt?.getTime() ?? 0
  if (al !== bl) return bl - al
  return a.name.localeCompare(b.name)
}

// The steps one person got through, whatever they're on now.
export function zachSteps(t: ZachFacts): StageKey[] {
  const out: StageKey[] = []
  if (zachReached(t)) out.push('reached')
  const accepted = isAccepted({
    status: t.status, sentAt: dt(t.sentAt), repliedAt: dt(t.repliedAt), updatedAt: dt(t.updatedAt) ?? new Date(),
    dmSentAt: dt(t.dmSentAt), callAt: null, handDeclinedAt: null, acceptedAt: dt(t.acceptedAt),
    emailReply: t.emailReply, contactStopped: false, brandStopped: false,
  }) || !!t.acceptedAt
  if (accepted) out.push('accepted')
  const replied = REPLIED.includes(t.status) || !!t.repliedAt || t.emailReply ||
    (accepted && !!(t.wantsEmailAt || t.liPathAt || t.liSentAt || t.emailedAt))
  if (replied) out.push('replied')
  if (t.wantsEmailAt || t.liPathAt) out.push('continue')
  if ((t.emailedAt && replied) || t.liSentAt) out.push('emailed')
  if (t.callAt || t.callBookedAt || t.status === 'converted') out.push('talks')
  return out
}
export function repSteps(r: RepFacts): StageKey[] {
  const out: StageKey[] = []
  if (repReached(r)) out.push('reached')
  if (r.acceptedAt) out.push('accepted')
  if (r.repliedAt || ['replied', 'call'].includes(r.status)) out.push('replied')
  if (r.callAt || r.callBookedAt || r.status === 'call') out.push('talks')
  return out
}
