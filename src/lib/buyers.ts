// Who counts as a "buyer" on the Brands table (Leo, Oct 2026: "there must
// be marketing/partnerships or someone like that at each, and i want a
// number of how many of those types of people we have on file"). Title
// rules only, no model call. Four kinds, Leo's picks:
//   partnerships — partnerships, sponsorship, alliances, business development
//   events       — events, experiential, field marketing, ambassador programs
//   marketing    — marketing, brand manager/director, CMO, growth, activation
//   founder      — founder, CEO, owner, president (small brands: they decide)
// A brand is covered with at least one (BUYER_TARGET).
// node scripts/test-buyers.mjs

export type BuyerKind = 'partnerships' | 'events' | 'marketing' | 'founder'

export const BUYER_KINDS: BuyerKind[] = ['partnerships', 'events', 'marketing', 'founder']
export const BUYER_TARGET = 1

// Never a buyer, whatever else the title says: not working there now, or
// not in a seat that decides anything.
const NOT_NOW = /\b(?:intern(?:ship)?|student|retired|former|formerly|ex[-\s]|seeking|looking for|open to work|aspiring)\b/i

const PARTNERSHIPS = /partner(?:ship|ships)\b|sponsor|alliances?\b|business development|\bbiz ?dev\b|\bbd\b|\bbdr\b|collaborations?\b|licensing/i
const EVENTS = /\bevents?\b|experiential|field marketing|ambassador|activations?\b|promotions?\b|college|campus|grassroots|sampling|tour(?:ing)?\b|nightlife|on[- ]premise/i
const MARKETING = /marketing|\bmarketer\b|\bbrand(?:s|ing)?\b|\bcmo\b|\bgrowth\b|communications|\bpr\b|public relations|influencer|social media|creative director|content|community|consumer engagement|media/i
const FOUNDER = /founder|\bceo\b|chief executive|\bowner\b|\bpresident\b|managing director|\bgm\b|general manager|\bcoo\b|chief operating|\bchief brand\b/i
// "Vice President of …" is the department, not the company's president.
const VP = /\b(?:vice[- ]president|vp|svp|evp|avp)\b/i
// "Partner" alone at a brand is usually a law/agency/investor title, and
// "people partner" is HR — neither buys a sponsorship.
const NOT_PARTNERSHIPS = /people partner|hr partner|business partner(?!ships)|human resources|talent|recruit|channel partner sales/i

export function buyerKind(title: string | null | undefined): BuyerKind | null {
  const t = String(title || '').trim()
  if (!t || NOT_NOW.test(t)) return null
  if (PARTNERSHIPS.test(t) && !NOT_PARTNERSHIPS.test(t)) return 'partnerships'
  if (EVENTS.test(t)) return 'events'
  if (MARKETING.test(t)) return 'marketing'
  if (FOUNDER.test(t.replace(VP, ' '))) return 'founder'
  return null
}

export function isBuyerTitle(title: string | null | undefined): boolean {
  return buyerKind(title) !== null
}

// Counts per kind plus the total, for one brand's people.
export function countBuyers(titles: (string | null | undefined)[]): Record<BuyerKind, number> & { total: number } {
  const out = { partnerships: 0, events: 0, marketing: 0, founder: 0, total: 0 }
  for (const t of titles) {
    const k = buyerKind(t)
    if (!k) continue
    out[k] += 1
    out.total += 1
  }
  return out
}
