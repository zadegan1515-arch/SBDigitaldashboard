// The LinkedIn fill's worklist (liList) — which brands the run reads and in
// what order. Shared by /api/ingest (the script asks for it) and /api/data
// (fillSchedule: Outreach → People's "Fill schedule", the same list split
// into the run's days), so the schedule is always what the run really reads.
// Read-only.
import { PrismaClient } from '@prisma/client'
import { focusTerms, matchesFocus, decideCompanyMatch, pageLooksWrong } from './li-capture'
import { readLiLog, liDue, issueWords, readLiResearch, researchResting, LI_SCRIPT_VERSION, SN_SINCE, SN_ISSUES, LI_REST_DAYS } from './li-sweep'
import { readHiddenLog } from './li-hidden'
import { parentOf, isParentCompany, LI_PARENT_PAGES_KEY } from './parents'
import { readJsonSetting, LI_CONFIRMED_KEY, LI_REVIEW_KEY, type Confirmed, type Review } from './li-review'
import { LANES, RESEARCH_EXTRA, brandKey, secondSearchName } from './stock'
import { dueDays, shortOnPeople, plannedFirst, workNeed } from './planned-first'
import { scoreBrand, priorityOf, isTopCategory } from './brand-fit'
import { brandSize } from './brand-size'
import { countBuyers, BUYER_TARGET } from './buyers'
import { byFit } from './fill-schedule'
import { giantWhy } from './giants'
import { giantOf, veryBigWhy, rowReached, parseGiants, GIANTS_KEY, VERY_BIG_LI } from './queue-rules'
import { isBigBrand } from './brand-work'

// How many people we keep on file per brand (Leo, Sep 2026) — see
// /api/ingest. The fill only reads brands under it.
export const CONTACT_CAP_PER_BRAND = 25
// The day the fill's Sales Navigator step shipped (New York midnight): a
// brand read since then without it is due for it (li-sweep.ts markOutcome).
export { SN_SINCE }
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
      need: workNeed({ tier: b.tier, workPeople: b.workPeople, liMembers: b.liMembers, big, top: isTopCategory(b.category, priorities) }),
      acceptRate: null, priority: priorityOf(b.category, priorities), giant: giantOf(b),
      name: b.name, about: b.about, topProducts: b.topProducts, notes: b.notes, now,
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
  // Read again only when the last read had an issue (li-sweep.ts liDue —
  // Leo, Oct 14 2026: "make sure that brands that have already been run
  // don't run again unless there's an issue with the people that they got"):
  // those go first, right after the Schedule's and the names Leo asked for;
  // a clean read stays off. A People-tab read from before Sales Navigator
  // whose buyers LinkedIn hid ("LinkedIn Member") is read once more with it
  // (not after Zach's account has read it).
  const hiddenLog = body.salesNav === true ? await readHiddenLog(prisma) : {}
  // A Sales Navigator issue a run with it switched off already read (it
  // kept the issue): that kind of run leaves it for a month — only Sales
  // Navigator can clear it.
  const dueOf = (b: { id: string; name: string; aka: string | null }) => {
    const m = log[b.id], d = liDue(m, !!parentOf(b.name, b.aka))
    if (body.salesNav !== true && m?.snOff && d.due && SN_ISSUES.includes(d.issue || '')) {
      const back = Date.parse(m.at) + LI_REST_DAYS * 864e5
      if (Date.now() < back) return { ...d, due: false, retry: false, back: new Date(back).toISOString() }
    }
    return d
  }
  const hiddenOld = (b: { id: string; linkedinUrl: string | null }) => {
    const m = log[b.id], h = hiddenLog[b.id]
    if (body.salesNav !== true || !b.linkedinUrl || !m || m.clean !== undefined || m.issue !== undefined || m.sn || m.snRetried) return false
    return Date.parse(m.at) < SN_SINCE && !!h && h.likely > 0 && !h.zachAt
  }
  // A Sales Navigator issue goes first only on a run that uses it (with the
  // switch off it's just due — and that read doesn't clear it, li-sweep.ts).
  const retryOf = (b: { id: string; name: string; aka: string | null; linkedinUrl: string | null }) => {
    const d = dueOf(b)
    return (d.retry && (body.salesNav === true || !SN_ISSUES.includes(d.issue || ''))) || hiddenOld(b)
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
    !dueOf(b).due && !rematch(b)
  const resting = underCap.filter(b => restsNow(b) && !hiddenOld(b)).length
  // Of those: read in full (never back by itself), and stuck (an issue
  // that outlasted its retries — back in a month).
  const stuck = underCap.filter(b => dueOf(b).stuck && !rematch(b)).length
  // Brands Leo said have no LinkedIn page ("None of these") aren't searched again.
  const confirmed = await readJsonSetting<Confirmed>(prisma, LI_CONFIRMED_KEY, {})
  const items = underCap
    .filter(b => ignoreRest || !restsNow(b) || hiddenOld(b))
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
      // Back because the last read had an issue (or, before Sales Navigator,
      // hid its buyers): it goes first. `hiddenRetry` = the same, for 1.37.
      retry: retryOf(b),
      issue: dueOf(b).issue || (hiddenOld(b) ? 'noSalesNav' : null),
      tries: dueOf(b).tries,
      issueNote: log[b.id]?.issueNote || null,
      issueText: issueWords(dueOf(b).issue || (hiddenOld(b) ? 'noSalesNav' : null)) || null,
      hiddenRetry: retryOf(b),
      fit: fitOf.get(b.id)?.score ?? null,
    }))

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
        select: { id: true, name: true, aka: true, category: true, tier: true, liMembers: true, workPeople: true, contacts: { select: { email: true, linkedinUrl: true } } },
      })
    : []
  const short = new Set(dueBrands.filter(b => shortOnPeople({ ...b, big: isBigBrand(b), top: isTopCategory(b.category, priorities) })).map(b => b.id))
  const { first: planned, rest: unplanned } = plannedFirst(items, due, short)
  // A retry meets the floor like any brand (the floor may have changed, or
  // its facts — a Skip category, not sold in the US).
  const fitted = unplanned.filter(i => fitOk(i.brandId))
  const belowFit = unplanned.length - fitted.length
  const byId = new Map(everyBrand.map(b => [b.id, b] as const))
  const rest = skipBig ? fitted.filter(i => !veryBig(byId.get(i.brandId)!)) : fitted
  const bigSkipped = fitted.length - rest.length + giantNamesSkipped
  // Best Brand Fit first (Leo, Oct 19 2026: "have the highest rated brands
  // … ran first then the lower ones after"; it replaced mid-size first and
  // re-reads first — byFit in fill-schedule.ts, where those only break a
  // tie). Before them: the Schedule's brands short on people (soonest day
  // first) and the names Leo asked for. After them: research names (not on
  // the roster, no score yet), then brands already reached out to, then
  // giants held back — each best fit first.
  const tail = (i: any) => (i.planned || i.asked) ? 0
    : (i.research ? i.giant : giantIds.has(i.brandId)) ? 2
    : !i.research && reachedIds.has(i.brandId) && !i.retry ? 1 : 0
  // The Schedule's: soonest day first, best fit first within a day.
  const byDay = (a: any, b: any) => (a.planned < b.planned ? -1 : a.planned > b.planned ? 1 : 0)
  const lead: any[] = [...byFit(planned).sort(byDay), ...research.filter(r => r.asked)]
  const pool: any[] = [...rest, ...research.filter(r => !r.asked)]
  const sorted: any[] = [...lead, ...byFit(pool.filter(i => tail(i) === 0 && !i.research)), ...pool.filter(i => tail(i) === 0 && i.research)]
  // The ones moved to the back don't go first for having no buyer or
  // the focus word any more, so the run's panel mustn't say they do.
  const ordered = [...sorted, ...[1, 2].flatMap(n => byFit(pool.filter(i => tail(i) === n)))]
    .map(i => (tail(i) ? { ...i, noBuyer: false, focus: false, last: tail(i) === 1 ? 'reached' : 'giant' } : i))
    // Whether the run may read it past 1,500 on LinkedIn (script 1.38 skips
    // at its People tab's count when Skip very big brands is on): the
    // Schedule's brands, names Leo asked for, giants he OK'd, conglomerates.
    .map(i => ({ ...i, bigOk: !skipBig || !!i.planned || !!i.asked || (!!i.brandId && giants.ok.has(i.brandId)) || isParentCompany(i.name, i.aka ?? null) }))
  const reachedLast = (i: any) => i.last === 'reached'
  return {
    items: ordered,
    // Brands on the list with nobody in marketing / partnerships yet —
    // they go right after the Schedule's (the panel says so).
    noBuyer: ordered.filter(i => i.noBuyer && !i.research && !i.planned).length,
    hiddenRetry: ordered.filter(i => i.retry).length,
    retry: ordered.filter(i => i.retry).length,
    stuck,
    skipBig,
    minFit, belowFit, bigSkipped,
    research: research.length,
    researchFocus: ordered.filter(i => i.research && i.focus).length,
    researchWaiting,
    focusCount: ordered.filter(i => i.focus).length,
    planned: planned.length,
    // Of the brands on this list (after any fit floor / big-brand skip).
    sizes: { target: ordered.filter(i => !i.research && i.size === 'target').length, unknown: ordered.filter(i => !i.research && i.size === 'unknown').length, small: ordered.filter(i => !i.research && i.size === 'small').length, big: ordered.filter(i => !i.research && i.size === 'big').length },
    // Best Brand Fit first (script 1.39 says so); mid-size first is gone.
    fitFirst: true,
    midFirst: false,
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
