// Group invite-link -> JID resolver (migration 0019, requested 2026-10-07).
// See the full rationale in src/routes/webhook.ts's
// /group-resolve-jobs/* handlers — this module is the shared
// create-job/poll-job logic used by both admin.ts (platform admin, any
// office) and customer.ts (office self-service, own office only).
//
// Accepts a pasted WhatsApp group invite link so a non-technical user never
// needs to know/paste the raw JID (e.g. "1203630XXXXXXXXXX@g.us").

const INVITE_LINK_RE = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,32})/i

// Extracts the invite code from a full link, or accepts a bare code typed
// directly (useful if a user only copies the code portion). Returns null
// if the input doesn't look like either.
export function parseInviteCode(input: string): string | null {
  const trimmed = (input || '').trim()
  if (!trimmed) return null
  const match = trimmed.match(INVITE_LINK_RE)
  if (match) return match[1]
  // Bare code fallback: WhatsApp invite codes are alphanumeric, 10-32 chars,
  // no spaces/slashes — reject anything that doesn't look like one so we
  // don't silently queue a job that can never resolve.
  if (/^[A-Za-z0-9]{10,32}$/.test(trimmed)) return trimmed
  return null
}

export async function createGroupResolveJob(DB: D1Database, customerId: number, inviteLinkOrCode: string): Promise<{ id: number } | { error: string }> {
  const code = parseInviteCode(inviteLinkOrCode)
  if (!code) return { error: 'رابط/رمز دعوة المجموعة غير صالح. الصق رابطاً بصيغة https://chat.whatsapp.com/XXXXXXXXXX' }

  const result = await DB.prepare(
    `INSERT INTO group_resolve_jobs (customer_id, invite_code, status) VALUES (?, ?, 'pending')`
  ).bind(customerId, code).run()
  return { id: result.meta.last_row_id as number }
}

export interface GroupResolveJobStatus {
  id: number
  status: 'pending' | 'resolving' | 'resolved' | 'failed'
  resolved_jid: string | null
  resolved_group_name: string | null
  resolved_bridge_number_id: number | null
  error: string | null
}

export async function getGroupResolveJob(DB: D1Database, id: number, customerId: number): Promise<GroupResolveJobStatus | null> {
  const row = await DB.prepare(
    `SELECT id, status, resolved_jid, resolved_group_name, resolved_bridge_number_id, error
     FROM group_resolve_jobs WHERE id = ? AND customer_id = ?`
  ).bind(id, customerId).first<GroupResolveJobStatus>()
  return row || null
}
