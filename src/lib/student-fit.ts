// Does the product fit a student's day? (Leo, Oct 18 2026: "neuro should
// definitely be higher given that the ideal candidates are people who
// study and do work"). Read with rules from what the brand says it is —
// its name, About, products and the Discover write-up — never from our
// own pitch idea ("a Finals-week pop-up at a campus show" says nothing
// about the brand). The first tier that matches counts, up to 20 points:
//
//   20  made for studying / focus      nootropic, focus drinks / pouches,
//                                       studying, finals week, brain health,
//                                       caffeine gum / mints / pouches
//   15  made for nights out / the       hangover, night out, party,
//       morning after                   nightlife, late-night, recovery drink
//   15  made for game day / campus      tailgate, game-day tees, dorm,
//       life                            campus stores, licensed college gear
//   10  energy / hydration / workout   energy drinks, electrolytes,
//                                       hydration, pre-workout, gym, protein,
//                                       caffeine (a name like "Raze Energy" too)
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

// Each tier names the product's use, not a word that happens to appear:
// "a clinical study", "a focus market", "3rd-party tested", "caffeine-free",
// "campus ambassadors", "Gen Z energy" never count (review, Oct 18 2026).
// `skip` = a write-up the tier never reads (skincare's "hydrating serum").
type Tier = { points: number; label: string; re: RegExp; skip?: RegExp }
const SKINCARE = /\b(skin ?care|serums?|moisturi[sz]\w*|lotions?|eye creams?|face (wash|creams?|masks?)|cosmetics?|make-?up)\b/i

export const STUDENT_USES: Tier[] = [
  {
    points: 20, label: 'made for studying / focus',
    re: new RegExp('\\b(' + [
      'nootropics?', "lion'?s mane", 'paraxanthine', 'l-theanine',
      // focus as what the product does — never "a focus on", "focus market", "focus groups", "-focused"
      '(?<![-\\w])focus(ing)?[- ](pouch(es)?|gum|drinks?|shots?|energy|supplements?|formula|blend|teas?|coffee|waters?|sodas?|mints|powders?|capsules?|gummies|chews?|bars?|beverages?|seltzers?)\\b',
      'for (mental |better |more )?focus\\b(?![- ]groups?)',
      '(mood|energy|clarity|calm)\\s*(\\/|and|&|\\+)\\s*focus\\b(?![- ]groups?)',
      'focus\\s*(\\/|and|&|\\+)\\s*(energy|clarity|calm|mood)\\b',
      '(boosts?|improves?|sharpens?|supports?|enhances?) (your |mental )?focus\\b',
      'mental (focus|energy|clarity|performance)\\b', 'focus-(boosting|enhancing)',
      // studying — never "a study found", "study abroad"
      'stud(y|ying)[- ](sessions?|breaks?|aid|snacks?|fuel|buddy|hall|nights?|drinks?)\\b',
      "(for|while|when) (you(?:'re)? )?stud(y|ying)\\b", 'studying\\b(?! abroad)',
      '(finals|exams?)[- ](week|season|time|prep|cramming)\\b', 'final exams', 'all-nighters?', 'cram(ming)? sessions?',
      'productivity',
      'brain[- ](health|boost\\w*|fuel|food|fog|power|support|function)\\b',
      'cognitive (function|performance|support|boost\\w*|health|enhanc\\w*|energy)\\b',
      // caffeine / energy gum, mints, pouches — "Caffeine (nicotine-free) pouch" too
      '(caffeine|caffeinated|energy)\\b[^.;:]{0,25}?\\b(gum|mints|pouch(es)?)\\b', '(caffeine|caffeinated|energy) mint\\b',
    ].join('|') + ')', 'i'),
  },
  {
    points: 15, label: 'made for nights out / the morning after',
    re: new RegExp('\\b(' + [
      'hangovers?', 'nights? out', 'morning[- ]after', 'recovery drinks?', 'nightlife', 'nightclubs?', 'clubbing',
      // a party, not "3rd-party tested", "party-size bags", "party packs", a birthday party
      "(?<!(third|3rd|birthday|kids'?|tea|dinner|slumber|watch)[- ])part(y|ies)\\b(?![- ](size[ds]?|packs?|supplies|favou?rs|city|trays?|platters?|mix(es)?)\\b)",
      'late[- ]night\\b(?! (show|talk|tv|television|host|with)\\b)',
      'liver (support|detox|health|aid)\\b',
    ].join('|') + ')', 'i'),
  },
  {
    points: 15, label: 'made for game day / campus life',
    // Where the product lives (campus stores and dining, campus crowds,
    // campus-wear, game-day tees, licensed college gear) — never a campus
    // tour, ambassadors, reps, sampling, a tailgate sponsorship or ESPN's
    // College GameDay: those are marketing and count under college / music.
    re: new RegExp('\\b(' + [
      '(?<!sponsor(s|ed|ing)? (of )?(the )?)tailgat(e|es|ing|ers?)\\b(?![- ](sponsor\\w*|activations?|tours?|events?|series|sampling|pop-?ups?|takeovers?|marketing|programs?)\\b)',
      '(?<!college )game[- ]?days?\\b(?![- ](activations?|tours?|campus|pop-?ups?|events?|sampling|sponsor\\w*|takeovers?)\\b)',
      'dorms?\\b', 'dorm[- ]rooms?',
      'campus(es)?[- ](stores?|bookstores?|dining|bodegas?|markets?|convenience|c-stores?|shops?|wear|life|crowds?|favou?rites?|staples?|only|kitchens?|cafes?|coffee)\\b',
      '(?<!(ambassadors?|reps?|sampling|events?|tours?|activations?|marketing|pop-?ups?|booths?|giveaways?|hires?|recruit\\w*|sponsor\\w*)\\s(\\w+\\s){0,2})(on|around|across) (college )?campus(es)?\\b(?![- ](tours?|events?|sampling|ambassadors?|reps?|activations?|marketing|sponsor\\w*|pop-?ups?|takeovers?)\\b)',
      '(university|college|campus) bookstores?', 'college[- ]towns?',
      'collegiate (apparel|headwear|line|gear|merch\\w*|collection)', 'licensed (college|collegiate)', 'school[- ]spirit', 'fan[- ]apparel',
    ].join('|') + ')', 'i'),
  },
  {
    points: 10, label: 'energy / hydration / workout',
    skip: SKINCARE,
    re: new RegExp('\\b(' + [
      // energy the product — never "Gen Z energy", "solar energy", "Energy Star"
      'energy[- ](drinks?|shots?|chews?|gels?|gum|bars?|boosts?|powders?|supplements?|waters?|seltzers?|sodas?|teas?|coffees?|beverages?|brand|line|pouch(es)?|mix(es)?|tabs|tablets|blend|chocolates?|snacks?)\\b',
      '(natural|sustained|plant-based|balanced|organic|functional|zero-sugar|sugar-free|sparkling|all-day) energy\\b',
      'for (natural |sustained |all-day )?energy\\b',
      'electrolytes?', 'isotonic', 'hydrat(e|es|ing|ion)\\b', 'pre-?workout', 'gym\\b', 'protein\\b', 'sports drinks?',
      // caffeine in it — never "caffeine-free", "zero caffeine"
      '(?<!(zero|no|without|non|low|less|free of)[- ])caffein(e|ated)\\b(?![- ]free)',
    ].join('|') + ')', 'i'),
  },
]
// A brand's own name can say energy / hydration ("Raze Energy", "Prime
// Hydration") — never the 20 (Focus Brands is a restaurant group).
const NAME_ENERGY = /\b(energy|hydration|hydrate|electrolytes?|protein|fuel)\b/i

// name = the brand's name, read only for the energy tier.
export function studentUse(text: string | null | undefined, name?: string | null): StudentUse | null {
  const t = String(text ?? '')
  for (const u of STUDENT_USES) {
    if (!t.trim() || (u.skip && u.skip.test(t))) continue
    const m = t.match(u.re)
    if (m) return { points: u.points, label: u.label, word: m[0].trim() }
  }
  const n = String(name ?? '').match(NAME_ENERGY)
  if (n && !SKINCARE.test(t)) {
    const e = STUDENT_USES[STUDENT_USES.length - 1]
    return { points: e.points, label: e.label, word: String(name).trim() }
  }
  return null
}

// The Discover write-up a brand added from Discover keeps in its notes
// ("Discover: <what was found>\nActivation idea: <our pitch>\nFound in: …"):
// the line that starts with "Discover: " (never Leo's own text that
// mentions the word), up to the pitch or the source.
export function discoverWriteUp(notes: string | null | undefined): string {
  const m = String(notes ?? '').replace(/\r/g, '').match(/^[ \t]*Discover:[ \t]*(.*)$/m)
  if (!m) return ''
  return m[1].split(/activation idea:|found in:/i)[0].trim()
}

// What a roster brand says it is: About, products, its Discover write-up
// (the name goes to studentUse on its own). Leo's own notes and the pitch
// are left out.
export function brandWriteUp(b: { about?: string | null; topProducts?: string | null; notes?: string | null }): string {
  return [b.about, b.topProducts, discoverWriteUp(b.notes)].map(x => String(x ?? '').trim()).filter(Boolean).join(' · ')
}

// The reason line both scores show. hasText = the brand says something
// beyond its name (an About, products or a write-up).
export function studentReason(use: StudentUse | null, hasText: boolean): { good: boolean | null; text: string; points: number } {
  if (use) return { good: true, text: use.label + ' (“' + use.word + '”)', points: use.points }
  return { good: null, text: hasText ? 'no student use named (studying, nights out, game day, energy)' : 'what it sells isn’t on file', points: 0 }
}

// The student fit can take a total past 100: the score stops there, and
// this line says so, so the points shown still add up to the score.
export function capAt100<R extends { good: boolean | null; text: string; points: number }>(reasons: R[]): number {
  const sum = reasons.reduce((n, r) => n + r.points, 0)
  if (sum > 100) reasons.push({ good: null, text: 'the score stops at 100', points: 100 - sum } as R)
  return Math.max(0, Math.min(100, sum))
}
