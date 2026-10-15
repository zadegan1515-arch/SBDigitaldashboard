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
//   growing fast        "fastest-growing", "doubled", "+50%", "triple-digit" 10
//   aims at 18–24       the hunt's sign 5
export interface FindScore { score: number; reasons: Array<{ good: boolean | null; text: string; points: number }> }

const RETAILERS = /\b(walmart|target|kroger|costco|whole foods|publix|h-e-b|heb|7-eleven|trader joe'?s|total wine|cvs|walgreens|albertsons|safeway|sprouts|wegmans|meijer|hy-vee|circle k|wawa|sheetz|bevmo|sam'?s club|harris teeter|dick'?s|foot locker|ulta|sephora)\b/gi
const SPENDS = /\b(official\s+[\w\s'-]{0,40}\b(of|partner)|licensed|NIL|collective|sponsor(s|ed|ship)?|presenting|presented|title partner|partner(ed|ship)? with|tour\b|festival|activation|sampling)/i
const AUDIENCE = /\b(college students|campus|sororit|fraternit|students|gen ?z|tailgat)/i
const GROWTH = /\b(fastest[- ]growing|doubled|tripled|triple[- ]digit|double[- ]digit|\d{2,3}%\s*(growth|yoy|year|up)|up\s+\d{2,3}%|\d{2,3}%\+?\s+yoy|growth of \d{2,3}%)/i

export function scoreFind(f: {
  priority: 'top' | 'middle' | 'low' | 'skip'
  signals?: string | null
  text?: string | null
  giant?: string | null
  hasParent?: boolean
}): FindScore {
  const t = String(f.text ?? '')
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

  if (GROWTH.test(t)) add(true, 'growing fast', 10)
  if (sign('genz')) add(true, 'aims at 18–24', 5)

  return { score: Math.max(0, Math.min(100, reasons.reduce((n, r) => n + r.points, 0))), reasons }
}
