import { Hono } from 'hono'
import { requireAdmin } from '../lib/middleware'
import { hashPassword } from '../lib/auth'
import { extractPassportData } from '../lib/gemini'
import { AVAILABLE_FIELDS, normalizeExtractionFields } from '../lib/fields'
import { fetchPhoneNumbersForWaba } from '../lib/whatsapp'
import type { AppEnv } from '../lib/types'

const admin = new Hono<AppEnv>()
admin.use('/*', requireAdmin)

// ---------------------- Available extraction fields ----------------------
// Used by the frontend to render the field-selection checkboxes when
// creating/editing a WhatsApp number.
admin.get('/fields', (c) => {
  return c.json({ fields: AVAILABLE_FIELDS })
})

// ---------------------- Passport extraction test tool ----------------------
// Lets the platform owner validate Gemini's Arabic-name extraction accuracy
// on real sample images before onboarding real WhatsApp numbers (MVP phase).
admin.post('/test-extract', async (c) => {
  const { GEMINI_API_KEY, DB } = c.env
  if (!GEMINI_API_KEY) return c.json({ error: 'GEMINI_API_KEY غير مهيأ على المنصة. أضفه من إعدادات Cloudflare secrets.' }, 400)

  const body = await c.req.json()
  const { image_base64, mime_type } = body
  if (!image_base64) return c.json({ error: 'الصورة مطلوبة' }, 400)

  const startTime = Date.now()
  try {
    const result = await extractPassportData(GEMINI_API_KEY, image_base64, mime_type || 'image/jpeg')
    const processingTime = Date.now() - startTime

    await DB.prepare(
      `INSERT INTO operations (status, full_name_ar, full_name_en, passport_number, nationality, date_of_birth, date_of_expiry, gender, extracted_json, processing_time_ms, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'portal_test')`
    ).bind(
      !result.is_passport ? 'failed' : !result.is_clear ? 'unclear' : 'success',
      result.full_name_ar || null,
      result.full_name_en || null,
      result.passport_number || null,
      result.nationality || null,
      result.date_of_birth || null,
      result.date_of_expiry || null,
      result.gender || null,
      JSON.stringify(result),
      processingTime
    ).run()

    return c.json({ success: true, result, processing_time_ms: processingTime })
  } catch (err: any) {
    return c.json({ error: `فشل الاستخراج: ${err?.message || err}` }, 500)
  }
})

// ---------------------- Dashboard ----------------------
admin.get('/dashboard', async (c) => {
  const { DB } = c.env

  const [customers, activeSubs, expiredSubs, numbers, opsTotal, opsSuccess, opsFailed, revenue] = await Promise.all([
    DB.prepare('SELECT COUNT(*) as cnt FROM customers').first<{ cnt: number }>(),
    DB.prepare("SELECT COUNT(*) as cnt FROM subscriptions WHERE status = 'active' AND end_date >= datetime('now')").first<{ cnt: number }>(),
    DB.prepare("SELECT COUNT(*) as cnt FROM subscriptions WHERE status != 'active' OR end_date < datetime('now')").first<{ cnt: number }>(),
    DB.prepare("SELECT COUNT(*) as cnt FROM whatsapp_numbers WHERE status = 'connected'").first<{ cnt: number }>(),
    DB.prepare('SELECT COUNT(*) as cnt FROM operations').first<{ cnt: number }>(),
    DB.prepare("SELECT COUNT(*) as cnt FROM operations WHERE status = 'success'").first<{ cnt: number }>(),
    DB.prepare("SELECT COUNT(*) as cnt FROM operations WHERE status IN ('failed','unclear')").first<{ cnt: number }>(),
    DB.prepare("SELECT COALESCE(SUM(price_paid),0) as total FROM subscriptions").first<{ total: number }>()
  ])

  const recentOps = await DB.prepare(
    `SELECT o.*, c.name as customer_name FROM operations o
     LEFT JOIN customers c ON c.id = o.customer_id
     ORDER BY o.created_at DESC LIMIT 10`
  ).all()

  return c.json({
    customers_count: customers?.cnt || 0,
    active_subscriptions: activeSubs?.cnt || 0,
    expired_subscriptions: expiredSubs?.cnt || 0,
    connected_numbers: numbers?.cnt || 0,
    operations_total: opsTotal?.cnt || 0,
    operations_success: opsSuccess?.cnt || 0,
    operations_failed: opsFailed?.cnt || 0,
    revenue_total: revenue?.total || 0,
    recent_operations: recentOps.results
  })
})

// ---------------------- Packages ----------------------
admin.get('/packages', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare('SELECT * FROM packages ORDER BY sort_order ASC, id ASC').all()
  return c.json({ packages: result.results })
})

admin.post('/packages', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const { name_ar, name_en, max_numbers, monthly_operations, price, currency, sort_order } = body
  if (!name_ar || !name_en) return c.json({ error: 'اسم الباقة مطلوب' }, 400)
  const result = await DB.prepare(
    `INSERT INTO packages (name_ar, name_en, max_numbers, monthly_operations, price, currency, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(name_ar, name_en, max_numbers || 1, monthly_operations || 500, price || 0, currency || 'SAR', sort_order || 0).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/packages/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name_ar, name_en, max_numbers, monthly_operations, price, currency, is_active, sort_order } = body
  await DB.prepare(
    `UPDATE packages SET name_ar=?, name_en=?, max_numbers=?, monthly_operations=?, price=?, currency=?, is_active=?, sort_order=? WHERE id=?`
  ).bind(name_ar, name_en, max_numbers, monthly_operations, price, currency, is_active ? 1 : 0, sort_order || 0, id).run()
  return c.json({ success: true })
})

admin.delete('/packages/:id', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM packages WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ---------------------- Customers ----------------------
admin.get('/customers', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    `SELECT cu.*,
       (SELECT COUNT(*) FROM whatsapp_numbers wn WHERE wn.customer_id = cu.id) as numbers_count,
       (SELECT s.id FROM subscriptions s WHERE s.customer_id = cu.id AND s.status='active' AND s.end_date >= datetime('now') ORDER BY s.end_date DESC LIMIT 1) as active_subscription_id
     FROM customers cu ORDER BY cu.created_at DESC`
  ).all()
  return c.json({ customers: result.results })
})

admin.get('/customers/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const customer = await DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first()
  if (!customer) return c.json({ error: 'العميل غير موجود' }, 404)
  const numbers = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE customer_id = ? ORDER BY created_at DESC').bind(id).all()
  const subscriptions = await DB.prepare(
    `SELECT s.*, p.name_ar as package_name_ar, p.name_en as package_name_en FROM subscriptions s
     JOIN packages p ON p.id = s.package_id WHERE s.customer_id = ? ORDER BY s.created_at DESC`
  ).bind(id).all()
  const operations = await DB.prepare('SELECT * FROM operations WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50').bind(id).all()
  return c.json({ customer, numbers: numbers.results, subscriptions: subscriptions.results, operations: operations.results })
})

admin.post('/customers', async (c) => {
  const { DB } = c.env
  const { name, email, phone, password } = await c.req.json()
  if (!name || !email || !password) return c.json({ error: 'الرجاء تعبئة جميع الحقول' }, 400)
  const existing = await DB.prepare('SELECT id FROM customers WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: 'البريد الإلكتروني مستخدم بالفعل' }, 400)
  const { hash, salt } = await hashPassword(password)
  const result = await DB.prepare(
    'INSERT INTO customers (name, email, phone, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, email, phone || null, hash, salt).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/customers/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { name, phone, status, reply_language, welcome_message } = await c.req.json()
  await DB.prepare(
    'UPDATE customers SET name=?, phone=?, status=?, reply_language=?, welcome_message=? WHERE id=?'
  ).bind(name, phone || null, status, reply_language || 'ar', welcome_message || null, id).run()
  return c.json({ success: true })
})

admin.delete('/customers/:id', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM customers WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ---------------------- Subscriptions ----------------------
admin.post('/subscriptions', async (c) => {
  const { DB } = c.env
  const { customer_id, package_id, duration_days, price_paid } = await c.req.json()
  if (!customer_id || !package_id) return c.json({ error: 'بيانات ناقصة' }, 400)

  const pkg = await DB.prepare('SELECT * FROM packages WHERE id = ?').bind(package_id).first<any>()
  if (!pkg) return c.json({ error: 'الباقة غير موجودة' }, 404)

  const days = duration_days || 30
  const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

  // Cancel previous active subscriptions for this customer
  await DB.prepare("UPDATE subscriptions SET status='cancelled' WHERE customer_id=? AND status='active'").bind(customer_id).run()

  const result = await DB.prepare(
    `INSERT INTO subscriptions (customer_id, package_id, end_date, status, operations_limit, price_paid)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(customer_id, package_id, endDate, pkg.monthly_operations, price_paid ?? pkg.price).run()

  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/subscriptions/:id/cancel', async (c) => {
  const { DB } = c.env
  await DB.prepare("UPDATE subscriptions SET status='cancelled' WHERE id=?").bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ---------------------- WhatsApp lookup helper ----------------------
// Given only a WABA ID + access token, ask Meta for the phone number(s)
// registered under that WABA, so the admin never has to manually find/copy
// the phone_number_id from the Meta dashboard.
admin.post('/whatsapp-lookup', async (c) => {
  const { waba_id, access_token, api_version } = await c.req.json()
  if (!waba_id || !access_token) {
    return c.json({ error: 'WABA ID والـ Access Token مطلوبان' }, 400)
  }
  try {
    const numbers = await fetchPhoneNumbersForWaba(waba_id, access_token, api_version)
    if (!numbers.length) {
      return c.json({ error: 'لم يتم العثور على أي رقم مسجل تحت WABA ID هذا. تأكد من صحة القيمة وأن الـ Access Token له صلاحية whatsapp_business_management.' }, 404)
    }
    return c.json({ numbers })
  } catch (err: any) {
    return c.json({ error: `فشل الاتصال بـ Meta: ${err?.message || err}` }, 400)
  }
})

// ---------------------- WhatsApp Numbers ----------------------
admin.get('/whatsapp-numbers', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    `SELECT wn.*, cu.name as customer_name FROM whatsapp_numbers wn
     JOIN customers cu ON cu.id = wn.customer_id ORDER BY wn.created_at DESC`
  ).all()
  return c.json({ numbers: result.results })
})

admin.post('/whatsapp-numbers', async (c) => {
  const { DB } = c.env
  const { customer_id, display_name, phone_number, phone_number_id, waba_id, access_token, extraction_fields } = await c.req.json()
  if (!customer_id || !display_name || !phone_number) return c.json({ error: 'بيانات ناقصة' }, 400)

  // Enforce max_numbers limit from active subscription
  const activeSub = await DB.prepare(
    `SELECT s.*, p.max_numbers FROM subscriptions s JOIN packages p ON p.id = s.package_id
     WHERE s.customer_id = ? AND s.status='active' AND s.end_date >= datetime('now') ORDER BY s.end_date DESC LIMIT 1`
  ).bind(customer_id).first<any>()

  const currentCount = await DB.prepare('SELECT COUNT(*) as cnt FROM whatsapp_numbers WHERE customer_id = ?').bind(customer_id).first<{ cnt: number }>()
  if (activeSub && currentCount && currentCount.cnt >= activeSub.max_numbers) {
    return c.json({ error: `العميل وصل للحد الأقصى لعدد الأرقام المسموح (${activeSub.max_numbers}) حسب باقته الحالية` }, 400)
  }

  const result = await DB.prepare(
    `INSERT INTO whatsapp_numbers (customer_id, display_name, phone_number, phone_number_id, waba_id, access_token, extraction_fields, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'connected')`
  ).bind(
    customer_id,
    display_name,
    phone_number,
    phone_number_id || null,
    waba_id || null,
    access_token || null,
    normalizeExtractionFields(extraction_fields)
  ).run()

  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/whatsapp-numbers/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const existing = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').bind(id).first<any>()
  if (!existing) return c.json({ error: 'الرقم غير موجود' }, 404)

  const body = await c.req.json()
  // Partial update: only overwrite fields explicitly present in the request body,
  // keep everything else as-is (e.g. saving extraction_fields alone from the
  // "حقول الاستخراج" modal must not wipe display_name/access_token/etc.)
  const display_name = 'display_name' in body ? body.display_name : existing.display_name
  const phone_number_id = 'phone_number_id' in body ? (body.phone_number_id || null) : existing.phone_number_id
  const waba_id = 'waba_id' in body ? (body.waba_id || null) : existing.waba_id
  const access_token = 'access_token' in body ? (body.access_token || null) : existing.access_token
  const status = 'status' in body ? (body.status || 'connected') : existing.status
  const extraction_fields = 'extraction_fields' in body
    ? normalizeExtractionFields(body.extraction_fields)
    : existing.extraction_fields

  await DB.prepare(
    'UPDATE whatsapp_numbers SET display_name=?, phone_number_id=?, waba_id=?, access_token=?, status=?, extraction_fields=? WHERE id=?'
  ).bind(display_name, phone_number_id, waba_id, access_token, status, extraction_fields, id).run()
  return c.json({ success: true })
})

admin.delete('/whatsapp-numbers/:id', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM whatsapp_numbers WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ---------------------- Operations log ----------------------
admin.get('/operations', async (c) => {
  const { DB } = c.env
  const page = parseInt(c.req.query('page') || '1')
  const limit = 30
  const offset = (page - 1) * limit
  const result = await DB.prepare(
    `SELECT o.*, cu.name as customer_name, wn.phone_number FROM operations o
     LEFT JOIN customers cu ON cu.id = o.customer_id
     LEFT JOIN whatsapp_numbers wn ON wn.id = o.whatsapp_number_id
     ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()
  const total = await DB.prepare('SELECT COUNT(*) as cnt FROM operations').first<{ cnt: number }>()
  return c.json({ operations: result.results, total: total?.cnt || 0, page, limit })
})

export default admin
