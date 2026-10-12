// A grade on every brand Brands → Discover finds (Leo, Oct 12 2026: "grade
// each brand that is found in the discover brands"). Rules only, no model
// call: the grade is Brand Fit (brand-fit.ts) turned into a letter, so a
// find and the brand it becomes are judged by one rule.
//
// A find that isn't on the roster yet is scored with what Discover knows:
// its category (Leo's priority), the hunt's "already sponsors college /
// music" sign, "mid-size and growing" as a growth-tier size, and a parent
// company from parents.ts. Money isn't known and nobody is on file yet —
// the same as any new brand. A find already on the roster uses that brand's
// own Brand Fit (facts, people, size).
//
// Letters (a find with no people tops out in the low 70s):
//   A  60+  — a Top category with a real sign, or a brand already doing well
//   B  45+  — worth adding
//   C  30+  — only if there's room
//   D       — under 30, or a Skip category / not sold in the US / closed
// Too small caps the grade at C.
//
//   node scripts/test-discover-grade.mjs

import { scoreBrand, type FitInput, type FitResult, type FitReason, type Priority } from './brand-fit'

export type Grade = 'A' | 'B' | 'C' | 'D'
export const GRADE_BARS: Array<[Grade, number]> = [['A', 60], ['B', 45], ['C', 30]]
export const GRADE_WORD: Record<Grade, string> = {
  A: 'Strong fit', B: 'Worth adding', C: 'Only if there’s room', D: 'Weak fit',
}

export function letterFor(score: number): Grade {
  for (const [g, min] of GRADE_BARS) if (score >= min) return g
  return 'D'
}

export interface DiscoverGrade {
  grade: Grade
  score: number // 0..100, the Brand Fit score
  word: string
  capped: string | null // a hard no (always named), or why the letter is lower than the score says
  reasons: FitReason[]
}

export function gradeFromFit(f: FitResult): DiscoverGrade {
  let grade = letterFor(f.score)
  let capped: string | null = null
  const hardNo = f.ruledOut ?? f.bizNote ?? (f.priority === 'skip' ? 'Skip category' : null)
  if (hardNo) { grade = 'D'; capped = hardNo }
  else if (f.tooSmall && (grade === 'A' || grade === 'B')) { grade = 'C'; capped = f.tooSmallWhy || 'too small' }
  return { grade, score: f.score, word: GRADE_WORD[grade], capped, reasons: f.reasons }
}

export function hasSign(signals: string | null | undefined, sign: string): boolean {
  return String(signals ?? '').split(',').map(s => s.trim()).includes(sign)
}

// A find not on the roster yet: what Discover knows, as Brand Fit input.
export function discoveryFitInput(
  row: { category: string | null; signals?: string | null; hasParent?: boolean },
  ctx: { priority: Priority; acceptRate: number | null; now: Date },
): FitInput {
  return {
    category: row.category,
    tier: hasSign(row.signals, 'midsize') ? 'growth' : null, // addDiscoveredBrand files it the same way
    hasParent: !!row.hasParent,
    sponsorsCollege: hasSign(row.signals, 'sponsors') ? true : null,
    reachable: 0,
    need: 4,
    acceptRate: ctx.acceptRate,
    priority: ctx.priority,
    now: ctx.now,
  }
}

export function gradeDiscovery(
  row: { category: string | null; signals?: string | null; hasParent?: boolean },
  ctx: { priority: Priority; acceptRate: number | null; now: Date },
): DiscoverGrade {
  return gradeFromFit(scoreBrand(discoveryFitInput(row, ctx)))
}
