// src/lib/email.ts
//
// The email outreach engine. Runs beside the LinkedIn queue, never through
// it: email sends don't touch LinkedIn statuses or its 10/day budget.
//
// Flow: draftDailyEmails() writes a personalized intro (or a 4-day
// follow-up) for the day's best targets who have a work email — capped by
// a deliverability ramp (10/day at first, +5 per week, ceiling 40). The
// drafts wait for a human: sendApprovedEmails() is wired to the morning
// "Send all" button. checkReplies() reads the inbox over IMAP and marks
// targets replied, which drops them into "Needs action today".
//
// The mailbox is whatever EMAIL_USER/EMAIL_APP_PASSWORD point at (a Gmail
// address + app password). Swapping in marketing@sboyagency.com later is
// changing those two env vars in Vercel — nothing here changes.

import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { resolveMx } from 'dns/promises'

const prisma = new PrismaClient()

// ---- config ----------------------------------------------------

const DAILY_START = 10       // day-one cap: warm the address up slowly
const DAILY_MAX = 40         // ceiling, even fully warmed
const RAMP_PER_WEEK = 5      // cap grows this much each week
const FOLLOWUP_AFTER_DAYS = 3   // intro -> follow-up 1
const FOLLOWUP2_AFTER_DAYS = 4  // follow-up 1 -> follow-up 2 (day ~7 overall)
const EXHAUSTED_AFTER_DAYS = 3  // follow-up 2 -> flagged "went quiet"
const WORK_TZ = 'America/New_York'
const SITE_URL = 'https://sb-digitaldashboard.vercel.app'

export function emailConfigured(): boolean {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
}
export function emailAddress(): string | null {
  return process.env.EMAIL_USER ?? null
}

function startOfLocalDay(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc }, {})
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const offset = asIfUtc - now.getTime()
  const localMidnightAsIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day)
  return new Date(localMidnightAsIfUtc - offset)
}

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}
async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// The ramp: starts the first day anything is drafted, grows weekly.
export async function currentDailyCap(): Promise<number> {
  let start = await getSetting('emailRampStart')
  if (!start) {
    start = new Date().toISOString()
    await setSetting('emailRampStart', start)
  }
  const weeks = Math.floor((Date.now() - new Date(start).getTime()) / (7 * 24 * 60 * 60 * 1000))
  return Math.min(DAILY_MAX, DAILY_START + weeks * RAMP_PER_WEEK)
}

// ---- Claude (same fallback dance as /api/data) -----------------

const DRAFT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MODEL_FALLBACKS = ['claude-sonnet-5', 'claude-haiku-4-5']

async function askClaude(prompt: string, maxTokens: number): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const candidates = [DRAFT_MODEL, ...MODEL_FALLBACKS.filter(m => m !== DRAFT_MODEL)]
  let lastErr: any = null
  for (const model of candidates) {
    try {
      const res = await anthropic.messages.create({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = res.content.find(b => b.type === 'text')
      return block && 'text' in block ? block.text : ''
    } catch (err: any) {
      lastErr = err
      if (!(err?.status === 404 || /model/i.test(err?.message ?? ''))) throw err
    }
  }
  throw lastErr ?? new Error('No usable Claude model')
}

function parseEmailJson(text: string): { subject: string; body: string } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.subject || !j.body) return null
    return { subject: String(j.subject).slice(0, 150), body: String(j.body).slice(0, 3000) }
  } catch { return null }
}

// ---- no-credit fallbacks ---------------------------------------
//
// Every AI feature tries Claude first. When the API account is out of
// credits (or the call fails), these hand-written templates take over,
// filled with the brand's real data — the machine never stops.

function isBillingError(err: any): boolean {
  return /credit balance|billing|purchase credits|invalid_request_error.*credit/i.test(String(err?.message ?? ''))
}

function firstNameOf(t: any): string {
  return String(t.contact?.name || '').trim().split(/\s+/)[0] || 'there'
}

// Deterministic pick so the same brand always gets the same variant.
function pick<T>(arr: T[], seed: string): T {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return arr[h % arr.length]
}

export function templateFollowup1(t: any, intro: any): { subject: string; body: string } {
  const first = firstNameOf(t)
  const brand = t.brand.name
  const bodies = [
    `Hi ${first},\n\nWanted to float this back to the top of your inbox. We're locking in partners for the semester now, and I think ${brand} would land really well on campus.\n\nWorth a quick 15 minutes this week?\n\nLeo\nSB Agency`,
    `Hi ${first},\n\nJust circling back — we're routing 500+ shows this year and still have room for a partner like ${brand} in a few big markets.\n\nOpen to a quick call?\n\nLeo\nSB Agency`,
    `Hi ${first},\n\nFollowing up in case this got buried. Spring calendars are filling in, and campus feels like a strong fit for ${brand}.\n\nHappy to share a one-pager or hop on a 15-minute call — whatever's easiest.\n\nLeo\nSB Agency`,
  ]
  return { subject: `re: ${intro?.subject ?? `SB Agency x ${brand}`}`, body: pick(bodies, brand) }
}

export function templateFollowup2(t: any, intro: any): { subject: string; body: string } {
  const first = firstNameOf(t)
  const brand = t.brand.name
  const bodies = [
    `Hi ${first},\n\nLast note from me — I'll stop filling your inbox. If campus ever makes sense for ${brand}, the door's open and I'd love to build something together.\n\nEither way, keep crushing it.\n\nLeo\nSB Agency`,
    `Hi ${first},\n\nClosing the loop on this one. If the timing's ever right for ${brand} to get in front of students, just say the word — we'll make it easy.\n\nAll the best,\nLeo\nSB Agency`,
  ]
  return { subject: `re: ${intro?.subject ?? `SB Agency x ${brand}`}`, body: pick(bodies, brand + '2') }
}

// Per-category angles for the ✦ suggestion box — {brand} gets substituted.
const CATEGORY_ANGLES: Record<string, { tip: string; insert: string }> = {
  beverage:  { tip: 'Sampling is the natural play — cold product in hands at peak energy is exactly what beverage brands buy.', insert: 'Concerts are a natural sampling moment for {brand} — thousands of students with product in hand at peak energy, plus all the content that follows.' },
  alcohol:   { tip: 'Lead with compliant 21+ sampling — the compliance angle is usually their first question.', insert: 'Our 21+ events give {brand} a compliant way to put product in hands in exactly the setting where trial converts.' },
  cpg:       { tip: 'Product seeding and house drops before show day put the product into daily student life, not just one night.', insert: 'Beyond show night, house drops across our Greek chapters would put {brand} into students\u2019 daily routines all semester.' },
  beauty:    { tip: 'The getting-ready moment before shows is where beauty routines and content happen — pitch sorority house seeding.', insert: 'Sorority house drops and the getting-ready moments before every show are a perfect fit for {brand} — that\u2019s where routines form and content gets made.' },
  betting:   { tip: 'College-age sports fans are their exact acquisition demo — talk signups per event, not impressions.', insert: 'Our crowds are exactly the demo {brand} is acquiring, and on-site signup activations convert while the energy is high.' },
  fintech:   { tip: 'Students opening their first accounts are a decade-long customer — frame campus as early acquisition.', insert: 'Students setting up their financial lives are {brand}\u2019s next decade of customers — campus is where that relationship starts.' },
  tech:      { tip: 'Device/app trial spreads fast through Greek networks — pitch hands-on demos plus a student-exclusive offer.', insert: 'Hands-on trial at our shows plus a student-exclusive offer would let {brand} ride word-of-mouth through the tightest networks on campus.' },
  software:  { tip: 'Student plans and campus ambassadors are the proven playbook for software on campus.', insert: 'A student offer seeded through our ambassadors would put {brand} in front of exactly the early adopters who spread it.' },
  apps:      { tip: 'Downloads happen in the room — QR moments at peak energy beat any paid install campaign.', insert: 'A QR moment on the big screen at peak energy is the cheapest install {brand} will ever buy — and it comes with a story.' },
  qsr:       { tip: 'Late-night after-show hunger is their moment — pitch vouchers and sampling at the exits.', insert: 'The after-show rush is prime {brand} territory — vouchers and sampling at the exits land right when cravings peak.' },
  apparel:   { tip: 'Front-row outfits are content — pitch ambassador seeding so the brand gets photographed all night.', insert: 'Show nights are the most photographed nights on campus — {brand} on our ambassadors gets seen, tagged, and shared all night.' },
  wellness:  { tip: 'Recovery and hydration around show weekends is the native use case.', insert: 'Show weekends are exactly when students reach for what {brand} makes — sampling before and after slots right into the routine.' },
  retail:    { tip: 'A student-exclusive discount pushed through Greek networks drives measurable store/site traffic.', insert: 'A student-exclusive {brand} offer pushed through our chapters would drive traffic you can actually measure.' },
  transport: { tip: 'Every show ends with thousands needing a ride — ride codes at the exits are an easy, measurable win.', insert: 'Every one of our shows ends with thousands of students needing a ride home — {brand} codes at the exits are an easy, measurable win.' },
  nightlife: { tip: 'They live in this exact culture — pitch co-branded moments, not just logos.', insert: '{brand} lives in exactly this culture — a co-branded moment inside the show would feel native, not sponsored.' },
  entertainment: { tip: 'Cross-promotion to a captive Gen Z audience is the pitch — trailers, activations, talent moments.', insert: 'Our shows put {brand} in front of a captive Gen Z audience at full attention — perfect for a launch or cross-promotion moment.' },
}
const DEFAULT_ANGLE = { tip: 'Make the first idea concrete — name the one thing this brand wants from students (trial, signups, or content) and pitch that.', insert: 'We\u2019d come with concrete ideas for how {brand} shows up — sampling, signage, or seeded product — matched to what you\u2019re trying to grow this year.' }

function templateSuggestion(t: any): string {
  const a = CATEGORY_ANGLES[t.brand.category ?? ''] ?? DEFAULT_ANGLE
  return JSON.stringify({
    tip: a.tip,
    insert: a.insert.replace(/\{brand\}/g, t.brand.name),
  })
}

export function templateReplyResponse(contactName: string, brandName: string, replySubject: string | null): { subject: string; body: string } {
  const first = String(contactName || '').trim().split(/\s+/)[0] || 'there'
  return {
    subject: `re: ${replySubject ?? `SB Agency x ${brandName}`}`,
    body: `Hi ${first},\n\nGreat to hear from you! I'd love to grab 15 minutes to walk through how we'd put ${brandName} inside our shows this semester \u2014 we run 500+ a year across 100+ college markets, so there's a lot to pick from.\n\nWould Tuesday or Wednesday afternoon work? Happy to flex to your calendar.\n\nBest,\nLeo\nSB Agency`,
  }
}

// ---- drafting --------------------------------------------------

// "Pickle's goals" but "Kulani Kinis' goals" — names already ending in
// s take a bare apostrophe.
function possessive(name: string): string {
  return /s$/i.test(name.trim()) ? `${name}'` : `${name}'s`
}

// Leo's outreach template, used verbatim for every intro — (NAME) and
// (BRAND) filled in, nothing AI-written. His voice, every time.
function introEmail(t: any): { subject: string; body: string } {
  const firstName = String(t.contact.name || '').trim().split(/\s+/)[0] || 'there'
  const brand = t.brand.name
  const body = [
    `Hi ${firstName},`,
    ``,
    `Hope you're having a good week!`,
    ``,
    `I'm reaching out from SB Agency. We are the largest producer of collegiate events and live entertainment activations in North America.`,
    ``,
    `Our experiential team puts brands directly inside the room at hundreds of major college events each year. We help partners tap into our established live audience on campus, giving them high-impact reach without having to build crowds from the ground up.`,
    ``,
    `That's 500+ shows a year across 100+ tier-1 college markets, all through our own Greek life campus networks.`,
    ``,
    `Here's a quick one-pager on what we do: ${SITE_URL}/materials/sba-one-pager.pdf`,
    ``,
    `We'd love to jump on a quick call to better understand ${possessive(brand)} goals for the upcoming year and brainstorm a few ways we might collaborate.`,
    ``,
    `Let me know your availability next week, and we can set up a call.`,
    ``,
    `Best,`,
    `Leo`,
    `SB Agency`,
  ].join('\n')
  return { subject: `SB Agency x ${brand}`, body }
}

// One sharp, brand-specific angle per draft — different for every brand
// because it's built from THAT brand's category, tier, and discovery
// notes. Returns {tip, insert} or null if generation fails (a draft
// without a suggestion is still a perfectly good draft).
async function generateSuggestion(t: any): Promise<string | null> {
  try {
    const prompt = [
      `You advise a sponsorship rep at SB Agency, which produces large fraternity/sorority concerts at US colleges and sells brands activations there (sampling, banners, product seeding, ambassadors).`,
      `SB AGENCY FACTS you may use: 500+ shows/year; 100+ tier-1 college markets; 100+ Greek life campus networks; fully customizable programs; in-house photo/video production on every show.`,
      `The rep is about to email this brand a templated intro. Give ONE angle that is SPECIFIC to this brand — never generic advice that could apply to anyone.`,
      ``,
      `BRAND: ${t.brand.name}`,
      t.brand.category ? `CATEGORY: ${t.brand.category}` : ``,
      t.brand.tier ? `STAGE: ${t.brand.tier}` : ``,
      t.brand.goals ? `WHAT THEY WANT (discovery notes): ${t.brand.goals}` : ``,
      t.brand.notes ? `NOTES: ${t.brand.notes}` : ``,
      `CONTACT: ${t.contact.name}${t.contact.title ? `, ${t.contact.title}` : ''}`,
      ``,
      `Return ONLY JSON:`,
      `{"tip": "one sentence telling the rep the angle and why it fits this brand", "insert": "one natural, friendly sentence ready to paste into the email that uses that angle — mentions the brand or its product specifically, fits before 'We'd love to jump on a quick call', no placeholder brackets"}`,
    ].filter(Boolean).join('\n')
    // 800 tokens: at 400 the model's answer was getting cut mid-JSON and
    // every suggestion "failed". Also strip markdown fences before parsing.
    const text = (await askClaude(prompt, 800)).replace(/```(?:json)?/g, '')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.tip || !j.insert) return templateSuggestion(t)
    return JSON.stringify({ tip: String(j.tip).slice(0, 400), insert: String(j.insert).slice(0, 400) })
  } catch { return templateSuggestion(t) }
}

// Generate (or regenerate) the suggestion for an existing draft.
export async function suggestForDraft(emailId: string) {
  const d = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { brand: true, contact: true } } },
  })
  if (!d) throw new Error('Draft not found')
  const s = await generateSuggestion(d.target)
  if (!s) throw new Error('Could not generate a suggestion — try again')  // unreachable: template fallback always answers
  await prisma.emailMessage.update({ where: { id: emailId }, data: { suggestion: s } })
  return JSON.parse(s)
}

// One demo email so Leo can see exactly what a recipient gets — same
// template, same attachment, sent to an address he chooses. Uses the
// first waiting draft as the sample (untouched), or a filled template
// if the queue is empty. Never counts against the daily cap.
export async function sendTestEmail(to: string) {
  if (!emailConfigured()) throw new Error('Email is not configured')
  if (!to || !/@/.test(to)) throw new Error('Valid address required')

  const sample = await prisma.emailMessage.findFirst({
    where: { direction: 'out', status: 'draft' },
    orderBy: { createdAt: 'asc' },
    include: { target: { include: { brand: true, contact: true } } },
  })
  const subject = sample ? `[TEST] ${sample.subject}` : '[TEST] SB Agency outreach preview'
  const body = sample?.body ?? 'This is a preview of the SB Agency outreach email.'

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
  })
  const attachment = await onePagerAttachment()
  await transporter.sendMail({
    from: `Leo — SB Agency <${process.env.EMAIL_USER}>`,
    to, subject, text: body,
    ...(attachment ? { attachments: [attachment] } : {}),
  })
  return { ok: true, to, subject, attached: !!attachment }
}

function followupPrompt(t: any, firstEmail: any): string {
  return [
    `Write a short FOLLOW-UP email (the first one got no reply) for SB Agency (books artists/DJs for college greek-life events; sells brands sponsorship at those shows).`,
    `TO: ${t.contact.name} at ${t.brand.name}.`,
    `FIRST EMAIL SUBJECT: ${firstEmail?.subject ?? ''}`,
    ``,
    `Rules: under 60 words, plain text. Friendly, zero pressure, adds one small new angle (timing, a specific school region, or momentum), then a soft ask. No guilt-tripping. Sign off exactly:\nLeo\nSB Agency`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject should be "re:" + the first subject.`,
  ].join('\n')
}

function followup2Prompt(t: any, firstEmail: any): string {
  return [
    `Write the LAST follow-up email in a sequence (two earlier emails got no reply) for SB Agency (produces large fraternity/sorority concerts at US colleges; sells brands activations there).`,
    `TO: ${t.contact.name} at ${t.brand.name}.`,
    `FIRST EMAIL SUBJECT: ${firstEmail?.subject ?? ''}`,
    ``,
    `Rules: under 45 words, plain text. "Closing the loop" style — graceful, zero pressure, makes clear this is the last note, leaves the door open ("if the timing's ever right..."). Optionally offer to send a one-pager or intro to whoever owns campus partnerships. Sign off exactly:\nLeo\nSB Agency`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject should be "re:" + the first subject.`,
  ].join('\n')
}

// Drafts up to `limit` emails per call (Claude calls are slow; callers
// loop until done=true). Follow-ups first — momentum beats new names.
export async function draftDailyEmails(limit = 5) {
  if (!emailConfigured()) return { configured: false, drafted: 0, done: true }
  // No API key just means templates do the writing — never a hard stop.

  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const pendingDrafts = await prisma.emailMessage.count({
    where: { direction: 'out', status: { in: ['draft', 'approved'] } },
  })
  let room = Math.max(0, cap - sentToday - pendingDrafts)
  if (room === 0) return { configured: true, drafted: 0, done: true, cap, sentToday, pendingDrafts }

  let drafted = 0

  // 1. Follow-ups due. Two rungs: follow-up 1 (intro sent >= 3 days ago)
  //    and follow-up 2 (follow-up 1 sent >= 4 more days ago, the last
  //    touch). A reply at any point stops the ladder.
  const cutoff1 = new Date(Date.now() - FOLLOWUP_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const followCandidates = await prisma.target.findMany({
    where: {
      status: { notIn: ['replied', 'converted', 'declined', 'dead'] },
      emails: { some: { direction: 'out', kind: 'intro', status: 'sent', sentAt: { lte: cutoff1 } } },
    },
    include: {
      brand: true, contact: true,
      emails: { orderBy: { createdAt: 'asc' } },
    },
    take: 50,
  })
  const cutoff2 = new Date(Date.now() - FOLLOWUP2_AFTER_DAYS * 24 * 60 * 60 * 1000)
  for (const t of followCandidates) {
    if (drafted >= limit || room === 0) break
    if (t.emails.some(e => e.direction === 'in') || !t.contact.email) continue
    const intro = t.emails.find(e => e.kind === 'intro' && e.status === 'sent')
    const f1 = t.emails.find(e => e.kind === 'followup')
    const hasF2 = t.emails.some(e => e.kind === 'followup2')
    if (!f1) {
      // Rung 1 due. AI first, template if the account can't pay for it.
      let parsed: any = null
      try { parsed = parseEmailJson(await askClaude(followupPrompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
      if (!parsed) parsed = templateFollowup1(t, intro)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'followup', status: 'draft',
          toEmail: t.contact.email, fromEmail: emailAddress(),
          subject: parsed.subject, body: parsed.body,
        },
      })
      drafted++; room--
    } else if (!hasF2 && f1.status === 'sent' && f1.sentAt && f1.sentAt <= cutoff2) {
      // Rung 2 due — the closing-the-loop note. Same fallback rule.
      let parsed: any = null
      try { parsed = parseEmailJson(await askClaude(followup2Prompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
      if (!parsed) parsed = templateFollowup2(t, intro)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'followup2', status: 'draft',
          toEmail: t.contact.email, fromEmail: emailAddress(),
          subject: parsed.subject, body: parsed.body,
        },
      })
      drafted++; room--
    }
  }

  // 2. Fresh intros: best-fit active targets with an email and no email
  //    history at all. Template-filled, not AI-written — instant.
  if (drafted < limit && room > 0) {
    // One email per BRAND, not per person: a brand that has ever been
    // emailed (any contact, draft or sent) is skipped, and only its
    // best-fit person gets the intro.
    const emailedBrands = new Set(
      (await prisma.emailMessage.findMany({
        where: { direction: 'out' },
        select: { target: { select: { brandId: true } } },
      })).map(m => m.target.brandId)
    )
    const fresh = await prisma.target.findMany({
      where: {
        status: { in: ['queued', 'drafted', 'sent'] },
        shelved: false,
        contact: { email: { not: null } },
        emails: { none: {} },
      },
      include: { brand: true, contact: true },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    })
    for (const t of fresh) {
      if (drafted >= limit || room === 0) break
      if (emailedBrands.has(t.brandId)) continue
      emailedBrands.add(t.brandId)
      const filled = introEmail(t)
      // Brand-specific angle, generated per draft — different for every
      // brand by construction. A failed generation never blocks the draft.
      const suggestion = await generateSuggestion(t)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
          toEmail: t.contact.email, fromEmail: emailAddress(),
          subject: filled.subject, body: filled.body,
          suggestion,
        },
      })
      drafted++; room--
    }
  }

  return { configured: true, drafted, done: room === 0 || drafted < limit, cap, sentToday }
}

// ---- sending ---------------------------------------------------

// The SBA one-pager, attached to every outreach email. Lives in the
// repo at public/materials/ so it's versioned with the site; fetched
// once per send batch so a missing file never blocks sending.
const ONE_PAGER_URL = 'https://sb-digitaldashboard.vercel.app/materials/sba-one-pager.pdf'
const ONE_PAGER_NAME = 'SBA One Pager.pdf'

async function onePagerAttachment(): Promise<{ filename: string; content: Buffer } | null> {
  try {
    const res = await fetch(ONE_PAGER_URL)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) return null
    return { filename: ONE_PAGER_NAME, content: buf }
  } catch { return null }
}

function makeTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
  })
}

// Bounce protection: a domain with no mail servers means a guaranteed
// bounce, and bounces are what get a sending address flagged as spam.
// Checked once per domain per batch.
const mxCache = new Map<string, boolean>()
async function domainAcceptsMail(address: string): Promise<boolean> {
  const domain = (address.split('@')[1] || '').toLowerCase()
  if (!domain) return false
  if (mxCache.has(domain)) return mxCache.get(domain)!
  let ok = false
  try {
    const mx = await resolveMx(domain)
    ok = Array.isArray(mx) && mx.length > 0
  } catch { ok = false }
  mxCache.set(domain, ok)
  return ok
}

// The HTML twin of the plain-text body: same words, plus the open-
// tracking pixel. Gmail shows this version; text-only clients get the
// plain version untouched.
function htmlBody(text: string, emailId: string): string {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>\n')
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.55">' +
    escaped +
    '</div><img src="' + SITE_URL + '/api/track?e=' + encodeURIComponent(emailId) + '" width="1" height="1" alt="" style="display:none">'
}

// Send exactly one draft: to + any CC, marked sent. Intros LINK the
// one-pager (attachments on a first cold email raise spam scores);
// follow-ups attach it. Shared by "Send all", the per-card Send button,
// and the 9am auto-send cron.
async function deliverDraft(d: any, transporter: any, attachment: { filename: string; content: Buffer } | null) {
  const to = d.toEmail || d.target.contact.email
  if (!to) throw new Error('No recipient address on this draft')
  if (!(await domainAcceptsMail(to))) throw new Error(`${to} — domain has no mail server (bounce protection)`)
  let cc: string[] = []
  try { cc = JSON.parse(d.ccEmails ?? '[]') } catch {}
  cc = cc.filter(a => typeof a === 'string' && /@/.test(a) && a.toLowerCase() !== to.toLowerCase())
  const attach = d.kind === 'intro' ? null : attachment
  await transporter.sendMail({
    from: `Leo — SB Agency <${process.env.EMAIL_USER}>`,
    to,
    ...(cc.length ? { cc } : {}),
    subject: d.subject ?? '',
    text: d.body ?? '',
    html: htmlBody(d.body ?? '', d.id),
    ...(attach ? { attachments: [attach] } : {}),
  })
  await prisma.emailMessage.update({
    where: { id: d.id },
    data: { status: 'sent', sentAt: new Date(), toEmail: to, fromEmail: emailAddress() },
  })
  return { to, cc }
}

// The open-tracking pixel calls this (via /api/track?e=<id>).
export async function recordOpen(emailId: string) {
  try {
    const d = await prisma.emailMessage.findUnique({ where: { id: emailId } })
    if (!d || d.direction !== 'out' || d.status !== 'sent') return
    await prisma.emailMessage.update({
      where: { id: emailId },
      data: { opens: { increment: 1 }, ...(d.openedAt ? {} : { openedAt: new Date() }) },
    })
  } catch {}
}

// One email, by draft id — the per-card Send button.
export async function sendOneEmail(emailId: string) {
  if (!emailConfigured()) throw new Error('Email is not configured')
  const d = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { contact: true, brand: true } } },
  })
  if (!d) throw new Error('Draft not found')
  if (d.direction !== 'out' || !['draft', 'approved'].includes(d.status)) throw new Error('Only unsent drafts can be sent')

  const transporter = makeTransport()
  const attachment = await onePagerAttachment()
  try {
    const r = await deliverDraft(d, transporter, attachment)
    return { ok: true, brand: d.target.brand.name, to: r.to, cc: r.cc, attached: !!attachment }
  } catch (err: any) {
    await prisma.emailMessage.update({
      where: { id: d.id },
      data: { status: 'failed', error: String(err?.message ?? 'send failed').slice(0, 300) },
    })
    throw new Error(`${d.target.brand.name}: ${err?.message ?? 'send failed'}`)
  }
}

// "Approve for 9am": marks every waiting draft approved; the Tue–Thu
// morning cron picks them up and sends in the best reply window.
export async function approveAllDrafts() {
  const r = await prisma.emailMessage.updateMany({
    where: { direction: 'out', status: 'draft' },
    data: { status: 'approved' },
  })
  return { approved: r.count }
}

// The auto-send cron: sends ONLY approved emails (drafts Leo hasn't
// approved stay put).
export async function sendScheduledEmails() {
  return sendBatch(['approved'])
}

// "Send all now": sends everything waiting — drafts and approved alike.
export async function sendApprovedEmails() {
  return sendBatch(['draft', 'approved'])
}

async function sendBatch(statuses: string[]) {
  if (!emailConfigured()) return { configured: false, sent: 0, failed: 0 }

  const transporter = makeTransport()
  const attachment = await onePagerAttachment()

  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: statuses } },
    include: { target: { include: { contact: true, brand: true } } },
    orderBy: { createdAt: 'asc' },
  })

  let sent = 0, failed = 0
  const errors: string[] = []
  for (const d of drafts) {
    try {
      await deliverDraft(d, transporter, attachment)
      sent++
    } catch (err: any) {
      failed++
      if (errors.length < 5) errors.push(`${d.target.brand.name}: ${err?.message ?? 'send failed'}`)
      await prisma.emailMessage.update({
        where: { id: d.id },
        data: { status: 'failed', error: String(err?.message ?? 'send failed').slice(0, 300) },
      }).catch(() => {})
    }
  }
  return { configured: true, sent, failed, errors }
}

// ---- replies ---------------------------------------------------

// Reads the inbox over IMAP and matches senders against people we've
// emailed. A match marks the target replied (which surfaces it in
// "Needs action today") and stops any future follow-up to them.
export async function checkReplies() {
  if (!emailConfigured()) return { configured: false, replies: 0 }

  // Everyone we've emailed, keyed by address.
  const sentOut = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: 'sent', toEmail: { not: null } },
    select: { targetId: true, toEmail: true },
  })
  if (sentOut.length === 0) return { configured: true, replies: 0 }
  const byEmail = new Map<string, string>()
  for (const m of sentOut) byEmail.set(m.toEmail!.toLowerCase(), m.targetId)

  const lastCheck = await getSetting('emailLastCheck')
  const since = lastCheck ? new Date(lastCheck) : new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.EMAIL_USER!, pass: process.env.EMAIL_APP_PASSWORD! },
    logger: false,
  })

  let replies = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      for await (const msg of client.fetch({ since }, { envelope: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase()
        if (!from) continue
        const targetId = byEmail.get(from)
        if (!targetId) continue

        // One reply record per target per message date-ish; skip if we
        // already logged a reply for this target with this subject.
        const subject = msg.envelope?.subject ?? null
        const dupe = await prisma.emailMessage.findFirst({
          where: { targetId, direction: 'in', subject },
        })
        if (dupe) continue

        await prisma.emailMessage.create({
          data: {
            targetId, direction: 'in', kind: 'reply', status: 'received',
            fromEmail: from, subject,
            sentAt: msg.envelope?.date ?? new Date(),
          },
        })

        const t = await prisma.target.findUnique({ where: { id: targetId } })
        if (t && !['replied', 'converted', 'declined', 'dead'].includes(t.status)) {
          await prisma.target.update({
            where: { id: targetId },
            data: { status: 'replied', repliedAt: t.repliedAt ?? new Date() },
          })
          await prisma.targetEvent.create({
            data: { targetId, kind: 'status', fromStatus: t.status, toStatus: 'replied', detail: 'email reply' },
          })
          await prisma.partner.upsert({
            where: { brandId: t.brandId },
            create: { brandId: t.brandId, lifecycle: 'in_network' },
            update: {},
          })
        }
        replies++
      }
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (err: any) {
    try { await client.logout() } catch {}
    return { configured: true, replies, error: String(err?.message ?? 'IMAP failed').slice(0, 200) }
  }

  await setSetting('emailLastCheck', new Date().toISOString())
  return { configured: true, replies }
}

// Draft an intro for ONE specific brand, on demand (the brand page's
// "✉ Draft intro email" button). Respects the one-email-per-brand rule.
export async function draftBrandIntro(brandId: string) {
  if (!emailConfigured()) throw new Error('Email is not configured')
  const prior = await prisma.emailMessage.findFirst({
    where: { direction: 'out', target: { brandId } },
  })
  if (prior) throw new Error('This brand already has an email drafted or sent — one thread per brand.')
  const t = await prisma.target.findFirst({
    where: {
      brandId, shelved: false,
      status: { in: ['queued', 'drafted', 'sent'] },
      contact: { email: { not: null } },
    },
    include: { brand: true, contact: true },
    orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
  })
  if (!t) throw new Error('No queued contact with an email at this brand — add or promote one first.')
  const filled = introEmail(t)
  const suggestion = await generateSuggestion(t)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
      toEmail: t.contact.email, fromEmail: emailAddress(),
      subject: filled.subject, body: filled.body, suggestion,
    },
  })
  return { ok: true, draftId: draft.id, to: t.contact.email, contact: t.contact.name }
}

// ---- exhausted sequences ---------------------------------------

// Brands that got the full ladder — intro, follow-up, closing note —
// and stayed silent. Each comes back flagged with a recommendation:
// the brand's next-best un-emailed contact if there is one, otherwise
// one last follow-up.
export async function listExhausted() {
  const cutoff = new Date(Date.now() - EXHAUSTED_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const ts = await prisma.target.findMany({
    where: {
      status: { notIn: ['replied', 'converted', 'declined', 'dead'] },
      emails: { some: { direction: 'out', kind: 'followup2', status: 'sent', sentAt: { lte: cutoff } } },
    },
    include: {
      brand: { select: { id: true, name: true, contacts: { select: { id: true, name: true, title: true, email: true }, where: { email: { not: null } } } } },
      contact: { select: { id: true, name: true, title: true, email: true } },
      emails: { orderBy: { sentAt: 'desc' } },
    },
    take: 30,
  })
  const silent = ts.filter(t => !t.emails.some(e => e.direction === 'in'))
  if (silent.length === 0) return []

  // Every address the BRAND has already been emailed at (any target),
  // so we never recommend someone who's already been hit.
  const brandIds = Array.from(new Set(silent.map(t => t.brandId)))
  const priorOut = await prisma.emailMessage.findMany({
    where: { direction: 'out', toEmail: { not: null }, target: { brandId: { in: brandIds } } },
    select: { toEmail: true, target: { select: { brandId: true } } },
  })
  const emailedByBrand = new Map<string, Set<string>>()
  for (const m of priorOut) {
    const set = emailedByBrand.get(m.target.brandId) ?? new Set<string>()
    set.add(m.toEmail!.toLowerCase())
    emailedByBrand.set(m.target.brandId, set)
  }

  return silent.map(t => {
    const emailed = emailedByBrand.get(t.brandId) ?? new Set<string>()
    const next = t.brand.contacts.find(c => c.email && !emailed.has(c.email.toLowerCase())) ?? null
    const lastOut = t.emails.find(e => e.direction === 'out' && e.status === 'sent')
    return {
      targetId: t.id,
      brand: { id: t.brand.id, name: t.brand.name },
      contact: { name: t.contact.name, title: t.contact.title, email: t.contact.email },
      lastTouch: lastOut?.sentAt ?? null,
      opened: t.emails.some(e => e.direction === 'out' && (e as any).opens > 0),
      nextContact: next,
      recommendation: next
        ? `Try ${next.name}${next.title ? ` (${next.title})` : ''} — a fresh intro to a new person restarts the clock.`
        : `No other contact on file — one last short follow-up, or mark it cold and revisit next semester.`,
    }
  })
}

// "Email the other person": retires the silent target and starts a
// fresh intro (template + suggestion) to a different contact at the
// same brand — waits in the draft queue like everything else.
export async function emailDifferentContact(targetId: string, contactId: string) {
  const old = await prisma.target.findUnique({ where: { id: targetId }, include: { brand: true } })
  if (!old) throw new Error('Target not found')
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact || contact.brandId !== old.brandId) throw new Error('That contact is not at this brand')
  if (!contact.email) throw new Error('That contact has no email address')

  await prisma.target.update({ where: { id: targetId }, data: { status: 'dead' } })
  await prisma.targetEvent.create({
    data: { targetId, kind: 'status', fromStatus: old.status, toStatus: 'dead', detail: 'no response after full email sequence — switching contacts' },
  })

  let t = await prisma.target.findFirst({ where: { brandId: old.brandId, contactId } })
  if (!t) {
    t = await prisma.target.create({ data: { brandId: old.brandId, contactId, status: 'queued', fitScore: old.fitScore } })
  } else if (['declined', 'dead'].includes(t.status as any)) {
    await prisma.target.update({ where: { id: t.id }, data: { status: 'queued', shelved: false } })
  }
  const full = await prisma.target.findUnique({ where: { id: t.id }, include: { brand: true, contact: true } })
  const filled = introEmail(full)
  const suggestion = await generateSuggestion(full)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
      toEmail: contact.email, fromEmail: emailAddress(),
      subject: filled.subject, body: filled.body, suggestion,
    },
  })
  return { ok: true, draftId: draft.id, to: contact.email }
}

// "One more follow-up" on an exhausted thread — a very short, final nudge.
export async function draftFinalNudge(targetId: string) {
  const t = await prisma.target.findUnique({
    where: { id: targetId },
    include: { brand: true, contact: true, emails: { orderBy: { createdAt: 'asc' } } },
  })
  if (!t) throw new Error('Target not found')
  if (!t.contact.email) throw new Error('No email on this contact')
  const intro = t.emails.find(e => e.kind === 'intro' && e.status === 'sent')
  let parsed: any = null
  try { parsed = parseEmailJson(await askClaude(followup2Prompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
  if (!parsed) parsed = templateFollowup2(t, intro)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'followup3', status: 'draft',
      toEmail: t.contact.email, fromEmail: emailAddress(),
      subject: parsed.subject, body: parsed.body,
    },
  })
  return { ok: true, draftId: draft.id }
}

// ---- reply assistant -------------------------------------------

// A brand wrote back — draft Leo's response for him to edit and send.
export async function draftReplyResponse(emailId: string) {
  const reply = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { brand: true, contact: true, emails: { orderBy: { createdAt: 'asc' } } } } },
  })
  if (!reply || reply.direction !== 'in') throw new Error('That is not an incoming reply')
  const t = reply.target
  const thread = t.emails.filter(e => e.direction === 'out' && e.status === 'sent')
    .map(e => `[${e.kind}] ${e.subject}`).join('\n')
  const prompt = [
    `You are drafting a reply for Leo at SB Agency (produces large fraternity/sorority concerts at US colleges; sells brands activations there: sampling, banners, product seeding, ambassadors).`,
    `${reply.target.contact.name}${t.contact.title ? ` (${t.contact.title})` : ''} at ${t.brand.name} just replied to Leo's outreach.`,
    `THEIR REPLY SUBJECT: ${reply.subject ?? '(unknown)'}`,
    `WHAT WE'VE SENT THEM SO FAR:\n${thread}`,
    t.brand.goals ? `BRAND DISCOVERY NOTES: ${t.brand.goals}` : '',
    ``,
    `Write Leo's response. Rules: warm, concise (under 110 words), plain text. Assume the reply was interested-or-curious unless the subject clearly says otherwise. Goal: lock a 15-minute call this week or next — propose two concrete windows (e.g. "Tue or Wed afternoon"). Offer to tailor ideas to their goals. Sign off exactly:\nBest,\nLeo\nSB Agency`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject "re:" + their subject.`,
  ].filter(Boolean).join('\n')
  let parsed: any = null
  try { parsed = parseEmailJson(await askClaude(prompt, 600)) } catch (err) { if (!isBillingError(err)) throw err }
  if (!parsed) parsed = templateReplyResponse(t.contact.name, t.brand.name, reply.subject)
  return { subject: parsed.subject, body: parsed.body, to: reply.fromEmail ?? t.contact.email }
}

// Send that response (or Leo's edited version of it).
export async function sendReplyEmail(targetId: string, to: string, subject: string, body: string) {
  if (!emailConfigured()) throw new Error('Email is not configured')
  if (!to || !/@/.test(to)) throw new Error('Valid address required')
  if (!(await domainAcceptsMail(to))) throw new Error(`${to} — domain has no mail server`)
  const transporter = makeTransport()
  const rec = await prisma.emailMessage.create({
    data: {
      targetId, direction: 'out', kind: 'response', status: 'draft',
      toEmail: to, fromEmail: emailAddress(), subject, body,
    },
  })
  await transporter.sendMail({
    from: `Leo — SB Agency <${process.env.EMAIL_USER}>`,
    to, subject, text: body, html: htmlBody(body, rec.id),
  })
  await prisma.emailMessage.update({ where: { id: rec.id }, data: { status: 'sent', sentAt: new Date() } })
  return { ok: true, to }
}

// ---- status ----------------------------------------------------

export async function emailStatus() {
  if (!emailConfigured()) return { configured: false }
  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const drafts = await prisma.emailMessage.count({ where: { direction: 'out', status: 'draft' } })
  const approved = await prisma.emailMessage.count({ where: { direction: 'out', status: 'approved' } })
  const totalSent = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent' } })
  const totalReplies = await prisma.emailMessage.count({ where: { direction: 'in' } })
  const totalOpened = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent', opens: { gt: 0 } } })
  return {
    configured: true, address: emailAddress(),
    cap, sentToday, drafts, approved, totalSent, totalReplies, totalOpened,
    lastCheck: await getSetting('emailLastCheck'),
  }
}

// Point a draft at a different person (and/or CC extras). Switching the
// main recipient also rewrites the "Hi <name>," greeting so the email
// never opens with the wrong first name.
export async function setDraftRecipients(emailId: string, args: { toEmail?: string; toName?: string; cc?: string[] }) {
  const d = await prisma.emailMessage.findUnique({ where: { id: emailId } })
  if (!d) throw new Error('Draft not found')
  if (d.status !== 'draft') throw new Error('Only unsent drafts can be re-addressed')

  const data: any = {}
  if (args.toEmail !== undefined) {
    const to = String(args.toEmail).trim()
    if (!/@/.test(to)) throw new Error('Valid recipient address required')
    data.toEmail = to
    // Fix the greeting to match the new person.
    if (args.toName && d.body) {
      const first = String(args.toName).trim().split(/\s+/)[0]
      if (first) data.body = d.body.replace(/^Hi [^,\n]{0,60},/, `Hi ${first},`)
    }
  }
  if (args.cc !== undefined) {
    const clean = (Array.isArray(args.cc) ? args.cc : [])
      .map(a => String(a).trim()).filter(a => /@/.test(a))
    const seen = new Set<string>()
    const deduped = clean.filter(a => {
      const k = a.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    data.ccEmails = deduped.length ? JSON.stringify(deduped) : null
  }
  if (Object.keys(data).length === 0) return d
  return prisma.emailMessage.update({ where: { id: emailId }, data })
}

export async function listEmailQueue() {
  const include = { target: { include: { brand: { select: { id: true, name: true, category: true } }, contact: { select: { name: true, title: true, email: true } } } } }
  // Drafts also carry every contact we have at the brand, so the UI can
  // offer "send to someone else / add someone" without a second call.
  const draftInclude = { target: { include: {
    brand: { select: { id: true, name: true, category: true,
      contacts: { select: { id: true, name: true, title: true, email: true }, where: { email: { not: null } }, orderBy: { name: 'asc' as const } } } },
    contact: { select: { name: true, title: true, email: true } },
  } } }
  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['draft', 'approved'] } },
    include: draftInclude, orderBy: { createdAt: 'asc' },
  })
  const recent = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['sent', 'failed'] } },
    include, orderBy: { sentAt: 'desc' }, take: 20,
  })
  const replies = await prisma.emailMessage.findMany({
    where: { direction: 'in' },
    include, orderBy: { createdAt: 'desc' }, take: 20,
  })
  const exhausted = await listExhausted().catch(() => [])
  return { drafts, recent, replies, exhausted }
}
