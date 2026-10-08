// src/lib/same-person.ts
//
// The same person filed twice at one brand (Leo, Oct 8 2026, combining
// Diageo's brands: "merge if two people appear"). Ari Anderman came in
// once from SponsorUnited under Don Julio (work email, an older title,
// LinkedIn's default link) and once from the LinkedIn fill under Ketel
// One (his custom link, today's title, invited) — one person, two rows.
//
// Who counts as the same person, at one brand: the same LinkedIn profile,
// the same full name, or the same personal email with names that agree
// ("R. Zalis" / "Rachel Zalis") — unless both rows carry an email and the
// two differ (two people who share a name). A shared inbox
// (partnerships@, info@…) never makes two rows one person. A LinkedIn link
// alone never separates them: people change their link, as Ari did. A
// one-word name never matches by name. Leo can say two rows aren't the
// same person (Setting "peopleNotSame", pairKey); that pair never matches.
//
// Pure here; /api/data does the writes (combineParent, mergePeople).
// node scripts/test-same-person.mjs

export type PersonRow = {
  id: string
  name: string
  title?: string | null
  email?: string | null
  phone?: string | null
  location?: string | null
  linkedinUrl?: string | null
  twitterUrl?: string | null
  externalId?: string | null
  source?: string | null
  isDecisionMaker?: boolean | null
  notes?: string | null
  createdAt?: string | Date | null
  // The person's outreach row, when there is one (one per contact).
  target?: { id: string; status: string; sentAt?: string | Date | null } | null
}

export function personNameKey(name: unknown): string {
  const k = String(name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s'-]+/g, ' ').replace(/['-]/g, '').replace(/\s+/g, ' ').trim()
  return k.split(' ').length >= 2 ? k : ''
}

export function linkedinSlug(url: unknown): string {
  const m = String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i)
  if (!m) return ''
  try { return decodeURIComponent(m[1]).toLowerCase() } catch { return m[1].toLowerCase() }
}

const emailKey = (e: unknown) => String(e ?? '').trim().toLowerCase()

// A team inbox, not a person's address.
const ROLE_INBOX = /^(info|hello|hi|contact|team|partners?|partnerships?|sponsors?|sponsorships?|marketing|events?|press|media|pr|sales|support|admin|office|collabs?|collaborations?|brand|brands|hr|careers|jobs|social|influencers?|ambassadors?|community|general|inquiries|enquiries|hey)@/
export const isRoleInbox = (e: unknown) => ROLE_INBOX.test(emailKey(e))

// The two names could be one person's: the same name, or the same last
// name with the same first initial ("R. Zalis", "Rachel Zalis").
function namesAgree(a: unknown, b: unknown): boolean {
  const x = personNameKey(a), y = personNameKey(b)
  if (!x || !y) return false
  if (x === y) return true
  const xs = x.split(' '), ys = y.split(' ')
  return xs[xs.length - 1] === ys[ys.length - 1] && xs[0][0] === ys[0][0]
}

// The key Leo's "not the same person" is kept under.
export const pairKey = (a: string, b: string) => [a, b].sort().join('|')

// Two rows are one person (see the top of the file).
export function samePerson(a: PersonRow, b: PersonRow, notSame?: Set<string> | null): boolean {
  if (notSame && notSame.has(pairKey(a.id, b.id))) return false
  const ea = emailKey(a.email), eb = emailKey(b.email)
  if (ea && eb && ea !== eb) return false
  const sa = linkedinSlug(a.linkedinUrl), sb = linkedinSlug(b.linkedinUrl)
  if (sa && sa === sb) return true
  if (ea && ea === eb && !ROLE_INBOX.test(ea) && namesAgree(a.name, b.name)) return true
  const na = personNameKey(a.name)
  return !!na && na === personNameKey(b.name)
}

// The rows at one brand that are one person, in groups of two or more.
// A group is only offered when every pair in it is the same person (three
// "Chris Lee"s where two have different emails are left alone).
export function samePeopleGroups<T extends PersonRow>(rows: T[], notSame?: Set<string> | null): T[][] {
  const parent = rows.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (samePerson(rows[i], rows[j], notSame)) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, T[]>()
  rows.forEach((r, i) => {
    const k = find(i)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  })
  // Through a third row, two rows can join that are plainly two people
  // (their own different emails, or Leo said so): the group is left alone.
  return [...groups.values()].filter(g => g.length > 1 && g.every((a, i) => g.every((b, j) =>
    i === j || samePerson(a, b, notSame) ||
    !((emailKey(a.email) && emailKey(b.email)) || (notSame && notSame.has(pairKey(a.id, b.id)))))))
}

// How far along a person's outreach is: the row that has gone furthest is
// the one kept (an invite is never undone by a merge), and a decision
// outranks a row merely waiting — "they said no" (declined, dead) or Leo
// passing on the person is never replaced by a queued copy.
const RANK: Record<string, number> = {
  converted: 9, replied: 8, declined: 7, accepted: 6, dead: 5.5, sent: 5, withdrawn: 4, passed: 3, drafted: 2, queued: 1,
}
export function targetRank(t: PersonRow['target']): number {
  if (!t) return 0
  return Math.max(RANK[t.status] ?? 0, t.sentAt ? RANK.sent : 0)
}

// The row that stays: the furthest outreach, then the one with a LinkedIn
// link (the queue works from it), then the newest (the freshest title).
export function pickKeeper<T extends PersonRow>(group: T[]): T {
  const time = (r: T) => (r.createdAt ? new Date(r.createdAt).getTime() : 0)
  return [...group].sort((a, b) =>
    targetRank(b.target) - targetRank(a.target) ||
    Number(!!linkedinSlug(b.linkedinUrl)) - Number(!!linkedinSlug(a.linkedinUrl)) ||
    time(b) - time(a))[0]
}

const FILL = ['email', 'phone', 'location', 'linkedinUrl', 'twitterUrl', 'externalId'] as const
export type MergeFields = Partial<Pick<PersonRow, (typeof FILL)[number] | 'title' | 'notes' | 'isDecisionMaker'>>

// What the kept row takes from the other: anything it's missing, and a
// note of what didn't fit (another title, another LinkedIn link) so
// nothing on file is lost. `day` = when, for the note.
export function mergeFields(keep: PersonRow, drop: PersonRow, day: string): { data: MergeFields; lines: string[] } {
  const data: MergeFields = {}
  const lines: string[] = []
  for (const k of FILL) if (!keep[k] && drop[k]) data[k] = drop[k] as any
  if (!keep.title && drop.title) data.title = drop.title
  else if (drop.title && keep.title && drop.title.trim().toLowerCase() !== keep.title.trim().toLowerCase()) {
    lines.push(`also on file as “${drop.title.trim()}”${drop.source ? ` (${drop.source})` : ''}`)
  }
  const ks = linkedinSlug(keep.linkedinUrl), ds = linkedinSlug(drop.linkedinUrl)
  if (ks && ds && ks !== ds) lines.push(`other LinkedIn link ${drop.linkedinUrl}`)
  if (personNameKey(drop.name) !== personNameKey(keep.name) && String(drop.name ?? '').trim()) lines.push(`also on file as name “${String(drop.name).trim()}”`)
  // A second phone, city, X link or SponsorUnited id: kept in the note.
  const other: [keyof PersonRow, string][] = [['phone', 'other phone'], ['location', 'also listed in'], ['twitterUrl', 'other X link'], ['externalId', 'other SponsorUnited id']]
  for (const [k, label] of other) {
    const kv = String(keep[k] ?? '').trim(), dv = String(drop[k] ?? '').trim()
    if (kv && dv && kv.toLowerCase() !== dv.toLowerCase()) lines.push(`${label} ${dv}`)
  }
  if (drop.isDecisionMaker && !keep.isDecisionMaker) data.isDecisionMaker = true
  const dropNotes = String(drop.notes ?? '').trim()
  const keepNotes = String(keep.notes ?? '').trim()
  const parts = [keepNotes]
  if (dropNotes && !keepNotes.includes(dropNotes)) parts.push(dropNotes)
  if (lines.length) parts.push(`Merged with a second copy ${day}: ${lines.join('; ')}.`)
  const notes = parts.filter(Boolean).join('\n')
  if (notes !== keepNotes) data.notes = notes || null
  return { data, lines }
}
