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

  if (ev.kind === 'start') {
    run.startedAt = at
    run.focus = str(ev.focus, 60)
    run.items = ev.items == null ? null : num(ev.items)
    run.status = 'running'
  } else if (ev.kind === 'brand') {
    const b: RunBrand = {
      at,
      name: str(ev.name, 120) || '(unnamed)',
      brandId: str(ev.brandId, 40),
      seen: num(ev.seen),
      added: num(ev.added),
      note: str(ev.note, 160),
      problem: str(ev.problem, 200),
    }
    if (run.brands.length < KEEP_BRANDS) run.brands.push(b)
    run.added += b.added
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
export async function recordRun(db: SettingStore & { $transaction?: any }, ev: RunEvent) {
  const write = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_RUNS_KEY}))::text`
    const next = applyRunEvent(await readRuns(tx), ev)
    const v = JSON.stringify(next)
    await tx.setting.upsert({ where: { key: LI_RUNS_KEY }, create: { key: LI_RUNS_KEY, value: v }, update: { value: v } })
  }
  if (typeof db.$transaction === 'function') await db.$transaction(write)
  else await write(db)
}
