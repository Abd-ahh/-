// Cumulative running list of extracted fields per conversation (e.g. a
// growing "1- name / passport number, 2- ..." list an office can copy in
// bulk after several passport submissions). Auto-resent after every new
// passport + available on demand via the "القائمة" command. Resets after a
// configurable number of hours per office (default 24h).
import { AVAILABLE_FIELDS } from './fields'

const DEFAULT_FIELDS = ['full_name_ar', 'passport_number']

// `started_at` is stored as `new Date().toISOString()` (already ends in "Z",
// e.g. "2026-08-23T18:13:25.088Z") when a list is created fresh here, but as
// a bug-fix safety net we also accept SQLite's `datetime('now')` format
// (space-separated, no "Z", e.g. "2026-08-23 18:13:25") in case any old rows
// were written differently. BUG HISTORY: this used to unconditionally append
// "Z" to the stored value before parsing, which turned an already-ISO string
// into "...088ZZ" — an INVALID Date whose age comparison (NaN < resetHours)
// always evaluated to false, silently resetting the cumulative list back to
// a single item on every single passport instead of accumulating them.
export function parseStoredTimestamp(value: string): Date {
  const iso = value.includes('T') ? value : value.replace(' ', 'T')
  return new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
}

export function parseCumulativeFields(raw: string | null | undefined): string[] {
  if (!raw) return DEFAULT_FIELDS
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_FIELDS
    const valid = arr.filter((k) => AVAILABLE_FIELDS.some((f) => f.key === k))
    return valid.length > 0 ? valid : DEFAULT_FIELDS
  } catch {
    return DEFAULT_FIELDS
  }
}

export function normalizeCumulativeFields(input: unknown): string | null {
  if (!Array.isArray(input)) return null
  const valid = input.filter((k) => typeof k === 'string' && AVAILABLE_FIELDS.some((f) => f.key === k))
  if (valid.length === 0) return null
  return JSON.stringify(valid)
}

// Appends the newly extracted item to the conversation's cumulative list,
// resetting it first if `cumulative_list_reset_hours` has elapsed since the
// list started. Returns the full, updated list of items (oldest first) so
// the caller can build the reply message.
export async function appendToCumulativeList(
  DB: D1Database,
  customerId: number,
  conversationKey: string,
  resetHours: number,
  fieldKeys: string[],
  extraction: any
): Promise<any[]> {
  const item: Record<string, string> = {}
  for (const key of fieldKeys) {
    if (extraction[key]) item[key] = extraction[key]
  }

  const existing = await DB.prepare(
    'SELECT * FROM cumulative_lists WHERE customer_id = ? AND conversation_key = ?'
  ).bind(customerId, conversationKey).first<any>()

  let items: any[] = []
  let startedAt = new Date().toISOString()

  if (existing) {
    const ageHours = (Date.now() - parseStoredTimestamp(existing.started_at).getTime()) / (1000 * 60 * 60)
    if (!Number.isNaN(ageHours) && ageHours < resetHours) {
      try {
        items = JSON.parse(existing.items_json) || []
      } catch {
        items = []
      }
      startedAt = existing.started_at
    }
    // else: expired, start fresh (items stays [], startedAt stays "now")
  }

  items.push(item)

  await DB.prepare(
    `INSERT INTO cumulative_lists (customer_id, conversation_key, items_json, started_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(customer_id, conversation_key) DO UPDATE SET items_json=excluded.items_json, started_at=excluded.started_at, updated_at=datetime('now')`
  ).bind(customerId, conversationKey, JSON.stringify(items), startedAt).run()

  return items
}

export async function getCumulativeList(
  DB: D1Database,
  customerId: number,
  conversationKey: string,
  resetHours: number
): Promise<any[]> {
  const existing = await DB.prepare(
    'SELECT * FROM cumulative_lists WHERE customer_id = ? AND conversation_key = ?'
  ).bind(customerId, conversationKey).first<any>()
  if (!existing) return []
  const ageHours = (Date.now() - parseStoredTimestamp(existing.started_at).getTime()) / (1000 * 60 * 60)
  if (Number.isNaN(ageHours) || ageHours >= resetHours) return []
  try {
    return JSON.parse(existing.items_json) || []
  } catch {
    return []
  }
}

// Builds the numbered "1- ... 2- ..." message from accumulated items,
// reusing the same field labels used in individual result replies.
export function buildCumulativeListMessage(items: any[], lang: 'ar' | 'en', fieldKeys: string[]): string {
  const header = lang === 'en' ? `📋 Cumulative list (${items.length}):` : `📋 القائمة التراكمية (${items.length}):`
  if (items.length === 0) {
    return lang === 'en' ? `${header}\n(empty)` : `${header}\n(فارغة)`
  }
  const fields = AVAILABLE_FIELDS.filter((f) => fieldKeys.includes(f.key))
  const lines = [header, '']
  items.forEach((item, idx) => {
    const parts = fields.map((f) => item[f.key]).filter(Boolean)
    lines.push(`${idx + 1}- ${parts.join(' - ')}`)
  })
  return lines.join('\n')
}
