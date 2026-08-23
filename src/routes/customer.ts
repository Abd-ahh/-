import { Hono } from 'hono'
import { requireCustomer } from '../lib/middleware'
import { AVAILABLE_FIELDS, normalizeExtractionFields } from '../lib/fields'
import { normalizeCumulativeFields, parseCumulativeFields } from '../lib/cumulative'
import { parseConversationKey } from '../lib/commands'
import type { AppEnv } from '../lib/types'

const customer = new Hono<AppEnv>()
customer.use('/*', requireCustomer)

// Available extraction fields, used to render the field-selection checkboxes
customer.get('/fields', (c) => {
  return c.json({ fields: AVAILABLE_FIELDS })
})

customer.get('/me', async (c) => {
  const { DB } = c.env
  const id = c.get('customer')!.id
  const cust = await DB.prepare('SELECT id, name, email, phone, status, reply_language, welcome_message, activation_code, deactivation_code, cumulative_list_fields, cumulative_list_reset_hours, created_at FROM customers WHERE id = ?').bind(id).first()
  return c.json({ customer: cust })
})

customer.get('/dashboard', async (c) => {
  const { DB } = c.env
  const id = c.get('customer')!.id

  // Never expose access_token to the customer portal (sensitive Meta credential)
  const numbers = await DB.prepare(
    "SELECT id, customer_id, display_name, phone_number, phone_number_id, waba_id, status, extraction_fields, created_at FROM whatsapp_numbers WHERE customer_id = ? AND is_shared = 0 ORDER BY created_at DESC"
  ).bind(id).all()

  const activeSub = await DB.prepare(
    `SELECT s.*, p.name_ar as package_name_ar, p.name_en as package_name_en, p.max_numbers, p.number_mode FROM subscriptions s
     JOIN packages p ON p.id = s.package_id
     WHERE s.customer_id = ? AND s.status='active' AND s.end_date >= datetime('now')
     ORDER BY s.end_date DESC LIMIT 1`
  ).bind(id).first<any>()

  const opsStats = await DB.prepare(
    `SELECT
       COUNT(*) as total,
       COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0) as success,
       COALESCE(SUM(CASE WHEN status IN ('failed','unclear') THEN 1 ELSE 0 END), 0) as failed
     FROM operations WHERE customer_id = ?`
  ).bind(id).first()

  const recentOps = await DB.prepare(
    `SELECT o.*, wn.phone_number FROM operations o
     LEFT JOIN whatsapp_numbers wn ON wn.id = o.whatsapp_number_id
     WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT 20`
  ).bind(id).all()

  // If this customer's active package uses the shared platform number, give
  // the frontend everything needed to build the wa.me deep-link (office name
  // is the customer's own registered name).
  let sharedLink: { phone_number: string; office_name: string; deep_link: string; activation_text: string; deactivation_text: string | null } | null = null
  if (activeSub && activeSub.number_mode === 'shared') {
    const sharedNumber = await DB.prepare("SELECT phone_number FROM whatsapp_numbers WHERE is_shared = 1 LIMIT 1").first<{ phone_number: string }>()
    const cust = await DB.prepare('SELECT name, activation_code, deactivation_code FROM customers WHERE id = ?')
      .bind(id).first<{ name: string; activation_code: string | null; deactivation_code: string | null }>()
    if (sharedNumber && cust) {
      const digits = (sharedNumber.phone_number || '').replace(/\D/g, '')
      // A custom activation_code fully replaces the auto-derived "<name> تفعيل" text.
      const text = cust.activation_code || `${cust.name} تفعيل`
      sharedLink = {
        phone_number: sharedNumber.phone_number,
        office_name: cust.name,
        deep_link: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`,
        activation_text: text,
        deactivation_text: cust.deactivation_code || null
      }
    }
  }

  // WhatsApp groups linked to this office via the unofficial group bridge
  // (only relevant for shared-mode customers, but harmless to fetch always).
  const groups = await DB.prepare(
    'SELECT id, group_jid, group_name, created_at, updated_at FROM whatsapp_groups WHERE customer_id = ? ORDER BY created_at DESC'
  ).bind(id).all()

  return c.json({
    numbers: numbers.results,
    active_subscription: activeSub || null,
    operations_stats: opsStats,
    recent_operations: recentOps.results,
    shared_link: sharedLink,
    groups: groups.results
  })
})

// Let the office unlink one of its WhatsApp groups from the bridge (e.g. a
// group was activated by mistake, or the office no longer uses it).
customer.delete('/groups/:id', async (c) => {
  const { DB } = c.env
  const customerId = c.get('customer')!.id
  const groupId = c.req.param('id')

  const owned = await DB.prepare('SELECT id FROM whatsapp_groups WHERE id = ? AND customer_id = ?')
    .bind(groupId, customerId)
    .first()
  if (!owned) return c.json({ error: 'المجموعة غير موجودة أو لا تخص مكتبك' }, 404)

  await DB.prepare('DELETE FROM whatsapp_groups WHERE id = ?').bind(groupId).run()
  return c.json({ success: true })
})

// Let the customer choose which fields the bot extracts/replies with for a
// specific WhatsApp number they own (e.g. "name only" vs "all fields").
customer.put('/numbers/:id/fields', async (c) => {
  const { DB } = c.env
  const customerId = c.get('customer')!.id
  const numberId = c.req.param('id')
  const { extraction_fields } = await c.req.json()

  // Ownership check: make sure this number belongs to the logged-in customer
  const owned = await DB.prepare('SELECT id FROM whatsapp_numbers WHERE id = ? AND customer_id = ?')
    .bind(numberId, customerId)
    .first()
  if (!owned) return c.json({ error: 'الرقم غير موجود أو لا يخصك' }, 404)

  await DB.prepare('UPDATE whatsapp_numbers SET extraction_fields = ? WHERE id = ?')
    .bind(normalizeExtractionFields(extraction_fields), numberId)
    .run()

  return c.json({ success: true })
})

customer.put('/settings', async (c) => {
  const { DB } = c.env
  const id = c.get('customer')!.id
  const body = await c.req.json()
  const { reply_language, welcome_message, phone, activation_code, deactivation_code } = body

  const actCode = activation_code?.trim() || null
  const deactCode = deactivation_code?.trim() || null

  if (actCode) {
    const dup = await DB.prepare('SELECT id FROM customers WHERE activation_code = ? AND id != ?').bind(actCode, id).first()
    if (dup) return c.json({ error: 'أمر التفعيل مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }
  if (deactCode) {
    const dup = await DB.prepare('SELECT id FROM customers WHERE deactivation_code = ? AND id != ?').bind(deactCode, id).first()
    if (dup) return c.json({ error: 'أمر الإيقاف مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }

  // Feature 2 (cumulative running list) settings: which fields to include in
  // the numbered list, and how often (in hours) it auto-resets. Both
  // optional in the request body — existing values are read first so a
  // caller that only sends the other settings-form fields doesn't reset them.
  const existing = await DB.prepare('SELECT cumulative_list_fields, cumulative_list_reset_hours FROM customers WHERE id = ?').bind(id).first<any>()
  const cumulativeFields = 'cumulative_list_fields' in body
    ? normalizeCumulativeFields(body.cumulative_list_fields)
    : existing?.cumulative_list_fields ?? null
  let resetHours = 'cumulative_list_reset_hours' in body
    ? parseInt(body.cumulative_list_reset_hours, 10)
    : existing?.cumulative_list_reset_hours ?? 24
  if (!Number.isFinite(resetHours) || resetHours <= 0) resetHours = 24

  await DB.prepare(
    'UPDATE customers SET reply_language=?, welcome_message=?, phone=?, activation_code=?, deactivation_code=?, cumulative_list_fields=?, cumulative_list_reset_hours=? WHERE id=?'
  ).bind(reply_language || 'ar', welcome_message || null, phone || null, actCode, deactCode, cumulativeFields, resetHours, id).run()
  return c.json({ success: true })
})

// Feature 2 (cumulative running list): now the ONLY place this list is
// visible when the office hasn't turned on the detailed "استخراج تلقائي"
// WhatsApp reply — the numbered list itself is still built automatically
// on every successful extraction (see appendToCumulativeList in
// webhook.ts), but by default it's read here in the portal instead of
// being sent as a WhatsApp message. Returns every active (non-expired)
// list for this office across all its conversations (private numbers,
// shared-number sessions, and linked groups), each with a human-readable
// label for the conversation and the resolved field list/labels so the
// frontend doesn't need its own copy of AVAILABLE_FIELDS logic beyond the
// emoji/label lookup already exposed via GET /fields.
customer.get('/cumulative-lists', async (c) => {
  const { DB } = c.env
  const id = c.get('customer')!.id

  const cust = await DB.prepare('SELECT cumulative_list_fields, cumulative_list_reset_hours FROM customers WHERE id = ?')
    .bind(id).first<{ cumulative_list_fields: string | null; cumulative_list_reset_hours: number }>()
  const fieldKeys = parseCumulativeFields(cust?.cumulative_list_fields)
  const resetHours = cust?.cumulative_list_reset_hours ?? 24

  const rows = await DB.prepare(
    'SELECT * FROM cumulative_lists WHERE customer_id = ? ORDER BY updated_at DESC'
  ).bind(id).all<any>()

  const lists: { conversation_key: string; label: string; items: any[]; started_at: string; updated_at: string }[] = []

  for (const row of rows.results || []) {
    const ageHours = (Date.now() - new Date(row.started_at + 'Z').getTime()) / (1000 * 60 * 60)
    if (ageHours >= resetHours) continue // expired — same rule as getCumulativeList, don't show a stale list

    let items: any[] = []
    try { items = JSON.parse(row.items_json) || [] } catch { items = [] }
    if (items.length === 0) continue

    // Resolve a human-readable label for this conversation instead of the
    // raw internal key ("wn:3:9665..." / "grp:1203...@g.us").
    let label = row.conversation_key
    const parsed = parseConversationKey(row.conversation_key)
    if (parsed?.channel === 'group') {
      const g = await DB.prepare('SELECT group_name FROM whatsapp_groups WHERE group_jid = ? AND customer_id = ?')
        .bind(parsed.group_jid, id).first<{ group_name: string | null }>()
      label = g?.group_name ? `📱 مجموعة: ${g.group_name}` : `📱 مجموعة واتساب`
    } else if (parsed?.channel === 'number') {
      label = `☎️ ${parsed.sender_phone}`
    }

    lists.push({ conversation_key: row.conversation_key, label, items, started_at: row.started_at, updated_at: row.updated_at })
  }

  return c.json({ fields: fieldKeys, lists })
})

customer.get('/operations', async (c) => {
  const { DB } = c.env
  const id = c.get('customer')!.id
  const page = parseInt(c.req.query('page') || '1')
  const limit = 30
  const offset = (page - 1) * limit
  const result = await DB.prepare(
    `SELECT o.*, wn.phone_number FROM operations o
     LEFT JOIN whatsapp_numbers wn ON wn.id = o.whatsapp_number_id
     WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  ).bind(id, limit, offset).all()
  const total = await DB.prepare('SELECT COUNT(*) as cnt FROM operations WHERE customer_id = ?').bind(id).first<{ cnt: number }>()
  return c.json({ operations: result.results, total: total?.cnt || 0, page, limit })
})

export default customer
