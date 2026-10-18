// Does the product fit a student's day? (Leo, Oct 18 2026: "neuro should
// definitely be higher given that the ideal candidates are people who
// study and do work"). Read with rules from what the brand says it is —
// its name, About, products and the Discover write-up — never from our
// own pitch idea ("a Finals-week pop-up at a campus show" says nothing
// about the brand). The first tier that matches counts, up to 20 points:
//
//   20  made for studying / focus      nootropic, focus, study, exams,
//                                       brain, caffeine gum / mints / pouches
//   15  made for nights out / the       hangover, night out, party,
//       morning after                   nightlife, late-night, recovery drink
//   15  made for game day / campus      tailgate, game-day tees, dorm,
//       life                            campus stores, licensed college gear
//   10  energy / hydration / workout   energy, electrolytes, hydration,
//                                       pre-workout, gym, protein, caffeine
//
// Used by the Discover find score (find-evidence.ts) and Brand Fit
// (brand-fit.ts) — Leo chose both: a roster brand made for studying ranks
// higher in Best fit and the Schedule too.
//
//   node scripts/test-student-fit.mjs

export interface StudentUse {
  points: number
  label: string // "made for studying / focus"
  word: string // the words that matched, as written ("nootropic")
}

export const STUDENT_USES: Array<{ points: number; label: string; re: RegExp }> = [
  {
    points: 20, label: 'made for studying / focus',
    // "focus" the product, not "youth-focused" / "focused on" / "a focus on".
    re: /\b(nootropics?|(?<![-\w])focus(?!ed|ing|es)\b(?!\s+on\b)|(?<!case )stud(y|ying)\b|exams?\b|finals week|productivity|brain\b|cognitive|mental (energy|clarity)|(caffeine|caffeinated|energy) (gum|mints?|pouch(es)?)|lion'?s mane|paraxanthine|l-theanine)/i,
  },
  {
    points: 15, label: 'made for nights out / the morning after',
    re: /\b(hangovers?|after a night|nights? out|(?<!third[- ])part(y|ies)\b|nightlife|late[- ]night|recovery drink|liver\b)/i,
  },
  {
    points: 15, label: 'made for game day / campus life',
    // Where the product lives (campus stores, dining, campus crowds,
    // campus-wear, game-day tees, licensed college gear) — not a campus
    // tour / events / clubs / ambassadors or a game-day activation, which
    // are marketing and count under college / music.
    re: /\b(tailgat\w*|game[- ]?days?(?![- ]?(activations?|tours?|campus|pop-?ups?|events?|sampling|sponsor\w*)\b)\b|dorms?\b|campus(?![- ]?((\w+ )?clubs?|tours?|events?|sampling|ambassadors?|vending|reach|programs?|activations?|marketing|shows?|demo|leaders?|athletic|health|recruit\w*)\b)|college towns?|collegiate (apparel|headwear|line|gear|merch\w*)|licensed (college|collegiate)|school[- ]spirit|fan[- ]apparel)/i,
  },
  {
    points: 10, label: 'energy / hydration / workout',
    re: /\b((?<!high[- ])energy\b|electrolytes?|hydrat(e|es|ing|ion)\b|pre-?workout|gym\b|protein\b|sports drinks?|caffeine|caffeinated)/i,
  },
]

export function studentUse(text: string | null | undefined): StudentUse | null {
  const t = String(text ?? '')
  if (!t.trim()) return null
  for (const u of STUDENT_USES) {
    const m = t.match(u.re)
    if (m) return { points: u.points, label: u.label, word: m[0].trim() }
  }
  return null
}

// The Discover write-up a brand added from Discover keeps in its notes
// ("Discover: <what was found>\nActivation idea: <our pitch>\nFound in: …"):
// only the first part, which is about the brand.
export function discoverWriteUp(notes: string | null | undefined): string {
  const s = String(notes ?? '')
  const at = s.indexOf('Discover: ')
  if (at < 0) return ''
  return s.slice(at + 'Discover: '.length).split(/\n|Activation idea:|Found in:/)[0].trim()
}

// What a roster brand says it is: name, About, products, its Discover
// write-up. Leo's own notes and the pitch are left out.
export function brandWriteUp(b: { name?: string | null; about?: string | null; topProducts?: string | null; notes?: string | null }): string {
  return [b.name, b.about, b.topProducts, discoverWriteUp(b.notes)].map(x => String(x ?? '').trim()).filter(Boolean).join(' · ')
}

// The reason line both scores show. hasText = the brand says something
// beyond its name (an About, products or a write-up).
export function studentReason(use: StudentUse | null, hasText: boolean): { good: boolean | null; text: string; points: number } {
  if (use) return { good: true, text: use.label + ' (“' + use.word + '”)', points: use.points }
  return { good: null, text: hasText ? 'no student use named (studying, nights out, game day, energy)' : 'what it sells isn’t on file', points: 0 }
}
