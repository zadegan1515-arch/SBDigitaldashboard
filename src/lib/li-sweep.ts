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

export type LiMark = { at: string; seen: number; added: number; note?: string | null }
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
  for (const [id, m] of Object.entries(log)) if (m && Date.parse(m.at) >= cutoff) kept[id] = m
  const v = JSON.stringify(kept)
  await db.setting.upsert({ where: { key: LI_SWEEP_KEY }, create: { key: LI_SWEEP_KEY, value: v }, update: { value: v } })
}

// Resting = the last visit added nobody, and it was recent. A visit that
// added someone never rests the brand: there may be more next time.
export function liResting(mark: LiMark | undefined, now = Date.now()): boolean {
  if (!mark || mark.added > 0) return false
  const at = Date.parse(mark.at)
  return Number.isFinite(at) && now - at < LI_REST_DAYS * 864e5
}
