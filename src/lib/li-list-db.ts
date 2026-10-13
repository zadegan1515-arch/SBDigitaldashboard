// The LinkedIn fill's worklist (liList) — which brands the run reads and in
// what order. Shared by /api/ingest (the script asks for it) and /api/data
// (fillSchedule: Outreach → People's "Fill schedule", the same list split
// into the run's days), so the schedule is always what the run really reads.
// Read-only.
import { PrismaClient } from '@prisma/client'
import { focusTerms, matchesFocus, decideCompanyMatch, pageLooksWrong } from './li-capture'
import { readLiLog, liRestsNow, readLiResearch, researchResting, LI_SCRIPT_VERSION } from './li-sweep'
import { readHiddenLog } from './li-hidden'
import { parentOf, isParentCompany, LI_PARENT_PAGES_KEY } from './parents'
import { readJsonSetting, LI_CONFIRMED_KEY, LI_REVIEW_KEY, type Confirmed, type Review } from './li-review'
import { LANES, RESEARCH_EXTRA, brandKey, secondSearchName } from './stock'
import { dueDays, shortOnPeople, plannedFirst, workNeed } from './planned-first'
import { scoreBrand, priorityOf } from './brand-fit'
import { brandSize, sizeRank } from './brand-size'
import { countBuyers, BUYER_TARGET } from './buyers'
import { noBuyerFirst } from './coverage'
import { giantWhy } from './giants'
import { giantOf, veryBigWhy, rowReached, parseGiants, GIANTS_KEY, VERY_BIG_LI } from './queue-rules'
import { isBigBrand } from './brand-work'

// How many people we keep on file per brand (Leo, Sep 2026) — see
// /api/ingest. The fill only reads brands under it.
export const CONTACT_CAP_PER_BRAND = 25
// The day the fill's Sales Navigator step shipped (New York midnight): a
// brand read since then without it is due once for it.
export const SN_SINCE = Date.parse('2026-10-12T04:00:00Z')
// The company-match fix (decideCompanyMatch / pageLooksWrong) shipped.
export const REMATCH_SINCE = Date.parse('2026-10-13T12:00:00Z')
// "Very big" for the fill's skip: 1,500+ people on LinkedIn (Leo, Oct 12 2026:
// "not reach out to any brand with over 1500 employees"; queue-rules.ts, the
// same line the Schedule holds back — conglomerates never); giants.ts covers
// the household names whatever their page says.
export { VERY_BIG_LI }

// A big company works ten at a time (Leo, Oct 7 2026) — one rule for
// /api/data and the fill: isBigBrand in brand-work.ts.
export { isBigBrand }

// `body` = the script's liList request: focus, research, salesNav, minFit, skipGiants, ignoreRest.
export async function buildLiList(prisma: PrismaClient, body: any) {
  const terms = focusTerms(body.focus)
  const log = await readLiLog(prisma)
  const [everyBrand, giantsSetting] = await Promise.all([
    prisma.brand.findMany({
      where: { doNotEmail: false, passedAt: null },
      select: {
        id: true, name: true, aka: true, about: true, topProducts: true, notes: true, salesCents: true,
        category: true, linkedinUrl: true, tier: true, liMembers: true, _count: { select: { contacts: true } },
        contacts: { select: { title: true, email: true, linkedinUrl: true } },
        // Brand Fit's facts (brand-fit.ts), for the fit floor below.
        fundingCents: true, lastRoundAt: true, usStatus: true, sponsorsCollege: true, bizStatus: true,
        acquiredBy: true, researchedAt: true, workPeople: true,
        // Reached out to already (queue-rules.ts): the Schedule's own
        // picks skip those, so the run reads them last.
        targets: {
          select: {
            status: true, sentAt: true, emailedAt: true,
            _count: { select: { emails: { where: { direction: 'out', status: 'sent' } } } },
          },
        },
      },
    }),
    readJsonSetting<unknown>(prisma, GIANTS_KEY, {}),
  ])
  // Brand Fit, the score on the ratings list (Leo, Oct 12 2026: "can it only
  // fill in the brands that score highly"): the same rules as the dashboard
  // (brand-fit.ts, Leo's category priority); the category's accept rate is
  // left out here (5 points at most). `minFit` = the run's floor: a brand
  // under it, too small, not sold in the US, closed or in a Skip category is
  // left off the list — the Schedule's own brands and names Leo asked for
  // never are. Best fit first within each group.
  const minFit = Math.max(0, Math.min(100, Number(body.minFit) || 0))
  const priorities = await readJsonSetting<Record<string, string>>(prisma, 'categoryPriority', {})
  const now = new Date()
  const fitOf = new Map(everyBrand.map(b => {
    const big = isBigBrand(b)
    const f = scoreBrand({
      category: b.category, tier: b.tier, liMembers: b.liMembers, hasParent: !!parentOf(b.name, b.aka),
      salesCents: b.salesCents == null ? null : Number(b.salesCents), fundingCents: b.fundingCents == null ? null : Number(b.fundingCents),
      lastRoundAt: b.lastRoundAt, usStatus: b.usStatus, sponsorsCollege: b.sponsorsCollege, bizStatus: b.bizStatus,
      acquiredBy: b.acquiredBy, researchedAt: b.researchedAt,
      reachable: b.contacts.filter(c => !!(c.email || c.linkedinUrl)).length,
      need: workNeed({ tier: b.tier, workPeople: b.workPeople, liMembers: b.liMembers, big }),
      acceptRate: null, priority: priorityOf(b.category, priorities), giant: giantOf(b), now,
    })
    return [b.id, f] as const
  }))
  const fitOk = (id: string) => {
    const f = fitOf.get(id)
    return !minFit || (!!f && f.score >= minFit && !f.tooSmall && !f.ruledOut && !f.bizNote && f.priority !== 'skip')
  }
  // Giants held back from outreach (Leo, Oct 12 2026: "not yet" — the
  // Schedule's Giants switch, queue-rules.ts) and brands already reached
  // out to (the Schedule's own picks skip them) are read last: their
  // people are ready for later, but they never take a day's visits from
  // brands that can go out now. One Leo OK'd by hand is a plain brand.
  const giants = parseGiants(giantsSetting)
  const giantIds = new Set(everyBrand
    .filter(b => !giants.on && !giants.ok.has(b.id) && !!giantOf(b))
    .map(b => b.id))
  // Very big brands left off altogether (Leo, Oct 12 2026: "skip the very big
  // brands"): the giants the Schedule holds back (giants.ts — household names,
  // the big parents' brands, $1B+ sales) and anything with 1,500+ people on
  // LinkedIn, unless Leo OK'd that brand. Conglomerates (the parent companies
  // themselves) are read like any brand. The Schedule's own brands and names
  // he asked for still go.
  const skipBig = body.skipGiants === true
  const veryBig = (b: { id: string; name: string; aka: string | null; liMembers: number | null }) =>
    giantIds.has(b.id) || (!giants.ok.has(b.id) && !!veryBigWhy(b))
  const all = everyBrand
  const reachedIds = new Set(all
    .filter(b => b.targets.some(t => rowReached({ status: t.status, sentAt: t.sentAt, emailedAt: t.emailedAt, emails: t._count.emails })))
    .map(b => b.id))
  const underCap = all.filter(b => b._count.contacts < CONTACT_CAP_PER_BRAND)
  const ignoreRest = body.ignoreRest === true
  // Brands whose people are under a parent company (parents.ts): the run
  // looks there when the brand's own page gives nobody. One read before
  // that existed, with nobody added, doesn't rest the brand.
  const parentPages = await readJsonSetting<Record<string, string>>(prisma, LI_PARENT_PAGES_KEY, {})
  const parentFor = (name: string, aka: string | null) => {
    const p = parentOf(name, aka)
    return p ? { name: p.name, search: p.search, slug: parentPages[p.name] || null } : null
  }
  // With Sales Navigator (script 1.31+, Leo, Oct 12 2026): a brand read
  // on the People tab whose buyers LinkedIn hid ("LinkedIn Member") is
  // due again at once — Sales Navigator names them. Once per brand (the
  // mark's `sn`), and not after Zach's account has read it.
  const hiddenLog = body.salesNav === true ? await readHiddenLog(prisma) : {}
  // Also every brand read without it since it shipped, or that a run with
  // it on had to read on the People tab (Leo, Oct 12 2026: "make sure it
  // hits every brand that it skipped"). Once: a retry that still can't use
  // it (no company id…) is marked and rests like any other read.
  const snRetry = (b: { id: string; linkedinUrl: string | null }) => {
    const m = log[b.id], h = hiddenLog[b.id]
    if (body.salesNav !== true || !b.linkedinUrl || !m || m.sn || m.snRetried) return false
    return !!m.snMissed || Date.parse(m.at) >= SN_SINCE || (!!h && h.likely > 0 && !h.zachAt)
  }
  // Read before the Oct 13 2026 match fix and put on "Which LinkedIn page
  // is theirs?": due again once when its saved results now resolve (a
  // same-named company in another trade, LinkedIn's bare "Manufacturing").
  const review = await readJsonSetting<Review>(prisma, LI_REVIEW_KEY, {})
  const rematch = (b: { id: string; name: string; aka: string | null; category?: string | null }) => {
    const e = review[b.id], m = log[b.id]
    if (!e || (m && Date.parse(m.at) >= REMATCH_SINCE)) return false
    if (e.why === 'wrong') return !!e.pageIndustry && !pageLooksWrong(b.category, e.pageIndustry)
    return e.why === 'unclear' && !!decideCompanyMatch(b, e.candidates || []).pick
  }
  const restsNow = (b: { id: string; name: string; aka: string | null; category?: string | null }) =>
    liRestsNow(log[b.id], !!parentOf(b.name, b.aka)) && !rematch(b)
  const resting = underCap.filter(b => restsNow(b) && !snRetry(b)).length
  // Brands Leo said have no LinkedIn page ("None of these") aren't searched again.
  const confirmed = await readJsonSetting<Confirmed>(prisma, LI_CONFIRMED_KEY, {})
  const items = underCap
    .filter(b => ignoreRest || !restsNow(b) || snRetry(b))
    .filter(b => b.linkedinUrl || confirmed[b.id] !== 'none' || parentOf(b.name, b.aka))
    .map(b => ({
      brandId: b.id, name: b.name, aka: b.aka, category: b.category,
      // Typed into LinkedIn's search when the name finds nothing (script 1.35+).
      alsoSearch: b.aka ? null : secondSearchName(b.name, b.aka) || null,
      linkedinUrl: b.linkedinUrl, contacts: b._count.contacts, focus: matchesFocus(b, terms),
      // Leo said it has no page of its own: only its parent's is searched.
      noPage: !b.linkedinUrl && confirmed[b.id] === 'none',
      // Nobody in marketing / partnerships on file yet (buyers.ts).
      noBuyer: countBuyers(b.contacts.map(c => c.title)).total < BUYER_TARGET,
      parent: parentFor(b.name, b.aka),
      // Target (mid-size) brands first, then not yet measured, small, big
      // (brand-size.ts; Leo, Oct 2026).
      size: brandSize({ liMembers: b.liMembers, tier: b.tier, hasParent: !!parentOf(b.name, b.aka) }),
      members: b.liMembers ?? null,
      // Back only for Sales Navigator (it rests otherwise).
      hiddenRetry: restsNow(b) && snRetry(b),
      fit: fitOf.get(b.id)?.score ?? null,
    }))
    // Mid-size first (Leo, Oct 12 2026: "i want to target the midsized brands
    // mainly"): target → not measured → small → big. With a fit floor, within
    // a size the brands with no buyer go first, then best fit.
    .sort((a, b) => Number(b.focus) - Number(a.focus)
      || sizeRank(a.size) - sizeRank(b.size)
      || (minFit ? (Number(b.noBuyer) - Number(a.noBuyer)) || ((b.fit ?? 0) - (a.fit ?? 0)) : 0)
      || a.contacts - b.contacts || a.name.localeCompare(b.name))

  // The research list: Stock take's lane ideas — known brand names not
  // on the roster under any name — for the run to look up on LinkedIn.
  // A lane the focus word names goes first ("electrolyte" → the
  // Electrolytes & hydration lane), ahead of the focus brands we have.
  const research: any[] = []
  let researchWaiting = 0
  if (body.research === true) {
    const rlog = await readLiResearch(prisma)
    const roster = await prisma.brand.findMany({ select: { name: true, aka: true } })
    const onRoster = new Set<string>()
    for (const b of roster) for (const n of [b.name, ...String(b.aka || '').split(/[,;]/)]) if (n.trim()) onRoster.add(brandKey(n))
    const words = String(body.focus || '').toLowerCase().split(/[,;]/).map(w => w.trim()).filter(Boolean)
    for (const l of LANES) {
      if (!l.priority) continue
      const laneFocus = words.some(w => l.key.includes(w) || l.name.toLowerCase().includes(w) || !!(l.words && l.words.test(w)))
      for (const k of l.known) {
        const names = k.split('|').map(n => n.trim()).filter(Boolean)
        if (!names.length || names.some(n => onRoster.has(brandKey(n)))) continue
        const akaList = names.slice(1).join(', ') || null
        // A name that found no page of its own before the parent route
        // existed gets its parent looked at now.
        const mark = rlog[brandKey(names[0])]
        if (researchResting(mark) && !(parentOf(names[0], akaList) && mark?.note === 'no clear LinkedIn page')) { researchWaiting++; continue }
        research.push({
          research: true, name: names[0], aka: akaList,
          category: l.key, lane: l.name, linkedinUrl: null, contacts: 0, focus: laneFocus,
          parent: parentFor(names[0], akaList),
          // A giant name waits behind everything else (giants held back).
          giant: !giants.on && !!giantWhy(names[0], { aka: akaList }),
        })
      }
    }
  }
  // Brands Leo asked for by name go before everything else.
  if (body.research === true) {
    const rlog = await readLiResearch(prisma)
    const roster = await prisma.brand.findMany({ select: { name: true, aka: true } })
    const onRoster = new Set<string>()
    for (const b of roster) for (const n of [b.name, ...String(b.aka || '').split(/[,;]/)]) if (n.trim()) onRoster.add(brandKey(n))
    const asked: any[] = []
    for (const x of RESEARCH_EXTRA) {
      const names = x.name.split('|').map(n => n.trim()).filter(Boolean)
      if (!names.length || names.some(n => onRoster.has(brandKey(n)))) continue
      if (researchResting(rlog[brandKey(names[0])])) { researchWaiting++; continue }
      asked.push({
        research: true, asked: true, name: names[0], aka: names.slice(1).join(', ') || null,
        category: x.category, lane: 'Asked for by name', linkedinUrl: null, contacts: 0, focus: true,
      })
    }
    research.unshift(...asked)
  }
  // Very big names off the research list too (a name Leo asked for stays).
  let giantNamesSkipped = 0
  if (skipBig) {
    for (let i = research.length - 1; i >= 0; i--) if (research[i].giant && !research[i].asked) { research.splice(i, 1); giantNamesSkipped++ }
  }
  // First of all: brands the Schedule has on its coming days that are
  // short on people (Leo: "planned brands first"), so they have
  // someone to invite by their day — soonest day first. `planned` is
  // that day.
  const [planRow, shownRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'outreachPlan' } }),
    prisma.setting.findUnique({ where: { key: 'outreachShownDays' } }),
  ])
  const parse = (row: { value: string } | null) => { try { return row ? JSON.parse(row.value) : null } catch { return null } }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const due = dueDays({ plan: parse(planRow), shown: parse(shownRow), today })
  const dueIds = items.map(i => i.brandId).filter(id => due.has(id))
  const dueBrands = dueIds.length
    ? await prisma.brand.findMany({
        where: { id: { in: dueIds } },
        select: { id: true, name: true, aka: true, tier: true, liMembers: true, workPeople: true, contacts: { select: { email: true, linkedinUrl: true } } },
      })
    : []
  const short = new Set(dueBrands.filter(b => shortOnPeople({ ...b, big: isBigBrand(b) })).map(b => b.id))
  const { first: planned, rest: unplanned } = plannedFirst(items, due, short)
  const fitted = unplanned.filter(i => fitOk(i.brandId))
  const belowFit = unplanned.length - fitted.length
  const byId = new Map(everyBrand.map(b => [b.id, b] as const))
  const rest = skipBig ? fitted.filter(i => !veryBig(byId.get(i.brandId)!)) : fitted
  const bigSkipped = fitted.length - rest.length + giantNamesSkipped
  // After the focus word: target brands, then the research list's names,
  // then the rest by size (unknown, small, big). Then the brands with no
  // buyer pulled ahead of all that, each group in that same order — only
  // the Schedule's brands and the names Leo asked for come before them.
  const others = rest.filter(i => !i.focus)
  const bySize = [
    ...planned,
    ...research.filter(r => r.focus), ...rest.filter(i => i.focus),
    ...others.filter(i => i.size === 'target'),
    ...research.filter(r => !r.focus), ...others.filter(i => i.size !== 'target'),
  ]
  // With a fit floor, size leads (mid-size first) and "no buyer yet" only
  // orders brands within a size; without one, as before.
  const sorted: any[] = minFit ? bySize : noBuyerFirst<any>(bySize)
  // Then brands already reached out to, then giants held back — each in
  // the same order as before. The Schedule's own brands and the names Leo
  // asked for keep their place.
  const tail = (i: any) => (i.planned || i.asked) ? 0
    : (i.research ? i.giant : giantIds.has(i.brandId)) ? 2
    : !i.research && reachedIds.has(i.brandId) ? 1 : 0
  // The brands back for Sales Navigator go right after the Schedule's and
  // the names Leo asked for: their buyers are known to be there.
  const lead = sorted.filter(i => i.planned || i.asked)
  const front = sorted.filter(i => tail(i) === 0 && !lead.includes(i))
  // The ones moved to the back don't go first for having no buyer or
  // the focus word any more, so the run's panel mustn't say they do.
  // Brands with a LinkedIn page before those the run has to search for (a
  // search often finds no clear page — a visit for nothing).
  const paged = (xs: any[]) => [...xs.filter(i => i.research || i.linkedinUrl), ...xs.filter(i => !i.research && !i.linkedinUrl)]
  const ordered = [...lead, ...paged(front.filter(i => i.hiddenRetry)), ...paged(front.filter(i => !i.hiddenRetry)),
    ...[1, 2].flatMap(n => sorted.filter(i => tail(i) === n))]
    .map(i => (tail(i) ? { ...i, noBuyer: false, focus: false, last: tail(i) === 1 ? 'reached' : 'giant' } : i))
  const reachedLast = (i: any) => i.last === 'reached'
  return {
    items: ordered,
    // Brands on the list with nobody in marketing / partnerships yet —
    // they go right after the Schedule's (the panel says so).
    noBuyer: ordered.filter(i => i.noBuyer && !i.research && !i.planned).length,
    hiddenRetry: ordered.filter(i => i.hiddenRetry).length,
    minFit, belowFit, bigSkipped,
    research: research.length,
    researchFocus: ordered.filter(i => i.research && i.focus).length,
    researchWaiting,
    focusCount: ordered.filter(i => i.focus).length,
    planned: planned.length,
    // Of the brands on this list (after any fit floor / big-brand skip).
    sizes: { target: ordered.filter(i => !i.research && i.size === 'target').length, unknown: ordered.filter(i => !i.research && i.size === 'unknown').length, small: ordered.filter(i => !i.research && i.size === 'small').length, big: ordered.filter(i => !i.research && i.size === 'big').length },
    midFirst: !!minFit,
    noPage: items.filter(i => !i.linkedinUrl).length,
    resting,
    underCap: underCap.length,
    // Read last: brands already reached out to, then giants held back.
    reachedLast: ordered.filter(reachedLast).length,
    giantsLast: ordered.filter(i => i.last === 'giant').length,
    cap: CONTACT_CAP_PER_BRAND,
    latest: LI_SCRIPT_VERSION,
  }
}
