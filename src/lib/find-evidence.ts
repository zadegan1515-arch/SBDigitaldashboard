// What a Discover find's write-up says about the brand, read with rules (no
// model call). Leo, Oct 15 2026: "have a score presented for each of the
// brands that i have to accept or deny so that way i can categorize and see
// what i should probably accept". The daily hunt only sends Top-category
// brands with a sign, so on category and signs alone 137 of 171 finds were an
// A. Their write-ups carry the facts that tell them apart — "$2M seed round",
// "3,500+ c-stores", "owned by Tilray", "official craft beer of the Pac-12" —
// and this turns those into Brand Fit facts:
//
//   money raised   "$7M Series A", "raised $4.5M", "closed a $10M round"
//   sales          "$10M run rate", "$25M in sales / revenue"
//   shelf size     "3,500+ stores / doors / outlets / points of distribution",
//                  the biggest number; 300–24,999 = mid-size, 25,000+ = big,
//                  under 50 = small. A valuation is never money raised.
//   a parent       "owned by X", "a division of X", "acquired by X"
//   college/music  an official partner of a school / conference, NIL,
//                  athletics, stadium, campus, a festival or tour
//
// A fact the text doesn't state stays unknown — never a guess. The score
// these feed is at the bottom (scoreFind).
//
//   node scripts/test-discover-grade.mjs

import { studentUse, studentReason, capAt100 } from './student-fit'

export interface FindEvidence {
  fundingCents: number | null
  salesCents: number | null
  stores: number | null
  parentNamed: string | null
  college: boolean
  music: boolean
}

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }
const MONEY = /\$\s?(\d+(?:[.,]\d+)?)\s?(k|thousand|mm|m|mil|million|bn|b|billion)\b/gi
const FUNDING_WORD = /\b(seed|series\s+[a-f]|round|raised?|raising|funding|financing|investment|invested|backing|closed)\b/i
const SALES_WORD = /\b(sales|revenue|run[- ]rate|turnover)\b/i
const VALUATION = /\bvaluation|valued\b/i

function dollars(num: string, unit: string): number {
  return Math.round(parseFloat(num.replace(/,/g, '')) * (MULT[unit.toLowerCase()] ?? 1))
}
function short(usd: number): string {
  if (usd >= 1e9) return '$' + +(usd / 1e9).toFixed(1) + 'B'
  if (usd >= 1e6) return '$' + +(usd / 1e6).toFixed(1) + 'M'
  return '$' + Math.round(usd / 1e3) + 'K'
}

export function readFind(text: string | null | undefined): FindEvidence {
  const t = String(text ?? '')
  const ev: FindEvidence = { fundingCents: null, salesCents: null, stores: null, parentNamed: null, college: false, music: false }

  // Money: each "$N unit" with the words around it (same clause).
  let funding = 0, sales = 0
  for (const m of Array.from(t.matchAll(MONEY))) {
    const at = m.index ?? 0
    const before = t.slice(Math.max(0, at - 45), at)
    const after = t.slice(at + m[0].length, at + m[0].length + 30)
    const near = (before.split(/[;:]|\. /).pop() || '') + ' ' + (after.split(/[;:,]|\. /)[0] || '')
    const usd = dollars(m[1], m[2])
    if (usd < 50_000) continue // a price, not a company's money
    // "$106M round at $500M+ valuation": the valuation is its own amount.
    if (VALUATION.test(after.split(/[;,($]/)[0] || '') || /\bat\s*$/i.test(before)) continue
    if (SALES_WORD.test(near)) sales = Math.max(sales, usd)
    else if (FUNDING_WORD.test(near)) funding += usd
  }
  // "raised two $7M rounds"
  const two = t.match(/\b(two|three)\s+\$\s?(\d+(?:\.\d+)?)\s?(m|million)\s+rounds\b/i)
  if (two) funding = Math.max(funding, dollars(two[2], two[3]) * (two[1].toLowerCase() === 'two' ? 2 : 3))
  if (funding) ev.fundingCents = funding * 100
  if (sales) ev.salesCents = sales * 100

  // Shelf: the biggest store count named.
  const STORES = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s?[kK]|\d+)\s?\+?\s*(?:[A-Za-z-]+\s){0,2}?(stores|doors|outlets|locations|points of distribution|retailers|retail doors|c-stores)\b/g
  for (const m of Array.from(t.matchAll(STORES))) {
    let n = m[1].replace(/,/g, '')
    const k = /k$/i.test(n.trim())
    const v = Math.round(parseFloat(n) * (k ? 1000 : 1))
    if (v > 0 && v < 1_000_000 && (ev.stores == null || v > ev.stores)) ev.stores = v
  }

  // A parent company named in the write-up.
  const parent = t.match(/\b(?:[Oo]wned by|[Aa] division of|[Aa]cquired by)\s+(?!the\b|The\b)([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/)
  if (parent) ev.parentNamed = parent[1].replace(/'s$/, '')

  // Already pays for college or music.
  ev.college = /\b(official\s+[\w\s'-]{0,40}\bof\b|NIL\b|athletics|collegiate|stadium|campus|universit(y|ies)|college|conference|sororit|fraternit|tailgate)/i.test(t)
  ev.music = /\b(festival|tour\b|concert|music)\b/i.test(t)
  return ev
}

// ── The find score ────────────────────────────────────────────────────────
// Brand Fit can't tell the hunt's finds apart (no money known, nobody on
// file), so a find not on the roster yet gets its own 0–100 from what the
// write-up proves, every point with its reason:
//   category priority   Top 25 · Middle 12 · Low 0 (Skip → D)
//   money               sales $10M–$500M 25 · $1M–$10M 12 · $500M–$1B 10
//                       raised $5M+ 20 · $1M–$5M 10 (the stronger one counts)
//                       a giant or a parent company: 0 (too big for now)
//   on shelves          1,000+ stores 15 · 300+ 10 · fewer 5 · "growing"
//                       sign alone 6; a big retailer named +5 (max 15)
//   pays for college /  an official partner, licensed, NIL, sponsor, tour,
//   music               festival 20 · the hunt's sign alone 12 ·
//                       only popular with students 6
//   fits a student's    made for studying / focus 20 · nights out / the
//   day                 morning after 15 · game day / campus life 15 ·
//                       energy / hydration / workout 10 (student-fit.ts;
//                       read from the write-up, + the name for energy,
//                       never our pitch idea). Leo, Oct 18 2026: "neuro
//                       should definitely be higher given that the ideal
//                       candidates are people who study and do work".
//   growing fast        "fastest-growing", "doubled", "+50%", "triple-digit",
//                       and launches (Oct 18 2026): "first mass-retail",
//                       "national launch", "rolling out to", "expanding
//                       into Walmart", "added 400 stores" — not history
//                       (launchIn) 10
//   past 100            "the score stops at 100" with the difference
//   aims at 18–24       the hunt's sign 5
export interface FindScore { score: number; reasons: Array<{ good: boolean | null; text: string; points: number }> }

const RETAILERS = /\b(walmart|target|kroger|costco|whole foods|publix|h-e-b|heb|7-eleven|trader joe'?s|total wine|cvs|walgreens|albertsons|safeway|sprouts|wegmans|meijer|hy-vee|circle k|wawa|sheetz|bevmo|sam'?s club|harris teeter|dick'?s|foot locker|ulta|sephora)\b/gi
const SPENDS = /\b(official\s+[\w\s'-]{0,40}\b(of|partner)|licensed|NIL|collective|sponsor(s|ed|ship)?|presenting|presented|title partner|partner(ed|ship)? with|tour\b|festival|activation|sampling)/i
const AUDIENCE = /\b(college students|campus|sororit|fraternit|students|gen ?z|tailgat)/i
const GROWTH = /\b(fastest[- ]growing|doubled|tripled|triple[- ]digit|double[- ]digit|\d{2,3}%\s*(growth|yoy|year|up)|up\s+\d{2,3}%|\d{2,3}%\+?\s+yoy|growth of \d{2,3}%)/i
// A launch or a push into new stores is growth too (Leo's yes, Oct 18
// 2026). Read on the write-up only, like the student fit: a pitch idea
// "launching at a campus show" is ours, not theirs. Only stores, markets
// and distribution count — never a footprint that just is ("in 48 states",
// "ships to 50 states"), a national ad campaign or award, "expanding into
// apparel" or "its team", and never a launch from years ago (launchIn).
const SHOP_NAMES = "walmart|target(?! (?:audiences?|demo\\w*|markets?|consumers?|customers?|groups?|segments?|ages?|field|center|centre|arena|stadium)\\b)|kroger|costco|whole foods|publix|h-e-b|heb|7-eleven|trader joe'?s|total wine|cvs|walgreens|albertsons|safeway|sprouts|wegmans|meijer|hy-vee|circle k|wawa|sheetz|bevmo|sam'?s club|harris teeter|dick'?s|foot locker|ulta|sephora|aldi|food lion|giant eagle|hannaford|stop & shop|ralphs|vons|fresh thyme|natural grocers|erewhon|gopuff|buc-ee'?s|dollar general|family dollar|rite aid|quiktrip|racetrac|casey'?s|winn-dixie|shoprite|jewel-osco|vitamin shoppe|gnc|bj'?s|five below|urban outfitters|pacsun|zumiez|nordstrom|best buy"
const STATE_CODES = '(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|DFW)(?=[\\s,.;)/]|$)'
const US_STATES = 'southern california|northern california|new england|the pacific northwest|the bay area|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|socal|norcal|the bay area|chicago|atlanta|austin|dallas|houston|miami|nyc|los angeles|boston|denver|seattle|phoenix|philadelphia'
// Where a launch goes: stores, markets, distribution, a retailer, a region.
const WHERE = '(?:(?:(?:about|nearly|over|more than|roughly|all|more|new|another|national|nationwide)\\s+)*(?:~?[\\d,]+\\+?\\s+)?(?:[\\w&\'-]+\\s+){0,3}(?:markets?|states|regions?|retail(?:ers)?|distribution|stores|doors|accounts|grocery|grocers|c-stores|convenience|chains?|outlets|locations)\\b' +
  '|(?:~?[\\d,]+\\+?\\s+)?(?:the\\s+)?(?:' + SHOP_NAMES + ')\\b|the (?:US|U\\.?S\\.?|Southeast|Northeast|Midwest|West Coast|East Coast|South|West)(?![\\w])|Canada\\b|Mexico\\b|(?:' + US_STATES + ')\\b)'
const LAUNCH = new RegExp('\\b(' + [
  'first (mass|national)[- ]?retail',
  'national (launch|rollout|roll-out|expansion)',
  'nationwide (launch|rollout|roll-out|retail|expansion)',
  '(went|goes|going|gone|rolled out|rolling out|launched|launching) nationwide\\b',
  'launch(ed|es|ing)? (a |its )?(nationwide|national(ly)?)\\b(?! (ad|ads|tv|marketing|media|campaigns?|spots?|commercials?|contests?|tours?|sweepstakes|promotions?|search|awards?)\\b)',
  '(secured|signed|landed|gained|moved to|won)\\s+(?:[\\w&-]+\\s+){0,3}(national|nationwide)\\s+(distribut\\w*|retail\\w*|accounts?|roll-?out|placement)',
  'expan(d|ds|ded|ding|sion)\\s+((in)?to|across)\\s+(?:[\\w,&.]+\\s+){0,4}?' + WHERE,
  'expanding\\s+its\\s+(?:[\\w.]+\\s+)?(footprint|distribution|retail presence|store count)',
  'roll(ed|ing|s)?( out)?\\s+(to|in|into|across|at)\\s+(?:[\\w,&.]+\\s+){0,4}?' + WHERE,
  '(went|goes|going|gone|took (it|them))\\s+national\\b', 'took (it|them) to \\d+\\+? (more |new )?states',
  '(entered|entering|enters)\\s+' + WHERE, 'launch(ed|es|ing)?\\s+(in|into)\\s+' + WHERE,
  'launch\\w*\\b[^.;]{0,30}?\\bnationwide\\b', 'growing\\s+(on|across|in|into)\\s+' + WHERE,
  '(re)?launch\\w*\\b[^.;]{0,40}?\\bdistribut(ion|or)\\b', '(distribution|distributors?) (deals?|agreements?|partnerships?)\\b',
  '[\\d,]+-(store|door)\\s+(?:[\\w-]+\\s+){0,2}(commitment|deal|roll-?out|expansion|launch)', 'went from\\b[^.;]{0,40}?\\bto\\s+(?:~?[\\d,]+\\+?\\s+)?(?:[\\w&\'-]+\\s+){0,2}(stores|doors|states|markets)\\b',
  'city[- ]by[- ]city', 'new cities',
  // state codes ("into NY", "into CA, CO, FL", "FL rollout") only right after the verb or before "rollout" —
  // never after skipped words, where "in", "or", "me" are just words
  '(expan(d|ds|ded|ding|sion)\\s+((in)?to|across)|roll(ed|ing|s)?( out)?\\s+(to|in|into|across)|entered|entering|enters|launch(ed|es|ing)?\\s+(in|into))\\s+' + STATE_CODES,
  STATE_CODES + '\\s+roll-?outs?',
  '(retail|national|nationwide|store|grocery|regional|statewide)\\s+roll-?outs?',
  'roll-?outs?\\s+(to|into|across|at|in)\\s+' + WHERE,
  'new (retail (partners?|accounts?|doors|chains?|distribution)|distribution|markets?|states|stores|doors|accounts)\\b',
  '(add|added|adding|adds) [\\d,]+\\+? (?:[A-Za-z-]+ ){0,2}(stores|doors|accounts|retailers|locations|states|markets)\\b',
  'launch(ed|es|ing)?\\b[^.;]{0,40}?\\b(in|at|into|on) (?:all |the )?(?:~?[\\d,]+\\+? (?:[\\w&\'-]+ ){0,2}(stores|doors)\\b|(?:' + SHOP_NAMES + ')\\b)',
  '(entered|entering|enters|into) (?:~?[\\d,]+\\+? )?(?:' + SHOP_NAMES + ')\\b',
  '(?:' + SHOP_NAMES + ') (launch|roll-?out|expansion|debut)\\b',
  'going national',
  '(expand\\w*|grow\\w*|roll\\w* out|launch\\w*) (in|into|to) \\d+ (more |new )?states',
  '\\d+ new (states|markets)',
].join('|') + ')', 'gi')

// A launch's clause runs to a ";" or to a "." that ends a sentence (not
// "U.S.", "Inc.", "Jan." or a period before a lowercase word or a number).
const ABBR = /(^|\s)(inc|co|corp|ltd|llc|st|mt|dr|no|vs|mr|mrs|ms|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z](\.[a-z])+)$/i
function clauseEnd(t: string, from: number): number {
  for (let i = from; i < t.length; i++) {
    if (t[i] === ';') return i
    if (t[i] === '.' && /^\s+[A-Z]/.test(t.slice(i + 1, i + 3)) && !ABBR.test(t.slice(Math.max(0, i - 12), i))) return i
  }
  return t.length
}
function clauseStart(t: string, at: number): number {
  for (let i = at - 1; i >= 0; i--) {
    if (t[i] === ';') return i + 1
    if (t[i] === '.' && /^\s+[A-Z]/.test(t.slice(i + 1, i + 3)) && !ABBR.test(t.slice(Math.max(0, i - 12), i))) return i + 1
  }
  return 0
}

// The first launch in the write-up that isn't history. Its year is the
// first one after it in the same clause ("expanded into Walmart (1,200
// stores) in 2016", "into Walmart since 2015"), else one just before it
// ("In 2016 it expanded…") that isn't a founding year ("(founded 2014) is
// rolling out…"); a year before last year makes it the brand's past.
export function launchIn(text: string, now: Date = new Date()): string | null {
  const t = String(text ?? '')
  for (const m of Array.from(t.matchAll(LAUNCH))) {
    const at = m.index ?? 0
    const end = at + m[0].length
    const after = t.slice(end, clauseEnd(t, end)).match(/\b(19|20)\d{2}\b/)
    let year = after ? Number(after[0]) : null
    if (year == null) {
      const before = t.slice(Math.max(clauseStart(t, at), at - 30), at)
      const ys = Array.from(before.matchAll(/\b(19|20)\d{2}\b/g)).filter(y => !/(founded|founding|est\.?|established|started|born|since)\s*(in\s*)?$/i.test(before.slice(0, y.index)))
      if (ys.length) year = Number(ys[ys.length - 1][0])
    }
    if (year != null && year < now.getUTCFullYear() - 1) continue
    return m[0].trim()
  }
  return null
}

export function scoreFind(f: {
  priority: 'top' | 'middle' | 'low' | 'skip'
  signals?: string | null
  text?: string | null
  giant?: string | null
  hasParent?: boolean
  // What the brand is: its name and the find's write-up, never our pitch
  // idea. Read for the student fit and launches; `text` (write-up +
  // pitch) for the rest, as before.
  name?: string | null
  writeUp?: string | null
  now?: Date // for "a launch years ago isn't growth" (launchIn)
}): FindScore {
  const t = String(f.text ?? '')
  const writeUp = String(f.writeUp ?? '').trim()
  const ev = readFind(t)
  const sign = (s: string) => String(f.signals ?? '').split(',').map(x => x.trim()).includes(s)
  const reasons: FindScore['reasons'] = []
  const add = (good: boolean | null, text: string, points: number) => reasons.push({ good, text, points })

  add(f.priority === 'top' ? true : f.priority === 'middle' ? null : false,
    { top: 'Top', middle: 'Middle', low: 'Low', skip: 'Skip' }[f.priority] + ' priority category', { top: 25, middle: 12, low: 0, skip: 0 }[f.priority])

  const parent = f.giant || (f.hasParent || ev.parentNamed ? 'owned by ' + (ev.parentNamed || 'a parent company') : null)
  if (parent) add(false, (f.giant ? 'giant (' + f.giant + ')' : parent) + ' — too big for now', 0)
  else {
    const s = ev.salesCents != null ? ev.salesCents / 100 : null
    const r = ev.fundingCents != null ? ev.fundingCents / 100 : null
    const salesPts = s == null ? null : s >= 1e9 ? 0 : s > 5e8 ? 10 : s >= 1e7 ? 25 : s >= 1e6 ? 12 : 0
    const raisePts = r == null ? null : r >= 5e6 ? 20 : r >= 1e6 ? 10 : 3
    if (salesPts == null && raisePts == null) add(null, 'money not stated', 0)
    else if ((salesPts ?? -1) >= (raisePts ?? -1)) add(salesPts! >= 20, short(s!) + ' in sales' + (salesPts === 25 ? ' — the sweet spot' : s! > 5e8 ? ' — big' : ''), salesPts!)
    else add(raisePts! >= 20, 'raised ' + short(r!), raisePts!)
  }

  const shops = new Set(Array.from(t.matchAll(RETAILERS)).map(m => m[1].toLowerCase().replace(/'/g, '')))
  let shelf = ev.stores == null ? (sign('midsize') ? 6 : 0) : ev.stores >= 1000 ? 15 : ev.stores >= 300 ? 10 : 5
  if (shops.size) shelf = Math.min(15, shelf + 5)
  add(shelf >= 10 ? true : shelf ? null : false,
    ev.stores != null ? ev.stores.toLocaleString('en-US') + '+ stores' + (shops.size ? ' incl. ' + Array.from(shops).slice(0, 3).join(', ') : '')
      : shops.size ? 'in ' + Array.from(shops).slice(0, 3).join(', ') : sign('midsize') ? 'mid-size and growing (no store count)' : 'shelf size not stated', shelf)

  if (SPENDS.test(t) && (ev.college || ev.music)) add(true, 'already pays for ' + [ev.college ? 'college' : '', ev.music ? 'music' : ''].filter(Boolean).join(' / '), 20)
  else if (sign('sponsors')) add(null, 'sponsors college / music (the hunt’s note)', 12)
  else if (AUDIENCE.test(t)) add(null, 'popular with students, no sponsorship yet', 6)
  else add(false, 'no college / music spend found', 0)

  // Fits a student's day (student-fit.ts) — the write-up, and the name
  // for energy ("Raze Energy"); "isn't on file" only when there's no write-up.
  reasons.push(studentReason(studentUse(writeUp, f.name), !!writeUp))

  const launch = launchIn(writeUp, f.now)
  if (GROWTH.test(t)) add(true, 'growing fast', 10)
  else if (launch) add(true, 'growing fast (“' + launch + '”)', 10)
  if (sign('genz')) add(true, 'aims at 18–24', 5)

  return { score: capAt100(reasons), reasons }
}
