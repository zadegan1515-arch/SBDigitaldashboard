// The calls the dashboard makes to Instantly's API v2
// (https://developer.instantly.ai — read Nov 16 2026). Bearer key from
// INSTANTLY_API_KEY in Vercel; the key is never logged, returned or stored.
// INSTANTLY_API_URL points the calls somewhere else (the tests' fake server).
//
// Paths used:
//   GET    /api/v2/campaigns                      list (id, name, status…)
//   GET    /api/v2/campaigns/{id}
//   POST   /api/v2/leads/add                      up to 1,000 leads into a campaign
//   POST   /api/v2/leads/list                     leads of a campaign / by address
//   DELETE /api/v2/leads/{id}
//   POST   /api/v2/block-lists-entries/bulk-create
//   GET    /api/v2/emails                         sent / received (20 calls a minute)
//   GET | POST | DELETE /api/v2/webhooks

import { HOOK_HEADER, INSTANTLY_KEY_ENV, type Campaign, type InstantlyLeadIn, type InstantlyLeadOut } from './instantly'

const base = () => (process.env.INSTANTLY_API_URL || 'https://api.instantly.ai').replace(/\/+$/, '')
const key = () => String(process.env[INSTANTLY_KEY_ENV] || '').trim()
export const instantlyKeySet = () => key().length > 0

export class InstantlyError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'InstantlyError' }
}

// What went wrong, in words Leo can act on.
function words(status: number, detail: string): string {
  if (status === 401) return 'Instantly didn’t accept the key — check ' + INSTANTLY_KEY_ENV + ' in Vercel (it may have been revoked)'
  if (status === 402) return 'Instantly says this workspace has no active paid plan'
  if (status === 403) return 'The Instantly key is missing a permission' + (detail ? ' (' + detail + ')' : '') + ' — make a new key with the scopes on the card'
  if (status === 429) return 'Instantly is busy (rate limit) — try again in a minute'
  if (status >= 500) return 'Instantly had a problem on its side (HTTP ' + status + ') — try again in a minute'
  return 'Instantly refused that' + (detail ? ': ' + detail : ' (HTTP ' + status + ')')
}

type CallOpts = { query?: Record<string, string | number | boolean | null | undefined>; body?: unknown; timeoutMs?: number }
async function call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: CallOpts = {}): Promise<T> {
  const k = key()
  if (!k) throw new InstantlyError(0, 'Instantly isn’t connected yet — ' + INSTANTLY_KEY_ENV + ' isn’t set in Vercel')
  const qs = new URLSearchParams()
  for (const [name, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined && v !== '') qs.set(name, String(v))
  const url = base() + path + (qs.size ? '?' + qs.toString() : '')
  const send = () => fetch(url, {
    method,
    headers: { authorization: 'Bearer ' + k, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    cache: 'no-store',
  })
  let res: Response
  try {
    res = await send()
    // One quiet retry on a rate limit or a hiccup on their side.
    if (res.status === 429 || res.status >= 502) {
      await new Promise(r => setTimeout(r, 1500))
      res = await send()
    }
  } catch (err: any) {
    throw new InstantlyError(0, 'Couldn’t reach Instantly' + (err?.name === 'TimeoutError' ? ' (it took too long)' : '') + ' — try again in a minute')
  }
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!res.ok) throw new InstantlyError(res.status, words(res.status, typeof json?.message === 'string' ? json.message.slice(0, 200) : ''))
  return json as T
}

type Page<T> = { items: T[]; next_starting_after?: string | null }
const items = <T>(r: Page<T> | null | undefined): T[] => (r && Array.isArray(r.items) ? r.items : [])

// ---- campaigns -------------------------------------------------------

export async function listCampaigns(max = 300): Promise<Campaign[]> {
  const out: Campaign[] = []
  let after: string | undefined
  while (out.length < max) {
    const r = await call<Page<Campaign>>('GET', '/api/v2/campaigns', { query: { limit: 100, starting_after: after } })
    out.push(...items(r))
    if (!r?.next_starting_after || !items(r).length) break
    after = r.next_starting_after
  }
  return out
}
export async function getCampaign(id: string): Promise<Campaign> {
  return call<Campaign>('GET', '/api/v2/campaigns/' + encodeURIComponent(id))
}

// ---- leads -----------------------------------------------------------

export type AddResult = {
  status?: string; total_sent?: number; leads_uploaded?: number; in_blocklist?: number; duplicated_leads?: number; skipped_count?: number
  invalid_email_count?: number; duplicate_email_count?: number; remaining_in_plan?: number | null
  created_leads?: Array<{ index: number; id: string; email?: string | null }>
}
// Into one campaign. A lead already in any campaign of the workspace is
// skipped (nobody gets two sequences); Instantly's own block list is always
// checked. `idempotencyKey` makes a retry of the same call safe.
export async function addLeads(campaignId: string, leads: InstantlyLeadIn[], idempotencyKey: string): Promise<AddResult> {
  return call<AddResult>('POST', '/api/v2/leads/add', {
    body: { campaign_id: campaignId, leads, skip_if_in_campaign: true, idempotency_key: idempotencyKey.slice(0, 128) },
    timeoutMs: 45000,
  })
}
export async function listLeads(args: { campaign?: string; contacts?: string[]; starting_after?: string; limit?: number }): Promise<Page<InstantlyLeadOut>> {
  const body: Record<string, unknown> = { limit: Math.min(100, Math.max(1, args.limit ?? 100)) }
  if (args.campaign) body.campaign = args.campaign
  if (args.contacts?.length) body.contacts = args.contacts
  if (args.starting_after) body.starting_after = args.starting_after
  const r = await call<Page<InstantlyLeadOut>>('POST', '/api/v2/leads/list', { body })
  return { items: items(r), next_starting_after: r?.next_starting_after ?? null }
}
// Gone already counts as gone.
export async function deleteLead(id: string): Promise<boolean> {
  try { await call('DELETE', '/api/v2/leads/' + encodeURIComponent(id)); return true } catch (err) {
    if (err instanceof InstantlyError && err.status === 404) return true
    throw err
  }
}
// Several leads out of one campaign in one call (DELETE /api/v2/leads).
export async function deleteLeads(campaignId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await call('DELETE', '/api/v2/leads', { body: { campaign_id: campaignId, ids: ids.slice(i, i + 500) }, timeoutMs: 45000 })
  }
}
export async function blockEmails(values: string[]): Promise<void> {
  for (let i = 0; i < values.length; i += 1000) {
    await call('POST', '/api/v2/block-lists-entries/bulk-create', { body: { bl_values: values.slice(i, i + 1000) } })
  }
}

// ---- emails ----------------------------------------------------------

export type InstantlyEmail = {
  id: string; timestamp_email?: string | null; timestamp_created?: string | null; subject?: string | null
  from_address_email?: string | null; eaccount?: string | null; lead?: string | null; campaign_id?: string | null
  ue_type?: number | null; step?: string | null; is_auto_reply?: number | null; body?: { text?: string | null } | null
}
// A campaign's emails of one kind since a moment, oldest first.
export async function listEmails(args: { campaignId: string; type: 'sent' | 'received'; since?: Date | null; starting_after?: string }): Promise<Page<InstantlyEmail>> {
  const r = await call<Page<InstantlyEmail>>('GET', '/api/v2/emails', {
    query: {
      campaign_id: args.campaignId, email_type: args.type, sort_order: 'asc', limit: 100,
      min_timestamp_created: args.since ? args.since.toISOString() : undefined, starting_after: args.starting_after,
    },
  })
  return { items: items(r), next_starting_after: r?.next_starting_after ?? null }
}

// ---- webhooks --------------------------------------------------------

export type Webhook = { id: string; target_hook_url: string; event_type?: string | null; name?: string | null; status?: number | null; timestamp_error?: string | null }
export async function listWebhooks(): Promise<Webhook[]> {
  return items(await call<Page<Webhook>>('GET', '/api/v2/webhooks', { query: { limit: 100 } }))
}
// Every event of the workspace to one address; our secret rides in a header
// Instantly sends back with each delivery.
export async function createWebhook(url: string, secret: string): Promise<Webhook> {
  return call<Webhook>('POST', '/api/v2/webhooks', {
    body: { target_hook_url: url, event_type: 'all_events', name: 'SB Command Center', headers: { [HOOK_HEADER]: secret } },
  })
}
export async function deleteWebhook(id: string): Promise<void> {
  try { await call('DELETE', '/api/v2/webhooks/' + encodeURIComponent(id)) } catch (err) {
    if (!(err instanceof InstantlyError && err.status === 404)) throw err
  }
}
