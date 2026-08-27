// GET /api/track?e=<emailId> — the open-tracking pixel.
//
// Every outgoing email's HTML embeds a 1x1 transparent GIF pointing
// here. When a recipient's mail client loads images, this fires once
// per open and bumps opens/openedAt on that EmailMessage. Deliberately
// outside the auth middleware (recipients aren't logged in), and it
// only ever increments counters on already-sent mail — nothing to
// abuse. Always answers with the pixel, even for junk ids, so mail
// clients never see a broken image.

import { NextRequest, NextResponse } from 'next/server'
import { recordOpen } from '@/lib/email'

export const dynamic = 'force-dynamic'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('e')
  if (id) await recordOpen(id)
  return new NextResponse(GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Content-Length': String(GIF.length),
    },
  })
}
