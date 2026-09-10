// src/lib/sponsor-request.ts
//
// A brand picked shows on the public sponsor page. Turn that into
// records the team already works with:
//   Brand (found by name or created, source "sponsor-page")
//   Contact (the person who submitted)
//   ShowSponsor per show, status "requested" — shows up on the Shows tab
//     and the Sponsorships ledger next to proposed/confirmed
//   Deal, one per request, stage "conversation", source "request" —
//     so the pipeline shows "Brand — sponsor request (5 shows)"
// …and an email to the team from the ops mailbox (outreach mailbox as
// fallback). Nothing here overwrites an existing brand's data.

import { PrismaClient } from '@prisma/client'
import { allShows, type Show } from '@/lib/shows'
import { opsSend, opsStatus } from '@/lib/google'
import { sendPlainEmail } from '@/lib/email'

const prisma = new PrismaClient()
const NOTIFY = (process.env.SPONSOR_REQUEST_TO || 'zach@sboyagency.com, leo@sboyagency.com').split(/[,\s]+/).filter(Boolean)
const SITE = process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'

function clean(s: any, max: number) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max) }
function fmtDate(d: string) {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
function showLine(s: Show) {
  return [fmtDate(s.date), s.artist, [s.schoolName, s.chapter].filter(Boolean).join(' · '), [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ')
}

export async function createSponsorRequest(input: any) {
  const company = clean(input.company, 120), name = clean(input.name, 120), email = clean(input.email, 200).toLowerCase()
  const phone = clean(input.phone, 40), notes = clean(input.notes, 2000), budget = clean(input.budget, 60)
  if (company.length < 2) throw new Error('Company name is required')
  if (name.length < 2) throw new Error('Your name is required')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required')
  const ids: string[] = Array.isArray(input.showIds) ? input.showIds.map((x: any) => String(x)).slice(0, 40) : []
  if (!ids.length) throw new Error('Pick at least one show')

  const { shows } = await allShows()
  const byId = new Map(shows.map(s => [s.id, s]))
  const picked = ids.map(id => byId.get(id)).filter((s): s is Show => !!s)
  if (!picked.length) throw new Error('Those shows are no longer available — reload the page')

  // Brand: a hand-picked link carries the brand id; otherwise match on
  // name, case-insensitive. Never rename an existing brand.
  const brandById = input.brandId ? await prisma.brand.findUnique({ where: { id: String(input.brandId).slice(0, 40) } }) : null
  let brand = brandById || await prisma.brand.findFirst({ where: { name: { equals: company, mode: 'insensitive' } } })
  if (!brand) brand = await prisma.brand.create({ data: { name: company, source: 'sponsor-page', notes: `Came in through the sponsor page on ${new Date().toISOString().slice(0, 10)}.` } })

  // Contact: reuse by email under this brand.
  const existing = await prisma.contact.findFirst({ where: { brandId: brand.id, email } })
  if (!existing) await prisma.contact.create({ data: { brandId: brand.id, name, email, phone: phone || null, source: 'sponsor-page', isDecisionMaker: true } })

  // One ShowSponsor per show. Existing links (already proposed/confirmed) are left alone.
  let added = 0
  for (const s of picked) {
    const link = await prisma.showSponsor.findUnique({ where: { brandId_crmLeadId: { brandId: brand.id, crmLeadId: s.id } } })
    if (link) continue
    await prisma.showSponsor.create({
      data: {
        brandId: brand.id, crmLeadId: s.id, school: s.schoolName, chapter: s.chapter || null, artist: s.artist, eventDate: s.date,
        status: 'requested', valueCents: 0, notes: `Requested by ${name} <${email}> on the sponsor page`,
      },
    })
    added++
  }

  // One deal per request.
  const upcoming = picked.filter(s => !s.past), past = picked.filter(s => s.past)
  const lines = [
    `Sponsor request from ${name} <${email}>${phone ? ' · ' + phone : ''}`,
    budget ? `Budget: ${budget}` : '',
    notes ? `Notes: ${notes}` : '',
    '',
    upcoming.length ? `Upcoming shows (${upcoming.length}):\n` + upcoming.map(s => '• ' + showLine(s)).join('\n') : '',
    past.length ? `\nPast shows they liked (${past.length}):\n` + past.map(s => '• ' + showLine(s)).join('\n') : '',
  ].filter(x => x !== '').join('\n')
  const deal = await prisma.deal.create({
    data: {
      brandId: brand.id, name: `${brand.name} — sponsor request (${picked.length} show${picked.length === 1 ? '' : 's'})`,
      stage: 'conversation', valueCents: 0, source: 'request',
      eventRef: upcoming.length ? `${upcoming.length} upcoming` : `${past.length} past`, notes: lines,
    },
  })

  // Partner record: at minimum in the network.
  await prisma.partner.upsert({ where: { brandId: brand.id }, create: { brandId: brand.id, lifecycle: 'in_network' }, update: {} })

  // Tell the team. Never let email failure fail the request.
  const subject = `Sponsor request: ${brand.name} — ${picked.length} show${picked.length === 1 ? '' : 's'}`
  const body = lines + `\n\nOpen in Command Center: ${SITE}/app.html#brand/${brand.id}\nReply to the brand: ${email}`
  let emailed = false
  try {
    const st = await opsStatus()
    if (st.connected) {
      await opsSend({ from: `SB Agency Operations <${st.address || 'ops@sboyagency.com'}>`, to: NOTIFY[0], cc: NOTIFY.slice(1), subject, text: body })
      emailed = true
    } else {
      await sendPlainEmail({ to: NOTIFY[0], cc: NOTIFY.slice(1), subject, body })
      emailed = true
    }
  } catch { emailed = false }

  return { id: deal.id, brandId: brand.id, shows: picked.length, added, emailed }
}
