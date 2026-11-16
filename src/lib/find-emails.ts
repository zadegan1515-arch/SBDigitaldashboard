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
export type FindGroup = 'noaccept' | 'quiet'
export const GROUP_WORDS: Record<FindGroup, string> = { noaccept: 'Didn’t accept', quiet: 'Accepted, then no response' }

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
  need: number; needBrands: number; noaccept: number; quiet: number
  have: number; emailed: number; tooNew: number; noName: number; offBrands: number; waitingBrands: number
}

// need = no email on file, a name Hunter can look up, old enough.
// have = an email is on file and nobody has emailed them yet.
export function needEmailList(brands: FindBrand[], opts: { minDays?: number; now?: Date } = {}): { need: FindRow[]; have: FindRow[]; counts: FindCounts } {
  const now = opts.now ?? new Date()
  const minDays = Math.max(0, opts.minDays ?? FIND_MIN_DAYS)
  const cutoff = now.getTime() - minDays * 864e5
  const need: FindRow[] = [], have: FindRow[] = []
  const c: FindCounts = { need: 0, needBrands: 0, noaccept: 0, quiet: 0, have: 0, emailed: 0, tooNew: 0, noName: 0, offBrands: 0, waitingBrands: 0 }
  const seen = new Set<string>()
  const needBrands = new Set<string>()
  for (const b of brands) {
    const where = brandIn(b)
    const mine = (b.people ?? []).filter(p => personGroup(p) && p.contactId)
    if (where === 'waiting') { if ((b.people ?? []).some(p => personGroup(p))) c.waitingBrands += 1; continue }
    if (where === 'off') { if (mine.length) c.offBrands += 1; continue }
    if (where !== 'in') continue
    for (const p of mine) {
      const id = String(p.contactId)
      if (seen.has(id)) continue
      seen.add(id)
      const group = personGroup(p) as FindGroup
      const nm = splitName(p.name)
      const row: FindRow = {
        contactId: id, name: String(p.name ?? '').trim(), first: nm?.first ?? '', last: nm?.last ?? '',
        title: p.title ?? null, linkedinUrl: p.linkedinUrl ?? null, email: p.email ? cleanEmail(p.email) : null,
        brandId: b.id, brandName: b.name, category: b.category ?? null, group, lastAt: p.lastAt ?? null, by: p.by ?? null,
      }
      if (row.email) {
        if (p.emailedAt) c.emailed += 1
        else { have.push(row); c.have += 1 }
        continue
      }
      // An invite still out and younger than the wait may yet be accepted.
      const fresh = group === 'noaccept' && p.label !== 'invite withdrawn' && !!p.lastAt && new Date(p.lastAt).getTime() > cutoff
      if (fresh) { c.tooNew += 1; continue }
      if (!nm) { c.noName += 1; continue }
      need.push(row)
      c[group] += 1
      needBrands.add(b.id)
    }
  }
  c.need = need.length
  c.needBrands = needBrands.size
  return { need, have, counts: c }
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
export const HUNTER_HEAD = ['First name', 'Last name', 'Company', 'Company website', 'SB brand', 'SB title', 'SB LinkedIn', 'SB id']
export type HunterRow = FindRow & { company: string; domain: string | null }
export function hunterCsv(rows: HunterRow[]): string {
  return toCsv([HUNTER_HEAD, ...rows.map(r => [r.first, r.last, r.company, r.domain ?? '', r.brandName, r.title ?? '', r.linkedinUrl ?? '', r.contactId])])
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
  let iStatus = col(k => /verif/.test(k))
  if (iStatus < 0) iStatus = col(k => /status/.test(k))
  if (iStatus < 0) iStatus = col(k => /deliverab|result/.test(k))
  const iScore = col(k => /score|confidence/.test(k))
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
