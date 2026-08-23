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

// The platform's user base is Yemen + Saudi Arabia, both fixed UTC+3 with no
// DST — a constant offset is deliberately used instead of a timezone
// database to keep this dependency-free inside the Workers runtime.
const RIYADH_OFFSET_MIN = 3 * 60

function riyadhNow(): Date {
  const utcMs = Date.now()
  return new Date(utcMs + RIYADH_OFFSET_MIN * 60 * 1000)
}

// Formats a Riyadh-shifted Date's UTC getters as 'YYYY-MM-DD' (the shifted
// Date's UTC fields represent Riyadh-local wall-clock time).
function riyadhDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function riyadhHHMM(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
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
export function isListDue(list: MessageListRow, now: Date = riyadhNow(), toleranceMin = 2): boolean {
  if (!list.is_active) return false

  const todayKey = riyadhDateKey(now)
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
    // JS Date.getUTCDay() on our Riyadh-shifted Date gives the Riyadh-local
    // weekday (0=Sunday..6=Saturday), matching the convention documented in
    // the migration.
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
    const logResult = await DB.prepare(
      `INSERT INTO message_list_send_log (run_id, list_id, contact_id, name_snapshot, jid_snapshot, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    ).bind(runId, list.id, contact.id, contact.name, jid).run()
    const sendLogId = logResult.meta.last_row_id as number

    await DB.prepare(
      `INSERT INTO group_outbox (group_jid, kind, text, send_log_id) VALUES (?, 'text', ?, ?)`
    ).bind(jid, list.message_text, sendLogId).run()
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
  const now = riyadhNow()
  const todayKey = riyadhDateKey(now)

  const active = await DB.prepare(`SELECT * FROM message_lists WHERE is_active = 1`).all<MessageListRow>()
  const lists = active.results || []

  let fired = 0
  let totalQueued = 0

  for (const list of lists) {
    if (!isListDue(list, now)) continue

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
}

export async function createContact(DB: D1Database, customerId: number, input: ContactInput): Promise<number> {
  const channel = input.channel === 'group' ? 'group' : 'number'
  const value = channel === 'number' ? (input.value || '').replace(/\D/g, '') : (input.value || '').trim()
  const result = await DB.prepare(
    `INSERT INTO message_contacts (customer_id, name, channel, value, region) VALUES (?, ?, ?, ?, ?)`
  ).bind(customerId, input.name.trim(), channel, value, input.region?.trim() || null).run()
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
  await DB.prepare(
    `UPDATE message_contacts SET name=?, channel=?, value=?, region=? WHERE id=?`
  ).bind(name, channel, value, region, id).run()
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

export async function createMessageList(DB: D1Database, customerId: number, input: MessageListInput): Promise<number> {
  const scheduleDays = normalizeScheduleDays(input.recurrence, input.schedule_days || [])
  const result = await DB.prepare(
    `INSERT INTO message_lists (customer_id, name, message_type, message_text, schedule_time, recurrence, schedule_days, target_region, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    customerId, input.name.trim(), input.message_type?.trim() || null, input.message_text.trim(),
    input.schedule_time, input.recurrence, scheduleDays, input.target_region?.trim() || null,
    input.is_active === false ? 0 : 1
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
  await DB.prepare(
    `UPDATE message_lists SET name=?, message_type=?, message_text=?, schedule_time=?, recurrence=?, schedule_days=?, target_region=?, is_active=?, updated_at=datetime('now')
     WHERE id=?`
  ).bind(
    input.name.trim(), input.message_type?.trim() || null, input.message_text.trim(),
    input.schedule_time, input.recurrence, scheduleDays, input.target_region?.trim() || null,
    input.is_active === false ? 0 : 1, id
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
