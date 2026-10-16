// src/lib/do-not-contact.ts
//
// "Doesn't want to continue" (Leo, Oct 15 2026: "some people respond but i
// want to make sure we dont reach out to them again"). On Zach's list the
// step asks: just this person, or the whole brand.
//   · just them   → Contact.doNotContactAt: never invited, DM'd, followed up,
//                   emailed or queued again, by the system or by hand.
//   · whole brand → Brand.stoppedAt (+ archived, do-not-email): nobody there.
// Only the step's own Undo takes either back.
//
// The flag sits on the person's Contact and goes with it (moves, merges).
// A second copy of the same person — re-captured under another LinkedIn link
// form, re-imported with a new title, added again by hand — is a different
// Contact, so every place that adds or picks people also asks `stoppedMatch`:
// the same LinkedIn profile or personal email anywhere, or the same full
// name at the same brand. Pure — node scripts/test-do-not-contact.mjs

import { personNameKey, linkedinSlug, isRoleInbox } from './same-person'

export type StopPerson = { id?: string; brandId: string; name: string; linkedinUrl?: string | null; email?: string | null; at?: Date | string | null }
export type StopIndex = { slugs: Map<string, StopPerson>; emails: Map<string, StopPerson>; names: Map<string, StopPerson> }

const emailOf = (e: unknown) => {
  const x = String(e ?? '').trim().toLowerCase()
  return x && x.includes('@') && !isRoleInbox(x) ? x : ''
}

export function stopIndex(people: StopPerson[]): StopIndex {
  const ix: StopIndex = { slugs: new Map(), emails: new Map(), names: new Map() }
  for (const p of people) {
    const s = linkedinSlug(p.linkedinUrl)
    if (s && !ix.slugs.has(s)) ix.slugs.set(s, p)
    const e = emailOf(p.email)
    if (e && !ix.emails.has(e)) ix.emails.set(e, p)
    const n = personNameKey(p.name)
    if (n && p.brandId && !ix.names.has(p.brandId + '|' + n)) ix.names.set(p.brandId + '|' + n, p)
  }
  return ix
}

// The person who said no that this row is, or null. `brandId` is where the
// row is (or would go); a name only counts at the same brand — two people
// called Sam Lee at two companies aren't one.
export function stoppedMatch(ix: StopIndex, c: { brandId?: string | null; name?: unknown; linkedinUrl?: unknown; email?: unknown }): StopPerson | null {
  const s = linkedinSlug(c.linkedinUrl)
  if (s && ix.slugs.has(s)) return ix.slugs.get(s)!
  const e = emailOf(c.email)
  if (e && ix.emails.has(e)) return ix.emails.get(e)!
  const n = personNameKey(c.name)
  if (n && c.brandId && ix.names.has(c.brandId + '|' + n)) return ix.names.get(c.brandId + '|' + n)!
  return null
}

// What to look a person's other copies up by (stopTwins in route.ts).
export function stopKeys(c: { linkedinUrl?: unknown; email?: unknown }): { slug: string; email: string } {
  return { slug: linkedinSlug(c.linkedinUrl), email: emailOf(c.email) }
}

const dayWords = (at: Date | string | null | undefined) => {
  const d = at ? new Date(at) : null
  return d && !isNaN(d.getTime()) ? ' (' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + ')' : ''
}
// What a refusal says.
export function stopWords(who: { name?: string | null; at?: Date | string | null }, brand?: string | null): string {
  return brand
    ? `${brand} said they don't want to continue${dayWords(who.at)} — nobody there is contacted. Undo it on its page to reach out again.`
    : `${who.name || 'They'} said they don't want to continue${dayWords(who.at)} — never contacted again. Undo it on Zach's list or the brand page to reach out again.`
}
