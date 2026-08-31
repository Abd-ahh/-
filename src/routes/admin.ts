import { Hono } from 'hono'
import { requireAdmin } from '../lib/middleware'
import { hashPassword } from '../lib/auth'
import { extractPassportData } from '../lib/gemini'
import { AVAILABLE_FIELDS, normalizeExtractionFields } from '../lib/fields'
import { fetchPhoneNumbersForWaba, findMatchingWabaNumber } from '../lib/whatsapp'
import { getSetting, setSetting, UNACTIVATED_WELCOME_KEY } from '../lib/settings'
import {
  fireMessageList, listContacts, createContact, updateContact, deleteContact,
  listMessageLists, getMessageListDetail, validateMessageListInput, createMessageList,
  updateMessageList, deleteMessageList
} from '../lib/messageLists'
import { listStaffNumbers, addStaffNumber, removeStaffNumber, runKnowledgeBaseAnalysis } from '../lib/knowledgeBase'
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

// ---------------------- Feature 1: unified welcome/activation message ----------------------
// A single platform-wide setting (settings.unactivated_welcome_message) sent
// to any non-activated sender in a private chat (dedicated or shared
// number). Groups stay silent — see src/routes/webhook.ts's /bridge/message
// handler, which never reads this setting.
admin.get('/welcome-message', async (c) => {
  const { DB } = c.env
  const value = await getSetting(DB, UNACTIVATED_WELCOME_KEY)
  return c.json({ message: value || '' })
})

admin.put('/welcome-message', async (c) => {
  const { DB } = c.env
  const { message } = await c.req.json()
  if (typeof message !== 'string' || !message.trim()) {
    return c.json({ error: 'نص الرسالة مطلوب' }, 400)
  }
  await setSetting(DB, UNACTIVATED_WELCOME_KEY, message.trim())
  return c.json({ success: true })
})

// ---------------------- Feature 3: suggestion box ----------------------
// Offices submit free-text suggestions via a WhatsApp command (see
// src/lib/commandHandlers.ts); visible here to the admin. `type` keeps the
// underlying table extensible for future similar "office-submitted content"
// features without new migrations.
admin.get('/suggestions', async (c) => {
  const { DB } = c.env
  const status = c.req.query('status') // optional filter: new | reviewed | done
  const query = status
    ? DB.prepare(
        `SELECT s.*, cu.name as customer_name FROM suggestions s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         WHERE s.status = ? ORDER BY s.created_at DESC`
      ).bind(status)
    : DB.prepare(
        `SELECT s.*, cu.name as customer_name FROM suggestions s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         ORDER BY s.created_at DESC`
      )
  const result = await query.all()
  return c.json({ suggestions: result.results })
})

admin.put('/suggestions/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { status } = await c.req.json()
  if (!['new', 'reviewed', 'done'].includes(status)) {
    return c.json({ error: 'حالة غير صالحة' }, 400)
  }
  await DB.prepare('UPDATE suggestions SET status = ? WHERE id = ?').bind(status, id).run()
  return c.json({ success: true })
})

// ---------------------- Activation/deactivation commands overview ----------------------
// Read-only reference view for the admin: which text command activates or
// deactivates each office on the platform's shared WhatsApp number (custom
// command if the office set one, otherwise the auto-derived default "<اسم
// المكتب> تفعيل" pattern — see src/lib/office.ts / webhook.ts for the actual
// matching logic). Also surfaces how many end-user sessions are currently
// linked to each office so the admin can gauge real usage at a glance.
// Only customers on a 'shared'-mode package are relevant here — customers
// on a 'private' package have their own dedicated number and never need an
// activation command at all.
admin.get('/activation-commands', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    `SELECT DISTINCT cu.id, cu.name, cu.activation_code, cu.deactivation_code,
       cu.feature_cumulative_list_enabled, cu.feature_visa_check_enabled,
       (SELECT COUNT(*) FROM shared_number_sessions sess
          WHERE sess.customer_id = cu.id AND sess.expires_at >= datetime('now')) as active_sessions
     FROM customers cu
     JOIN subscriptions s ON s.customer_id = cu.id
     JOIN packages p ON p.id = s.package_id
     WHERE p.number_mode = 'shared' AND s.status = 'active' AND s.end_date >= datetime('now')
     ORDER BY cu.name COLLATE NOCASE`
  ).all<{
    id: number; name: string; activation_code: string | null; deactivation_code: string | null
    feature_cumulative_list_enabled: number; feature_visa_check_enabled: number; active_sessions: number
  }>()

  const offices = (result.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    activation_command: r.activation_code || `${r.name} تفعيل`,
    activation_is_custom: !!r.activation_code,
    deactivation_command: r.deactivation_code || null,
    active_sessions: r.active_sessions || 0,
    features: {
      cumulative_list: { enabled: !!r.feature_cumulative_list_enabled, enable_command: 'تفعيل القائمة', disable_command: 'الغاء القائمة' },
      visa_check: { enabled: !!r.feature_visa_check_enabled, enable_command: 'تفعيل فحص التاشيره', disable_command: 'الغاء فحص التاشيره' }
    }
  }))

  return c.json({ offices })
})

// ---------------------- Feature 4: Umrah visa-check monitor ----------------------
// Read-only visibility for the admin over the periodic checker's queue and
// history (the VPS process itself polls/updates these rows via the
// /webhook/visa-checks/* API, independent of this admin view).
admin.get('/visa-checks', async (c) => {
  const { DB } = c.env
  const status = c.req.query('status') // optional filter: pending | checking | found | failed
  const query = status
    ? DB.prepare(
        `SELECT v.*, cu.name as customer_name FROM umrah_visa_checks v
         JOIN customers cu ON cu.id = v.customer_id
         WHERE v.status = ? ORDER BY v.created_at DESC LIMIT 100`
      ).bind(status)
    : DB.prepare(
        `SELECT v.*, cu.name as customer_name FROM umrah_visa_checks v
         JOIN customers cu ON cu.id = v.customer_id
         ORDER BY v.created_at DESC LIMIT 100`
      )
  const result = await query.all()
  return c.json({ checks: result.results })
})

// ---------------------- Message Lists (قوائم رسائل) — platform-wide admin view ----------------------
// The admin can see/manage every office's contacts and lists (e.g. to set
// up "معالم الرياض"'s pilot list on their behalf), scoped by customer_id
// passed explicitly in the request (query param for reads, body for
// writes) since the admin isn't tied to a single customer_id like the
// customer portal is. See src/routes/customer.ts for the office's own
// self-service equivalent of these same endpoints.
admin.get('/message-contacts', async (c) => {
  const { DB } = c.env
  const customerId = parseInt(c.req.query('customer_id') || '', 10)
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  const contacts = await listContacts(DB, customerId)
  return c.json({ contacts })
})

admin.post('/message-contacts', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const customerId = parseInt(body.customer_id, 10)
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  if (!body.name || !body.value) return c.json({ error: 'الاسم والرقم/المعرّف مطلوبان' }, 400)
  const id = await createContact(DB, customerId, body)
  return c.json({ success: true, id })
})

admin.put('/message-contacts/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const body = await c.req.json()
  const customerId = parseInt(body.customer_id, 10)
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  const ok = await updateContact(DB, id, customerId, body)
  if (!ok) return c.json({ error: 'جهة الاتصال غير موجودة' }, 404)
  return c.json({ success: true })
})

admin.delete('/message-contacts/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const customerId = parseInt(c.req.query('customer_id') || '', 10)
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  const ok = await deleteContact(DB, id, customerId)
  if (!ok) return c.json({ error: 'جهة الاتصال غير موجودة' }, 404)
  return c.json({ success: true })
})

admin.get('/message-lists', async (c) => {
  const { DB } = c.env
  const customerId = parseInt(c.req.query('customer_id') || '', 10)
  if (customerId) {
    const lists = await listMessageLists(DB, customerId)
    return c.json({ lists })
  }
  // No filter: platform-wide view across every office, for the admin's
  // overview table.
  const rows = await DB.prepare(
    `SELECT l.*, cu.name as customer_name,
       (SELECT r2.run_at FROM message_list_runs r2 WHERE r2.list_id = l.id ORDER BY r2.run_at DESC LIMIT 1) as last_run_at
     FROM message_lists l JOIN customers cu ON cu.id = l.customer_id
     ORDER BY l.created_at DESC`
  ).all()
  return c.json({ lists: rows.results })
})

admin.get('/message-lists/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const row = await DB.prepare('SELECT customer_id FROM message_lists WHERE id = ?').bind(id).first<{ customer_id: number }>()
  if (!row) return c.json({ error: 'القائمة غير موجودة' }, 404)
  const detail = await getMessageListDetail(DB, id, row.customer_id)
  return c.json(detail)
})

admin.post('/message-lists', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const customerId = parseInt(body.customer_id, 10)
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  const validationError = validateMessageListInput(body)
  if (validationError) return c.json(validationError, 400)
  const id = await createMessageList(DB, customerId, body)
  return c.json({ success: true, id })
})

admin.put('/message-lists/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const body = await c.req.json()
  const row = await DB.prepare('SELECT customer_id FROM message_lists WHERE id = ?').bind(id).first<{ customer_id: number }>()
  if (!row) return c.json({ error: 'القائمة غير موجودة' }, 404)
  const validationError = validateMessageListInput(body)
  if (validationError) return c.json(validationError, 400)
  await updateMessageList(DB, id, row.customer_id, body)
  return c.json({ success: true })
})

admin.delete('/message-lists/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const row = await DB.prepare('SELECT customer_id FROM message_lists WHERE id = ?').bind(id).first<{ customer_id: number }>()
  if (!row) return c.json({ error: 'القائمة غير موجودة' }, 404)
  await deleteMessageList(DB, id, row.customer_id)
  return c.json({ success: true })
})

// Manual immediate send, bypassing the schedule — useful for testing a list
// right after creating it instead of waiting for the next scheduled time.
admin.post('/message-lists/:id/send-now', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const list = await DB.prepare('SELECT * FROM message_lists WHERE id = ?').bind(id).first<any>()
  if (!list) return c.json({ error: 'القائمة غير موجودة' }, 404)
  const result = await fireMessageList(DB, list)
  return c.json({ success: true, ...result })
})

// =====================================================================
// Knowledge Base (قاعدة المعرفة) — requested 2026-08-24. Admin can see and
// manage EVERY office's staff-number registry and extracted knowledge (a
// customer_id query param scopes to one office; without it these list
// endpoints show a platform-wide view). See knowledgeBase.ts /
// migrations/0011 for the full privacy-design rationale.
// =====================================================================

// ---- Staff numbers (who counts as a confirmed office employee) ----
admin.get('/staff-numbers', async (c) => {
  const { DB } = c.env
  const customerId = c.req.query('customer_id')
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  const list = await listStaffNumbers(DB, parseInt(customerId, 10))
  return c.json({ staff_numbers: list })
})

admin.post('/staff-numbers', async (c) => {
  const { DB } = c.env
  const { customer_id, identifier, label } = await c.req.json()
  if (!customer_id || !identifier) return c.json({ error: 'customer_id و identifier مطلوبان' }, 400)
  await addStaffNumber(DB, customer_id, identifier, label || null)
})

admin.delete('/staff-numbers/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const customerId = c.req.query('customer_id')
  if (!customerId) return c.json({ error: 'customer_id مطلوب' }, 400)
  await removeStaffNumber(DB, parseInt(customerId, 10), id)
  return c.json({ success: true })
})

// ---- Extracted knowledge items (review queue) ----
admin.get('/knowledge-base', async (c) => {
  const { DB } = c.env
  const customerId = c.req.query('customer_id')
  const status = c.req.query('status') // pending_review | approved | rejected
  let query = `SELECT kb.*, cu.name as customer_name FROM knowledge_base kb
               JOIN customers cu ON cu.id = kb.customer_id WHERE 1=1`
  const binds: any[] = []
  if (customerId) { query += ' AND kb.customer_id = ?'; binds.push(parseInt(customerId, 10)) }
  if (status) { query += ' AND kb.status = ?'; binds.push(status) }
  query += ' ORDER BY kb.created_at DESC LIMIT 200'
  const res = await DB.prepare(query).bind(...binds).all()
  return c.json({ items: res.results || [] })
})

admin.put('/knowledge-base/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  const { status } = await c.req.json() // approved | rejected | pending_review
  if (!['approved', 'rejected', 'pending_review'].includes(status)) {
    return c.json({ error: 'status غير صالحة' }, 400)
  }
  const adminUser = c.get('admin')
  await DB.prepare(
    `UPDATE knowledge_base SET status = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`
  ).bind(status, adminUser?.email || null, id).run()
  return c.json({ success: true })
})

admin.delete('/knowledge-base/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'), 10)
  await DB.prepare('DELETE FROM knowledge_base WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// Manual on-demand trigger (in addition to the periodic VPS-polled tick) —
// useful right after registering staff numbers to see results immediately
// instead of waiting for the next tick.
admin.post('/knowledge-base/analyze-now', async (c) => {
  const { DB, GEMINI_API_KEY } = c.env
  const { customer_id } = await c.req.json()
  if (!customer_id) return c.json({ error: 'customer_id مطلوب' }, 400)
  const result = await runKnowledgeBaseAnalysis(DB, GEMINI_API_KEY, customer_id)
  if ('error' in result) return c.json(result, 400)
  return c.json({ success: true, ...result })
})
// === Health Monitoring ===
admin.get('/health', async (c) => {
  const db = c.env.DB as any;
    try {
        const stuck = await db.prepare(
              "SELECT COUNT(*) as c FROM umrah_visa_checks WHERE status='checking' AND datetime(updated_at) < datetime('now','-5 minutes')"
                  ).first() as any;

                      const lastTick = await db.prepare(
                            "SELECT MAX(created_at) as t FROM bridge_events ORDER BY id DESC"
                                ).first() as any;

                                    const todayOps = await db.prepare(
                                          "SELECT status, COUNT(*) as cnt FROM umrah_visa_checks WHERE date(created_at)=date('now') GROUP BY status"
                                              ).all() as any;

                                                  return c.json({
                                                        ok: true,
                                                              time: new Date().toISOString(),
                                                                    stuck_checks: stuck?.c || 0,
                                                                          bridge_last_tick: lastTick?.t || null,
                                                                                r2_enabled: !!c.env.PASSPORT_BUCKET,
                                                                                      ops_today: todayOps.results || []
                                                                                          });
                                                                                            } catch (e:any) {
                                                                                                return c.json({ ok: false, error: e.message }, 500);
                                                                                                  }
                                                                                                  });

                                                                                                  admin.post('/health/fix-stuck', async (c) => {
                                                                                                    const db = c.env.DB as any;
                                                                                                      const r = await db.prepare(
                                                                                                          "UPDATE umrah_visa_checks SET status='pending', updated_at=datetime('now') WHERE status='checking' AND datetime(updated_at) < datetime('now','-5 minutes')"
                                                                                                            ).run();
                                                                                                              return c.json({ fixed: r.meta.changes });
                                                                                                              });

                                                                                                              export default admin
