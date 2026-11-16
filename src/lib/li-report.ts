// src/lib/li-report.ts
//
// What each unattended LinkedIn run did, told by the script as it goes:
// when it started, every brand it finished (people seen / added, why it
// skipped one), where it paused and why, how it ended. When the card
// reader looks broken on a page — LinkedIn showed people and the reader
// made out none, or every title came out the same — the script sends
// what it saw of the first cards, so the fix can start from LinkedIn's
// real markup instead of Leo pasting a sample.
//
// Leo reads it on Outreach → People; Claude reads it through
// /api/reports/linkedin (read-only, REPORT_TOKEN) for the morning check.
// JSON in Setting["liRunReports"], newest run first, last 10 runs.

import type { PageCounts } from './coverage'

export const LI_RUNS_KEY = 'liRunReports'
const KEEP_RUNS = 10
const KEEP_BRANDS = 300
const KEEP_PAUSES = 20
const KEEP_SAMPLES = 3
const SAMPLE_CHARS = 6000

export type RunBrand = {
  at: string
  name: string
  brandId?: string | null
  seen: number
  added: number
  note?: string | null
  problem?: string | null
  // How long the brand took, and how much of that its window was hidden
  // (Chrome slows a hidden window to about a step a minute).
  ms?: number | null
  hiddenMs?: number
  // "via Diageo" (the parent's People tab) or "big company: searched …"
  via?: string | null
  // LinkedIn's "N associated members" for a big brand
  members?: number | null
  // "LinkedIn Member" cards — people Leo's account can't see — and how
  // many of them look like buyers (li-hidden.ts; script 1.30+).
  hiddenPeople?: number | null
  hiddenLikely?: number | null
  // Script 1.38: what went wrong (li-sweep.ts ISSUE_WORDS), whether this
  // was the brand's second try in the run, lookalikes sent to Discover, and
  // the post's own key (a post retried after a timeout counts once).
  issue?: string | null
  again?: boolean
  review?: number
  key?: string | null
}
export type RunReport = {
  id: string
  startedAt: string
  lastAt: string
  script: string | null
  reader: number
  focus: string | null
  items: number | null
  status: 'running' | 'paused' | 'finished' | 'stopped'
  added: number
  brands: RunBrand[]
  pauses: Array<{ at: string; why: string }>
  problems: number
  samples: Array<{ at: string; name: string; problem: string; sample: string }>
  newBrands: number
  hiddenMs?: number
  // Lookalikes sent to Discover for review (1.38) and brands whose last try
  // in the run had an issue (issueBy: each brand's last word, brandId|name).
  review?: number
  issues?: number
  issueBy?: Record<string, string | null>
  // Brands with no LinkedIn page saved (coverage.ts pageCounts): `before`
  // from when the run started — or, for a run already going when this
  // shipped, from its first word after — and `after` from its last pause or
  // its end. The card sets `before` beside now while the run is going.
  pages?: { before?: PageCounts; after?: PageCounts }
}

export type RunEvent = {
  kind: 'start' | 'brand' | 'pause' | 'resume' | 'finish'
  run: string
  script?: string | null
  reader?: number
  focus?: string | null
  items?: number | null
  name?: string
  brandId?: string | null
  seen?: number
  added?: number
  note?: string | null
  problem?: string | null
  sample?: string | null
  why?: string | null
  stopped?: boolean
  newBrands?: number
  ms?: number | null
  hiddenMs?: number
  via?: string | null
  members?: number | null
  hiddenPeople?: number | null
  hiddenLikely?: number | null
  issue?: string | null
  again?: boolean
  review?: number
  key?: string | null
  // The page counts as this event arrives (recordRun reads them only when
  // pagesWanted says the run keeps them).
  pages?: PageCounts | null
}

// Does this event's run keep the page counts? Its start (before), its
// first word when it has no `before` yet, and every pause and its end
// (after). Not every brand: the card reads "now" itself.
export function pagesWanted(run: RunReport | undefined | null, kind: RunEvent['kind']): boolean {
  if (kind === 'start' || kind === 'pause' || kind === 'finish') return true
  return !run || !run.pages || !run.pages.before
}

// What a count has to look like to be kept (the report is JSON in a
// Setting, and the event comes off the wire): anything else is left out.
const PAGE_KEYS: Array<Exclude<keyof PageCounts, 'at'>> = ['brands', 'noPage', 'inPlay', 'waiting', 'next', 'nobody']
export function cleanPageCounts(v: unknown): PageCounts | null {
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at))) return null
  const out = { at: o.at } as PageCounts
  for (const k of PAGE_KEYS) {
    const n = Number(o[k])
    if (o[k] == null || !Number.isFinite(n) || n < 0) return null
    out[k] = Math.floor(n)
  }
  return out
}

const str = (v: unknown, n: number) => (v == null || v === '' ? null : String(v).slice(0, n))
const num = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0))

// Pure: the reports after one event. An event for a run we never heard
// start (an older copy of the script started it) opens that run here.
export function applyRunEvent(reports: RunReport[], ev: RunEvent, now = new Date()): RunReport[] {
  const id = str(ev && ev.run, 40)
  if (!id) return reports
  const at = now.toISOString()
  const list = reports.filter(r => r && r.id)
  let run = list.find(r => r.id === id)
  if (!run) {
    run = {
      id, startedAt: at, lastAt: at, script: null, reader: 0, focus: null, items: null,
      status: 'running', added: 0, brands: [], pauses: [], problems: 0, samples: [], newBrands: 0,
    }
    list.unshift(run)
  }
  run.lastAt = at
  if (ev.script) run.script = str(ev.script, 12)
  if (ev.reader) run.reader = num(ev.reader)

  const snap = cleanPageCounts(ev.pages)
  if (snap && pagesWanted(run, ev.kind)) {
    const p = run.pages || (run.pages = {})
    // A start is a new before; a run heard of late takes its first count.
    if (ev.kind === 'start' || !p.before) { p.before = snap; delete p.after }
    else p.after = snap
  }

  if (ev.kind === 'start') {
    run.startedAt = at
    run.focus = str(ev.focus, 60)
    run.items = ev.items == null ? null : num(ev.items)
    run.status = 'running'
  } else if (ev.kind === 'brand') {
    const key = str(ev.key, 120)
    if (key && run.brands.some(x => x.key === key)) return list
    const b: RunBrand = {
      at,
      name: str(ev.name, 120) || '(unnamed)',
      brandId: str(ev.brandId, 40),
      seen: num(ev.seen),
      added: num(ev.added),
      note: str(ev.note, 160),
      problem: str(ev.problem, 200),
      ms: ev.ms == null ? null : num(ev.ms),
      hiddenMs: num(ev.hiddenMs),
      via: str(ev.via, 120),
      members: ev.members == null ? null : num(ev.members),
      hiddenPeople: ev.hiddenPeople == null ? null : num(ev.hiddenPeople),
      hiddenLikely: ev.hiddenLikely == null ? null : num(ev.hiddenLikely),
      issue: str(ev.issue, 40),
      again: ev.again === true,
      review: num(ev.review),
      key,
    }
    if (run.brands.length < KEEP_BRANDS) run.brands.push(b)
    run.added += b.added
    if (b.review) run.review = (run.review || 0) + b.review
    // A brand that went wrong and then came out fine on its second try
    // isn't one with an issue; one that failed twice counts once.
    const by = run.issueBy || (run.issueBy = {})
    by[b.brandId || b.name] = b.issue || null
    run.issues = Object.values(by).filter(Boolean).length
    run.hiddenMs = (run.hiddenMs || 0) + (b.hiddenMs || 0)
    if (b.problem) {
      run.problems++
      const sample = str(ev.sample, SAMPLE_CHARS)
      if (sample && run.samples.length < KEEP_SAMPLES) run.samples.push({ at, name: b.name, problem: b.problem, sample })
    }
    if (run.status === 'paused') run.status = 'running'
  } else if (ev.kind === 'pause') {
    run.status = 'paused'
    if (run.pauses.length < KEEP_PAUSES) run.pauses.push({ at, why: str(ev.why, 300) || 'paused' })
  } else if (ev.kind === 'resume') {
    run.status = 'running'
  } else if (ev.kind === 'finish') {
    run.status = ev.stopped ? 'stopped' : 'finished'
    run.newBrands = num(ev.newBrands)
  }

  list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return list.slice(0, KEEP_RUNS)
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readRuns(db: SettingStore): Promise<RunReport[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: LI_RUNS_KEY } })
    const parsed = row ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// One writer at a time: a brand's report and the run's end can arrive
// together, and a plain read-then-write would drop one of them.
//
// `pages` reads the page counts (coverage-db.ts readPageCounts). It's asked
// only when the run keeps them for this event, and before the lock is
// taken — a count that can't be read never costs the report its event.
export async function recordRun(
  db: SettingStore & { $transaction?: any },
  ev: RunEvent,
  pages?: () => Promise<PageCounts | null>,
) {
  let snap: PageCounts | null = null
  if (pages && ev && ev.run) {
    try {
      const run = (await readRuns(db)).find(r => r && r.id === String(ev.run).slice(0, 40))
      if (pagesWanted(run, ev.kind)) snap = await pages()
    } catch { snap = null }
  }
  const event = snap ? { ...ev, pages: snap } : ev
  const write = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_RUNS_KEY}))::text`
    const next = applyRunEvent(await readRuns(tx), event)
    const v = JSON.stringify(next)
    await tx.setting.upsert({ where: { key: LI_RUNS_KEY }, create: { key: LI_RUNS_KEY, value: v }, update: { value: v } })
  }
  // Generous waits: a cold serverless start can take seconds to get a
  // connection, and a dropped event is a hole in the report.
  if (typeof db.$transaction === 'function') await db.$transaction(write, { maxWait: 10000, timeout: 20000 })
  else await write(db)
}
