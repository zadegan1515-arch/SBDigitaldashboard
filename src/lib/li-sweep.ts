// src/lib/li-sweep.ts
//
// What the unattended LinkedIn fill did last time, per brand — so the
// next run skips brands that just gave nothing, and the dashboard can say
// why a brand is still thin ("no clear LinkedIn page — do it by hand").
// JSON in Setting["liSweepLog"], brandId -> last visit. Same shape and
// idea as the SponsorUnited sweep log in su-match.ts, kept separate
// because the two sites run on different clocks.

export const LI_SWEEP_KEY = 'liSweepLog'
// LinkedIn's People pages change slowly; a brand that gave nothing new
// (or had no clear company page) waits a month before the next visit.
export const LI_REST_DAYS = 30
const LI_KEEP_DAYS = 120
// Leo (Sep 2026): only companies with under 100 people on LinkedIn. The
// script skips a bigger one on its People tab's count ("too big — …");
// a company doesn't shrink under 100 in a month, so it rests a year.
export const LI_BIG_REST_DAYS = 365
export const isTooBig = (mark: { note?: string | null } | undefined) => /^too big\b/i.test(String(mark?.note || ''))

// The script's card reader. Reader 1 misread LinkedIn's "• 3rd+" badge as
// people's titles and added nobody, so its visits prove nothing: a mark
// from an older reader never rests a brand. The ingest route refuses
// LinkedIn calls from older readers altogether.
export const LI_READER = 2

// The current LinkedIn script, = its @version. The dashboard tells older
// copies there's an update (the pill turns orange; one click takes it),
// since Tampermonkey on its own only checks about once a day.
// scripts/test-li-script.js fails when the two drift apart.
export const LI_SCRIPT_VERSION = '1.38'

// Sales Navigator in the fill (script 1.31, Oct 12 2026): reads before this
// were on the People tab only.
export const SN_SINCE = Date.parse('2026-10-12T04:00:00Z')

// Read again only when something went wrong (Leo, Oct 14 2026: "make sure
// that brands that have already been run don't run again unless there's an
// issue with the people that they got"). A clean read — Sales Navigator
// opened and every search was read to its end — never comes back by itself.
// A read with an issue (Sales Navigator's results didn't load, no company
// id, another company's people, fewer read than it showed, the dashboard
// didn't save…) goes first on the next run, for LI_RETRY_MAX runs in all;
// still failing, it rests a month and shows on the run report as stuck.
export const LI_RETRY_MAX = 3

// sn = the read went through Sales Navigator, which names people the
// People tab hides ("LinkedIn Member"); snMissed = a run with it on read
// the People tab instead; snRetried = that was the brand's one retry.
// Since 1.38: clean / issue (+ issueNote, tries = failed runs in a row,
// run = the run that wrote it), skip 'veryBig' (left at 1,500+ on
// LinkedIn), shown / read (Sales Navigator's results vs people read).
export type LiMark = {
  at: string; seen: number; added: number; note?: string | null; v?: number; parentTried?: boolean
  sn?: boolean; snMissed?: boolean; snRetried?: boolean
  clean?: boolean; issue?: string | null; issueNote?: string | null; tries?: number; run?: string | null
  skip?: string | null; shown?: number | null; read?: number | null
  // Read by a run with Sales Navigator switched off (1.38).
  snOff?: boolean
}
export type LiLog = Record<string, LiMark>

// What went wrong, in words (the run report, Brands' coverage, the fill schedule).
const ISSUE_WORDS: Record<string, string> = {
  snNoLoad: 'Sales Navigator’s results didn’t load',
  snNoId: 'couldn’t find its LinkedIn company id',
  snOtherCompany: 'Sales Navigator showed another company’s people',
  snLeft: 'Sales Navigator didn’t open',
  noOpen: 'its page wouldn’t open',
  save: 'the dashboard didn’t save',
  partial: 'didn’t read all the people',
  peopleNoLoad: 'its People tab didn’t load',
  reading: 'the reader misread the page',
  noSalesNav: 'read without Sales Navigator',
}
export const issueWords = (issue: string | null | undefined) => (issue ? ISSUE_WORDS[issue] || issue : '')

// A mark from before 1.38 has no clean / issue: a Sales Navigator read (or
// its one retry) is clean; a People-tab read since Sales Navigator shipped
// is an issue (read again, with it) — not a brand whose page was the
// problem (no clear page, another company's): that's Leo's list, and the
// old month; an older read that found people is done, one that found
// nobody keeps the old month's rest.
const PAGE_NOTE = /no clear LinkedIn page|no LinkedIn page|looks like another company|its LinkedIn page is saved on|could not find .+ on LinkedIn/i
export function markOutcome(mark: LiMark): { clean: boolean; issue: string | null } {
  if (mark.clean !== undefined || mark.issue !== undefined) return { clean: !!mark.clean && !mark.issue, issue: mark.issue || null }
  // snRetried without sn = its one retry still couldn't use Sales Navigator.
  if (mark.sn) return { clean: true, issue: null }
  if ((mark.snMissed || Date.parse(mark.at) >= SN_SINCE) && !PAGE_NOTE.test(mark.note || '')) return { clean: false, issue: 'noSalesNav' }
  return { clean: !!mark.added, issue: null }
}

// What a liSwept says about the read, as a mark's outcome. Script 1.38
// sends `issue` (a code above, or null) and `done` (it read everything it
// meant to: every Sales Navigator search to its end, or the parent
// company's page); clean = done with no issue. Older copies send neither:
// a Sales Navigator read is clean, a run that meant to use it and read the
// People tab is an issue, anything else keeps the old month's rest.
export const ISSUE_CODES = Object.keys(ISSUE_WORDS)
export function sweptOutcome(body: any): Pick<LiMark, 'clean' | 'issue' | 'issueNote' | 'run' | 'skip' | 'shown' | 'read' | 'snOff'> {
  const b = body && typeof body === 'object' ? body : {}
  const sn = b.salesNav === true
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))))
  let issue: string | null = typeof b.issue === 'string' && b.issue ? (ISSUE_CODES.includes(b.issue) ? b.issue : 'reading') : null
  if (!issue && b.problem) issue = 'reading'
  if (!issue && !('done' in b) && b.snMissed === true && !sn) issue = 'noSalesNav'
  const skip = b.skipped === 'veryBig' ? 'veryBig' : null
  const done = 'done' in b ? b.done === true : sn
  return {
    clean: !issue && !skip && done,
    issue,
    issueNote: issue ? String(b.issueNote || b.note || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null : null,
    run: b.run ? String(b.run).slice(0, 80) : null,
    skip,
    shown: num(b.shown),
    read: num(b.read),
    ...(b.snOn === false ? { snOff: true } : {}),
  }
}

// The issues that only a Sales Navigator read can clear.
export const SN_ISSUES = ['snNoLoad', 'snNoId', 'snOtherCompany', 'snLeft', 'partial', 'noSalesNav']

// The mark a visit leaves, given the one before: a run with Sales Navigator
// switched off that ends with nothing wrong doesn't clear a Sales Navigator
// issue (nor count as a try) — the brand still needs it.
export function nextMark(prev: LiMark | undefined, mark: Omit<LiMark, 'at'>, at: string): LiMark {
  const before = prev ? markOutcome(prev) : null
  if (mark.snOff && !mark.issue && !mark.clean && !mark.skip && before?.issue && SN_ISSUES.includes(before.issue)) {
    return { at, ...mark, issue: before.issue, issueNote: prev!.issueNote || null, tries: prev!.tries || 1 }
  }
  const tries = nextTries(prev, mark)
  return { at, ...mark, ...(mark.issue ? { tries } : {}) }
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readLiLog(db: SettingStore): Promise<LiLog> {
  try {
    const row = await db.setting.findUnique({ where: { key: LI_SWEEP_KEY } })
    const parsed = row ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A corrupt value must never stop a run.
    return {}
  }
}

// Failed runs in a row: the same run posting twice (a retried post, the
// in-run second try) counts once; a clean read starts over.
export function nextTries(prev: LiMark | undefined, mark: Pick<LiMark, 'issue' | 'run'>): number {
  if (!mark.issue) return 0
  const before = prev ? markOutcome(prev).issue : null
  if (!prev || !before) return 1
  const n = prev.tries || 1
  return prev.run && mark.run && prev.run === mark.run ? n : n + 1
}

// One writer at a time (a retried post and the next brand's can land
// together); clean marks are kept for good — they're what keeps a brand
// from being read again — the rest for LI_KEEP_DAYS.
export async function markLiSwept(db: SettingStore & { $transaction?: any }, brandId: string, mark: Omit<LiMark, 'at'>) {
  const write = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_SWEEP_KEY}))::text`
    const log = await readLiLog(tx)
    log[brandId] = nextMark(log[brandId], mark, new Date().toISOString())
    const cutoff = Date.now() - LI_KEEP_DAYS * 864e5
    const kept: LiLog = {}
    const bigCutoff = Date.now() - LI_BIG_REST_DAYS * 864e5
    for (const [id, m] of Object.entries(log)) {
      if (m && (markOutcome(m).clean || Date.parse(m.at) >= (isTooBig(m) ? bigCutoff : cutoff))) kept[id] = m
    }
    const v = JSON.stringify(kept)
    await tx.setting.upsert({ where: { key: LI_SWEEP_KEY }, create: { key: LI_SWEEP_KEY, value: v }, update: { value: v } })
  }
  if (typeof db.$transaction === 'function') await db.$transaction(write, { maxWait: 10000, timeout: 20000 })
  else await write(db)
}

// Any other change to the visit log (Leo's page pick, "send it back to the
// fill") under the same lock, so it can't be undone by a visit landing at
// the same moment — a clean mark lost that way would bury the brand.
export async function updateLiLog<T>(db: SettingStore & { $transaction?: any }, fn: (log: LiLog) => T): Promise<T> {
  let out: T
  const write = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_SWEEP_KEY}))::text`
    const log = await readLiLog(tx)
    out = fn(log)
    const v = JSON.stringify(log)
    await tx.setting.upsert({ where: { key: LI_SWEEP_KEY }, create: { key: LI_SWEEP_KEY, value: v }, update: { value: v } })
  }
  if (typeof db.$transaction === 'function') await db.$transaction(write, { maxWait: 10000, timeout: 20000 })
  else await write(db)
  return out!
}

// Whether the fill reads a brand now (the worklist, liList, and All brands'
// coverage card, coverage.ts, both ask this):
//   due    on the list
//   retry  on it because the last read had an issue (it goes first)
//   stuck  the issue outlasted LI_RETRY_MAX runs: rests until `back`
//   back   when it's due again (null = only by hand — a clean read)
// A brand with a parent company (parents.ts) whose People tab the run
// hasn't searched yet is due at once when its own page gave nobody.
export type LiDue = { due: boolean; retry: boolean; stuck: boolean; back: string | null; issue: string | null; tries: number }
export function liDue(mark: LiMark | undefined, hasParent: boolean, now = Date.now()): LiDue {
  const due: LiDue = { due: true, retry: false, stuck: false, back: null, issue: null, tries: 0 }
  if (!mark || !mark.v || mark.v < LI_READER || isTooBig(mark)) return due
  // Left at 1,500+ by Skip very big brands: its headcount is saved now, so
  // the worklist leaves it off while that's on, and reads it when it's off.
  if (mark.skip === 'veryBig') return due
  // A parent whose page wasn't found (script ≤1.20 marked it tried anyway),
  // or one the run hasn't tried yet.
  const at = Date.parse(mark.at)
  const { clean, issue } = markOutcome(mark)
  // (Not a brand whose read went wrong: that goes through its retries.)
  if (!issue && hasParent && !mark.added && (/could not find .+ on LinkedIn/.test(mark.note || '') || !mark.parentTried)) return due
  const month = Number.isFinite(at) ? at + LI_REST_DAYS * 864e5 : 0
  if (issue) {
    // A legacy snRetried mark had its one retry already: one more.
    const tries = mark.tries || (mark.snRetried && !mark.sn ? LI_RETRY_MAX - 1 : 1)
    if (tries < LI_RETRY_MAX || now >= month) return { ...due, retry: true, issue, tries }
    return { due: false, retry: false, stuck: true, back: new Date(month).toISOString(), issue, tries }
  }
  if (clean) return { due: false, retry: false, stuck: false, back: null, issue: null, tries: 0 }
  return now >= month ? due : { due: false, retry: false, stuck: false, back: new Date(month).toISOString(), issue: null, tries: 0 }
}
export function liRestsNow(mark: LiMark | undefined, hasParent: boolean, now = Date.now()): boolean {
  return !liDue(mark, hasParent, now).due
}

// ---- the research list ----
//
// Names from Stock take's lane ideas that the run looked up on LinkedIn.
// Keyed by brandKey of the list name. "added" names are brands now and
// drop off the ideas by themselves; an "unclear" one waits a month
// before the run tries it again, and Stock take shows the note.

export const LI_RESEARCH_KEY = 'liResearchLog'

export type LiResearchMark = { at: string; outcome: 'added' | 'exists' | 'unclear' | 'taken'; note?: string | null }
export type LiResearchLog = Record<string, LiResearchMark>

export async function readLiResearch(db: SettingStore): Promise<LiResearchLog> {
  try {
    const row = await db.setting.findUnique({ where: { key: LI_RESEARCH_KEY } })
    const parsed = row ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function markLiResearch(db: SettingStore, key: string, mark: Omit<LiResearchMark, 'at'>) {
  const log = await readLiResearch(db)
  log[key] = { at: new Date().toISOString(), ...mark }
  const v = JSON.stringify(log)
  await db.setting.upsert({ where: { key: LI_RESEARCH_KEY }, create: { key: LI_RESEARCH_KEY, value: v }, update: { value: v } })
}

export function researchResting(mark: LiResearchMark | undefined, now = Date.now()): boolean {
  if (!mark || mark.outcome === 'added' || mark.outcome === 'exists') return false
  const at = Date.parse(mark.at)
  return Number.isFinite(at) && now - at < LI_REST_DAYS * 864e5
}
