// src/lib/coverage-db.ts — the database side of coverage.ts: reads the
// LinkedIn fill's visit log and Leo's page answers once, then says where
// each brand stands. /api/data (listBrands for the roster, buyerCoverage
// for All brands' card) and /api/reports/linkedin (counts only, for the
// morning check) use it, so every place counts the same way.

import type { PrismaClient } from '@prisma/client'
import { coverOf, coverCounts, type Cover, type CoverCounts } from './coverage'
import { readLiLog, type LiLog } from './li-sweep'
import { readJsonSetting, LI_REVIEW_KEY, LI_CONFIRMED_KEY, type Review, type Confirmed } from './li-review'
import { parentOf } from './parents'

// How many people we keep on file per brand — CONTACT_CAP_PER_BRAND in
// /api/data and /api/ingest.
export const COVER_CAP = 25

export type CoverFacts = { log: LiLog; review: Review; confirmed: Confirmed }

export async function readCoverFacts(db: PrismaClient): Promise<CoverFacts> {
  const [log, review, confirmed] = await Promise.all([
    readLiLog(db),
    readJsonSetting<Review>(db, LI_REVIEW_KEY, {}),
    readJsonSetting<Confirmed>(db, LI_CONFIRMED_KEY, {}),
  ])
  return { log, review, confirmed }
}

export type CoverBrand = {
  id: string
  name: string
  aka?: string | null
  linkedinUrl?: string | null
  passedAt?: Date | string | null
  doNotEmail?: boolean | null
  titles: Array<string | null | undefined>
}

export function brandCover(b: CoverBrand, f: CoverFacts, now = Date.now()): Cover {
  return coverOf({
    passedAt: b.passedAt,
    doNotEmail: b.doNotEmail,
    titles: b.titles,
    linkedinUrl: b.linkedinUrl,
    hasParent: !!parentOf(b.name, b.aka ?? null),
    mark: f.log[b.id],
    inReview: !!f.review[b.id],
    confirmed: f.confirmed[b.id] ?? null,
  }, { cap: COVER_CAP, now })
}

// Every brand's state, counted — no names, no people.
export async function readCoverCounts(db: PrismaClient): Promise<CoverCounts> {
  const [brands, facts] = await Promise.all([
    db.brand.findMany({
      select: {
        id: true, name: true, aka: true, linkedinUrl: true, passedAt: true, doNotEmail: true,
        contacts: { select: { title: true } },
      },
    }),
    readCoverFacts(db),
  ])
  const now = Date.now()
  return coverCounts(brands.map(b => brandCover({ ...b, titles: b.contacts.map(c => c.title) }, facts, now)))
}
