// Which first message gets replies (Leo, Oct 18 2026 — "lets do 1": about
// 1 in 6 people accept but only 1 in 20 reply). Two versions of the first
// LinkedIn message on Zach's list: A = Leo's first message (Setting
// handFirstDmTemplate), B = his test version (handFirstDmTemplateB for a
// man, handFirstDmTemplateBW for a woman). Every brand is A or B — the same
// for everyone there (his pick: "every other brand") — split by a stable
// hash of the brand's id, so nothing is stored until a message goes out.
// Ticking "Messaged" records the version on Target.handFirstVariant.
//
// An answer counts for the version when it came after the first message and
// before the final reach-out (nudgedAt) — after that, the final reach-out
// may be what they answered. A message is judged once it was answered, the
// final reach-out went, or HAND_NUDGE_DAYS passed (when the final is due).
// "Doesn't want to continue" is an answer too, counted apart as "said no".
// Rules only, read-only. node scripts/test-first-test.mjs

export type Version = 'A' | 'B'
export const VERSIONS: Version[] = ['A', 'B']
export const FIRST_TEST_KEY = 'firstMsgTest' // Setting: { on, at, by } — no row = on
export const JUDGE_DAYS = 10 // HAND_NUDGE_DAYS in route.ts
export const FEW = 30

// The brand's version: a stable half-and-half split by its id (FNV-1a).
export function versionOf(brandId: string): Version {
  let h = 0x811c9dc5
  for (let i = 0; i < brandId.length; i++) {
    h ^= brandId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 2 === 0 ? 'A' : 'B'
}

export function isVersion(v: unknown): v is Version {
  return v === 'A' || v === 'B'
}

// The test is on unless Leo stopped it.
export function testOn(saved: unknown): boolean {
  return !(saved && typeof saved === 'object' && (saved as any).on === false)
}

export type FirstTestRow = {
  variant: string | null
  dmSentAt: Date | string | null
  nudgedAt?: Date | string | null
  status?: string | null
  repliedAt?: Date | string | null
  wantsEmailAt?: Date | string | null
  liPathAt?: Date | string | null
  callBookedAt?: Date | string | null
  declinedAt?: Date | string | null
  updatedAt?: Date | string | null
}
export type VersionCell = {
  key: Version
  sent: number // first messages that went out as this version
  judged: number // answered, final reach-out sent, or JUDGE_DAYS old
  answered: number // answered before the final reach-out
  saidNo: number // of those, "doesn't want to continue"
  waiting: number // not judged yet
  rate: number | null // answered / judged
  few: boolean
}
export type FirstTestTable = { versions: VersionCell[]; startedAt: string | null; judgeDays: number; few: number }

const DAY = 864e5
const ms = (d: Date | string | null | undefined): number | null => {
  if (!d) return null
  const t = d instanceof Date ? d.getTime() : Date.parse(d)
  return Number.isFinite(t) ? t : null
}

// When they first answered: a reply logged, a path picked (they want email /
// to keep it on LinkedIn), a call booked, or "doesn't want to continue". A
// reply status with no date reads the row's last change.
export function answeredAt(r: FirstTestRow): number | null {
  const at = [r.repliedAt, r.wantsEmailAt, r.liPathAt, r.callBookedAt, r.declinedAt].map(ms).filter((x): x is number => x != null)
  if (!at.length && (r.status === 'replied' || r.status === 'converted')) {
    const u = ms(r.updatedAt)
    if (u != null) at.push(u)
  }
  return at.length ? Math.min(...at) : null
}

export function firstTestTable(rows: FirstTestRow[], now: Date, opts: { judgeDays?: number } = {}): FirstTestTable {
  const judgeDays = opts.judgeDays ?? JUDGE_DAYS
  const t = now.getTime()
  const cells = new Map<Version, VersionCell>(VERSIONS.map(v => [v, { key: v, sent: 0, judged: 0, answered: 0, saidNo: 0, waiting: 0, rate: null, few: true }]))
  let started: number | null = null
  for (const r of rows) {
    if (!isVersion(r.variant)) continue
    const sent = ms(r.dmSentAt)
    if (sent == null) continue
    const ans = answeredAt(r)
    // They answered before the first message went: nothing to credit it with.
    if (ans != null && ans < sent) continue
    const c = cells.get(r.variant)!
    c.sent++
    if (started == null || sent < started) started = sent
    const nudged = ms(r.nudgedAt)
    const answered = ans != null && (nudged == null || ans <= nudged)
    if (answered) {
      c.judged++
      c.answered++
      if (ms(r.declinedAt) === ans) c.saidNo++
    } else if (nudged != null || t - sent >= judgeDays * DAY) {
      c.judged++
    } else {
      c.waiting++
    }
  }
  const versions = [...cells.values()].map(c => ({ ...c, rate: c.judged ? c.answered / c.judged : null, few: c.judged < FEW }))
  return { versions, startedAt: started == null ? null : new Date(started).toISOString(), judgeDays, few: FEW }
}
