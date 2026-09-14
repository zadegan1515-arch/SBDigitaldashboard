// POST /api/public/access — a brand without a code asked for Show Board
// access from the gate. Stores the request (pending) and emails the team;
// approval/denial happens in the Command Center's Show Board tab.
// Public, so: strict input checks, a honeypot, and a per-IP limit.

import { NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { opsSend, opsStatus } from '@/lib/google'
import { sendPlainEmail } from '@/lib/email'

const prisma = new PrismaClient()

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const NOTIFY = (process.env.SPONSOR_REQUEST_TO || 'zach@sboyagency.com, leo@sboyagency.com').split(/[,\s]+/).filter(Boolean)
const SITE = process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'

const hits = new Map<string, number[]>()
function limited(ip: string) {
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000)
  arr.push(now); hits.set(ip, arr)
  return arr.length > 5
}

function clean(s: any, max: number) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max) }

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    if (limited(ip)) return NextResponse.json({ ok: false, error: 'Too many requests — try again in an hour.' }, { status: 429 })
    const body = await req.json().catch(() => ({}))
    if (body.website_url) return NextResponse.json({ ok: true })              // honeypot

    const company = clean(body.company, 120), name = clean(body.name, 120)
    const email = clean(body.email, 200).toLowerCase()
    if (company.length < 2) throw new Error('Company name is required')
    if (name.length < 2) throw new Error('Your name is required')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required')

    // One open request per email — a resubmit just confirms.
    const open = await prisma.boardAccessRequest.findFirst({ where: { email, status: 'pending' } })
    if (!open) {
      await prisma.boardAccessRequest.create({ data: { company, name, email, ip } })
      const subject = `Show Board access request: ${company}`
      const text = `${name} <${email}> from ${company} asked for access to the Show Board.\n\nApprove or deny: ${SITE}/app.html#board`
      try {
        const st = await opsStatus()
        if (st.connected) await opsSend({ from: `SB Agency Operations <${st.address || 'ops@sboyagency.com'}>`, to: NOTIFY[0], cc: NOTIFY.slice(1), subject, text })
        else await sendPlainEmail({ to: NOTIFY[0], cc: NOTIFY.slice(1), subject, body: text })
      } catch { /* the request is saved either way */ }
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 })
  }
}
