import { Hono } from 'hono'
import { requireCustomer } from '../lib/middleware'
import type { AppEnv } from '../lib/types'

const customer = new Hono<AppEnv>()
customer.use('/*', requireCustomer)

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
    'SELECT id, customer_id, display_name, phone_number, phone_number_id, waba_id, status, created_at FROM whatsapp_numbers WHERE customer_id = ? ORDER BY created_at DESC'
  ).bind(id).all()

  const activeSub = await DB.prepare(
    `SELECT s.*, p.name_ar as package_name_ar, p.name_en as package_name_en, p.max_numbers FROM subscriptions s
     JOIN packages p ON p.id = s.package_id
     WHERE s.customer_id = ? AND s.status='active' AND s.end_date >= datetime('now')
     ORDER BY s.end_date DESC LIMIT 1`
  ).bind(id).first()

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

  return c.json({
    numbers: numbers.results,
    active_subscription: activeSub || null,
    operations_stats: opsStats,
    recent_operations: recentOps.results
  })
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
