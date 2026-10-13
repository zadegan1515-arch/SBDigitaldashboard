// Home → Today's send list (Leo, Oct 6 2026: "check the schedule and the
// people who are queued and if there are people i should not send out to
// because they do not fit a role or there is someone who should replace
// them i want that to be flagged"). Rules only, no model call:
//  - a queued person whose title isn't a buyer (buyers.ts) or that the
//    LinkedIn rules refuse (students, store staff, investors… li-capture)
//    is flagged, and so is one with no title;
//  - someone at the same brand not yet contacted, with a LinkedIn link and
//    a stronger buyer title, is offered as their replacement.
// Each candidate replaces at most one person per brand. Nothing is
// changed — Leo decides. node scripts/test-queue-check.mjs

import { buyerKind, type BuyerKind } from './buyers'
import { refusedWhy } from './li-capture'

export type QueuedPerson = { targetId: string; name: string; title: string | null }
export type OtherPerson = { contactId: string; name: string; title: string | null; linkedinUrl: string | null; contacted: boolean; queued: boolean }
export type QueueFlag = {
  targetId: string
  problem: string | null
  better: { contactId: string; name: string; title: string | null; linkedinUrl: string | null; why: string } | null
}

// Partnerships people buy sponsorships; events next; marketing and the
// founder (a small brand's decider) level.
const RANK: Record<BuyerKind, number> = { partnerships: 3, events: 2, marketing: 1, founder: 1 }
const KIND_WORD: Record<BuyerKind, string> = {
  partnerships: 'partnerships', events: 'events / experiential', marketing: 'marketing', founder: 'founder / CEO',
}
const REFUSED: Record<string, string> = {
  student: 'a student or new grad', store: 'store staff', outside: 'an investor, adviser or another company’s leader',
  notMarketing: 'not in marketing or partnerships',
}

export function personProblem(title: string | null | undefined, names?: string[]): string | null {
  const t = String(title || '').trim()
  if (!t) return 'no job title on file — check who this is'
  if (/\b(?:intern(?:ship)?|student|retired|former|formerly|ex[-\s]|seeking|open to work|aspiring)\b/i.test(t)) {
    return 'looks like a student, intern or past employee (' + t + ')'
  }
  const refused = refusedWhy(t, names)
  if (refused) return 'looks like ' + (REFUSED[refused] || 'not a buyer') + ' (' + t + ')'
  if (!buyerKind(t)) return 'not a marketing, partnerships or founder role (' + t + ')'
  return null
}

// Who at a brand goes first when the queue opens it (picks — Oct 12 2026:
// each brand opens with exactly its number, best LinkedIn buyers first, so
// the same 30 invites reach more brands). In order: a buyer the rules
// above don't flag, then someone Zach can invite on LinkedIn (an email-only
// contact can't take a LinkedIn slot ahead of them), partnerships > events
// > marketing = founder, the person's fit score (scoreFit / Target.fitScore
// in route.ts), then an email on file. The queue (queueBrandTargets), its
// preview (previewBrandPicks) and the limit (reconcileBrandTargets, both
// copies) all sort by it, so the Schedule names who really goes.
export type PickPerson = { title: string | null; linkedinUrl?: string | null; email?: string | null; fit?: number | null }
export function buyerRank(title: string | null | undefined): number {
  const k = buyerKind(title)
  return k ? RANK[k] : 0
}
export function comparePicks(a: PickPerson, b: PickPerson, names?: string[]): number {
  return Number(!!personProblem(a.title, names)) - Number(!!personProblem(b.title, names)) ||
    Number(!!b.linkedinUrl) - Number(!!a.linkedinUrl) ||
    buyerRank(b.title) - buyerRank(a.title) ||
    (b.fit ?? 0) - (a.fit ?? 0) ||
    Number(!!b.email) - Number(!!a.email)
}
// A sorted copy; equal people keep the order they came in.
export function sortPicks<T extends PickPerson>(list: T[], names?: string[]): T[] {
  return list.map((p, i) => ({ p, i })).sort((x, y) => comparePicks(x.p, y.p, names) || x.i - y.i).map(x => x.p)
}
// Flagged people (not a buyer, no title, refused by the LinkedIn rules)
// stay out of the queue's own picks while anyone unflagged is reachable at
// the brand — waiting to be picked, or already in play (`unflaggedInPlay`:
// otherwise the next load would fill the brand's count with them). A brand
// with nobody else still gets worked: a worse door beats no door. "+ Person"
// is a click on purpose and skips this.
export function leaveOutFlagged<T extends { title: string | null }>(cands: T[], names: string[] | undefined, unflaggedInPlay: boolean): T[] {
  const ok = cands.filter(c => !personProblem(c.title, names))
  return ok.length ? ok : unflaggedInPlay ? [] : cands
}

function rankOf(title: string | null | undefined, names?: string[]): number {
  if (personProblem(title, names)) return 0
  const k = buyerKind(title)
  return k ? RANK[k] : 0
}

export function checkBrandQueue(queued: QueuedPerson[], others: OtherPerson[], names?: string[]): QueueFlag[] {
  const pool = others
    .filter(o => !o.contacted && !o.queued && o.linkedinUrl && rankOf(o.title, names) > 0)
    .sort((a, b) => rankOf(b.title, names) - rankOf(a.title, names))
  const used = new Set<string>()
  // Weakest queued person first, so the best candidate goes where it helps most.
  const order = queued.map(q => ({ q, rank: rankOf(q.title, names), problem: personProblem(q.title, names) }))
    .sort((a, b) => a.rank - b.rank)
  const out = new Map<string, QueueFlag>()
  for (const { q, rank, problem } of order) {
    const cand = pool.find(o => !used.has(o.contactId) && rankOf(o.title, names) > rank)
    let better: QueueFlag['better'] = null
    if (cand && (problem || rankOf(cand.title, names) >= rank + 1)) {
      used.add(cand.contactId)
      const k = buyerKind(cand.title)!
      better = { contactId: cand.contactId, name: cand.name, title: cand.title, linkedinUrl: cand.linkedinUrl,
        why: problem ? 'a ' + KIND_WORD[k] + ' person instead' : KIND_WORD[k] + ' beats ' + KIND_WORD[buyerKind(q.title)!] }
    }
    out.set(q.targetId, { targetId: q.targetId, problem, better })
  }
  return queued.map(q => out.get(q.targetId)!)
}
