// Find emails for the people who never answered on LinkedIn (Leo, Nov 16
// 2026: "start doing cold emails to all the brands that did not accept us …
// how do we acquire their emails", then "how can i import all of the brands
// that didn't accept/respond to us and put into hunter").
//
// Outreach → Email's card: download the people who didn't accept or went
// quiet as a file Hunter's bulk Email Finder takes (first name, last name,
// company, website), then bring Hunter's file back — a preview first, and
// only an empty email field is ever filled. Nothing is emailed from here.
//
// Who's on the list follows Deals → Overview (tracker.ts), so "didn't
// accept" and "no response" mean what they mean there:
//   · the brand sits at Reached out (nobody there accepted), or at Out
//     because everyone who accepted went quiet after the last follow-up —
//     and nobody there ever wrote back, said no or asked us to stop;
//   · the person was invited and never accepted (an invite at least
//     FIND_MIN_DAYS old, or withdrawn), or accepted and went quiet.
// Never a brand that replied, is in talks, said no, doesn't want to
// continue, is archived or marked do-not-email — and a brand where someone
// accepted and is still being worked on LinkedIn waits until that ends.
//
//
// Later the same day (Leo: "there are about 900 brands on the Command Center
// … I want to get all those brands into our cold email outreach … a download
// … that has a list of all the brands and then probably the people from those
// brands too"): a third group, brands **not reached out to yet** — the ones
// the queue could still pick (never invited or emailed, not in talks, no
// deal, not set aside or held back). At each, the best few people on file
// (FRESH_PER_BRAND; buyer titles first) — the ones with no email go on the
// list for Hunter, the ones with an email are ready. A brand with nobody to
// look up goes on a second file, its website, for Hunter's Domain Search.
//
// Pure: the handlers in route.ts load the rows. node scripts/test-find-emails.mjs

import { websiteDomain } from './duplicates'
import { linkedinSlug, personNameKey } from './same-person'

// An invite this old with no accept counts as "didn't accept" — the Old
// invites rule (staleInvites, 21 days).
export const FIND_MIN_DAYS = 21
export const FOUND_LAST_KEY = 'foundEmailsLast'

// ---- names ----------------------------------------------------------

const HONORIFIC = /^(dr|mr|mrs|ms|miss|mx|prof|professor|sir|coach)\.?$/i
// Only letters that are never a surname. ("Ma", "Ba" are people's names.)
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|ph\.d|mba|m\.b\.a|cpa|esq|cfa|pmp|md|m\.d)\.?$/i
const PARTICLE = /^(de|del|della|di|da|dos|das|du|la|le|van|von|der|den|ter|bin|ibn|al|el|st\.?)$/i
const INITIAL = /^\p{L}\.?$/u

// "Dr. Jane A. Smith, MBA (she/her)" → Jane / Smith. Null when there's no
// first and last name to look up: one word, "LinkedIn Member", or a name
// LinkedIn cut short ("Jane S.").
export function splitName(name: unknown): { first: string; last: string } | null {
  let s = String(name ?? '').normalize('NFC')
  if (/linkedin member/i.test(s)) return null
  s = s.replace(/\(.*?\)/g, ' ').replace(/["“”«»].*?["“”«»]/g, ' ')
  s = s.split(/[,|·•–—]|\s-\s/)[0]
  s = s.replace(/[^\p{L}\p{M}\s.'’-]/gu, ' ')
  const tokens = s.trim().split(/\s+/).filter(Boolean)
  while (tokens.length && HONORIFIC.test(tokens[0])) tokens.shift()
  while (tokens.length > 2 && SUFFIX.test(tokens[tokens.length - 1])) tokens.pop()
  if (tokens.length < 2) return null
  let i = tokens.length - 1
  while (i - 1 >= 1 && PARTICLE.test(tokens[i - 1])) i--
  const first = tokens[0].replace(/\.$/, '')
  const last = tokens.slice(i).join(' ').replace(/\.$/, '')
  if (INITIAL.test(first) || INITIAL.test(last) || !first || !last) return null
  return { first, last }
}

// ---- the company's email domain -------------------------------------

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'mail.com', 'hey.com', 'zoho.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net',
])
const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[a-z]{2,}$/i
export const looksLikeEmail = (v: unknown) => EMAIL_RE.test(String(v ?? '').trim())
export const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase()

// The company's own domain in an address — never a free mailbox.
export function mailDomain(email: unknown): string | null {
  const e = cleanEmail(email)
  if (!looksLikeEmail(e)) return null
  const d = e.slice(e.lastIndexOf('@') + 1).replace(/\.$/, '')
  return FREE_MAIL.has(d) ? null : d
}

// Where a brand's people get their mail: the domain most of the addresses
// we already hold there use (a label under a parent mails from the
// parent's), else the brand's own website.
export function companyDomain(x: { website?: string | null; emails?: Array<string | null | undefined> }): { domain: string | null; from: 'emails' | 'website' | null } {
  const site = websiteDomain(x.website)
  const n = new Map<string, number>()
  for (const e of x.emails ?? []) { const d = mailDomain(e); if (d) n.set(d, (n.get(d) ?? 0) + 1) }
  let best: string | null = null
  for (const [d, c] of n) {
    const b = best ? (n.get(best) as number) : -1
    if (c > b || (c === b && (d === site || (best !== site && d < (best as string))))) best = d
  }
  if (best) return { domain: best, from: 'emails' }
  return site ? { domain: site, from: 'website' } : { domain: null, from: null }
}

// ---- who's on the list ----------------------------------------------

// outreachTracker's rows, the parts this reads.
export type FindPerson = {
  contactId?: string | null; name?: string | null; title?: string | null; linkedinUrl?: string | null; email?: string | null
  stage: string; out?: string | null; label?: string | null; lastAt?: string | null; emailedAt?: string | null; by?: string | null
  steps?: string[]                // the steps they got through (outreachTracker): 'replied' = they wrote back once
}
export type FindBrand = {
  id: string; name: string; category?: string | null; stage: string; out?: string | null
  archived?: boolean; doNotEmail?: boolean; people: FindPerson[]
}
// working / held (Leo, Nov 16 2026: "include all of them, i want every brand
// on the file"): working = a brand where someone accepted and is still on
// Zach's list — its people, the one who accepted too; held = a brand not
// reached yet that the queue's rules hold back (a giant, a Skip category, too
// small). Each is its own group, so the card can leave it out again and the
// file says which is which ("SB status").
export type FindGroup = 'noaccept' | 'quiet' | 'working' | 'fresh' | 'held'
export const GROUP_WORDS: Record<FindGroup, string> = {
  noaccept: 'Didn’t accept', quiet: 'Accepted, then no response', working: 'Someone accepted — on Zach’s list',
  fresh: 'Not reached out to yet', held: 'Not reached out to yet — held back by the queue',
}

// Invited (or emailed) with no answer → didn't accept; accepted and quiet
// after the last follow-up → no response. Anyone else isn't on the list.
export function personGroup(p: FindPerson): FindGroup | null {
  if (p.stage === 'reached') return 'noaccept'
  if (p.stage === 'out' && p.out === 'quiet') return 'quiet'
  return null
}

// Someone there answered us — wrote back, said no, or said they don't want
// to continue (even "just me"): the company isn't approached again (Leo, Oct
// 18 2026, Reach out again's rule: "if someone has replied then we prob
// shouldnt reach out to their company again").
export function brandAnswered(b: FindBrand): boolean {
  return (b.people ?? []).some(p => (p.stage === 'out' && p.out !== 'quiet') || (p.steps ?? []).includes('replied'))
}

// in = on the list · off = it would be, but it's archived / do not email ·
// waiting = someone accepted and is still being worked on LinkedIn · no =
// replied, in talks, said no, doesn't want to continue…
export function brandIn(b: FindBrand): 'in' | 'off' | 'waiting' | 'no' {
  if (brandAnswered(b)) return 'no'
  const fits = b.stage === 'reached' || (b.stage === 'out' && b.out === 'quiet')
  if (!fits) return b.stage === 'accepted' ? 'waiting' : 'no'
  return b.archived || b.doNotEmail ? 'off' : 'in'
}

export type FindRow = {
  contactId: string; name: string; first: string; last: string; title: string | null; linkedinUrl: string | null; email: string | null
  brandId: string; brandName: string; category: string | null; group: FindGroup; lastAt: string | null; by: string | null
}
export type FindCounts = {
  need: number; needBrands: number; noaccept: number; quiet: number; working: number; fresh: number; held: number
  have: number; emailed: number; tooNew: number; noName: number; offBrands: number; waitingBrands: number
}

// Where one brand stands on the card — every brand in exactly one place, so
// the card can account for the whole roster (Leo, Nov 16 2026: "Only 210
// brands, not ~900"):
//   list     someone there to look up (on the file for Hunter)
//   ready    nobody to look up, but an email is on file and not used yet
//   nobody   not reached yet and nobody on file to email or look up
//   tooNew   reached, every invite younger than the wait
//   emailed  reached, the people there already emailed
//   waiting  someone accepted and is still on Zach's list
//   talking  replied, in talks, said no or asked us to stop
//   held     not reached yet, held back by the queue's rules
//   known    not reached yet, but a deal / show / activation / board request
//   off      archived, do not email, stopped, not sold in the US, closed
export type BrandSpot = 'list' | 'ready' | 'nobody' | 'tooNew' | 'emailed' | 'waiting' | 'talking' | 'held' | 'known' | 'off' | 'other'
export const BRAND_SPOTS: BrandSpot[] = ['list', 'ready', 'nobody', 'tooNew', 'emailed', 'waiting', 'talking', 'held', 'known', 'off', 'other']
export type SpotTally = Record<string, Partial<Record<BrandSpot, number>>>

// Brands per category ('' = none) and place: the card sums them, or reads
// one category's.
export function tallySpots(rows: Array<{ category?: string | null; spot: BrandSpot }>): SpotTally {
  const out: SpotTally = {}
  for (const r of rows) {
    const k = r.category || ''
    const t = out[k] ?? (out[k] = {})
    t[r.spot] = (t[r.spot] ?? 0) + 1
  }
  return out
}

// need = no email on file, a name Hunter can look up, old enough.
// have = an email is on file and nobody has emailed them yet.
// spots = where each of these brands stands (BrandSpot).
// working: true also lists the brands where someone accepted and is still on
// Zach's list (group 'working') — without it they wait, as they did.
export function needEmailList(brands: FindBrand[], opts: { minDays?: number; now?: Date; working?: boolean } = {}): { need: FindRow[]; have: FindRow[]; counts: FindCounts; spots: Record<string, BrandSpot> } {
  const now = opts.now ?? new Date()
  const minDays = Math.max(0, opts.minDays ?? FIND_MIN_DAYS)
  const cutoff = now.getTime() - minDays * 864e5
  const need: FindRow[] = [], have: FindRow[] = []
  const c: FindCounts = { need: 0, needBrands: 0, noaccept: 0, quiet: 0, working: 0, fresh: 0, held: 0, have: 0, emailed: 0, tooNew: 0, noName: 0, offBrands: 0, waitingBrands: 0 }
  const seen = new Set<string>()
  const needBrands = new Set<string>()
  const spots: Record<string, BrandSpot> = {}
  for (const b of brands) {
    const where = brandIn(b)
    const working = where === 'waiting' && !!opts.working
    const mine = (b.people ?? []).filter(p => (personGroup(p) || (working && p.stage === 'accepted')) && p.contactId)
    if (where === 'waiting') {
      if ((b.people ?? []).some(p => personGroup(p))) c.waitingBrands += 1
      if (!working) { spots[b.id] = 'waiting'; continue }
    } else if (where === 'off') { spots[b.id] = 'off'; if (mine.length) c.offBrands += 1; continue }
    else if (where !== 'in') { spots[b.id] = 'talking'; continue }
    const n = { need: 0, have: 0, tooNew: 0, emailed: 0 }
    for (const p of mine) {
      const id = String(p.contactId)
      if (seen.has(id)) continue
      seen.add(id)
      const own = personGroup(p)
      const group: FindGroup = working ? 'working' : (own as FindGroup)
      const nm = splitName(p.name)
      const row: FindRow = {
        contactId: id, name: String(p.name ?? '').trim(), first: nm?.first ?? '', last: nm?.last ?? '',
        title: p.title ?? null, linkedinUrl: p.linkedinUrl ?? null, email: p.email ? cleanEmail(p.email) : null,
        brandId: b.id, brandName: b.name, category: b.category ?? null, group, lastAt: p.lastAt ?? null, by: p.by ?? null,
      }
      if (row.email) {
        if (p.emailedAt) { c.emailed += 1; n.emailed += 1 }
        else { have.push(row); c.have += 1; n.have += 1 }
        continue
      }
      // An invite still out and younger than the wait may yet be accepted.
      const fresh = own === 'noaccept' && p.label !== 'invite withdrawn' && !!p.lastAt && new Date(p.lastAt).getTime() > cutoff
      if (fresh) { c.tooNew += 1; n.tooNew += 1; continue }
      if (!nm) { c.noName += 1; continue }
      need.push(row)
      c[group] += 1
      n.need += 1
      needBrands.add(b.id)
    }
    spots[b.id] = n.need ? 'list' : n.have ? 'ready' : n.tooNew ? 'tooNew' : n.emailed ? 'emailed' : working ? 'waiting' : 'other'
  }
  c.need = need.length
  c.needBrands = needBrands.size
  return { need, have, counts: c, spots }
}

// ---- brands not reached out to yet -----------------------------------

// How many people a brand not reached yet gets by default: its best three
// (a first outreach opens with three or four — brand-work.ts).
export const FRESH_PER_BRAND = 3

// One person on file at a brand nobody has reached out to. flagged = not a
// buyer's title, no title, or works outside the US (the queue check's ⚠);
// rank = how strong the title is (partnerships > events > marketing =
// founder, queue-check.ts buyerRank).
export type FreshPerson = {
  contactId: string; name?: string | null; title?: string | null; linkedinUrl?: string | null; email?: string | null
  stopped?: boolean; flagged?: boolean; rank?: number; decisionMaker?: boolean
}
// group: 'held' for a brand the queue's rules hold back (else 'fresh').
export type FreshBrand = { id: string; name: string; category?: string | null; group?: FindGroup; people: FreshPerson[] }
export type FreshCounts = {
  fresh: number; freshBrands: number; freshHave: number
  freshMore: number          // people past the brand's number — not looked up
  freshNoName: number        // no email and no first + last name to look up
  nobodyBrands: number       // nobody there to email or look up → the Domain Search file
}

// Who goes first at a brand: an unflagged title, the stronger title, a
// marked decision maker, a LinkedIn link (Hunter's match is surer with the
// profile beside it). Equal people keep the order they came in.
function freshOrder(a: FreshPerson, b: FreshPerson): number {
  return Number(!!a.flagged) - Number(!!b.flagged) || (b.rank ?? 0) - (a.rank ?? 0) ||
    Number(!!b.decisionMaker) - Number(!!a.decisionMaker) || Number(!!b.linkedinUrl) - Number(!!a.linkedinUrl)
}

// The best `perBrand` people at each brand (0 = everyone): the ones with an
// email are ready, the ones without go on the list for Hunter. Flagged
// people only when the brand has nobody else — a worse door beats no door.
// Never someone who said they don't want to continue. `skip` = contact ids
// already on the list another way.
export function freshList(brands: FreshBrand[], opts: { perBrand?: number; skip?: Set<string> } = {}): {
  need: FindRow[]; have: FindRow[]; nobody: Array<{ id: string; name: string; category: string | null }>; counts: FreshCounts
} {
  const per = Math.max(0, Math.floor(opts.perBrand ?? FRESH_PER_BRAND))
  const need: FindRow[] = [], have: FindRow[] = []
  const nobody: Array<{ id: string; name: string; category: string | null }> = []
  const c: FreshCounts = { fresh: 0, freshBrands: 0, freshHave: 0, freshMore: 0, freshNoName: 0, nobodyBrands: 0 }
  const seen = new Set<string>(opts.skip ?? [])
  for (const b of brands) {
    const pool: Array<{ p: FreshPerson; nm: { first: string; last: string } | null; email: string | null }> = []
    const here = new Set<string>()
    for (const p of b.people ?? []) {
      if (!p.contactId || p.stopped || seen.has(p.contactId) || here.has(p.contactId)) continue
      here.add(p.contactId)
      const email = p.email && looksLikeEmail(p.email) ? cleanEmail(p.email) : null
      const nm = splitName(p.name)
      if (!email && !nm) { c.freshNoName += 1; continue }
      pool.push({ p, nm, email })
    }
    if (!pool.length) { nobody.push({ id: b.id, name: b.name, category: b.category ?? null }); c.nobodyBrands += 1; continue }
    const ok = pool.filter(x => !x.p.flagged)
    const from = (ok.length ? ok : pool).map((x, i) => ({ x, i })).sort((l, r) => freshOrder(l.x.p, r.x.p) || l.i - r.i).map(o => o.x)
    const take = per ? from.slice(0, per) : from
    c.freshMore += from.length - take.length
    let any = false
    for (const { p, nm, email } of take) {
      seen.add(p.contactId)
      const row: FindRow = {
        contactId: p.contactId, name: String(p.name ?? '').trim(), first: nm?.first ?? '', last: nm?.last ?? '',
        title: p.title ?? null, linkedinUrl: p.linkedinUrl ?? null, email,
        brandId: b.id, brandName: b.name, category: b.category ?? null, group: b.group ?? 'fresh', lastAt: null, by: null,
      }
      if (email) { have.push(row); c.freshHave += 1 } else { need.push(row); c.fresh += 1; any = true }
    }
    if (any) c.freshBrands += 1
  }
  return { need, have, nobody, counts: c }
}

// The file for Hunter's bulk Domain Search: one company a line — its
// website's domain, else its name (Hunter takes either; a domain is surer).
// The same company once.
export function domainLines(rows: Array<{ domain?: string | null; company?: string | null }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const v = String(r.domain || r.company || '').trim()
    const k = v.toLowerCase()
    if (!v || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

// ---- Hunter's file, read back ---------------------------------------

// Minimal CSV parser — quotes, escaped quotes, CR/LF, a leading BOM.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQ = false
  const src = String(text ?? '').replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else inQ = false
      } else cell += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(v => v.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some(v => v.trim() !== '')) rows.push(row)
  return rows
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
export const toCsv = (grid: unknown[][]) => grid.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

// The file for Hunter's bulk Email Finder. Hunter keeps every column and
// adds its own, so "SB id" comes back with each address.
// "SB category" = the brand's category, so the list stays split by category
// in Hunter too (catName: its words — the page's CAT_NAMES).
// "SB status" = why they're on it (GROUP_WORDS).
export const HUNTER_HEAD = ['First name', 'Last name', 'Company', 'Company website', 'SB brand', 'SB category', 'SB status', 'SB title', 'SB LinkedIn', 'SB id']
export type HunterRow = FindRow & { company: string; domain: string | null }
export function hunterCsv(rows: HunterRow[], catName: (key: string | null) => string = k => k ?? ''): string {
  return toCsv([HUNTER_HEAD, ...rows.map(r => [r.first, r.last, r.company, r.domain ?? '', r.brandName, catName(r.category), GROUP_WORDS[r.group] ?? '', r.title ?? '', r.linkedinUrl ?? '', r.contactId])])
}

export type FoundRow = {
  line: number; id: string; email: string; status: string; score: number | null
  name: string; company: string; linkedin: string
}
export type FoundFile = {
  rows: FoundRow[]; total: number; empty: number
  cols: { email: string | null; status: string | null; score: string | null; id: string | null }
  error?: string
}
const hkey = (h: string) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

// Hunter's result (or any finder's): which column is the address, which
// says whether it's verified. The address column is found by what's in it
// — the column holding the most addresses, one whose heading says "mail"
// first — so a renamed heading still reads.
export function readFoundFile(text: string): FoundFile {
  const grid = parseCsv(text)
  const none: FoundFile = { rows: [], total: 0, empty: 0, cols: { email: null, status: null, score: null, id: null } }
  if (grid.length < 2) return { ...none, error: 'That file has no rows — choose the .csv Hunter gave back.' }
  const head = grid[0].map(h => String(h ?? '').trim())
  const keys = head.map(hkey)
  const body = grid.slice(1)
  const col = (test: (k: string) => boolean) => keys.findIndex(test)
  const hits = keys.map((_, i) => body.filter(r => looksLikeEmail(r[i])).length)
  let iEmail = -1
  keys.forEach((k, i) => { if (/mail/.test(k) && hits[i] > 0 && (iEmail < 0 || hits[i] > hits[iEmail])) iEmail = i })
  if (iEmail < 0) hits.forEach((n, i) => { if (n > 0 && (iEmail < 0 || n > hits[iEmail])) iEmail = i })
  if (iEmail < 0) return { ...none, total: body.length, error: 'No email addresses in that file. Choose the file Hunter gave back, not the one you uploaded to it.' }
  const iId = col(k => k === 'sbid')
  // Never one of our own columns ("SB status" says why someone is on the
  // list — it is not Hunter's verdict on the address).
  const theirs = (k: string) => !k.startsWith('sb')
  // Hunter's Leads export has "Verification status", "Sending status" and
  // "Verification date" side by side: the verdict is the first, never the
  // date it was checked or whether the lead was contacted.
  const notVerdict = (k: string) => /date|time|send|contact/.test(k)
  let iStatus = col(k => theirs(k) && /verif/.test(k) && /status|result/.test(k))
  if (iStatus < 0) iStatus = col(k => theirs(k) && /verif/.test(k) && !notVerdict(k))
  if (iStatus < 0) iStatus = col(k => theirs(k) && /status/.test(k) && !notVerdict(k))
  if (iStatus < 0) iStatus = col(k => theirs(k) && /deliverab|result/.test(k) && !notVerdict(k))
  const iScore = col(k => theirs(k) && /score|confidence/.test(k))
  const iFirst = col(k => k === 'firstname' || k === 'first')
  const iLast = col(k => k === 'lastname' || k === 'last')
  const iName = col(k => k === 'fullname' || k === 'name')
  let iCompany = col(k => k === 'sbbrand')
  if (iCompany < 0) iCompany = col(k => k === 'company' || k === 'companyname' || k === 'organization')
  let iLi = col(k => k === 'sblinkedin')
  if (iLi < 0) iLi = col(k => /linkedin/.test(k))
  const cell = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '')
  const rows: FoundRow[] = []
  let empty = 0
  body.forEach((r, n) => {
    const email = cleanEmail(cell(r, iEmail))
    if (!email) { empty += 1; return }
    const sc = cell(r, iScore).replace('%', '')
    const name = cell(r, iName) || [cell(r, iFirst), cell(r, iLast)].filter(Boolean).join(' ')
    rows.push({
      line: n + 2, id: cell(r, iId), email, status: cell(r, iStatus), score: sc !== '' && isFinite(Number(sc)) ? Number(sc) : null,
      name, company: cell(r, iCompany), linkedin: cell(r, iLi),
    })
  })
  return {
    rows, total: body.length, empty,
    cols: { email: head[iEmail] || null, status: iStatus >= 0 ? head[iStatus] : null, score: iScore >= 0 ? head[iScore] : null, id: iId >= 0 ? head[iId] : null },
  }
}

// valid = the finder says it's deliverable · invalid = it says it isn't ·
// unverified = anything in between (accept-all, risky, unknown, blank) ·
// unknown = the file has no verification column at all.
export type Verdict = 'valid' | 'invalid' | 'unverified' | 'unknown'
export function verdictOf(status: unknown, hasStatusCol: boolean): Verdict {
  const s = String(status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!s) return hasStatusCol ? 'unverified' : 'unknown'
  if (/invalid|undeliverable|not_deliverable|bounce|disposable|reject/.test(s)) return 'invalid'
  if (/^(valid|deliverable|verified|ok|safe|good)$/.test(s)) return 'valid'
  return 'unverified'
}

// ---- what a file would save ------------------------------------------

export type FoundContact = {
  id: string; name: string; email: string | null; linkedinUrl: string | null
  brandId: string; brandName: string; stopped: string | null     // why they're never contacted, or null
}
export type FoundAction = 'save' | 'same' | 'has' | 'invalid' | 'bad' | 'unknown' | 'stopped' | 'taken' | 'twice'
export type FoundLine = {
  line: number; contactId: string | null; name: string; brandName: string; email: string
  verdict: Verdict; status: string; score: number | null
  action: FoundAction; why: string; tick: boolean
}
export type FoundPlan = { lines: FoundLine[]; counts: Record<FoundAction, number> & { ticked: number }; sig: string }

// A file row with no "SB id" is matched to the list by profile link, else
// by name + brand.
export const findKey = (name: unknown, brand: unknown) => {
  const n = personNameKey(name)
  const b = String(brand ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  return n && b ? n + '|' + b : ''
}

export function planFoundEmails(file: FoundFile, ctx: {
  contacts: Map<string, FoundContact>
  bySlug?: Map<string, string>                 // profile slug → contact id (the list's people)
  byKey?: Map<string, string>                  // findKey → contact id
  taken?: Map<string, { id: string; name: string; brandName: string }>   // an address already on file → whose
  stopHit?: (email: string, c: FoundContact) => string | null            // someone who doesn't want to continue has it
}): FoundPlan {
  const hasStatus = !!file.cols.status
  const lines: FoundLine[] = []
  const used = new Map<string, string>()        // email → the contact this file gives it to
  const filled = new Set<string>()              // contacts this file already filled
  for (const r of file.rows) {
    let id = r.id && ctx.contacts.has(r.id) ? r.id : ''
    if (!id && !r.id) {
      const slug = linkedinSlug(r.linkedin)
      id = (slug && ctx.bySlug?.get(slug)) || ctx.byKey?.get(findKey(r.name, r.company)) || ''
      if (id && !ctx.contacts.has(id)) id = ''
    }
    const c = id ? (ctx.contacts.get(id) as FoundContact) : null
    const verdict = verdictOf(r.status, hasStatus)
    const base = { line: r.line, contactId: c?.id ?? null, name: c?.name ?? r.name, brandName: c?.brandName ?? r.company, email: r.email, verdict, status: r.status, score: r.score }
    const put = (action: FoundAction, why: string, tick = false) => lines.push({ ...base, action, why, tick })
    if (!c) { put('unknown', 'Not someone on the dashboard'); continue }
    if (!looksLikeEmail(r.email)) { put('bad', 'Not an email address'); continue }
    if (c.stopped) { put('stopped', c.stopped); continue }
    const cur = c.email ? cleanEmail(c.email) : ''
    if (cur === r.email) { put('same', 'Already saved'); continue }
    if (cur) { put('has', 'Already has ' + cur + ' — left as it is'); continue }
    if (verdict === 'invalid') { put('invalid', 'Hunter says this address doesn’t work'); continue }
    const stop = ctx.stopHit?.(r.email, c)
    if (stop) { put('stopped', stop); continue }
    const other = ctx.taken?.get(r.email)
    if (other && other.id !== c.id) { put('taken', 'Already ' + other.name + '’s address at ' + other.brandName); continue }
    if (used.has(r.email) && used.get(r.email) !== c.id) { put('twice', 'The file gives this address to two people'); continue }
    if (filled.has(c.id)) { put('twice', 'The file has two addresses for them — the first is used'); continue }
    used.set(r.email, c.id)
    filled.add(c.id)
    put('save', verdict === 'valid' ? 'Verified' : verdict === 'unknown' ? 'The file doesn’t say if it’s verified' : 'Not verified' + (r.status ? ' (' + r.status + ')' : ''),
      verdict === 'valid' || verdict === 'unknown')
  }
  const counts = { save: 0, same: 0, has: 0, invalid: 0, bad: 0, unknown: 0, stopped: 0, taken: 0, twice: 0, ticked: 0 } as FoundPlan['counts']
  for (const l of lines) { counts[l.action] += 1; if (l.tick) counts.ticked += 1 }
  return { lines, counts, sig: sigOf(lines.filter(l => l.action === 'save').map(l => l.contactId + ':' + l.email)) }
}

// A short signature of what a preview showed (djb2): the apply sends it
// back, and anything that changed since reads as stale.
export function sigOf(parts: string[]): string {
  let h = 5381
  for (const ch of [...parts].sort().join('\n')) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  return parts.length + '.' + (h >>> 0).toString(36)
}

// The line a saved address leaves in the person's notes, and taking it
// back out again on Undo.
export const foundNote = (day: string, verdict: Verdict) =>
  'Email added from Hunter’s file, ' + day + (verdict === 'valid' ? ' (verified)' : verdict === 'unverified' ? ' (not verified)' : '')
export function addNote(notes: string | null | undefined, line: string): string {
  return [String(notes ?? '').trim(), line].filter(Boolean).join('\n')
}
export function dropNote(notes: string | null | undefined, line: string): string | null {
  const kept = String(notes ?? '').split('\n').filter(l => l.trim() !== line.trim()).join('\n').trim()
  return kept || null
}
