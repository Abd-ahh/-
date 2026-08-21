import { Hono } from 'hono'
import { requireAdmin } from '../lib/middleware'
import { hashPassword } from '../lib/auth'
import { extractPassportData } from '../lib/gemini'
import { AVAILABLE_FIELDS, normalizeExtractionFields } from '../lib/fields'
import { fetchPhoneNumbersForWaba, findMatchingWabaNumber } from '../lib/whatsapp'
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
  const { name_ar, name_en, max_numbers, monthly_operations, price, currency, sort_order, number_mode } = body
  if (!name_ar || !name_en) return c.json({ error: 'اسم الباقة مطلوب' }, 400)
  const result = await DB.prepare(
    `INSERT INTO packages (name_ar, name_en, max_numbers, monthly_operations, price, currency, sort_order, number_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    name_ar, name_en, max_numbers || 1, monthly_operations || 500, price || 0, currency || 'SAR', sort_order || 0,
    number_mode === 'shared' ? 'shared' : 'private'
  ).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/packages/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name_ar, name_en, max_numbers, monthly_operations, price, currency, is_active, sort_order, number_mode } = body
  await DB.prepare(
    `UPDATE packages SET name_ar=?, name_en=?, max_numbers=?, monthly_operations=?, price=?, currency=?, is_active=?, sort_order=?, number_mode=? WHERE id=?`
  ).bind(
    name_ar, name_en, max_numbers, monthly_operations, price, currency, is_active ? 1 : 0, sort_order || 0,
    number_mode === 'shared' ? 'shared' : 'private', id
  ).run()
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

// Custom activation/deactivation commands must be unique across all customers
// (they're matched against the shared number's incoming messages with no
// other context, so ambiguity would misroute a message to the wrong office).
async function checkDuplicateCommand(
  DB: D1Database,
  field: 'activation_code' | 'deactivation_code',
  value: string,
  excludeId?: string | number
): Promise<boolean> {
  const query = excludeId
    ? DB.prepare(`SELECT id FROM customers WHERE ${field} = ? AND id != ?`).bind(value, excludeId)
    : DB.prepare(`SELECT id FROM customers WHERE ${field} = ?`).bind(value)
  const existing = await query.first()
  return !!existing
}

admin.post('/customers', async (c) => {
  const { DB } = c.env
  const { name, email, phone, password, activation_code, deactivation_code } = await c.req.json()
  if (!name || !email || !password) return c.json({ error: 'الرجاء تعبئة جميع الحقول' }, 400)
  const existing = await DB.prepare('SELECT id FROM customers WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: 'البريد الإلكتروني مستخدم بالفعل' }, 400)

  const actCode = activation_code?.trim() || null
  const deactCode = deactivation_code?.trim() || null
  if (actCode && (await checkDuplicateCommand(DB, 'activation_code', actCode))) {
    return c.json({ error: 'أمر التفعيل مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }
  if (deactCode && (await checkDuplicateCommand(DB, 'deactivation_code', deactCode))) {
    return c.json({ error: 'أمر الإيقاف مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }

  const { hash, salt } = await hashPassword(password)
  const result = await DB.prepare(
    'INSERT INTO customers (name, email, phone, password_hash, password_salt, activation_code, deactivation_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(name, email, phone || null, hash, salt, actCode, deactCode).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

admin.put('/customers/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const existing = await DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<any>()
  if (!existing) return c.json({ error: 'العميل غير موجود' }, 404)

  const body = await c.req.json()
  // Partial update: keep existing values for any field not sent in the body,
  // so callers (e.g. the "save commands only" UI action) can update just
  // activation_code/deactivation_code without wiping name/phone/status.
  const name = body.name !== undefined ? body.name : existing.name
  const phone = body.phone !== undefined ? (body.phone || null) : existing.phone
  const status = body.status !== undefined ? body.status : existing.status
  const reply_language = body.reply_language !== undefined ? (body.reply_language || 'ar') : existing.reply_language
  const welcome_message = body.welcome_message !== undefined ? (body.welcome_message || null) : existing.welcome_message
  const actCode = body.activation_code !== undefined ? (body.activation_code?.trim() || null) : existing.activation_code
  const deactCode = body.deactivation_code !== undefined ? (body.deactivation_code?.trim() || null) : existing.deactivation_code

  if (actCode && (await checkDuplicateCommand(DB, 'activation_code', actCode, id))) {
    return c.json({ error: 'أمر التفعيل مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }
  if (deactCode && (await checkDuplicateCommand(DB, 'deactivation_code', deactCode, id))) {
    return c.json({ error: 'أمر الإيقاف مستخدم بالفعل من مكتب آخر، الرجاء اختيار أمر مختلف' }, 400)
  }

  await DB.prepare(
    'UPDATE customers SET name=?, phone=?, status=?, reply_language=?, welcome_message=?, activation_code=?, deactivation_code=? WHERE id=?'
  ).bind(name, phone, status, reply_language, welcome_message, actCode, deactCode, id).run()
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

// ---------------------- Platform-wide Meta connection settings ----------------------
// The admin links WABA ID + Access Token ONCE for the whole platform (stored in the
// `settings` table server-side, not per-browser). After that, adding a customer's
// number only needs the phone number itself — the backend looks it up under this
// single saved WABA and resolves phone_number_id automatically.
const META_WABA_KEY = 'meta_waba_id'
const META_TOKEN_KEY = 'meta_access_token'

admin.get('/meta-settings', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (?, ?)`
  ).bind(META_WABA_KEY, META_TOKEN_KEY).all<{ key: string; value: string }>()
  const map: Record<string, string> = {}
  for (const r of rows.results || []) map[r.key] = r.value
  return c.json({
    waba_id: map[META_WABA_KEY] || '',
    has_token: !!map[META_TOKEN_KEY] // never send the token itself back to the browser
  })
})

admin.put('/meta-settings', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const waba_id: string | undefined = body.waba_id
  // access_token is optional on update: if left blank, keep the previously saved
  // token (frontend shows "leave blank to keep the saved token" for this reason).
  let access_token: string | undefined = body.access_token
  if (!waba_id) {
    return c.json({ error: 'WABA ID مطلوب' }, 400)
  }
  if (!access_token) {
    const existing = await getMetaSettings(DB)
    if (!existing) {
      return c.json({ error: 'الـ Access Token مطلوب عند أول ربط للحساب' }, 400)
    }
    access_token = existing.access_token
  }
  // Validate against Meta before saving, so a typo doesn't silently break every future number
  try {
    await fetchPhoneNumbersForWaba(waba_id, access_token)
  } catch (err: any) {
    return c.json({ error: `تعذر التحقق من البيانات مع Meta: ${err?.message || err}` }, 400)
  }
  await DB.batch([
    DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).bind(META_WABA_KEY, waba_id),
    DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).bind(META_TOKEN_KEY, access_token)
  ])
  return c.json({ success: true })
})

async function getMetaSettings(DB: D1Database): Promise<{ waba_id: string; access_token: string } | null> {
  const rows = await DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (?, ?)`
  ).bind(META_WABA_KEY, META_TOKEN_KEY).all<{ key: string; value: string }>()
  const map: Record<string, string> = {}
  for (const r of rows.results || []) map[r.key] = r.value
  if (!map[META_WABA_KEY] || !map[META_TOKEN_KEY]) return null
  return { waba_id: map[META_WABA_KEY], access_token: map[META_TOKEN_KEY] }
}

// ---------------------- WhatsApp lookup helper (advanced/manual use) ----------------------
// Given only a WABA ID + access token, ask Meta for the phone number(s)
// registered under that WABA. Kept for advanced cases (e.g. a customer on a
// different Meta account); normal flow now uses the platform-wide settings above.
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
// Excludes the platform's shared number (is_shared=1) — that one is managed
// separately via the /shared-number endpoints below since it has no single
// customer owner.
admin.get('/whatsapp-numbers', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    `SELECT wn.*, cu.name as customer_name FROM whatsapp_numbers wn
     JOIN customers cu ON cu.id = wn.customer_id
     WHERE wn.is_shared = 0
     ORDER BY wn.created_at DESC`
  ).all()
  return c.json({ numbers: result.results })
})

// Main flow: admin gives ONLY the customer's phone number (+ which customer, + a
// display name). The platform's saved WABA ID/Access Token (set once via
// /meta-settings) is used to look the number up on Meta and resolve its
// phone_number_id automatically — no ID of any kind is ever typed by the admin.
admin.post('/whatsapp-numbers', async (c) => {
  const { DB } = c.env
  const { customer_id, display_name, phone_number, extraction_fields } = await c.req.json()
  if (!customer_id || !display_name || !phone_number) return c.json({ error: 'بيانات ناقصة' }, 400)

  const meta = await getMetaSettings(DB)
  if (!meta) {
    return c.json({ error: 'لم يتم ربط حساب واتساب الأعمال (Meta) بعد. اذهب إلى "إعدادات واتساب" وأدخل WABA ID والـ Access Token مرة واحدة أولاً.' }, 400)
  }

  // Enforce max_numbers limit from active subscription
  const activeSub = await DB.prepare(
    `SELECT s.*, p.max_numbers FROM subscriptions s JOIN packages p ON p.id = s.package_id
     WHERE s.customer_id = ? AND s.status='active' AND s.end_date >= datetime('now') ORDER BY s.end_date DESC LIMIT 1`
  ).bind(customer_id).first<any>()

  const currentCount = await DB.prepare('SELECT COUNT(*) as cnt FROM whatsapp_numbers WHERE customer_id = ?').bind(customer_id).first<{ cnt: number }>()
  if (activeSub && currentCount && currentCount.cnt >= activeSub.max_numbers) {
    return c.json({ error: `العميل وصل للحد الأقصى لعدد الأرقام المسموح (${activeSub.max_numbers}) حسب باقته الحالية` }, 400)
  }

  // Resolve phone_number_id automatically from Meta using only the phone number
  let matched
  try {
    const numbers = await fetchPhoneNumbersForWaba(meta.waba_id, meta.access_token)
    matched = findMatchingWabaNumber(numbers, phone_number)
  } catch (err: any) {
    return c.json({ error: `فشل الاتصال بـ Meta: ${err?.message || err}` }, 400)
  }
  if (!matched) {
    return c.json({ error: 'لم يتم العثور على هذا الرقم تحت حساب واتساب الأعمال المربوط بالمنصة. تأكد أن الرقم أُضيف فعلياً في Meta Business Manager.' }, 404)
  }

  const result = await DB.prepare(
    `INSERT INTO whatsapp_numbers (customer_id, display_name, phone_number, phone_number_id, waba_id, access_token, extraction_fields, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'connected')`
  ).bind(
    customer_id,
    display_name,
    matched.display_phone_number,
    matched.id,
    meta.waba_id,
    meta.access_token,
    normalizeExtractionFields(extraction_fields)
  ).run()

  return c.json({ success: true, id: result.meta.last_row_id, phone_number_id: matched.id })
})

// One-click fix for an existing number that's missing phone_number_id (e.g. it
// was created before this account-wide auto-linking existed). Uses the number's
// own stored phone_number + the platform-wide Meta settings — no ID typing needed.
admin.post('/whatsapp-numbers/:id/auto-fix', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const existing = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').bind(id).first<any>()
  if (!existing) return c.json({ error: 'الرقم غير موجود' }, 404)

  const meta = await getMetaSettings(DB)
  if (!meta) {
    return c.json({ error: 'لم يتم ربط حساب واتساب الأعمال (Meta) بعد. اذهب إلى "إعدادات واتساب" وأدخل WABA ID والـ Access Token مرة واحدة أولاً.' }, 400)
  }

  let matched
  try {
    const numbers = await fetchPhoneNumbersForWaba(meta.waba_id, meta.access_token)
    matched = findMatchingWabaNumber(numbers, existing.phone_number)
  } catch (err: any) {
    return c.json({ error: `فشل الاتصال بـ Meta: ${err?.message || err}` }, 400)
  }
  if (!matched) {
    return c.json({ error: `لم يتم العثور على الرقم "${existing.phone_number}" تحت حساب واتساب الأعمال المربوط بالمنصة. تأكد أن الرقم صحيح ومُضاف فعلياً في Meta Business Manager.` }, 404)
  }

  await DB.prepare(
    'UPDATE whatsapp_numbers SET phone_number=?, phone_number_id=?, waba_id=?, access_token=?, status=? WHERE id=?'
  ).bind(matched.display_phone_number, matched.id, meta.waba_id, meta.access_token, 'connected', id).run()

  return c.json({ success: true, phone_number_id: matched.id })
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
  const phone_number = 'phone_number' in body ? (body.phone_number || existing.phone_number) : existing.phone_number
  const phone_number_id = 'phone_number_id' in body ? (body.phone_number_id || null) : existing.phone_number_id
  const waba_id = 'waba_id' in body ? (body.waba_id || null) : existing.waba_id
  const access_token = 'access_token' in body ? (body.access_token || null) : existing.access_token
  const status = 'status' in body ? (body.status || 'connected') : existing.status
  const extraction_fields = 'extraction_fields' in body
    ? normalizeExtractionFields(body.extraction_fields)
    : existing.extraction_fields

  await DB.prepare(
    'UPDATE whatsapp_numbers SET display_name=?, phone_number=?, phone_number_id=?, waba_id=?, access_token=?, status=?, extraction_fields=? WHERE id=?'
  ).bind(display_name, phone_number, phone_number_id, waba_id, access_token, status, extraction_fields, id).run()
  return c.json({ success: true })
})

admin.delete('/whatsapp-numbers/:id', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM whatsapp_numbers WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ---------------------- Shared (multi-tenant) platform number ----------------------
// Exactly one whatsapp_numbers row can be the platform's shared number
// (customer_id = NULL, is_shared = 1). Customers on a 'shared'-mode package
// don't get a dedicated number; instead their end-users message this single
// number and identify their office by sending "<اسم المكتب> تفعيل" once.
admin.get('/shared-number', async (c) => {
  const { DB } = c.env
  const row = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE is_shared = 1 LIMIT 1').first<any>()
  return c.json({ number: row || null })
})

// Create or update the platform's shared number. Uses the same platform-wide
// Meta settings (WABA ID/token) + phone-number-only lookup as private numbers.
admin.post('/shared-number', async (c) => {
  const { DB } = c.env
  const { display_name, phone_number } = await c.req.json()
  if (!display_name || !phone_number) return c.json({ error: 'بيانات ناقصة' }, 400)

  const meta = await getMetaSettings(DB)
  if (!meta) {
    return c.json({ error: 'لم يتم ربط حساب واتساب الأعمال (Meta) بعد. اذهب إلى "إعدادات واتساب" وأدخل WABA ID والـ Access Token مرة واحدة أولاً.' }, 400)
  }

  let matched
  try {
    const numbers = await fetchPhoneNumbersForWaba(meta.waba_id, meta.access_token)
    matched = findMatchingWabaNumber(numbers, phone_number)
  } catch (err: any) {
    return c.json({ error: `فشل الاتصال بـ Meta: ${err?.message || err}` }, 400)
  }
  if (!matched) {
    return c.json({ error: 'لم يتم العثور على هذا الرقم تحت حساب واتساب الأعمال المربوط بالمنصة. تأكد أن الرقم أُضيف فعلياً في Meta Business Manager.' }, 404)
  }

  const existing = await DB.prepare('SELECT id FROM whatsapp_numbers WHERE is_shared = 1 LIMIT 1').first<{ id: number }>()
  if (existing) {
    await DB.prepare(
      `UPDATE whatsapp_numbers SET display_name=?, phone_number=?, phone_number_id=?, waba_id=?, access_token=?, status='connected' WHERE id=?`
    ).bind(display_name, matched.display_phone_number, matched.id, meta.waba_id, meta.access_token, existing.id).run()
    return c.json({ success: true, id: existing.id, phone_number_id: matched.id })
  }

  const result = await DB.prepare(
    `INSERT INTO whatsapp_numbers (customer_id, is_shared, display_name, phone_number, phone_number_id, waba_id, access_token, status)
     VALUES (NULL, 1, ?, ?, ?, ?, ?, 'connected')`
  ).bind(display_name, matched.display_phone_number, matched.id, meta.waba_id, meta.access_token).run()

  return c.json({ success: true, id: result.meta.last_row_id, phone_number_id: matched.id })
})

admin.delete('/shared-number', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM whatsapp_numbers WHERE is_shared = 1').run()
  return c.json({ success: true })
})

// ---------------------- WhatsApp group bridge (unofficial) ----------------------
// Read-only visibility for the admin over groups activated via the external
// Baileys bridge (see /webhook/bridge/message). Admin can unlink a
// misactivated/abandoned group; the bridge process itself lives on a
// separate VPS outside this Worker's control.
admin.get('/whatsapp-groups', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    `SELECT g.*, cu.name as customer_name FROM whatsapp_groups g
     JOIN customers cu ON cu.id = g.customer_id
     ORDER BY g.created_at DESC`
  ).all()
  return c.json({ groups: result.results })
})

admin.delete('/whatsapp-groups/:id', async (c) => {
  const { DB } = c.env
  await DB.prepare('DELETE FROM whatsapp_groups WHERE id = ?').bind(c.req.param('id')).run()
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
