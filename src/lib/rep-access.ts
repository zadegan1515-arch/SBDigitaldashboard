// Accounts that see only Elizabeth's part (Leo, Oct 21 2026: "her own
// sign-in, sees only her part"). Operations → Team marks an email
// (Setting repAccounts, founding members only); that account's requests go
// only to her handlers (REP_FNS in /api/data), and the Google connects and
// ops attachments refuse it. Read through a 30 s memo per server.

import { PrismaClient } from '@prisma/client'
import { cleanAccounts, REP_ACCOUNTS_KEY, type RepAccount } from './rep-outreach'

let memo: { at: number; map: Record<string, RepAccount> } = { at: 0, map: {} }

type SettingDb = Pick<PrismaClient, 'setting'>

export async function readRepAccounts(db: SettingDb, fresh = false): Promise<Record<string, RepAccount>> {
  if (!fresh && Date.now() - memo.at < 30e3) return memo.map
  const row = await db.setting.findUnique({ where: { key: REP_ACCOUNTS_KEY } })
  let v: unknown = null
  try { v = row ? JSON.parse(row.value) : null } catch { v = null }
  memo = { at: Date.now(), map: cleanAccounts(v) }
  return memo.map
}
export function forgetRepAccounts() { memo = { at: 0, map: {} } }

// The rep this signed-in email is limited to, or null for a full account.
export async function repAccountOf(db: SettingDb, email: string | null | undefined): Promise<string | null> {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return null
  const map = await readRepAccounts(db)
  return map[e]?.rep ?? null
}

export const REP_ONLY_MESSAGE = 'This account opens only Elizabeth’s outreach.'
