// One order for today's LinkedIn list (Outreach → LinkedIn, Today's list
// for Zach, the Schedule's today column). Leo set who goes first on the
// Schedule ("set who goes first"), so his planned brands lead in his order;
// then brands added by hand today, newest first; then the automatic fill's
// brands in the order it picked them (best first — outreachAutoQueued keeps
// it). People within a brand: best fit first.
//
// Before this, the first load sorted by person fit, a reload by stamp time
// (newest first — the fill stamps best first, so a reload came out
// worst-first) and the Schedule a third way; on a day Zach sent fewer than
// 30, the best brands were the ones left over.
//
// Pure — src/app/api/data/route.ts hands it the plan, the fill's log and
// each brand's newest stamp. node scripts/test-today-order.mjs

export type TodayOrderInput = {
  // Today's planned brands, in the Schedule's order.
  planIds: string[]
  // The automatic fill's brands today, in the order it took them.
  autoIds: string[]
  // brandId -> the newest stamp (ms) — orders the hand-added brands.
  newest: ReadonlyMap<string, number>
}

// Compares two brand ids: planned (0), added by hand (1), the automatic
// fill (2). Never 0 for two different brands, so a brand's people always
// stay together.
export function compareTodayBrands(o: TodayOrderInput): (a: string, b: string) => number {
  const plan = new Map(o.planIds.map((id, i) => [id, i]))
  const auto = new Map<string, number>()
  o.autoIds.forEach((id, i) => { if (!auto.has(id)) auto.set(id, i) })
  const tier = (id: string) => (plan.has(id) ? 0 : auto.has(id) ? 2 : 1)
  return (a, b) => {
    if (a === b) return 0
    const ta = tier(a), tb = tier(b)
    if (ta !== tb) return ta - tb
    const d = ta === 0 ? plan.get(a)! - plan.get(b)!
      : ta === 2 ? auto.get(a)! - auto.get(b)!
      : (o.newest.get(b) ?? 0) - (o.newest.get(a) ?? 0)
    return d || (a < b ? -1 : 1)
  }
}

// Today's people in that order: brands as above, best fit first inside a
// brand, then the older row first.
export function sortToday<T extends { brandId: string; fitScore: number; createdAt?: Date | string | null }>(
  rows: T[],
  o: TodayOrderInput,
): T[] {
  const byBrand = compareTodayBrands(o)
  const at = (t: T) => (t.createdAt ? new Date(t.createdAt).getTime() : 0)
  return rows.slice().sort((x, y) => byBrand(x.brandId, y.brandId) || y.fitScore - x.fitScore || at(x) - at(y))
}
