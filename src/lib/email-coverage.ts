// src/lib/email-coverage.ts
//
// Email → "Where we stand on emails" (Leo, Nov 17 2026: "I just want all this
// to be organized. After we run these searches I want numbers on: how many
// brands have an email · how many brands don't have an email · how many brands
// don't have a website · how we can find a website for them"). His picks: a
// card on the Email tab plus a one-page report; two numbers for "has an email"
// (anyone's, and a buyer's); only the brands we're not talking to; websites
// Claude finds come to him as a list before they're saved.
//
// Pure rules, no database: the handlers (emailCoverage, stageBrandWebsites …
// in src/app/api/data/route.ts) read the brands and hand them here.
//   node scripts/test-email-coverage.mjs
import { isBuyerTitle } from './buyers'
import { websiteDomain } from './duplicates'
import { companyDomain, type BrandSpot } from './find-emails'

// The brands the numbers cover: the ones cold email is for — every place on
// the Hunter card (find-emails.ts BrandSpot) except replied / in talks / said
// no (talking), a deal, show or board request (known), archived or set aside
// (off).
export const COLD_SPOTS: BrandSpot[] = ['list', 'ready', 'nobody', 'tooNew', 'emailed', 'waiting', 'held']
export const isCold = (spot: BrandSpot | null | undefined) => !!spot && COLD_SPOTS.includes(spot)

// One person on file. hunter = their address came from Hunter (the line a
// saved file leaves in their notes, or a person Hunter's search added).
export type CoverPerson = { title?: string | null; email?: string | null; hunter?: boolean; stopped?: boolean }
export type CoverBrand = {
  id: string; name: string; category?: string | null; spot: BrandSpot
  website?: string | null; linkedinUrl?: string | null
  parent?: string | null          // a label under a parent company (parents.ts): its people mail from there
  people: CoverPerson[]
}

// How Hunter can look a brand up: by a domain we hold (its website, or the
// one its people already mail from), under its parent company's name, or by
// its own name alone — which finds the fewest.
export type FindBy = 'domain' | 'parent' | 'name'

// One brand, counted.
export type CoverRow = {
  id: string; name: string; category: string | null
  people: number; emails: number; buyerEmails: number
  hunterOnly: boolean             // every address there came from Hunter
  buyerHunterOnly: boolean        // … every buyer's address did
  website: string | null          // the saved website's domain
  mailDomain: string | null       // no website saved, but the domain their people mail from
  linkedin: boolean               // a LinkedIn page is saved
  parent: string | null
  find: FindBy
}

export function coverRow(b: CoverBrand): CoverRow {
  const people = (b.people ?? []).filter(p => !p.stopped)
  const mail = people.filter(p => !!String(p.email ?? '').trim())
  const buyers = mail.filter(p => isBuyerTitle(p.title))
  const site = websiteDomain(b.website)
  const d = companyDomain({ website: b.website, emails: mail.map(p => p.email) })
  const mailDomain = !site && d.from === 'emails' ? d.domain : null
  // The Hunter card's own rule (findEmailPeople's coOf): a label with no
  // address of its own goes by its parent's name.
  const find: FindBy = b.parent && d.from !== 'emails' ? 'parent' : d.domain ? 'domain' : 'name'
  return {
    id: b.id, name: b.name, category: b.category || null,
    people: people.length, emails: mail.length, buyerEmails: buyers.length,
    hunterOnly: mail.length > 0 && mail.every(p => !!p.hunter),
    buyerHunterOnly: buyers.length > 0 && buyers.every(p => !!p.hunter),
    website: site, mailDomain, linkedin: !!String(b.linkedinUrl ?? '').trim(), parent: b.parent || null, find,
  }
}

export type CoverNumbers = {
  brands: number
  email: number                   // at least one person there has an email
  emailHunter: number             // … only thanks to Hunter
  buyerEmail: number              // … and it's a buyer's (partnerships, events, marketing, founder)
  buyerHunter: number
  noEmail: number
  noEmailPeople: number           // nobody's email, but people on file to look up
  noEmailNobody: number           // nobody on file at all
  website: number
  noWebsite: number
  noWebsiteMail: number           // no website saved; their people's addresses give the domain
  noWebsitePage: number           // only a LinkedIn page to go by
  noWebsiteNothing: number        // the name alone
  // The brands with no email, by how Hunter can look them up.
  findDomain: number; findParent: number; findName: number
  people: number; emails: number
}

export const emptyNumbers = (): CoverNumbers => ({
  brands: 0, email: 0, emailHunter: 0, buyerEmail: 0, buyerHunter: 0, noEmail: 0, noEmailPeople: 0, noEmailNobody: 0,
  website: 0, noWebsite: 0, noWebsiteMail: 0, noWebsitePage: 0, noWebsiteNothing: 0, findDomain: 0, findParent: 0, findName: 0,
  people: 0, emails: 0,
})

export function addRow(n: CoverNumbers, r: CoverRow): CoverNumbers {
  n.brands += 1
  n.people += r.people
  n.emails += r.emails
  if (r.emails) {
    n.email += 1
    if (r.hunterOnly) n.emailHunter += 1
    if (r.buyerEmails) { n.buyerEmail += 1; if (r.buyerHunterOnly) n.buyerHunter += 1 }
  } else {
    n.noEmail += 1
    if (r.people) n.noEmailPeople += 1
    else n.noEmailNobody += 1
    if (r.find === 'domain') n.findDomain += 1
    else if (r.find === 'parent') n.findParent += 1
    else n.findName += 1
  }
  if (r.website) n.website += 1
  else {
    n.noWebsite += 1
    if (r.mailDomain) n.noWebsiteMail += 1
    else if (r.linkedin) n.noWebsitePage += 1
    else n.noWebsiteNothing += 1
  }
  return n
}

export const countRows = (rows: CoverRow[]): CoverNumbers => rows.reduce(addRow, emptyNumbers())

// Who's left out of the numbers, and why (the rest of the roster).
export type LeftOut = { talking: number; known: number; off: number; other: number }

export type Coverage = {
  n: CoverNumbers
  rows: CoverRow[]                                  // the brands counted, best covered last
  byCategory: Array<{ key: string; n: CoverNumbers }>   // '' = no category; biggest first
  out: LeftOut
  total: number                                     // every brand on the roster
}

export function coverage(brands: CoverBrand[]): Coverage {
  const rows: CoverRow[] = []
  const out: LeftOut = { talking: 0, known: 0, off: 0, other: 0 }
  for (const b of brands) {
    if (isCold(b.spot)) { rows.push(coverRow(b)); continue }
    if (b.spot === 'talking') out.talking += 1
    else if (b.spot === 'known') out.known += 1
    else if (b.spot === 'off') out.off += 1
    else out.other += 1
  }
  rows.sort((x, y) => x.name.localeCompare(y.name))
  const cats = new Map<string, CoverNumbers>()
  for (const r of rows) addRow(cats.get(r.category || '') ?? cats.set(r.category || '', emptyNumbers()).get(r.category || '')!, r)
  const byCategory = [...cats].map(([key, n]) => ({ key, n })).sort((x, y) => y.n.brands - x.n.brands || x.key.localeCompare(y.key))
  return { n: countRows(rows), rows, byCategory, out, total: brands.length }
}

// ---- marks: the numbers on a day, kept ---------------------------------
//
// One line each time something moves them — a Hunter file saved, a list of
// websites saved — and whenever one is asked for by hand (the start). The
// card and the report read "then → now" from them.
export const MARKS_KEY = 'emailCoverageMarks'
export const MARKS_KEEP = 40
export type MarkWhy = 'start' | 'file' | 'websites' | 'mark'
export type Mark = { at: string; by: string | null; why: MarkWhy; label: string; n: Pick<CoverNumbers, 'brands' | 'email' | 'buyerEmail' | 'noEmail' | 'website' | 'noWebsite' | 'emails'> }

export const markNumbers = (n: CoverNumbers): Mark['n'] =>
  ({ brands: n.brands, email: n.email, buyerEmail: n.buyerEmail, noEmail: n.noEmail, website: n.website, noWebsite: n.noWebsite, emails: n.emails })

export function cleanMarks(v: unknown): Mark[] {
  const list = Array.isArray(v) ? v : []
  return list.filter((m: any) => m && typeof m.at === 'string' && m.n && typeof m.n.brands === 'number').map((m: any) => ({
    at: m.at, by: m.by ?? null, why: (['start', 'file', 'websites', 'mark'].includes(m.why) ? m.why : 'mark') as MarkWhy,
    label: String(m.label ?? '').slice(0, 120), n: markNumbers({ ...emptyNumbers(), ...m.n }),
  }))
}

// A new mark on the end; the first one (the start) is never dropped.
export function addMark(marks: Mark[], m: Mark): Mark[] {
  const all = [...marks, m]
  return all.length > MARKS_KEEP ? [all[0], ...all.slice(all.length - (MARKS_KEEP - 1))] : all
}

// ---- websites waiting for Leo's yes ------------------------------------
//
// A Claude session's finds (the open web, never a paid lookup) wait here until
// he has seen them: nothing is saved on a brand before that.
export const STAGED_KEY = 'brandWebsitesStaged'
// search = found on the web this round · unsure = found, but not confirmed
// (one old listing, a name that could be another company) · memory = a
// well-known brand, not looked up · emails = the domain its people already
// mail from. The card ticks only the sure ones (isSure).
export type StagedHow = 'search' | 'unsure' | 'memory' | 'emails'
const HOWS: StagedHow[] = ['search', 'unsure', 'memory', 'emails']
export const isSure = (how: StagedHow) => how === 'search' || how === 'emails'
export type StagedSite = { brandId: string; website: string; how: StagedHow; note: string; at: string; by: string | null }
export type StagedState = { rows: StagedSite[]; no: Record<string, string[]> }   // no = websites turned down, per brand

export const HOW_WORDS: Record<StagedHow, string> = {
  search: 'Found on the web', unsure: 'Found on the web — not confirmed', memory: 'A well-known brand — not looked up', emails: 'Their people’s email addresses',
}

// Not a company's own site.
const NOT_A_SITE = /(^|\.)(instagram|facebook|tiktok|linkedin|twitter|x|youtube|amazon|linktr|wikipedia|crunchbase|shopify|myshopify|google)\.(com|ee|org)$/
export const siteDomain = (v: unknown): string | null => {
  const d = websiteDomain(String(v ?? ''))
  return d && !NOT_A_SITE.test(d) ? d : null
}

export function cleanStaged(v: unknown): StagedState {
  const o = (v && typeof v === 'object' ? v : {}) as any
  const rows: StagedSite[] = (Array.isArray(o.rows) ? o.rows : [])
    .filter((r: any) => r && typeof r.brandId === 'string' && siteDomain(r.website))
    .map((r: any) => ({
      brandId: r.brandId, website: siteDomain(r.website) as string, how: (HOWS.includes(r.how) ? r.how : 'search') as StagedHow,
      note: String(r.note ?? '').slice(0, 200), at: String(r.at ?? ''), by: r.by ?? null,
    }))
  const no: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(o.no && typeof o.no === 'object' ? o.no : {})) {
    const ds = (Array.isArray(list) ? list : []).map(siteDomain).filter(Boolean) as string[]
    if (ds.length) no[k] = [...new Set(ds)].slice(0, 12)
  }
  return { rows, no }
}

export type StageAction = 'staged' | 'has' | 'bad' | 'unknown' | 'twice' | 'no'
export type StageLine = { brandId: string; name: string; website: string; action: StageAction; why: string }

// What a new list does to the waiting ones. A brand's newer find replaces its
// older one; never a brand that has a website by now, a link that isn't a
// company's site, a brand that isn't on file, or a website Leo already turned
// down for that brand.
export function planStage(
  state: StagedState,
  list: Array<{ brandId?: unknown; website?: unknown; how?: unknown; note?: unknown }>,
  ctx: { brands: Map<string, { name: string; website: string | null }>; at: string; by: string | null },
): { state: StagedState; lines: StageLine[]; counts: Record<StageAction, number> } {
  const lines: StageLine[] = []
  const add = new Map<string, StagedSite>()
  for (const r of list) {
    const id = String(r?.brandId ?? '')
    const b = ctx.brands.get(id)
    const d = siteDomain(r?.website)
    const base = { brandId: id, name: b?.name ?? '', website: d ?? String(r?.website ?? '') }
    if (!b) { lines.push({ ...base, action: 'unknown', why: 'Not a brand on the dashboard' }); continue }
    if (add.has(id)) { lines.push({ ...base, action: 'twice', why: 'In the list twice — the first is used' }); continue }
    if (!d) { lines.push({ ...base, action: 'bad', why: 'Not a company website' }); continue }
    if (String(b.website ?? '').trim()) { lines.push({ ...base, action: 'has', why: 'Already has a website' }); continue }
    if ((state.no[id] ?? []).includes(d)) { lines.push({ ...base, action: 'no', why: 'Turned down for this brand before' }); continue }
    const how = (HOWS.includes(String(r?.how) as StagedHow) ? String(r?.how) : 'search') as StagedHow
    add.set(id, { brandId: id, website: d, how, note: String(r?.note ?? '').slice(0, 200), at: ctx.at, by: ctx.by })
    lines.push({ ...base, action: 'staged', why: '' })
  }
  // The ones already waiting stay unless this list has a newer find for the
  // brand, or the brand got a website (or left the roster) meanwhile.
  const kept = state.rows.filter(r => !add.has(r.brandId) && ctx.brands.has(r.brandId) && !String(ctx.brands.get(r.brandId)!.website ?? '').trim())
  const counts = { staged: 0, has: 0, bad: 0, unknown: 0, twice: 0, no: 0 } as Record<StageAction, number>
  for (const l of lines) counts[l.action] += 1
  return { state: { rows: [...kept, ...add.values()], no: state.no }, lines, counts }
}

// Leo's "not theirs": off the list, and that website isn't offered for the
// brand again.
export function dropStaged(state: StagedState, brandIds: string[]): { state: StagedState; dropped: StagedSite[] } {
  const ids = new Set(brandIds)
  const dropped = state.rows.filter(r => ids.has(r.brandId))
  const no = { ...state.no }
  for (const r of dropped) no[r.brandId] = [...new Set([...(no[r.brandId] ?? []), r.website])].slice(-12)
  return { state: { rows: state.rows.filter(r => !ids.has(r.brandId)), no }, dropped }
}

// The ones still waiting: the brand is on file and still has no website.
export function waiting(state: StagedState, brands: Map<string, { name: string; website: string | null }>): Array<StagedSite & { name: string }> {
  return state.rows
    .filter(r => brands.has(r.brandId) && !String(brands.get(r.brandId)!.website ?? '').trim())
    .map(r => ({ ...r, name: brands.get(r.brandId)!.name }))
    .sort((x, y) => x.name.localeCompare(y.name))
}
