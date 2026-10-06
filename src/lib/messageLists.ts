// Feature: Message Lists (قوائم رسائل) — scheduled WhatsApp broadcast lists.
//
// Cloudflare Pages has no native cron/scheduled-handler support (confirmed
// 2026-08-23), so scheduling follows the exact same pattern already used for
// the Umrah visa periodic checker: an external VPS process (the Baileys
// bridge, see bridge/bridge.js) polls a Worker endpoint on a timer —
// GET /webhook/message-lists/tick, once per minute — and this module decides
// which lists are due right now and fires them.
//
// Delivery reuses group_outbox (migration 0007) as-is: Baileys'
// sock.sendMessage(jid, ...) works identically whether `jid` is a group
// (...@g.us) or an individual number (...@s.whatsapp.net), so no bridge.js
// delivery-logic changes were needed — only the new tick-polling call.
import type { MessageListRow, MessageContactRow } from './types'

// The platform's original user base was Yemen + Saudi Arabia, both fixed
// UTC+3 with no DST — a constant offset was used instead of a timezone
// database to keep this dependency-free inside the Workers runtime. This
// default is kept for backward compatibility (every list created before
// migration 0019 defaults to timezone_offset_hours=3, identical behavior).
const DEFAULT_OFFSET_HOURS = 3

// Common fixed UTC offsets for the admin UI's country/timezone picker
// (migration 0019, "توقيت الرسائل الجماعية حسب البلد"). All are whole-hour,
// DST-free offsets — matches every country this platform currently serves
// or is likely to expand into. Kept as a flat list here (used by both
// admin.js and customer.js dropdowns via GET so it only needs to be
// maintained in one place).
export const COUNTRY_TIMEZONE_OPTIONS = [
  { offset: 3, label_ar: 'اليمن / السعودية / العراق (UTC+3)' },
  { offset: 4, label_ar: 'الإمارات / عمان (UTC+4)' },
  { offset: 2, label_ar: 'مصر / الأردن / فلسطين (UTC+2)' },
  { offset: 1, label_ar: 'ليبيا / تونس / الجزائر (UTC+1)' },
  { offset: 0, label_ar: 'المغرب (UTC+0)' }
]

// Returns "now" shifted by the given fixed UTC offset (hours), so the
// shifted Date's UTC getters (getUTCHours/getUTCDate/getUTCDay/...)
// directly represent that offset's local wall-clock time.
function offsetNow(offsetHours: number): Date {
  const utcMs = Date.now()
  return new Date(utcMs + offsetHours * 60 * 60 * 1000)
}

// Formats an offset-shifted Date's UTC getters as 'YYYY-MM-DD' (the shifted
// Date's UTC fields represent that offset's local wall-clock time).
function offsetDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDaysJson(raw: string | null): number[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

// Whether `list` should fire during this tick (called ~once/minute).
// Matches on the exact HH:MM (with a small tolerance window based on the
// poll interval) rather than "already past" to avoid re-sending hours later
// if the tick was briefly down — last_run_date is what actually prevents
// double-sends within the same day, this just decides day-of eligibility.
//
// Per-country timezone (migration 0019): "now" is computed USING THIS
// LIST'S OWN timezone_offset_hours (default 3 = the original Yemen/Saudi
// behavior), not a single shared platform-wide instant — two lists with
// different countries evaluate schedule_time against their own local
// wall-clock, independently. An explicit `nowOverride` param is kept only
// for deterministic unit testing (bypasses the per-list offset entirely).
export function isListDue(list: MessageListRow, toleranceMin = 2, nowOverride?: Date): boolean {
  if (!list.is_active) return false

  const offsetHours = Number.isFinite(list.timezone_offset_hours) ? list.timezone_offset_hours : DEFAULT_OFFSET_HOURS
  const now = nowOverride || offsetNow(offsetHours)

  const todayKey = offsetDateKey(now)
  if (list.last_run_date === todayKey) return false // already fired today

  const [schH, schM] = (list.schedule_time || '00:00').split(':').map((n) => parseInt(n, 10))
  if (!Number.isFinite(schH) || !Number.isFinite(schM)) return false
  const scheduledMinutes = schH * 60 + schM
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  // Only fire at/after the scheduled minute, within a short tolerance window
  // (covers the case where a tick is a little late) — never fire early.
  const diff = nowMinutes - scheduledMinutes
  if (diff < 0 || diff > toleranceMin) return false

  if (list.recurrence === 'daily') return true

  if (list.recurrence === 'weekly') {
    const days = parseDaysJson(list.schedule_days)
    // JS Date.getUTCDay() on our offset-shifted Date gives that offset's
    // local weekday (0=Sunday..6=Saturday), matching the convention
    // documented in the migration.
    return days.includes(now.getUTCDay())
  }

  if (list.recurrence === 'monthly') {
    const days = parseDaysJson(list.schedule_days)
    return days.includes(now.getUTCDate())
  }

  return false
}

// Converts a stored message_contacts row into the destination JID Baileys
// expects. Groups are already stored as a full JID; individual numbers are
// stored as bare digits and need the @s.whatsapp.net suffix.
export function contactToJid(contact: Pick<MessageContactRow, 'channel' | 'value'>): string {
  if (contact.channel === 'group') return contact.value
  const digits = (contact.value || '').replace(/\D/g, '')
  return `${digits}@s.whatsapp.net`
}

// Resolves every recipient for a list: explicit message_list_recipients
// entries UNIONed with every contact matching target_region (if set),
// de-duplicated by contact id. Resolved fresh on every send so a
// region-targeted list automatically includes newly-added agents.
export async function resolveListRecipients(DB: D1Database, list: MessageListRow): Promise<MessageContactRow[]> {
  const explicit = await DB.prepare(
    `SELECT mc.* FROM message_list_recipients r
     JOIN message_contacts mc ON mc.id = r.contact_id
     WHERE r.list_id = ?`
  ).bind(list.id).all<MessageContactRow>()

  const byId = new Map<number, MessageContactRow>()
  for (const c of explicit.results || []) byId.set(c.id, c)

  if (list.target_region && list.target_region.trim()) {
    const regional = await DB.prepare(
      `SELECT * FROM message_contacts WHERE customer_id = ? AND region = ?`
    ).bind(list.customer_id, list.target_region.trim()).all<MessageContactRow>()
    for (const c of regional.results || []) byId.set(c.id, c)
  }

  return Array.from(byId.values())
}

// ---------------------- Validation helpers (used by admin.ts / customer.ts routes) ----------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function validateScheduleTime(value: unknown): string | null {
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null
  return value
}

export function validateRecurrence(value: unknown): 'daily' | 'weekly' | 'monthly' | null {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : null
}

// Normalizes the recurrence-specific days array into a validated JSON string
// (or null for 'daily', where it's meaningless). weekly: 0-6 (Sun-Sat).
// monthly: 1-31.
export function normalizeScheduleDays(recurrence: string, raw: unknown): string | null {
  if (recurrence === 'daily') return null
  if (!Array.isArray(raw)) return null
  const max = recurrence === 'weekly' ? 6 : 31
  const min = recurrence === 'weekly' ? 0 : 1
  const cleaned = Array.from(new Set(raw.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= min && n <= max)))
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null
}

export interface TickResult {
  lists_checked: number
  lists_fired: number
  total_recipients_queued: number
}

// Resolves recipients and queues one group_outbox row per recipient, linked
// back to a message_list_send_log row via send_log_id so the bridge's
// existing ack call (POST /webhook/bridge/outbox/:id/ack) also updates
// delivery status for this feature without any bridge.js delivery changes.
// Shared by both the scheduled tick path and the manual "send now" action.
export async function fireMessageList(DB: D1Database, list: MessageListRow): Promise<{ run_id: number; recipients: number }> {
  const recipients = await resolveListRecipients(DB, list)

  const runResult = await DB.prepare(
    `INSERT INTO message_list_runs (list_id, total_recipients, status) VALUES (?, ?, 'running')`
  ).bind(list.id, recipients.length).run()
  const runId = runResult.meta.last_row_id as number

  for (const contact of recipients) {
    const jid = contactToJid(contact)

    // Multi-number bridge support (migration 0015): a 'group' contact must
    // be delivered through the SAME bridge number that group is actually
    // linked to (its own live Baileys socket), not the contact's own
    // bridge_number_id column (which only matters for channel='number').
    let bridgeNumberId = contact.bridge_number_id
    if (contact.channel === 'group') {
      const groupRow = await DB.prepare('SELECT bridge_number_id FROM whatsapp_groups WHERE group_jid = ?')
        .bind(contact.value).first<{ bridge_number_id: number }>()
      if (groupRow) bridgeNumberId = groupRow.bridge_number_id
    }

    const logResult = await DB.prepare(
      `INSERT INTO message_list_send_log (run_id, list_id, contact_id, name_snapshot, jid_snapshot, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    ).bind(runId, list.id, contact.id, contact.name, jid).run()
    const sendLogId = logResult.meta.last_row_id as number

    await DB.prepare(
      `INSERT INTO group_outbox (group_jid, kind, text, send_log_id, bridge_number_id) VALUES (?, 'text', ?, ?, ?)`
    ).bind(jid, list.message_text, sendLogId, bridgeNumberId).run()
  }

  // Mark done immediately — "sent_count"/"failed_count" are filled in
  // asynchronously as the bridge acks each group_outbox item (see
  // applyMessageListAck below); status='done' here just means "this list's
  // items have all been queued for delivery", not "delivered".
  await DB.prepare(`UPDATE message_list_runs SET status='done' WHERE id=?`).bind(runId).run()

  return { run_id: runId, recipients: recipients.length }
}

// The main entry point called by GET /webhook/message-lists/tick. Finds
// every active list, fires the ones due right now (updating last_run_date
// so the same list doesn't double-fire within the same day across multiple
// tick polls).
export async function runDueMessageLists(DB: D1Database): Promise<TickResult> {
  const active = await DB.prepare(`SELECT * FROM message_lists WHERE is_active = 1`).all<MessageListRow>()
  const lists = active.results || []

  let fired = 0
  let totalQueued = 0

  for (const list of lists) {
    // Per-country timezone (migration 0019): each list's due-check and
    // last_run_date stamp use ITS OWN offset, not one shared platform-wide
    // instant — see isListDue's doc comment.
    if (!isListDue(list)) continue
    const offsetHours = Number.isFinite(list.timezone_offset_hours) ? list.timezone_offset_hours : DEFAULT_OFFSET_HOURS
    const todayKey = offsetDateKey(offsetNow(offsetHours))

    const { recipients } = await fireMessageList(DB, list)

    await DB.prepare(
      `UPDATE message_lists SET last_run_date=?, updated_at=datetime('now') WHERE id=?`
    ).bind(todayKey, list.id).run()

    fired++
    totalQueued += recipients
  }

  return { lists_checked: lists.length, lists_fired: fired, total_recipients_queued: totalQueued }
}

// Called from the existing /webhook/bridge/outbox/:id/ack handler when a
// group_outbox row has send_log_id set — propagates the delivery result to
// message_list_send_log and increments the parent run's sent/failed
// counters, so the admin/customer UI can show live ✅/❌ results.
export async function applyMessageListAck(
  DB: D1Database,
  sendLogId: number,
  status: 'sent' | 'failed',
  error?: string
): Promise<void> {
  const log = await DB.prepare('SELECT * FROM message_list_send_log WHERE id = ?').bind(sendLogId).first<any>()
  if (!log) return

  await DB.prepare(
    `UPDATE message_list_send_log SET status=?, error=?, updated_at=datetime('now') WHERE id=?`
  ).bind(status, error || null, sendLogId).run()

  const column = status === 'sent' ? 'sent_count' : 'failed_count'
  await DB.prepare(
    `UPDATE message_list_runs SET ${column} = ${column} + 1 WHERE id = ?`
  ).bind(log.run_id).run()
}

// ---------------------- Shared CRUD helpers (used by both admin.ts, scoped to any customer_id, and customer.ts, scoped to the logged-in customer only) ----------------------

export async function listContacts(DB: D1Database, customerId: number) {
  const rows = await DB.prepare(
    `SELECT * FROM message_contacts WHERE customer_id = ? ORDER BY region IS NULL, region, name COLLATE NOCASE`
  ).bind(customerId).all<MessageContactRow>()
  return rows.results || []
}

export interface ContactInput {
  name: string
  channel: 'number' | 'group'
  value: string
  region?: string | null
  // Multi-number bridge support (migration 0015). Only meaningful for
  // channel='number' (group-channel contacts are routed via their own
  // group's whatsapp_groups.bridge_number_id instead). Defaults to 1 (the
  // original/default number) when omitted.
  bridge_number_id?: number | null
}

export async function createContact(DB: D1Database, customerId: number, input: ContactInput): Promise<number> {
  const channel = input.channel === 'group' ? 'group' : 'number'
  const value = channel === 'number' ? (input.value || '').replace(/\D/g, '') : (input.value || '').trim()
  const bridgeNumberId = input.bridge_number_id || 1
  const result = await DB.prepare(
    `INSERT INTO message_contacts (customer_id, name, channel, value, region, bridge_number_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(customerId, input.name.trim(), channel, value, input.region?.trim() || null, bridgeNumberId).run()
  return result.meta.last_row_id as number
}

export async function updateContact(DB: D1Database, id: number, customerId: number, input: Partial<ContactInput>): Promise<boolean> {
  const existing = await DB.prepare('SELECT * FROM message_contacts WHERE id = ? AND customer_id = ?').bind(id, customerId).first<MessageContactRow>()
  if (!existing) return false
  const name = input.name !== undefined ? input.name.trim() : existing.name
  const channel = input.channel !== undefined ? (input.channel === 'group' ? 'group' : 'number') : existing.channel
  const rawValue = input.value !== undefined ? input.value : existing.value
  const value = channel === 'number' ? (rawValue || '').replace(/\D/g, '') : (rawValue || '').trim()
  const region = input.region !== undefined ? (input.region?.trim() || null) : existing.region
  const bridgeNumberId = input.bridge_number_id !== undefined ? (input.bridge_number_id || 1) : existing.bridge_number_id
  await DB.prepare(
    `UPDATE message_contacts SET name=?, channel=?, value=?, region=?, bridge_number_id=? WHERE id=?`
  ).bind(name, channel, value, region, bridgeNumberId, id).run()
  return true
}

export async function deleteContact(DB: D1Database, id: number, customerId: number): Promise<boolean> {
  const result = await DB.prepare('DELETE FROM message_contacts WHERE id = ? AND customer_id = ?').bind(id, customerId).run()
  return (result.meta.changes || 0) > 0
}

export async function listMessageLists(DB: D1Database, customerId: number) {
  const rows = await DB.prepare(
    `SELECT l.*,
       (SELECT COUNT(*) FROM message_list_recipients r WHERE r.list_id = l.id) as explicit_recipients_count,
       (SELECT r2.run_at FROM message_list_runs r2 WHERE r2.list_id = l.id ORDER BY r2.run_at DESC LIMIT 1) as last_run_at
     FROM message_lists l WHERE l.customer_id = ? ORDER BY l.created_at DESC`
  ).bind(customerId).all<any>()
  return rows.results || []
}

export async function getMessageListDetail(DB: D1Database, id: number, customerId: number) {
  const list = await DB.prepare('SELECT * FROM message_lists WHERE id = ? AND customer_id = ?').bind(id, customerId).first<MessageListRow>()
  if (!list) return null

  const recipients = await DB.prepare(
    `SELECT mc.* FROM message_list_recipients r JOIN message_contacts mc ON mc.id = r.contact_id WHERE r.list_id = ? ORDER BY mc.name COLLATE NOCASE`
  ).bind(id).all<MessageContactRow>()

  const runs = await DB.prepare(
    `SELECT * FROM message_list_runs WHERE list_id = ? ORDER BY run_at DESC LIMIT 10`
  ).bind(id).all<any>()

  const recentLogs = await DB.prepare(
    `SELECT * FROM message_list_send_log WHERE list_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id).all<any>()

  return {
    list,
    recipients: recipients.results || [],
    runs: runs.results || [],
    recent_logs: recentLogs.results || []
  }
}

export interface MessageListInput {
  name: string
  message_type?: string | null
  message_text: string
  schedule_time: string
  recurrence: 'daily' | 'weekly' | 'monthly'
  schedule_days?: number[]
  target_region?: string | null
  is_active?: boolean
  recipient_contact_ids?: number[]
  // Fixed UTC offset in hours this list's schedule_time is evaluated
  // against (migration 0019, "توقيت الرسائل الجماعية حسب البلد"). Omitted
  // = defaults to 3 (Yemen/Saudi), identical to the pre-migration behavior.
  timezone_offset_hours?: number
}

export interface MessageListValidationError {
  error: string
}

export function validateMessageListInput(input: any): MessageListValidationError | null {
  if (!input.name || !String(input.name).trim()) return { error: 'اسم القائمة مطلوب' }
  if (!input.message_text || !String(input.message_text).trim()) return { error: 'نص الرسالة مطلوب' }
  if (!validateScheduleTime(input.schedule_time)) return { error: 'وقت الجدولة غير صالح (يجب أن يكون بصيغة HH:MM)' }
  if (!validateRecurrence(input.recurrence)) return { error: 'التكرار يجب أن يكون daily أو weekly أو monthly' }
  if (input.recurrence !== 'daily' && (!Array.isArray(input.schedule_days) || input.schedule_days.length === 0)) {
    return { error: 'يجب تحديد الأيام لهذا النوع من التكرار' }
  }
  return null
}

// Validates+clamps a requested offset to the supported list (migration
// 0019) — falls back to the original default (3) for anything missing or
// not in COUNTRY_TIMEZONE_OPTIONS, so a bad/unexpected value can never
// silently corrupt a list's schedule evaluation.
function normalizeTimezoneOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
  return COUNTRY_TIMEZONE_OPTIONS.some((o) => o.offset === n) ? n : DEFAULT_OFFSET_HOURS
}

export async function createMessageList(DB: D1Database, customerId: number, input: MessageListInput): Promise<number> {
  const scheduleDays = normalizeScheduleDays(input.recurrence, input.schedule_days || [])
  const tzOffset = normalizeTimezoneOffset(input.timezone_offset_hours)
  const result = await DB.prepare(
    `INSERT INTO message_lists (customer_id, name, message_type, message_text, schedule_time, recurrence, schedule_days, target_region, is_active, timezone_offset_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    customerId, input.name.trim(), input.message_type?.trim() || null, input.message_text.trim(),
    input.schedule_time, input.recurrence, scheduleDays, input.target_region?.trim() || null,
    input.is_active === false ? 0 : 1, tzOffset
  ).run()
  const listId = result.meta.last_row_id as number

  if (input.recipient_contact_ids?.length) {
    await setListRecipients(DB, listId, input.recipient_contact_ids)
  }
  return listId
}

export async function updateMessageList(DB: D1Database, id: number, customerId: number, input: MessageListInput): Promise<boolean> {
  const existing = await DB.prepare('SELECT id FROM message_lists WHERE id = ? AND customer_id = ?').bind(id, customerId).first()
  if (!existing) return false

  const scheduleDays = normalizeScheduleDays(input.recurrence, input.schedule_days || [])
  const tzOffset = normalizeTimezoneOffset(input.timezone_offset_hours)
  await DB.prepare(
    `UPDATE message_lists SET name=?, message_type=?, message_text=?, schedule_time=?, recurrence=?, schedule_days=?, target_region=?, is_active=?, timezone_offset_hours=?, updated_at=datetime('now')
     WHERE id=?`
  ).bind(
    input.name.trim(), input.message_type?.trim() || null, input.message_text.trim(),
    input.schedule_time, input.recurrence, scheduleDays, input.target_region?.trim() || null,
    input.is_active === false ? 0 : 1, tzOffset, id
  ).run()

  if (input.recipient_contact_ids !== undefined) {
    await setListRecipients(DB, id, input.recipient_contact_ids)
  }
  return true
}

async function setListRecipients(DB: D1Database, listId: number, contactIds: number[]): Promise<void> {
  await DB.prepare('DELETE FROM message_list_recipients WHERE list_id = ?').bind(listId).run()
  for (const contactId of contactIds) {
    await DB.prepare('INSERT OR IGNORE INTO message_list_recipients (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run()
  }
}

export async function deleteMessageList(DB: D1Database, id: number, customerId: number): Promise<boolean> {
  const result = await DB.prepare('DELETE FROM message_lists WHERE id = ? AND customer_id = ?').bind(id, customerId).run()
  return (result.meta.changes || 0) > 0
}
