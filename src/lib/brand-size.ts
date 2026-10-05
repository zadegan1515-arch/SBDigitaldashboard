// How big a brand is, for the LinkedIn fill's order (Leo, Oct 2026: "do
// more smaller brands and classify mid-sized brands as target brands and
// do those"). Rules only, no model calls:
//
//   1. LinkedIn headcount — the People tab's "N associated members",
//      saved on the brand every time the fill (or a hand scan) reads it:
//      small < 20 · target 20–499 · big 500+.
//   2. Not measured yet: owned by a parent company we know (parents.ts —
//      Diageo, Pernod Ricard, Monster…) → big; else the brand's tier:
//      established → big, growth → target, emerging → small.
//   3. Otherwise unknown, until the fill reads its page.
//
// The fill goes target → unknown → small → big (Leo's pick), after the
// brands asked for by name, the Schedule's short brands and the focus word.

export type BrandSize = 'target' | 'unknown' | 'small' | 'big'

export const SMALL_BELOW = 20
export const BIG_FROM = 500

export const SIZE_ORDER: BrandSize[] = ['target', 'unknown', 'small', 'big']

export const SIZE_WORDS: Record<BrandSize, string> = {
  target: 'target brand (mid-size)',
  unknown: 'size not known yet',
  small: 'small brand',
  big: 'big company',
}

export function sizeFromMembers(n: number | null | undefined): BrandSize | null {
  if (n == null || !isFinite(n) || n < 0) return null
  if (n < SMALL_BELOW) return 'small'
  if (n < BIG_FROM) return 'target'
  return 'big'
}

export function brandSize(b: { liMembers?: number | null; tier?: string | null; hasParent?: boolean }): BrandSize {
  const measured = sizeFromMembers(b.liMembers)
  if (measured) return measured
  if (b.hasParent) return 'big'
  if (b.tier === 'established') return 'big'
  if (b.tier === 'growth') return 'target'
  if (b.tier === 'emerging') return 'small'
  return 'unknown'
}

export function sizeRank(s: BrandSize): number {
  return SIZE_ORDER.indexOf(s)
}

// A People tab's headcount worth saving: a whole number, not absurd.
export function cleanMembers(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : null
}
