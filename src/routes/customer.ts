import { Hono } from 'hono'
import { requireCustomer } from '../lib/middleware'
import { AVAILABLE_FIELDS, normalizeExtractionFields } from '../lib/fields'
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
  const cust = await DB.prepare('SELECT id, name, email, phone, status, reply_language, welcome_message, created_at FROM customers WHERE id = ?').bind(id).first()
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
  let sharedLink: { phone_number: string; office_name: string; deep_link: string } | null = null
  if (activeSub && activeSub.number_mode === 'shared') {
    const sharedNumber = await DB.prepare("SELECT phone_number FROM whatsapp_numbers WHERE is_shared = 1 LIMIT 1").first<{ phone_number: string }>()
    const cust = await DB.prepare('SELECT name FROM customers WHERE id = ?').bind(id).first<{ name: string }>()
    if (sharedNumber && cust) {
      const digits = (sharedNumber.phone_number || '').replace(/\D/g, '')
      const text = `${cust.name} تفعيل`
      sharedLink = {
        phone_number: sharedNumber.phone_number,
        office_name: cust.name,
        deep_link: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
      }
    }
  }

  return c.json({
    numbers: numbers.results,
    active_subscription: activeSub || null,
    operations_stats: opsStats,
    recent_operations: recentOps.results,
    shared_link: sharedLink
  })
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
  const { reply_language, welcome_message, phone } = await c.req.json()
  await DB.prepare('UPDATE customers SET reply_language=?, welcome_message=?, phone=? WHERE id=?')
    .bind(reply_language || 'ar', welcome_message || null, phone || null, id)
    .run()
  return c.json({ success: true })
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
