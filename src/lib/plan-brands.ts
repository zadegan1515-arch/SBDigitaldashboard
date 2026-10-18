// src/lib/plan-brands.ts
//
// The brand list behind the Schedule: every field "who would go out, and
// why not" reads (src/app/api/data/route.ts — the Schedule, the Fill
// boxes, Plan my week, today's Best fit fill, the category drill-in).
//
// One select so every handler that answers those questions reads the
// same fields and can't drift apart. loadPlanBrands answers with exactly
// what prisma.brand.findMany({ select: PLAN_BRAND_SELECT }) would, from
// flat reads instead of one nested read (roster-loader, Oct 2026): the
// nested read spent most of its time building nested objects (Postgres
// was ~15 ms of ~400 ms at 1,500 brands); the flat reads give the same
// rows in under half the time.
// E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-plan-brands-e2e.js

import { Prisma, type PrismaClient } from '@prisma/client'

const BRAND_FIELDS = {
  id: true, name: true, aka: true, category: true, tier: true, workPeople: true,
  website: true, linkedinUrl: true, externalId: true,
  passedAt: true, passedTodayAt: true, passedUntil: true, doNotEmail: true, stoppedAt: true,
  // Brand Fit facts (brandFit in route.ts) — the Fill box and Plan my
  // week rank and hide by them.
  liMembers: true, salesCents: true, fundingCents: true, lastRoundAt: true, usStatus: true,
  sponsorsCollege: true, bizStatus: true, acquiredBy: true, researchedAt: true,
  // Where it's based (abroad.ts — people outside the US stay out of the picks
  // unless the company is based abroad).
  hq: true,
  // What the brand says it is, for Brand Fit's student fit (student-fit.ts).
  about: true, topProducts: true, notes: true,
} as const
const CONTACT_FIELDS = { id: true, name: true, title: true, email: true, linkedinUrl: true, isDecisionMaker: true, doNotContactAt: true, location: true } as const
const TARGET_FIELDS = {
  id: true, status: true, shelved: true, shelvedHow: true, queuedFor: true, sentAt: true, repliedAt: true,
  emailedAt: true, updatedAt: true, fitScore: true, contactId: true,
} as const
// An email the machine actually sent counts as reaching the brand, same
// as a LinkedIn invite; the first one's date starts the brand's two-week
// rest (queue-rules.ts).
// queueBrandTargets reads the same two fields, so the queue and its
// preview agree on when a brand's first outreach was.
export const SENT_EMAIL = { direction: 'out', status: 'sent' }

export const PLAN_BRAND_SELECT = Prisma.validator<Prisma.BrandSelect>()({
  ...BRAND_FIELDS,
  contacts: { select: CONTACT_FIELDS },
  targets: {
    select: {
      ...TARGET_FIELDS,
      contact: { select: { name: true, title: true } },
      _count: { select: { emails: { where: SENT_EMAIL } } },
      emails: { where: SENT_EMAIL, select: { sentAt: true }, orderBy: { sentAt: 'asc' }, take: 1 },
    },
  },
})
export type PlanBrand = Prisma.BrandGetPayload<{ select: typeof PLAN_BRAND_SELECT }>

// What the loader needs of a Prisma client (the app's, a transaction's,
// or a test's).
type Db = Pick<PrismaClient, 'brand' | 'contact' | 'target' | 'emailMessage'>

type ContactRow = PlanBrand['contacts'][number]
type TargetRow = PlanBrand['targets'][number]

// The brands `where` picks (every brand without it), each with its
// contacts and targets — the same rows, the same order, the same shape as
// the nested read. The brands first, then their contacts and targets by
// brand id in the very statements the nested read sends (the targets with
// the same sent-email count joined on): rows come back in whatever order
// Postgres's plan gives — a filtered read's targets in the join's, not the
// table's — so the same statements are what keeps the order the same.
// Only the nested contact and first-email reads, where the time went, are
// rebuilt here.
export async function loadPlanBrands(client: Db, where?: Prisma.BrandWhereInput): Promise<PlanBrand[]> {
  // Untyped inside: groupBy's generic types loop on a built-up argument,
  // and the test checks every row against the nested read anyway.
  const db = client as any
  const brands: any[] = await db.brand.findMany({ ...(where ? { where } : {}), select: BRAND_FIELDS })
  if (!brands.length) return []
  const ids = brands.map(b => b.id)
  const [contacts, targets, emails]: any[][] = await Promise.all([
    db.contact.findMany({ where: { brandId: { in: ids } }, select: { ...CONTACT_FIELDS, brandId: true } }),
    db.target.findMany({
      where: { brandId: { in: ids } },
      select: { ...TARGET_FIELDS, brandId: true, _count: { select: { emails: { where: SENT_EMAIL } } } },
    }),
    // The first sent email's date per target (the whole roster: every
    // target's, no filter needed).
    db.emailMessage.groupBy({
      by: ['targetId'], where: { ...SENT_EMAIL, ...(where ? { target: { brandId: { in: ids } } } : {}) }, _min: { sentAt: true },
    }),
  ])

  const contactsOf = new Map<string, ContactRow[]>()
  const nameOf = new Map<string, { name: string; title: string | null }>()
  for (const { brandId, ...c } of contacts) {
    const list = contactsOf.get(brandId)
    if (list) list.push(c)
    else contactsOf.set(brandId, [c])
    nameOf.set(c.id, { name: c.name, title: c.title })
  }
  // A target whose person is on file at a brand outside `where` (moved
  // since): read those few by id, as the nested read does.
  const missing = [...new Set(targets.map(t => t.contactId).filter(id => !nameOf.has(id)))]
  if (missing.length) {
    for (const c of await db.contact.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, title: true } })) {
      nameOf.set(c.id, { name: c.name, title: c.title })
    }
  }
  const firstSent = new Map<string, Date | null>(emails.map(e => [e.targetId, e._min?.sentAt ?? null]))
  const targetsOf = new Map<string, TargetRow[]>()
  for (const { brandId, _count, ...t } of targets) {
    const n = _count?.emails ?? 0
    const who = nameOf.get(t.contactId)
    const row: TargetRow = {
      ...t,
      contact: who ? { name: who.name, title: who.title } : (null as any),
      _count: { emails: n },
      emails: n ? [{ sentAt: firstSent.get(t.id) ?? null }] : [],
    }
    const list = targetsOf.get(brandId)
    if (list) list.push(row)
    else targetsOf.set(brandId, [row])
  }
  return brands.map(b => ({ ...b, contacts: contactsOf.get(b.id) ?? [], targets: targetsOf.get(b.id) ?? [] }))
}
