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
export const LI_SCRIPT_VERSION = '1.24'

export type LiMark = { at: string; seen: number; added: number; note?: string | null; v?: number; parentTried?: boolean }
export type LiLog = Record<string, LiMark>

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

export async function markLiSwept(db: SettingStore, brandId: string, mark: Omit<LiMark, 'at'>) {
  const log = await readLiLog(db)
  log[brandId] = { at: new Date().toISOString(), ...mark }
  const cutoff = Date.now() - LI_KEEP_DAYS * 864e5
  const kept: LiLog = {}
  const bigCutoff = Date.now() - LI_BIG_REST_DAYS * 864e5
  for (const [id, m] of Object.entries(log)) if (m && Date.parse(m.at) >= (isTooBig(m) ? bigCutoff : cutoff)) kept[id] = m
  const v = JSON.stringify(kept)
  await db.setting.upsert({ where: { key: LI_SWEEP_KEY }, create: { key: LI_SWEEP_KEY, value: v }, update: { value: v } })
}

// Resting = read by a current reader within the last month. A full read
// of a brand's People tab (plus its marketing / partnerships views) is
// everything LinkedIn will show; a visit a week later finds the same
// people, so a brand rests whether or not it gave anyone — which is what
// lets Leo stop and restart a run without redoing what it just did.
export function liResting(mark: LiMark | undefined, now = Date.now()): boolean {
  if (!mark) return false
  if (!mark.v || mark.v < LI_READER) return false
  // Skipped as "too big" by script 1.17–1.19, never read: big brands get
  // targeted searches now (Leo, Sep 30), so they're due at once.
  if (isTooBig(mark)) return false
  const at = Date.parse(mark.at)
  return Number.isFinite(at) && now - at < (isTooBig(mark) ? LI_BIG_REST_DAYS : LI_REST_DAYS) * 864e5
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
