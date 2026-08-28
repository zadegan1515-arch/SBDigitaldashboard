// src/lib/notion.ts
//
// Pulls the team's deal list from Notion ("Projects" database) into the
// Pipeline, nightly (via the morning cron) and on demand (the Pipeline
// page's Sync button). Notion is the source of truth for these rows:
// name and stage are overwritten on every sync; dollar values live only
// on the site and are never touched.
//
// Setup: create an internal integration at notion.so/my-integrations,
// connect it to the Projects database (••• → Connections), and put its
// secret in Vercel as NOTION_TOKEN.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const NOTION_DB = process.env.NOTION_DEALS_DB || '3a69184c05cc80bfaad1e16677c8eb64'

// Notion stage → pipeline stage.
const STAGE_MAP: Record<string, string> = {
  'Idea': 'conversation',
  'Planning': 'proposal',
  'In Progress': 'verbal',
  'Complete': 'closed',
  'Archived': 'lost',
}

export function notionConfigured(): boolean {
  return !!process.env.NOTION_TOKEN
}

async function notionQuery(cursor?: string): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
  })
  if (!res.ok) {
    const t = await res.text()
    if (res.status === 401) throw new Error('Notion token rejected — check NOTION_TOKEN in Vercel.')
    if (res.status === 404) throw new Error('Notion database not found — connect the integration to the Projects database (••• → Connections).')
    throw new Error(`Notion API ${res.status}: ${t.slice(0, 200)}`)
  }
  return res.json()
}

export async function syncNotionDeals() {
  if (!notionConfigured()) {
    return { configured: false, synced: 0, created: 0, skipped: [], hint: 'Add NOTION_TOKEN in Vercel (notion.so/my-integrations), connect it to the Projects database, redeploy.' }
  }

  // Pull every row.
  const pages: any[] = []
  let cursor: string | undefined
  do {
    const r = await notionQuery(cursor)
    pages.push(...(r.results ?? []))
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor && pages.length < 500)

  let synced = 0, created = 0
  const skipped: string[] = []

  for (const page of pages) {
    const name: string = (page.properties?.Name?.title ?? []).map((t: any) => t.plain_text).join('').trim()
    const notionStage: string = page.properties?.Stage?.select?.name ?? ''
    const url: string = page.url
    if (!name || !url) continue

    const stage = STAGE_MAP[notionStage] ?? 'conversation'

    // Which brand is this? "Venmo Proposal" → Venmo. A row that matches
    // no brand and doesn't look like a brand deal (e.g. "Website
    // Redesign") is skipped — internal projects don't belong in a
    // sponsorship pipeline.
    const brandName = name.replace(/\s+proposal$/i, '').trim()
    let brand = await prisma.brand.findFirst({ where: { name: { equals: brandName, mode: 'insensitive' } } })
    if (!brand) {
      // Second try: collapse spaces ("Wavy Talk" → "Wavytalk").
      brand = await prisma.brand.findFirst({ where: { name: { equals: brandName.replace(/\s+/g, ''), mode: 'insensitive' } } })
    }
    if (!brand && /proposal$/i.test(name)) {
      brand = await prisma.brand.create({ data: { name: brandName, source: 'notion', tier: 'established' } })
    }
    if (!brand) { skipped.push(name); continue }

    const existing = await (prisma as any).deal.findFirst({ where: { externalRef: url } })
    if (existing) {
      await prisma.deal.update({ where: { id: existing.id }, data: { name, stage, brandId: brand.id } })
    } else {
      await (prisma as any).deal.create({
        data: { brandId: brand.id, name, stage, valueCents: 0, source: 'notion', externalRef: url },
      })
      created++
    }
    synced++
  }

  return { configured: true, synced, created, skipped }
}
