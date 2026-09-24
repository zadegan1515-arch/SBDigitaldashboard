// src/lib/li-capture.ts
//
// The rules behind the LinkedIn People capture (scripts/linkedin-capture.user.js
// → /api/ingest, actions liPreview / liCapture). Pure and dependency-free
// so node scripts/test-li-capture.mjs can compile and check it on its own.
//
// What LinkedIn gives us is a name, a headline and a profile link — no
// email, no location. The headline is the person's own words ("Senior
// Brand Manager at Liquid Death | ex-Red Bull"), so the job here is to
// turn it into a title we can put in a template and decide whether the
// person buys sponsorships at all. Leo's call (Sep 2026): buyers only,
// inside the same 25-per-brand file cap as SponsorUnited.

// A company or showcase page slug from any LinkedIn company URL:
// linkedin.com/company/liquid-death/people/?keywords=x → "liquid-death".
export function companySlug(url: string | null | undefined): string | null {
  const m = String(url || '').match(/linkedin\.com\/(?:company|showcase)\/([^\/?#\s]+)/i)
    || String(url || '').match(/^\/(?:company|showcase)\/([^\/?#\s]+)/i)
  if (!m) return null
  let s = m[1]
  try { s = decodeURIComponent(s) } catch { /* keep as is */ }
  s = s.trim().toLowerCase()
  return s || null
}

export function companyPageUrl(slug: string): string {
  return 'https://www.linkedin.com/company/' + encodeURIComponent(slug) + '/'
}

// A person's profile slug: linkedin.com/in/jane-doe-12ab/?miniProfileUrn=… →
// "jane-doe-12ab". SponsorUnited stores the same links, so this is what
// tells us a LinkedIn card is someone already on file.
export function profileSlug(url: string | null | undefined): string | null {
  const m = String(url || '').match(/(?:linkedin\.com)?\/(?:in|pub)\/([^\/?#\s]+)/i)
  if (!m) return null
  let s = m[1]
  try { s = decodeURIComponent(s) } catch { /* keep as is */ }
  s = s.trim().toLowerCase()
  return s || null
}

export function profileUrl(slug: string): string {
  return 'https://www.linkedin.com/in/' + encodeURIComponent(slug) + '/'
}

// The name as LinkedIn shows it, tidied. Null for anything that is not a
// person's name: "LinkedIn Member" (out of network, no profile to open),
// an address, or a whole card's text.
export function cleanName(raw: string | null | undefined): string | null {
  const s = String(raw || '')
    .replace(/[​-‍﻿]/g, '')
    // Emoji and pictographs people put in their names.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || s.length > 80 || s.indexOf('@') !== -1) return null
  if (/^linkedin member$/i.test(s)) return null
  return s
}

// Two spellings of the same person: "Jane Doe, MBA" and "Jane Doe" on
// SponsorUnited, "José" and "Jose". Used only for "already on file".
export function personKey(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(',')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The role out of a headline: the first segment, without " at Company".
//   "Senior Brand Manager at Liquid Death | ex-Red Bull" → "Senior Brand Manager"
//   "VP, Marketing @ Olipop"                             → "VP, Marketing"
//   "Head of Partnerships – Liquid Death"                → "Head of Partnerships" (company given)
export function roleFromHeadline(headline: string | null | undefined, companyName?: string | null): string | null {
  let s = String(headline || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  s = s.split(/\s*[|•·]\s*/)[0]
  s = s.replace(/\s+(?:at|@)\s+.+$/i, '').replace(/\s*@\s*\S.*$/, '')
  if (companyName) {
    const co = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (co) s = s.replace(new RegExp('\\s*[-–—,]\\s*' + co + '.*$', 'i'), '')
  }
  s = s.replace(/[\s,;:-]+$/, '').trim()
  return s ? s.slice(0, 120) : null
}

// Who buys sponsorships. Judged on the role (the headline's first
// segment), because the rest of a headline is history and slogans:
// "Brand Manager | ex-Red Bull" is a buyer at this brand, not Red Bull's.
const BUYER = /marketing|ambassador programs?|student (?:engagement|programs?)|\bbrand|partnership|sponsor|experiential|activation|campus|college|universit|\bevents?\b|community|influencer|social media|\bcmo\b|chief (?:marketing|brand|growth|commercial|revenue)|\bgrowth\b|promotion|shopper|entertainment|communications|public relations|\bpr\b|creative director/i
// Small brands: the founder or CEO is who signs.
const LEADER = /\b(?:co-?founder|founder|ceo|chief executive|owner|(?<!vice[ -])president)\b/i
// A role this generic ("Director", "Senior Manager") says nothing on its
// own; let the rest of the headline decide it.
const GENERIC = /^(?:senior |sr\.? |associate |assistant |group |global |regional |national )*(?:director|manager|lead|head|vp|vice president|svp|evp|avp|coordinator|specialist|executive|strategist)$/i
// Never a buyer, whatever else the headline says. "Brand Ambassador" is
// a promo rep at a beverage brand; "People & Culture" is HR. Whoever
// RUNS the student or ambassador program is the opposite — that is the
// college buyer — so those two words only disqualify on their own.
const NOT_BUYER = /\bintern(?:ship)?\b|\bstudent\b(?!\s+(?:marketing|engagement|programs?|partnerships?|activation))|ambassador(?!\s+(?:programs?|marketing|manager|lead|director|coordinator))|recruit|talent acquisition|human resources|\bhr\b|people (?:&|and) culture|designer|engineer|developer|accountant|accounting|\bfinance\b|\blegal\b|counsel|attorney|paralegal|supply chain|logistics|warehouse|driver|merchandiser|cashier|retired|seeking|open to work|looking for|aspiring|volunteer/i

export function isBuyer(role: string | null | undefined, headline?: string | null): boolean {
  const r = String(role || '').trim()
  if (!r || NOT_BUYER.test(r)) return false
  if (BUYER.test(r) || LEADER.test(r)) return true
  const h = String(headline || '')
  return GENERIC.test(r) && BUYER.test(h) && !NOT_BUYER.test(h.split(/\s*[|•·]\s*/).slice(0, 2).join(' '))
}
