// src/lib/supply.ts
//
// Brands → All brands: what the queue has to work with (Leo, Nov 5 2026:
// "give me counts of how many brands need a linkedin fill. what brands have
// more people we can reach out to again, and overall clean up the queue
// brands so that i can get more when i want to reach out"). His picks:
//
//   - counts on All brands, each one opens those brands in the table
//   - "needs a LinkedIn fill" = short on people to go out whole, no buyer on
//     file, or not read by the fill yet
//   - reach out again = Week plan's rule (reach-again.ts), shown there too
//   - the fill does the best brands the queue could pick that are short on
//     people first; every read adds a founders + events search (`wide`), and
//     every brand read in full before that search existed gets one more read
//     with it (`reread` on the visit mark, li-sweep.ts nextMark; Nov 6 2026,
//     after his list was down to 28 brands)
//   - what the rules hold back (giants, too small, Skip categories) as counts
//     with a switch each — nothing changes until he flips one
//   - Archive dead weight: brands that can never go out, previewed, Undo
//
// Pure — route.ts (brandSupply, deadWeight) and li-list-db.ts (the fill's
// worklist) hand in what they read. node scripts/test-supply.mjs

import { markOutcome, type LiMark } from './li-sweep'

// Where a brand stands for the queue's own picks:
//   ready    the queue can pick it and it has enough people to go out whole
//   short    the queue can pick it, but fewer reachable people than it works
//   held     never reached, but a rule holds it back (holdsOf)
//   pass     never reached, on a two-week Pass Leo gave it
//   reached  reached out to before — only by hand, or Reach out again
//   off      archived, do-not-email, said stop, not sold in the US, closed
export type SupplyState = 'ready' | 'short' | 'held' | 'pass' | 'reached' | 'off'

// The rules that keep a never-reached brand out of the automatic picks.
export type Hold = 'giant' | 'skip' | 'small'
export const HOLDS: Hold[] = ['giant', 'skip', 'small']

// giant: a giant Leo hasn't OK'd one by one (queue-rules.ts giantOf); the
// Giants switch lets them all in. small: brand-fit.ts isTooSmall; the
// Too small switch lets them in. skip: a category on Skip priority — the
// switch for that is Category priority.
export function holdsOf(
  x: { giant: boolean; tooSmall: boolean; skip: boolean },
  sw: { giantsOn?: boolean; smallOn?: boolean },
): Hold[] {
  const out: Hold[] = []
  if (x.giant && !sw.giantsOn) out.push('giant')
  if (x.skip) out.push('skip')
  if (x.tooSmall && !sw.smallOn) out.push('small')
  return out
}

export function supplyOf(x: {
  off: boolean; reached: boolean; pass: boolean; holds: Hold[]; ready: boolean
}): SupplyState {
  if (x.off) return 'off'
  if (x.reached) return 'reached'
  if (x.holds.length) return 'held'
  if (x.pass) return 'pass'
  return x.ready ? 'ready' : 'short'
}

// The queue could pick it by itself once it has the people (ready or short,
// a Pass aside — it comes back by itself).
export function queuePickable(s: SupplyState): boolean {
  return s === 'ready' || s === 'short' || s === 'pass'
}

// How many more brands a switch lets in: the ones that rule alone holds.
export function onlyHeldBy(holds: Hold[][], rule: Hold): number {
  return holds.filter(h => h.length === 1 && h[0] === rule).length
}

// The LinkedIn fill's Brand Fit floor by default (FIT_DEFAULT in
// scripts/linkedin-capture.user.js; Outreach → People's Fill schedule).
export const FILL_FIT_DEFAULT = 50

// The fill's one more, wider read: its last read was clean (read in full,
// nothing went wrong), didn't take the founders + events search (script 1.44
// adds it to every read), and it hasn't been read again since. Every brand
// read before that search existed gets it once (Leo, Nov 6 2026), short on
// people or not; a visit to a brand whose mark was clean sets `reread`
// (li-sweep.ts nextMark), so it's once.
export function rereadOpen(mark: LiMark | undefined): boolean {
  return !!mark && !mark.reread && !mark.wide && !mark.skip && markOutcome(mark).clean
}

// One more read for a brand that still needs people (Leo, Nov 7 2026: "i want
// these brands to be ran" — the Needs a LinkedIn fill card's brands): its last
// read was clean and it hasn't had its one more read yet, founders & events
// searched or not. `reread` on the next visit's mark keeps it to once.
export function needsReadOpen(mark: LiMark | undefined): boolean {
  return !!mark && !mark.reread && !mark.skip && markOutcome(mark).clean
}

// What the fill does next with a brand on its worklist (li-list-db.ts):
//   new     never read by the current reader
//   again   read before: the read had an issue, its month is up, or its
//           parent company's page is still to search
//   reread  read in full before the founders & events search: one more read
export type FillKind = 'new' | 'again' | 'reread'
export function fillKindOf(mark: LiMark | undefined, opts: { reread: boolean; reader: number }): FillKind {
  if (opts.reread) return 'reread'
  return !mark || !mark.v || mark.v < opts.reader ? 'new' : 'again'
}

// ---- Archive dead weight ----
// Brands that can never go out: confirmed not sold in the US, out of
// business or bought, a league / team / agency that sells sponsorships
// (li-capture.ts looksLikeSeller), or nobody to reach after the fill read it
// in full (and its wider read, when it gets one) — or Leo said it has no
// LinkedIn page and there's no parent to look under. Never a brand in talks,
// with a deal or an activation, or with Elizabeth's outreach waiting; never
// "nobody to reach" for a brand Leo picked himself (his Week plan list, one
// he added).
export type DeadWhy = 'notus' | 'closed' | 'seller' | 'nobody' | 'nopage'
export const DEAD_WORDS: Record<DeadWhy, string> = {
  notus: 'Not sold in the US',
  closed: 'Out of business or bought',
  seller: 'Sells sponsorships (a league, team or agency)',
  nobody: 'The LinkedIn fill read it in full and found nobody to reach',
  nopage: 'No LinkedIn page, no parent company, nobody to reach',
}
export function deadWeightOf(x: {
  notUs: boolean; closed: boolean; seller: boolean
  // Someone on file with a LinkedIn link or an email.
  reachable: number
  // The fill's last read was clean.
  cleanRead: boolean
  // It still gets the wider read (rereadOpen and the fill would take it).
  rereadPending: boolean
  // Leo said it has no LinkedIn page, it has no parent company.
  noPage: boolean
  inTalks: boolean; deal: boolean; activation: boolean; rep: boolean
  handPick: boolean
}): DeadWhy | null {
  if (x.inTalks || x.deal || x.activation || x.rep) return null
  if (x.notUs) return 'notus'
  if (x.closed) return 'closed'
  if (x.seller) return 'seller'
  if (x.reachable > 0 || x.handPick) return null
  if (x.noPage) return 'nopage'
  if (x.cleanRead && !x.rereadPending) return 'nobody'
  return null
}
