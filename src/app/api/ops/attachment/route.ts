// GET /api/ops/attachment?m=<opsMessageId>&a=<attachmentId>
// Streams one attachment from the ops mailbox to a signed-in user.
// Nothing is cached server-side; Gmail stays the system of record.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { PrismaClient } from '@prisma/client'
import { authOptions } from '@/lib/auth'
import { opsGetAttachment } from '@/lib/google'

const prisma = new PrismaClient()
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session: any = await getServerSession(authOptions)
  if (!session?.user?.email) return NextResponse.json({ ok: false, error: 'Sign in first' }, { status: 401 })
  const m = req.nextUrl.searchParams.get('m') || ''
  const a = req.nextUrl.searchParams.get('a') || ''
  const row = await prisma.opsMessage.findUnique({ where: { id: m }, select: { gmailId: true, attachments: true } })
  if (!row) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  const meta = (JSON.parse(row.attachments || '[]') as any[]).find(x => x.id === a)
  if (!meta) return NextResponse.json({ ok: false, error: 'No such attachment' }, { status: 404 })
  try {
    const bytes = await opsGetAttachment(row.gmailId, a)
    const inline = /^(application\/pdf|image\/)/.test(meta.mimeType || '')
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': meta.mimeType || 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(meta.filename).replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 502 })
  }
}
