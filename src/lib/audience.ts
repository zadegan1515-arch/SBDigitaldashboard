// src/lib/audience.ts
//
// Audience module (sponsorship Phase 1): events, attendees, and the
// attendance join table. Public entry points (RSVP, check-in) are called
// from /api/public/* with strict input checks; everything else is called
// from the signed-in dashboard via /api/data.
//
// Rules this file enforces:
//  - Email is identity: every write goes through normalizeEmail.
//  - Consent is captured on every entry point, with the text versioned.
//  - Individual rows never leave through the public API — the public
//    responses carry only the caller's own ticket, or door-list rows
//    behind the event's staff PIN.

import { PrismaClient } from '@prisma/client'
import {
  normalizeEmail, isValidEmail, clean, cleanAmbassadorRef, newStaffPin,
  mapImportRows, CONSENT_VERSION, CONSENT_TEXT,
} from '@/lib/audience-core'

const prisma = new PrismaClient()

// The consent text row is written lazily so a fresh database works
// without a seed step. Same version = same text, never overwritten.
async function ensureConsentText() {
  await prisma.consentText.upsert({
    where: { version: CONSENT_VERSION },
    update: {},
    create: { version: CONSENT_VERSION, text: CONSENT_TEXT },
  })
}

function consentData() {
  return {
    consentVersion: CONSENT_VERSION,
    consentFlags: JSON.stringify({ contact: true }),
    consentAt: new Date(),
  }
}

// Upsert an attendee by normalized email. Existing records only ever
// gain data — a later entry point never blanks a field a person already
// filled in.
async function upsertAttendee(email: string, fields: {
  name?: string | null; school?: string | null; classYear?: string | null; phone?: string | null
}, withConsent: boolean) {
  const existing = await prisma.attendee.findUnique({ where: { email } })
  if (!existing) {
    return prisma.attendee.create({
      data: {
        email,
        name: fields.name ?? null,
        school: fields.school ?? null,
        classYear: fields.classYear ?? null,
        phone: fields.phone ?? null,
        ...(withConsent ? consentData() : {}),
      },
    })
  }
  const patch: any = {}
  if (!existing.name && fields.name) patch.name = fields.name
  if (!existing.school && fields.school) patch.school = fields.school
  if (!existing.classYear && fields.classYear) patch.classYear = fields.classYear
  if (!existing.phone && fields.phone) patch.phone = fields.phone
  if (withConsent && !existing.consentAt) Object.assign(patch, consentData())
  if (Object.keys(patch).length) return prisma.attendee.update({ where: { id: existing.id }, data: patch })
  return existing
}

// ---------------------------------------------------------------
// Public: RSVP page
// ---------------------------------------------------------------

export async function publicEvent(slug: string) {
  const ev = await prisma.event.findUnique({ where: { rsvpSlug: String(slug ?? '').slice(0, 40) } })
  if (!ev) return null
  // Brand-safe subset only — no PIN, no ids, no counts.
  return {
    name: ev.name, headliner: ev.headliner, venue: ev.venue, city: ev.city,
    state: ev.state, school: ev.school,
    date: ev.date ? ev.date.toISOString() : null,
    open: ev.rsvpOpen,
    consentText: CONSENT_TEXT, consentVersion: CONSENT_VERSION,
  }
}

export async function createRsvp(input: any) {
  const ev = await prisma.event.findUnique({ where: { rsvpSlug: String(input.slug ?? '').slice(0, 40) } })
  if (!ev) throw new Error('Event not found — check the link')
  if (!ev.rsvpOpen) throw new Error('RSVPs are closed for this event')
  const email = normalizeEmail(input.email)
  if (!isValidEmail(email)) throw new Error('A valid email is required')
  if (input.consent !== true) throw new Error('The consent box is required')
  const name = clean(input.name, 120)
  if (name.length < 2) throw new Error('Your name is required')

  await ensureConsentText()
  const attendee = await upsertAttendee(email, {
    name,
    school: clean(input.school, 120) || null,
    classYear: clean(input.classYear, 20) || null,
  }, true)

  const walkup = input.walkup === true
  const ref = cleanAmbassadorRef(input.ref)
  const existing = await prisma.attendance.findUnique({
    where: { attendeeId_eventId: { attendeeId: attendee.id, eventId: ev.id } },
  })
  if (existing) {
    // Same person RSVPing twice is normal (new phone, lost link) — hand
    // back the ticket they already have instead of erroring.
    if (walkup && !existing.checkedInAt) {
      await prisma.attendance.update({ where: { id: existing.id }, data: { checkedInAt: new Date() } })
    }
    return { token: existing.checkinToken, already: true }
  }
  const att = await prisma.attendance.create({
    data: {
      attendeeId: attendee.id,
      eventId: ev.id,
      rsvpAt: new Date(),
      source: walkup ? 'walkup_qr' : ref ? 'ambassador_link' : 'rsvp',
      referringAmbassadorRef: ref,
      cameFor: clean(input.cameFor, 120) || null,
      checkedInAt: walkup ? new Date() : null,
    },
  })
  return { token: att.checkinToken, already: false }
}

// The ticket view (rsvp.html?e=<slug>&t=<token>) — the caller proves
// ownership by holding the token, and gets back only their own row.
export async function ticketByToken(token: string) {
  const att = await prisma.attendance.findUnique({
    where: { checkinToken: String(token ?? '').slice(0, 40) },
    include: { attendee: true, event: true },
  })
  if (!att) return null
  return {
    name: att.attendee.name, email: att.attendee.email,
    event: att.event.name, headliner: att.event.headliner,
    venue: att.event.venue, date: att.event.date ? att.event.date.toISOString() : null,
    checkedIn: !!att.checkedInAt,
  }
}

// ---------------------------------------------------------------
// Public: check-in (self via token; staff via event PIN)
// ---------------------------------------------------------------

export async function selfCheckin(token: string) {
  const att = await prisma.attendance.findUnique({
    where: { checkinToken: String(token ?? '').slice(0, 40) },
    include: { event: true },
  })
  if (!att) throw new Error('Ticket not found')
  if (!att.checkedInAt) {
    await prisma.attendance.update({ where: { id: att.id }, data: { checkedInAt: new Date() } })
  }
  return { event: att.event.name, checkedIn: true }
}

async function eventForPin(slug: string, pin: string) {
  const ev = await prisma.event.findUnique({ where: { rsvpSlug: String(slug ?? '').slice(0, 40) } })
  if (!ev) throw new Error('Event not found')
  const given = String(pin ?? '').trim()
  if (!ev.staffPin || given.length < 4 || given !== ev.staffPin) throw new Error('Wrong PIN')
  return ev
}

// The guest list for door mode. Behind the event PIN; door.html caches
// it locally so a dead venue connection doesn't stop the line.
export async function doorList(slug: string, pin: string) {
  const ev = await eventForPin(slug, pin)
  const rows = await prisma.attendance.findMany({
    where: { eventId: ev.id },
    include: { attendee: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  })
  return {
    event: ev.name,
    guests: rows.map(r => ({
      id: r.id, name: r.attendee.name, email: r.attendee.email,
      ticketType: r.ticketType, checkedIn: !!r.checkedInAt,
    })),
  }
}

// Batch door check-in — door.html queues ids offline and syncs them
// here. Idempotent: an id already checked in stays at its first time.
export async function doorCheckin(slug: string, pin: string, ids: unknown) {
  const ev = await eventForPin(slug, pin)
  const list = Array.isArray(ids) ? ids.map(x => String(x)).slice(0, 500) : []
  if (!list.length) return { checkedIn: 0 }
  const r = await prisma.attendance.updateMany({
    where: { id: { in: list }, eventId: ev.id, checkedInAt: null },
    data: { checkedInAt: new Date() },
  })
  return { checkedIn: r.count }
}

// ---------------------------------------------------------------
// Dashboard: events
// ---------------------------------------------------------------

export async function listAudienceEvents() {
  const events = await prisma.event.findMany({ orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] })
  const counts = await prisma.attendance.groupBy({ by: ['eventId'], _count: true })
  const ins = await prisma.attendance.groupBy({ by: ['eventId'], _count: true, where: { checkedInAt: { not: null } } })
  const cMap = new Map(counts.map(c => [c.eventId, c._count]))
  const iMap = new Map(ins.map(c => [c.eventId, c._count]))
  return events.map(ev => ({
    ...ev,
    rsvps: cMap.get(ev.id) || 0,
    checkins: iMap.get(ev.id) || 0,
  }))
}

export async function saveAudienceEvent(input: any) {
  const data: any = {
    name: clean(input.name, 160),
    school: clean(input.school, 120) || null,
    venue: clean(input.venue, 160) || null,
    city: clean(input.city, 120) || null,
    state: clean(input.state, 10) || null,
    capacity: input.capacity ? Math.max(0, parseInt(input.capacity, 10) || 0) || null : null,
    headliner: clean(input.headliner, 160) || null,
    genre: clean(input.genre, 60) || null,
    ticketSource: ['internal', 'box_office', 'third_party'].includes(input.ticketSource) ? input.ticketSource : 'internal',
    showRef: clean(input.showRef, 60) || null,
    rsvpOpen: input.rsvpOpen !== false,
  }
  if (!data.name || data.name.length < 2) throw new Error('Event name is required')
  if (input.date) {
    const d = new Date(String(input.date))
    if (isNaN(d.getTime())) throw new Error('Unreadable date')
    data.date = d
  } else data.date = null

  if (input.id) {
    return prisma.event.update({ where: { id: String(input.id) }, data })
  }
  return prisma.event.create({ data: { ...data, staffPin: newStaffPin() } })
}

// Deleting an event takes its attendances with it (cascade). The UI
// shows the row counts and asks before calling this.
export async function deleteAudienceEvent(id: string) {
  const n = await prisma.attendance.count({ where: { eventId: String(id) } })
  await prisma.event.delete({ where: { id: String(id) } })
  return { deletedAttendances: n }
}

export async function regenStaffPin(id: string) {
  const pin = newStaffPin()
  await prisma.event.update({ where: { id: String(id) }, data: { staffPin: pin } })
  return { staffPin: pin }
}

export async function audienceEventStats(id: string) {
  const eventId = String(id)
  const rows = await prisma.attendance.findMany({
    where: { eventId },
    include: { attendee: { select: { id: true, school: true } } },
  })
  const ins = rows.filter(r => r.checkedInAt)
  const bySource: Record<string, number> = {}
  const byTicket: Record<string, number> = {}
  const byAmb: Record<string, number> = {}
  const bySchool: Record<string, number> = {}
  let revenueCents = 0
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] || 0) + 1
    byTicket[r.ticketType] = (byTicket[r.ticketType] || 0) + 1
    if (r.referringAmbassadorRef) byAmb[r.referringAmbassadorRef] = (byAmb[r.referringAmbassadorRef] || 0) + 1
    const school = r.attendee.school || '(unknown)'
    bySchool[school] = (bySchool[school] || 0) + 1
    revenueCents += r.pricePaidCents
  }
  // Repeat share: of this event's attendees, how many have any other
  // attendance — the number the whole module exists to grow.
  const ids = rows.map(r => r.attendee.id)
  const repeats = ids.length
    ? await prisma.attendance.groupBy({
        by: ['attendeeId'],
        where: { attendeeId: { in: ids }, eventId: { not: eventId } },
      })
    : []
  return {
    rsvps: rows.length,
    checkins: ins.length,
    showRate: rows.length ? Math.round((ins.length / rows.length) * 100) : 0,
    revenueCents,
    bySource, byTicket, bySchool,
    ambassadors: Object.entries(byAmb).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([ref, count]) => ({ ref, count })),
    repeatCount: repeats.length,
  }
}

// ---------------------------------------------------------------
// Dashboard: attendees
// ---------------------------------------------------------------

export async function listAttendees(input: any) {
  const q = clean(input?.q, 120)
  const where: any = { mergedIntoId: null }
  if (q) {
    where.OR = [
      { email: { contains: q.toLowerCase() } },
      { name: { contains: q, mode: 'insensitive' } },
      { school: { contains: q, mode: 'insensitive' } },
    ]
  }
  const [total, rows] = await Promise.all([
    prisma.attendee.count({ where }),
    prisma.attendee.findMany({
      where,
      include: { attendances: { include: { event: { select: { name: true, date: true } } }, orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])
  return {
    total,
    attendees: rows.map(a => ({
      id: a.id, email: a.email, name: a.name, school: a.school, classYear: a.classYear,
      consentAt: a.consentAt, events: a.attendances.length,
      checkedIn: a.attendances.filter(x => x.checkedInAt).length,
      spendCents: a.attendances.reduce((s, x) => s + x.pricePaidCents, 0),
      lastEvent: a.attendances[0]?.event?.name ?? null,
    })),
  }
}

// Near-duplicate candidates for the merge tool: same person, different
// email. Grouped on the normalized name; the human decides.
export async function listDupCandidates() {
  const rows = await prisma.attendee.findMany({
    where: { mergedIntoId: null, name: { not: null } },
    select: { id: true, email: true, name: true, school: true, _count: { select: { attendances: true } } },
  })
  const byName = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = String(r.name).trim().toLowerCase().replace(/\s+/g, ' ')
    if (key.length < 5) continue
    const arr = byName.get(key) || []
    arr.push(r)
    byName.set(key, arr)
  }
  return Array.from(byName.values())
    .filter(g => g.length > 1)
    .slice(0, 20)
    .map(g => g.map(r => ({ id: r.id, email: r.email, name: r.name, school: r.school, events: r._count.attendances })))
}

// Merge: move the loser's attendances onto the survivor, then mark the
// loser merged (kept as a tombstone so the id trail survives). Where
// both attended the same event, the survivor's row wins.
export async function mergeAttendees(fromId: string, intoId: string) {
  const from = String(fromId), into = String(intoId)
  if (from === into) throw new Error('Pick two different attendees')
  const [a, b] = await Promise.all([
    prisma.attendee.findUnique({ where: { id: from } }),
    prisma.attendee.findUnique({ where: { id: into } }),
  ])
  if (!a || !b) throw new Error('Attendee not found')
  const bEvents = await prisma.attendance.findMany({ where: { attendeeId: into }, select: { eventId: true } })
  const taken = new Set(bEvents.map(x => x.eventId))
  const moving = await prisma.attendance.findMany({ where: { attendeeId: from } })
  let moved = 0, dropped = 0
  for (const att of moving) {
    if (taken.has(att.eventId)) { await prisma.attendance.delete({ where: { id: att.id } }); dropped++ }
    else { await prisma.attendance.update({ where: { id: att.id }, data: { attendeeId: into } }); moved++ }
  }
  // Survivor gains any fields it was missing.
  const patch: any = {}
  if (!b.name && a.name) patch.name = a.name
  if (!b.school && a.school) patch.school = a.school
  if (!b.classYear && a.classYear) patch.classYear = a.classYear
  if (!b.phone && a.phone) patch.phone = a.phone
  if (Object.keys(patch).length) await prisma.attendee.update({ where: { id: into }, data: patch })
  await prisma.attendee.update({ where: { id: from }, data: { mergedIntoId: into } })
  return { moved, dropped }
}

// The delete-request path (a student asks to be removed). Hard delete —
// attendances cascade. The UI shows what will go and asks first.
export async function deleteAttendee(id: string) {
  const a = await prisma.attendee.findUnique({
    where: { id: String(id) },
    include: { _count: { select: { attendances: true } } },
  })
  if (!a) throw new Error('Attendee not found')
  await prisma.attendee.delete({ where: { id: a.id } })
  return { email: a.email, deletedAttendances: a._count.attendances }
}

// ---------------------------------------------------------------
// Segments — derived, never hand-entered (sponsorship Phase 2)
// ---------------------------------------------------------------
//
// Everything below is recomputed from the attendance join table on
// demand; nothing is stored. "Same person, multiple events" is the
// signal, so every profile leads with repeat behavior. Output is
// aggregates only — these numbers are what goes in front of a brand,
// never the rows behind them.

type PersonAgg = {
  school: string | null
  classYear: string | null
  events: number
  checkins: number
  spendCents: number
  vip: boolean
  genres: Record<string, number>
  states: Record<string, number>
}

function profileOf(members: PersonAgg[]) {
  const size = members.length
  const schools: Record<string, number> = {}
  const classYears: Record<string, number> = {}
  const states: Record<string, number> = {}
  let spend = 0, events = 0, checkins = 0, repeat = 0
  for (const m of members) {
    spend += m.spendCents; events += m.events; checkins += m.checkins
    if (m.events >= 2) repeat++
    if (m.school) schools[m.school] = (schools[m.school] || 0) + 1
    if (m.classYear) classYears[m.classYear] = (classYears[m.classYear] || 0) + 1
    for (const st of Object.keys(m.states)) states[st] = (states[st] || 0) + 1
  }
  const top = (o: Record<string, number>, n: number) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  return {
    size,
    avgSpendCents: size ? Math.round(spend / size) : 0,
    avgEvents: size ? Math.round((events / size) * 10) / 10 : 0,
    checkinRate: events ? Math.round((checkins / events) * 100) : 0,
    repeatPct: size ? Math.round((repeat / size) * 100) : 0,
    topSchools: top(schools, 6),
    topStates: top(states, 6),
    classYears,
  }
}

export async function segmentsOverview() {
  const atts = await prisma.attendance.findMany({
    include: {
      attendee: { select: { id: true, school: true, classYear: true, mergedIntoId: true } },
      event: { select: { id: true, school: true, state: true, genre: true } },
    },
  })
  const people = new Map<string, PersonAgg>()
  const portfolio = {
    totalRsvps: 0, totalCheckins: 0,
    bySchool: {} as Record<string, number>,
    byState: {} as Record<string, number>,
    byGenre: {} as Record<string, number>,
    ticketRevenueCents: 0,
  }
  for (const a of atts) {
    if (a.attendee.mergedIntoId) continue
    portfolio.totalRsvps++
    if (a.checkedInAt) portfolio.totalCheckins++
    portfolio.ticketRevenueCents += a.pricePaidCents
    const evSchool = a.event.school || '(unknown)'
    portfolio.bySchool[evSchool] = (portfolio.bySchool[evSchool] || 0) + 1
    if (a.event.state) portfolio.byState[a.event.state] = (portfolio.byState[a.event.state] || 0) + 1
    if (a.event.genre) portfolio.byGenre[a.event.genre] = (portfolio.byGenre[a.event.genre] || 0) + 1

    let p = people.get(a.attendee.id)
    if (!p) {
      p = { school: a.attendee.school, classYear: a.attendee.classYear, events: 0, checkins: 0, spendCents: 0, vip: false, genres: {}, states: {} }
      people.set(a.attendee.id, p)
    }
    p.events++
    if (a.checkedInAt) p.checkins++
    p.spendCents += a.pricePaidCents
    if (a.ticketType === 'vip') p.vip = true
    if (a.event.genre) p.genres[a.event.genre] = (p.genres[a.event.genre] || 0) + 1
    if (a.event.state) p.states[a.event.state] = (p.states[a.event.state] || 0) + 1
  }
  const all = Array.from(people.values())
  const majorityGenre = (p: PersonAgg) => {
    const e = Object.entries(p.genres).sort((a, b) => b[1] - a[1])
    return e.length ? e[0][0] : null
  }

  const segments: any[] = []
  const add = (key: string, name: string, desc: string, members: PersonAgg[]) => {
    if (members.length) segments.push({ key, name, desc, ...profileOf(members) })
  }
  add('repeat2', 'Repeat attenders (2+)', 'Came to two or more SBOY shows — the proof the flywheel works.', all.filter(p => p.events >= 2))
  add('repeat3', 'Core fans (3+)', 'Three or more shows. The audience a brand can reach again and again.', all.filter(p => p.events >= 3))
  add('vip', 'VIP / high-spend', 'Bought VIP at least once, or $75+ lifetime ticket spend.', all.filter(p => p.vip || p.spendCents >= 7500))
  add('first', 'First-timers', 'One show so far — the pool the repeat segments grow from.', all.filter(p => p.events === 1))
  // Genre affinity: one segment per genre with members whose majority is it.
  const genres = new Set(all.map(majorityGenre).filter(Boolean) as string[])
  for (const g of Array.from(genres).sort()) {
    add('genre:' + g, g + ' affinity', 'Majority of shows attended were ' + g + ' headliners.', all.filter(p => majorityGenre(p) === g))
  }
  // Campus cohorts: attendee's own school, largest first, small ones folded away.
  const bySchool = new Map<string, PersonAgg[]>()
  for (const p of all) {
    if (!p.school) continue
    const arr = bySchool.get(p.school) || []
    arr.push(p); bySchool.set(p.school, arr)
  }
  Array.from(bySchool.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 8)
    .forEach(([school, members]) => {
      if (members.length >= 5) add('campus:' + school, school + ' cohort', 'Attendees who told us ' + school + ' is their school.', members)
    })

  return {
    portfolio: {
      uniqueAttendees: all.length,
      events: await prisma.event.count(),
      ...portfolio,
      repeatShare: all.length ? Math.round((all.filter(p => p.events >= 2).length / all.length) * 100) : 0,
    },
    segments,
  }
}

// ---------------------------------------------------------------
// Dashboard: CSV import
// ---------------------------------------------------------------

// One handler, two passes. dryRun=true parses and reports what WOULD
// happen (the preview the UI must show); dryRun=false writes. Both
// passes run the same mapping code, so the preview can't lie.
export async function importAttendees(input: any) {
  const eventId = String(input.eventId ?? '')
  const ev = await prisma.event.findUnique({ where: { id: eventId } })
  if (!ev) throw new Error('Pick an event first')
  const csv = String(input.csv ?? '')
  if (csv.length > 2_000_000) throw new Error('File too large — split it and import in parts')
  const { rows, skipped, dupesInFile } = mapImportRows(csv)
  if (!rows.length) return { dryRun: true, rows: 0, skipped, dupesInFile, newAttendees: 0, existing: 0, alreadyOnEvent: 0, sample: [] }

  const emails = rows.map(r => r.email)
  const existing = await prisma.attendee.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
  const existingByEmail = new Map(existing.map(a => [a.email, a.id]))
  const onEvent = existing.length
    ? await prisma.attendance.findMany({
        where: { eventId, attendeeId: { in: existing.map(a => a.id) } },
        select: { attendeeId: true },
      })
    : []
  const onEventIds = new Set(onEvent.map(x => x.attendeeId))
  const alreadyOnEvent = rows.filter(r => {
    const id = existingByEmail.get(r.email)
    return id !== undefined && onEventIds.has(id)
  }).length

  const summary = {
    rows: rows.length,
    skipped,
    dupesInFile,
    newAttendees: rows.length - existing.length,
    existing: existing.length,
    alreadyOnEvent,
    sample: rows.slice(0, 8),
  }
  if (input.dryRun !== false) return { dryRun: true, ...summary }

  await ensureConsentText()
  let added = 0
  for (const r of rows) {
    // No consent flags on import: these people agreed to the ticket
    // vendor's terms, not our consent text. They get our consent capture
    // the first time they touch an SBOY form themselves.
    const attendee = await upsertAttendee(r.email, r, false)
    const has = await prisma.attendance.findUnique({
      where: { attendeeId_eventId: { attendeeId: attendee.id, eventId } },
    })
    if (has) continue
    await prisma.attendance.create({
      data: {
        attendeeId: attendee.id, eventId,
        ticketType: r.ticketType, pricePaidCents: r.priceCents,
        source: 'import', rsvpAt: new Date(),
      },
    })
    added++
  }
  return { dryRun: false, ...summary, added }
}
