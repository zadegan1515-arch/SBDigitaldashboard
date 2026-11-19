// src/lib/remove-people.ts
//
// Taking people off a brand for good (Leo, Nov 18 2026: the nicotine pouch
// brand Rogue had seven people from Rogue Fitness, another company, on it —
// "remove them"). Until then the only ways a person left a brand were a
// merge, a move, or the LinkedIn clean-up of titles the rules leave out.
//
// Pure here: who may go, who stays and why, the stamp a confirm must carry,
// and what is kept so the removal can be put back. /api/data reads and
// writes. node scripts/test-remove-people.mjs
//
// Never removed:
//   - someone who said they don't want to continue (the "no" has to stay on
//     file, or the same person could be added and written to again);
//   - someone already written to (an invite, a message, an email, a reply,
//     a call) — that history is what the brand's Reached tag, Results and
//     the tracker read;
//   - someone on Elizabeth's list or handed to Instantly.
// Those are set aside by other means (Doesn't want to continue, Shelve).

export type RemoveRow = {
  id: string
  name: string
  title: string | null
  doNotContactAt: Date | string | null
  repOutreach: number          // Elizabeth's rows for this person
  targets: Array<{
    status: string
    sentAt: Date | string | null
    emailedAt: Date | string | null
    dmSentAt: Date | string | null
    repliedAt: Date | string | null
    handDeclinedAt: Date | string | null
    callAt: Date | string | null
    callBookedAt: Date | string | null
    emails: number             // emails drafted, sent or received on the row
    instantly: boolean         // handed to an Instantly campaign
    drafts: number             // LinkedIn drafts written for them
    shelved: boolean
  }>
}

export type StayWhy = 'stopped' | 'reached' | 'call' | 'emails' | 'instantly' | 'elizabeth'

const REACHED = new Set(['sent', 'accepted', 'replied', 'converted', 'declined', 'dead', 'withdrawn'])

// Why this person can't be removed, or null when they can.
export function stayWhy(p: RemoveRow): StayWhy | null {
  if (p.doNotContactAt || p.targets.some(t => t.handDeclinedAt)) return 'stopped'
  if (p.targets.some(t => t.callAt || t.callBookedAt)) return 'call'
  if (p.targets.some(t => t.sentAt || t.dmSentAt || t.repliedAt || t.emailedAt || REACHED.has(t.status))) return 'reached'
  if (p.targets.some(t => t.instantly)) return 'instantly'
  if (p.targets.some(t => t.emails > 0)) return 'emails'
  if (p.repOutreach > 0) return 'elizabeth'
  return null
}

export const STAY_TEXT: Record<StayWhy, string> = {
  stopped: 'said they don’t want to continue — that stays on file',
  reached: 'already reached out to — the history stays',
  call: 'has a call booked or held',
  emails: 'has emails on file',
  instantly: 'handed to an Instantly campaign',
  elizabeth: 'on Elizabeth’s list',
}

// Where a person who can go stands, in words for the preview.
export function standingText(p: RemoveRow): string {
  const t = p.targets[0]
  if (!t) return 'not in the queue'
  if (t.status === 'passed') return 'left out of the queue'
  if (t.shelved) return 'next in line'
  const drafts = p.targets.reduce((n, x) => n + x.drafts, 0)
  return drafts ? 'in the queue, note drafted' : 'in the queue'
}

// Sorted into who goes and who stays. Ids asked for that aren't at the
// brand are the caller's to name (`missing`).
export function sortRemoval(asked: string[], rows: RemoveRow[]) {
  const byId = new Map(rows.map(r => [r.id, r]))
  const ids = Array.from(new Set(asked.map(String)))
  const go: Array<{ id: string; name: string; title: string | null; standing: string; drafts: number }> = []
  const stay: Array<{ id: string; name: string; title: string | null; why: StayWhy; text: string }> = []
  const missing: string[] = []
  for (const id of ids) {
    const p = byId.get(id)
    if (!p) { missing.push(id); continue }
    const why = stayWhy(p)
    if (why) stay.push({ id: p.id, name: p.name, title: p.title, why, text: STAY_TEXT[why] })
    else go.push({ id: p.id, name: p.name, title: p.title, standing: standingText(p), drafts: p.targets.reduce((n, x) => n + x.drafts, 0) })
  }
  return { go, stay, missing }
}

// The stamp of a preview: the brand and exactly who would go. A confirm
// carrying another stamp is stale (someone was written to since, or the
// list changed) and is shown again instead of applied.
export function removalSig(brandId: string, go: Array<{ id: string }>): string {
  return JSON.stringify([brandId, go.map(g => g.id).sort()])
}

// What is kept of each person so Undo can put them back.
export type Removed = {
  name: string
  title: string | null
  email: string | null
  phone: string | null
  location: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  source: string
  externalId: string | null
  isDecisionMaker: boolean
  notes: string | null
  createdAt: string
  // Their place in the queue, when they had one. Drafts aren't kept: they
  // are written again from the templates.
  target: { fitScore: number; assignedTo: string | null; passed: boolean; shelved: boolean; shelvedHow: string | null } | null
}

export type RemovalLog = { at: string; by: string; brandId: string; brandName: string; people: Removed[]; undone?: string }

export function readRemovalLog(v: unknown): RemovalLog | null {
  const x = v as any
  if (!x || typeof x !== 'object' || typeof x.brandId !== 'string' || !Array.isArray(x.people)) return null
  return x as RemovalLog
}

// Undo only puts back someone who isn't on the brand again already: the
// same LinkedIn profile, or the same name with no link to compare.
export function alreadyBack(p: Pick<Removed, 'name' | 'linkedinUrl'>, now: Array<{ name: string; linkedinUrl: string | null }>, slug: (u: string | null) => string | null): boolean {
  const s = slug(p.linkedinUrl)
  const name = p.name.trim().toLowerCase()
  return now.some(c => {
    const cs = slug(c.linkedinUrl)
    if (s && cs) return s === cs
    return c.name.trim().toLowerCase() === name
  })
}
