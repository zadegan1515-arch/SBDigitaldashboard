// src/lib/li-log-db.ts
//
// The writes behind logging a LinkedIn person by hand (the rules are in
// li-log.ts). Shared by /api/data (Zach's list, the brand page) and
// /api/ingest (the SB pill on a LinkedIn profile), so all three log the
// same way: one step to "invite sent" or "accepted", never through a
// day's queue.

import type { PrismaClient, TargetStatus } from '@prisma/client'
import { cleanName, profileSlug, profileUrl } from './li-capture'
import { findOnFile, isLogStage, logChoices, logWrite, nameFromSlug, type LogStage } from './li-log'

type Db = PrismaClient

// The queue's own fit score and decision-maker test, passed in by the
// route so a logged person scores exactly like a queued one.
export type LogHelpers = {
  fit: (title: string | null, tier: string | null) => number
  decisionMaker: (title: string | null) => boolean
}

// Someone already on file, as a lookup shows them.
export type OnFilePerson = {
  contactId: string
  name: string
  title: string | null
  linkedinUrl: string | null
  brand: { id: string; name: string; archived: boolean }
  targetId: string | null
  status: string | null
  sentAt: Date | null
  choices: LogStage[]
  by: 'link' | 'name'
}

const PERSON_SELECT = {
  id: true, name: true, title: true, linkedinUrl: true, brandId: true,
  brand: { select: { id: true, name: true, passedAt: true } },
  targets: { select: { id: true, status: true, sentAt: true }, take: 1 },
} as const

function toPerson(c: any, by: 'link' | 'name'): OnFilePerson {
  const t = c.targets?.[0] ?? null
  return {
    contactId: c.id,
    name: c.name,
    title: c.title ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    brand: { id: c.brand.id, name: c.brand.name, archived: !!c.brand.passedAt },
    targetId: t?.id ?? null,
    status: t?.status ?? null,
    sentAt: t?.sentAt ?? null,
    choices: logChoices(t?.status ?? null),
    by,
  }
}

// Stored links vary ("…/in/Jane-Doe-12ab/?trk=…", accents written as
// %C3%A9), so a slug is looked for in both spellings.
function slugWhere(slug: string) {
  const forms = Array.from(new Set([slug, encodeURIComponent(slug)]))
  return { OR: forms.map(f => ({ linkedinUrl: { contains: '/in/' + f, mode: 'insensitive' as const } })) }
}

// Who a pasted profile link or a typed name could be, among everyone on
// file. A link gives its own name guess for the "not on file" form.
export async function findLinkedInPeople(db: Db, q: unknown, take = 8) {
  const query = String(q ?? '').trim().slice(0, 300)
  const slug = profileSlug(query)
  if (slug) {
    const rows = await db.contact.findMany({ where: slugWhere(slug), select: PERSON_SELECT, take: 20 })
    // `contains` also finds "jane-doe-12ab" inside "jane-doe-12abc".
    const people = rows.filter(c => profileSlug(c.linkedinUrl) === slug).slice(0, take).map(c => toPerson(c, 'link'))
    return { slug, url: profileUrl(slug), nameGuess: nameFromSlug(slug), people }
  }
  if (/linkedin\.com/i.test(query)) return { slug: null, url: null, nameGuess: null, people: [], notProfile: true }
  const words = query.split(/\s+/).filter(w => w.length >= 2).slice(0, 4)
  if (!words.length) return { slug: null, url: null, nameGuess: null, people: [] }
  const rows = await db.contact.findMany({
    where: { AND: words.map(w => ({ name: { contains: w, mode: 'insensitive' as const } })) },
    select: PERSON_SELECT,
    orderBy: { name: 'asc' },
    take,
  })
  return { slug: null, url: null, nameGuess: cleanName(query), people: rows.map(c => toPerson(c, 'name')) }
}

// The one person a profile is, if they're on file: by profile link
// anywhere, else by name at the brand they'd go under (people from
// SponsorUnited often have no LinkedIn link saved).
export async function personOnFile(
  db: Db,
  want: { url?: string | null; name?: string | null; brandId?: string | null },
): Promise<OnFilePerson | null> {
  const slug = profileSlug(want.url)
  if (!slug && !want.brandId) return null
  const pool = await db.contact.findMany({
    where: { OR: [...(slug ? [slugWhere(slug)] : []), ...(want.brandId ? [{ brandId: want.brandId }] : [])] },
    select: PERSON_SELECT,
    take: 300,
  })
  const hit = findOnFile(pool, want)
  return hit ? toPerson(hit.contact, hit.by) : null
}

export type LogInput = {
  // Someone on file (a lookup row, a brand page card) …
  contactId?: string | null
  // … or someone new, at this brand.
  brandId?: string | null
  name?: string | null
  title?: string | null
  linkedinUrl?: string | null
  email?: string | null
  phone?: string | null
  location?: string | null
  notes?: string | null
  stage: unknown
  actor?: string | null
}

// Enough to take one log back (undoLinkedInLog).
export type LogUndo = {
  targetId: string
  stage: LogStage
  // The row as it was, or null when the log made the row.
  before: { status: string; sentAt: string | null; queuedFor: string | null; shelved: boolean } | null
  madeContact: boolean
}

export type LogResult = {
  contactId: string
  targetId: string
  name: string
  brand: { id: string; name: string }
  status: string
  madeContact: boolean
  // Why nothing changed ("already-accepted"…), or null.
  noop: string | null
  undo: LogUndo | null
}

// The checks a new person must pass, run before anything is written — a
// new brand is only made once the person going under it is sound.
export function checkNewPerson(input: { name?: unknown; linkedinUrl?: unknown }): void {
  const rawUrl = String(input.linkedinUrl ?? '').trim()
  const slug = profileSlug(rawUrl)
  if (rawUrl && !slug) throw new Error('That LinkedIn link isn’t a person’s profile (linkedin.com/in/…).')
  if (!cleanName(input.name as string) && !(slug && nameFromSlug(slug))) throw new Error('Name required')
}

function clip(v: unknown, n: number): string | null {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, n) : null
}

export async function logLinkedInPerson(db: Db, input: LogInput, h: LogHelpers): Promise<LogResult> {
  if (!isLogStage(input.stage)) throw new Error('Pick “Invite sent” or “They accepted”.')
  const stage = input.stage
  const include = { brand: true, targets: true } as const

  let contact = input.contactId
    ? await db.contact.findUnique({ where: { id: String(input.contactId) }, include })
    : null
  if (input.contactId && !contact) throw new Error('Person not found')
  let madeContact = false

  if (!contact) {
    const brandId = String(input.brandId || '')
    if (!brandId) throw new Error('Pick the brand first.')
    const brand = await db.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')
    checkNewPerson(input)
    const rawUrl = String(input.linkedinUrl || '').trim()
    const slug = profileSlug(rawUrl)
    const name = cleanName(input.name) ?? (slug ? nameFromSlug(slug) : null)
    if (!name) throw new Error('Name required')
    const title = clip(input.title, 200)

    // Already on file? The same profile link anywhere, or the same name
    // at this brand — never a second copy of them.
    const pool = await db.contact.findMany({
      where: { OR: [{ brandId }, ...(slug ? [slugWhere(slug)] : [])] },
      select: { id: true, brandId: true, name: true, linkedinUrl: true },
    })
    const found = findOnFile(pool, { url: rawUrl, name, brandId })
    if (found && found.contact.brandId !== brandId) {
      const at = await db.brand.findUnique({ where: { id: found.contact.brandId }, select: { name: true } })
      throw new Error(`${found.contact.name} is already on file at ${at?.name ?? 'another brand'}. Log them there — or, if they moved, use “They moved company →” on their card.`)
    }
    if (found) {
      contact = await db.contact.findUnique({ where: { id: found.contact.id }, include })
      // Fill what's missing; never overwrite what someone typed before.
      const fill: { title?: string; linkedinUrl?: string } = {}
      if (contact && title && !contact.title) fill.title = title
      if (contact && slug && !contact.linkedinUrl) fill.linkedinUrl = profileUrl(slug)
      if (contact && Object.keys(fill).length) {
        contact = await db.contact.update({ where: { id: contact.id }, data: fill, include })
      }
    } else {
      contact = await db.contact.create({
        data: {
          brandId,
          name,
          title,
          linkedinUrl: slug ? profileUrl(slug) : null,
          email: clip(input.email, 200),
          phone: clip(input.phone, 60),
          location: clip(input.location, 120),
          notes: clip(input.notes, 4000),
          isDecisionMaker: h.decisionMaker(title),
          source: 'manual',
        },
        include,
      })
      madeContact = true
    }
  }
  if (!contact) throw new Error('Person not found')

  const t = contact.targets[0] ?? null
  const w = logWrite(t && { status: t.status, sentAt: t.sentAt, queuedFor: t.queuedFor, shelved: t.shelved }, stage, new Date())
  const base = {
    contactId: contact.id,
    name: contact.name,
    brand: { id: contact.brand.id, name: contact.brand.name },
    madeContact,
  }
  if (w.kind === 'none') return { ...base, targetId: t!.id, status: w.status, noop: w.reason, undo: null }

  const before = t
    ? { status: t.status, sentAt: t.sentAt ? t.sentAt.toISOString() : null, queuedFor: t.queuedFor ? t.queuedFor.toISOString() : null, shelved: t.shelved }
    : null
  const target = w.kind === 'create'
    ? await db.target.create({
        data: {
          brandId: contact.brandId,
          contactId: contact.id,
          fitScore: h.fit(contact.title, contact.brand.tier),
          assignedTo: contact.brand.owner ?? null,
          ...w.data,
        },
      })
    : await db.target.update({ where: { id: t!.id }, data: w.data })
  // The audit trail, and for an accept the date Zach's list counts
  // "Text them on LinkedIn" from.
  await db.targetEvent.create({
    data: {
      targetId: target.id,
      kind: 'status',
      fromStatus: w.from,
      toStatus: w.to,
      actor: input.actor ?? null,
      detail: w.to === 'sent' ? 'Logged by hand: invite sent from LinkedIn'
        : target.sentAt ? 'Logged by hand: they accepted'
        : 'Logged by hand: accepted an invite sent outside the dashboard (no invite date)',
    },
  })
  return {
    ...base,
    targetId: target.id,
    status: target.status,
    noop: null,
    undo: { targetId: target.id, stage, before, madeContact },
  }
}

// Undo is for the log just made (the Undo bar lasts seconds), so anything
// older than this is refused rather than reversed.
const UNDO_WINDOW_MS = 30 * 60 * 1000
const STATUSES = ['queued', 'drafted', 'sent', 'accepted', 'withdrawn', 'passed', 'replied', 'converted', 'declined', 'dead']

// Takes one log back: the row as it was, or — when the log made the
// person — the person again. Only while nothing has happened since.
export async function undoLinkedInLog(db: Db, u: any, actor: string | null) {
  const targetId = String(u?.targetId || '')
  if (!targetId || !isLogStage(u?.stage)) throw new Error('Nothing to undo')
  const t = await db.target.findUnique({
    where: { id: targetId },
    include: { contact: true, events: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  if (!t) return { undone: true, name: null as string | null, removed: false }
  const last = t.events[0]
  const fresh = (d: Date) => Date.now() - d.getTime() < UNDO_WINDOW_MS
  if (t.status !== u.stage || !last || last.toStatus !== u.stage || !fresh(last.createdAt)) {
    throw new Error('Something changed since — undo it on the brand page instead.')
  }
  if (u.madeContact === true && t.contact.source === 'manual' && fresh(t.contact.createdAt)) {
    // Their row, its events and drafts go with them.
    await db.contact.delete({ where: { id: t.contactId } })
    return { undone: true, name: t.contact.name, removed: true }
  }
  const b = u.before
  if (!b) {
    if (!fresh(t.createdAt)) throw new Error('Something changed since — undo it on the brand page instead.')
    await db.target.delete({ where: { id: t.id } })
    return { undone: true, name: t.contact.name, removed: false }
  }
  if (!STATUSES.includes(String(b.status))) throw new Error('Nothing to undo')
  await db.target.update({
    where: { id: t.id },
    data: {
      status: b.status as TargetStatus,
      sentAt: b.sentAt ? new Date(b.sentAt) : null,
      queuedFor: b.queuedFor ? new Date(b.queuedFor) : null,
      shelved: !!b.shelved,
    },
  })
  await db.targetEvent.create({
    data: { targetId: t.id, kind: 'status', fromStatus: u.stage, toStatus: String(b.status), actor, detail: 'Log undone' },
  })
  return { undone: true, name: t.contact.name, removed: false }
}
