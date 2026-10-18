// A grade on every brand Brands → Discover finds (Leo, Oct 12 2026: "grade
// each brand that is found in the discover brands"). Rules only, no model
// call: a score out of 100 with a reason for every point, as a letter.
//
// A find that isn't on the roster yet gets the find score (find-evidence.ts,
// Oct 15 2026): category priority plus what its write-up proves — money
// raised or sales (the $10M–$500M sweet spot), how many stores, already paying
// for college / music, fits a student's day (made for studying, nights out,
// game day, energy — Oct 18 2026), growing fast. Brand Fit couldn't tell the hunt's finds
// apart (137 of 171 were an A on category and signs alone). A find already on
// the roster uses that brand's own Brand Fit (facts, people, size).
//
// Letters (set so the 171 finds of Oct 15 2026 split about 17 / 52 / 63 / 39;
// a Top category that pays for college, nothing else known, is 45 = C):
//   A  65+  — strong fit, accept
//   B  50+  — worth adding
//   C  40+  — maybe
//   D       — under 40, or a Skip category / not sold in the US / closed
// Too small caps the grade at C.
//
//   node scripts/test-discover-grade.mjs

import { type FitResult, type FitReason, type Priority } from './brand-fit'
import { scoreFind } from './find-evidence'

export type Grade = 'A' | 'B' | 'C' | 'D'
export const GRADE_BARS: Array<[Grade, number]> = [['A', 65], ['B', 50], ['C', 40]]
export const GRADE_WORD: Record<Grade, string> = {
  A: 'Strong fit — accept', B: 'Worth adding', C: 'Maybe', D: 'Probably pass',
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

// text = the write-up and our pitch idea; name + writeUp = what the brand is
// (the student fit and launches read only that).
type FindRow = {
  category: string | null; signals?: string | null; hasParent?: boolean; giant?: string | null; text?: string | null
  name?: string | null; writeUp?: string | null
}

// A find not on the roster yet: the find score (find-evidence.ts), which
// reads the write-up. Skip / giant / too-small rules as gradeFromFit.
export function gradeDiscovery(row: FindRow, ctx: { priority: Priority; acceptRate: number | null; now: Date }): DiscoverGrade {
  const fs = scoreFind({
    priority: ctx.priority, signals: row.signals, text: row.text, giant: row.giant, hasParent: row.hasParent,
    name: row.name, writeUp: row.writeUp, now: ctx.now,
  })
  let grade = letterFor(fs.score)
  let capped: string | null = null
  if (ctx.priority === 'skip') { grade = 'D'; capped = 'Skip category' }
  return { grade, score: fs.score, word: GRADE_WORD[grade], capped, reasons: fs.reasons }
}
