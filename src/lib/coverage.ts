// src/lib/coverage.ts
//
// Every brand a buyer (Leo, Oct 2026, on All brands: "how can we get all
// brands on the command center to have sufficient contacts"). A brand is
// covered with one marketing / partnerships person on file (buyers.ts,
// BUYER_TARGET — Leo's call). For each brand in play that isn't, this
// says what stands in the way, so the gap reads as work with a button:
//
//   next     the LinkedIn fill reads it next — brands with no buyer go
//            first in its worklist, after the Schedule's short brands
//   page     the fill wasn't sure which LinkedIn page is theirs: Leo
//            picks it on Outreach → People and the next run reads it
//   zach     people Leo's free LinkedIn hides ("LinkedIn Member") look
//            like buyers: Zach's account reads them (li-hidden.ts —
//            "Read on Zach's LinkedIn" on Outreach → People)
//   resting  the fill read it lately and found nobody with a buyer title
//            (or its page wouldn't open); back on the fill's list a month
//            after that visit — meanwhile SponsorUnited or by hand
//   noPage   Leo said LinkedIn has no page for it, and there's no parent
//            company to look under: SponsorUnited or by hand only
//   full     25 on file and none a buyer: the fill can't add anyone
//
// Archived and do-not-email brands are "off": nobody needs people there.
// Pure — /api/data (buyerCoverage, listBrands) and /api/ingest (liList)
// hand in the brand, its LinkedIn visit mark and Leo's page answers.
// node scripts/test-coverage.mjs

import { countBuyers, BUYER_TARGET } from './buyers'
import { liRestsNow, LI_REST_DAYS, type LiMark } from './li-sweep'

export type CoverState = 'covered' | 'off' | 'full' | 'page' | 'zach' | 'noPage' | 'resting' | 'next'

// The LinkedIn fill's pace, brands a day — DAILY_CAP in
// scripts/linkedin-capture.user.js. The card's "about N days" uses it.
export const LI_PER_DAY = 100

// The states a brand that still needs a buyer can be in, in the order the
// card lists them: what the fill will do by itself first, then what needs
// Leo, then what LinkedIn can't help with.
export const NEED_STATES: CoverState[] = ['next', 'page', 'zach', 'resting', 'noPage', 'full']

export type CoverInput = {
  passedAt?: Date | string | null
  doNotEmail?: boolean | null
  // Everyone on file at the brand.
  titles: Array<string | null | undefined>
  linkedinUrl?: string | null
  // Owned by a parent company the fill can search under (parents.ts).
  hasParent?: boolean
  // Setting liSweepLog[brandId]: the fill's last visit.
  mark?: LiMark
  // On Setting liPageReview ("Which LinkedIn page is theirs?").
  inReview?: boolean
  // Setting liPageConfirmed[brandId]: the page slug Leo picked, or "none".
  confirmed?: string | null
  // Setting liHidden: likely buyers hidden from Leo's account, waiting on
  // Zach's (li-hidden.ts zachDue).
  zachDue?: boolean
}

export type Cover = {
  state: CoverState
  buyers: number
  // resting: the fill's note from that visit, when it was, and the day
  // the brand is back on the fill's list.
  note?: string | null
  at?: string | null
  back?: string | null
}

export function coverOf(b: CoverInput, opts: { cap: number; now?: number }): Cover {
  const buyers = countBuyers(b.titles).total
  if (b.passedAt || b.doNotEmail) return { state: 'off', buyers }
  if (buyers >= BUYER_TARGET) return { state: 'covered', buyers }
  if (b.titles.length >= opts.cap) return { state: 'full', buyers }
  if (b.inReview) return { state: 'page', buyers }
  // Leo's account read it and LinkedIn hid the buyers: another read from
  // his account sees the same, so it's Zach's to read.
  if (b.zachDue) return { state: 'zach', buyers }
  // Same test as the fill's worklist: no page, Leo said there's none, and
  // no parent to look under — the fill never visits it.
  if (!b.linkedinUrl && b.confirmed === 'none' && !b.hasParent) return { state: 'noPage', buyers }
  const now = opts.now ?? Date.now()
  if (liRestsNow(b.mark, !!b.hasParent, now)) {
    const at = b.mark!.at
    return {
      state: 'resting', buyers,
      note: b.mark!.note || null,
      at,
      back: new Date(Date.parse(at) + LI_REST_DAYS * 864e5).toISOString(),
    }
  }
  return { state: 'next', buyers }
}

export type CoverCounts = Record<CoverState, number> & { inPlay: number; need: number }

export function coverCounts(list: Cover[]): CoverCounts {
  const out: CoverCounts = { covered: 0, off: 0, full: 0, page: 0, zach: 0, noPage: 0, resting: 0, next: 0, inPlay: 0, need: 0 }
  for (const c of list) {
    out[c.state] += 1
    if (c.state !== 'off') out.inPlay += 1
    if (c.state !== 'off' && c.state !== 'covered') out.need += 1
  }
  return out
}

// The fill's worklist with the brands that have no buyer pulled forward:
// after the Schedule's short brands (`planned`) and the names Leo asked
// for by name (`asked`), ahead of everything else. Each group keeps the
// order it came in (focus word, size, emptiest first). Research names
// aren't on the roster yet, so they never count as "no buyer".
export function noBuyerFirst<T extends { planned?: string; asked?: boolean; research?: boolean; noBuyer?: boolean }>(ordered: T[]): T[] {
  const lead: T[] = [], gap: T[] = [], rest: T[] = []
  for (const i of ordered) {
    if (i.planned || i.asked) lead.push(i)
    else if (i.noBuyer && !i.research) gap.push(i)
    else rest.push(i)
  }
  return [...lead, ...gap, ...rest]
}
