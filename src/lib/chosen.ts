// People picked for a day's LinkedIn list (review fix, Oct 13 2026): queued
// by hand — the brand page's Queue (Swap on Today's list for Zach too), Send
// to dashboard on a LinkedIn profile, + Add person (upsertContact) — or
// taken out of a missed day's list by the morning roll so that day's queue
// stamps them again (route.ts carryBrands: "that day's queue stamps them
// again").
//
// The flagged hold-back in queueBrandTargets / previewBrandPicks (route.ts:
// a flagged person waiting in the pool is set aside next in line while an
// unflagged buyer is reachable) is for people the system pooled and nobody
// chose. One of these goes as chosen, flag or not — the hold-back used to
// set aside the person Leo queued on Tuesday once the roll had put them
// back in the pool on Wednesday, and someone else went in their place.
// Nor does the brand's number cut them (third review, Oct 13 2026): chosen
// people go first and all go (route.ts chosenFirst), and the brand's limit
// never sets them aside next in line (keepInPlay, brand-work.ts — fourth
// review); the number holds only the system's own picks.
//
// Setting outreachChosen = { targetId: the New York day key it was chosen },
// kept CHOSEN_DAYS (past the two weeks' rest and the roll's week) and at most
// CHOSEN_MAX ids, newest kept. Read by route.ts (readQueueCtx) and written by
// route.ts and /api/ingest. node scripts/test-carry.mjs

export const CHOSEN_KEY = 'outreachChosen'
export const CHOSEN_DAYS = 30
export const CHOSEN_MAX = 3000

function isKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

// The ids chosen on `today` or the CHOSEN_DAYS before it, oldest first.
export function parseChosen(v: unknown, today: string): Map<string, string> {
  const since = shiftKey(today, -CHOSEN_DAYS)
  const out = new Map<string, string>()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const rows = Object.entries(v as Record<string, unknown>)
    .filter((e): e is [string, string] => !!e[0] && isKey(e[1]) && e[1] >= since && e[1] <= today)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  for (const [id, day] of rows) out.set(id, day)
  return out
}

// `ids` chosen on `day`: each one's day moves to `day` (newest last), and
// past CHOSEN_MAX the oldest go.
export function addChosen(cur: Map<string, string>, ids: string[], day: string): Map<string, string> {
  const out = new Map(cur)
  for (const id of ids) {
    if (!id) continue
    out.delete(id)
    out.set(id, day)
  }
  while (out.size > CHOSEN_MAX) out.delete(out.keys().next().value as string)
  return out
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readChosenIds(db: SettingStore, today: string): Promise<Set<string>> {
  return new Set((await readChosenMap(db, today)).keys())
}

async function readChosenMap(db: SettingStore, today: string): Promise<Map<string, string>> {
  try {
    const row = await db.setting.findUnique({ where: { key: CHOSEN_KEY } })
    return parseChosen(row ? JSON.parse(row.value) : null, today)
  } catch {
    return new Map()
  }
}

// Adds `ids` as chosen today (nothing written when there are none).
export async function noteChosenIds(db: SettingStore, ids: string[], today: string): Promise<void> {
  const list = ids.filter(Boolean)
  if (!list.length) return
  const next = addChosen(await readChosenMap(db, today), list, today)
  const value = JSON.stringify(Object.fromEntries(next))
  await db.setting.upsert({ where: { key: CHOSEN_KEY }, create: { key: CHOSEN_KEY, value }, update: { value } })
}
