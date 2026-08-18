import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import type { WhatsAppWebhookBody } from '../lib/whatsapp'
import { downloadMedia, sendTextMessage, markMessageRead } from '../lib/whatsapp'
import { extractPassportData } from '../lib/gemini'
import { AVAILABLE_FIELDS, parseExtractionFields } from '../lib/fields'
import { extractOfficeActivationCode, matchOfficeByName, matchByCustomCommand } from '../lib/office'

const SHARED_SESSION_DAYS = 30

const webhook = new Hono<AppEnv>()

// ---------------------- Webhook verification (GET) ----------------------
// Meta calls this once when you configure the webhook URL in the App dashboard.
webhook.get('/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  const expectedToken = c.env.WHATSAPP_VERIFY_TOKEN || 'change-me-verify-token'

  if (mode === 'subscribe' && token === expectedToken) {
    return c.text(challenge || '', 200)
  }
  return c.text('Verification failed', 403)
})

// ---------------------- Incoming messages (POST) ----------------------
webhook.post('/whatsapp', async (c) => {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY, WHATSAPP_API_VERSION } = c.env

  let body: WhatsAppWebhookBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: true })
  }

  // Always respond 200 quickly to Meta; process best-effort.
  if (body.object !== 'whatsapp_business_account') {
    return c.json({ ok: true })
  }

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value
      if (!value?.messages || value.messages.length === 0) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find the connected number + owning customer + active subscription
      const numberRow = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first<any>()

      for (const msg of value.messages) {
        await handleIncomingMessage({
          DB,
          PASSPORTS_BUCKET,
          GEMINI_API_KEY,
          WHATSAPP_API_VERSION,
          numberRow,
          phoneNumberId,
          msg
        }).catch((err) => {
          console.error('Error handling message', err)
        })
      }
    }
  }

  return c.json({ ok: true })
})

async function handleIncomingMessage(params: {
  DB: D1Database
  PASSPORTS_BUCKET: R2Bucket
  GEMINI_API_KEY?: string
  WHATSAPP_API_VERSION?: string
  numberRow: any
  phoneNumberId: string
  msg: any
}) {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY, WHATSAPP_API_VERSION, numberRow, phoneNumberId, msg } = params
  const senderPhone = msg.from as string
  const messageId = msg.id as string
  const startTime = Date.now()

  // Number not registered on the platform at all -> ignore silently
  if (!numberRow) {
    console.warn(`Received message for unregistered phone_number_id=${phoneNumberId}`)
    return
  }

  const accessToken = numberRow.access_token
  if (!accessToken) {
    console.warn(`Number ${phoneNumberId} has no access_token configured`)
    return
  }

  markMessageRead(phoneNumberId, accessToken, messageId, WHATSAPP_API_VERSION).catch(() => {})

  let customerId: number | null = numberRow.customer_id as number | null

  // ---------------- Shared/multi-tenant number resolution ----------------
  // This number has no single owner (is_shared = 1). The sender must first
  // link their number to an office, either by sending "<اسم المكتب> تفعيل"
  // (auto-derived pattern) or the office's own custom activation command
  // (if the office set one — this fully replaces the name-based pattern for
  // that office). After that a session row resolves them automatically for
  // 30 days (renewed on every successful interaction). The office may also
  // set a custom deactivation command to let the sender unlink on demand.
  if (numberRow.is_shared) {
    const messageText: string = msg.type === 'text' ? (msg.text?.body || '') : ''

    // ---- 1) Deactivation command: only relevant if a session already exists ----
    const existingSession = await DB.prepare(
      `SELECT * FROM shared_number_sessions WHERE whatsapp_number_id = ? AND sender_phone = ? AND expires_at >= datetime('now')`
    ).bind(numberRow.id, senderPhone).first<any>()

    if (existingSession && messageText) {
      const linkedCustomer = await DB.prepare('SELECT deactivation_code FROM customers WHERE id = ?')
        .bind(existingSession.customer_id).first<{ deactivation_code: string | null }>()

      if (linkedCustomer?.deactivation_code) {
        const isDeactivation = matchByCustomCommand(
          [{ id: existingSession.id, code: linkedCustomer.deactivation_code }],
          messageText
        )
        if (isDeactivation) {
          await DB.prepare('DELETE FROM shared_number_sessions WHERE id = ?').bind(existingSession.id).run()
          await sendTextMessage(
            phoneNumberId, accessToken, senderPhone,
            '✅ تم إلغاء ربط رقمك بالمكتب. أرسل اسم مكتبك متبوعاً بكلمة "تفعيل" أو أمر التفعيل الخاص بالمكتب للربط من جديد.',
            WHATSAPP_API_VERSION
          ).catch(() => {})
          return
        }
      }
    }

    // ---- 2) Activation attempt (custom command first, then name pattern) ----
    const candidates = await DB.prepare(
      `SELECT DISTINCT cu.id, cu.name, cu.activation_code FROM customers cu
       JOIN subscriptions s ON s.customer_id = cu.id
       JOIN packages p ON p.id = s.package_id
       WHERE p.number_mode = 'shared' AND s.status = 'active' AND s.end_date >= datetime('now')`
    ).all<{ id: number; name: string; activation_code: string | null }>()
    const allCandidates = candidates.results || []

    let matched: { id: number; name: string } | null = null

    if (messageText) {
      const customMatch = matchByCustomCommand(
        allCandidates
          .filter((c) => !!c.activation_code)
          .map((c) => ({ id: c.id, name: c.name, code: c.activation_code })),
        messageText
      )
      if (customMatch) matched = { id: customMatch.id, name: customMatch.name }
    }

    const officeNameRaw = !matched ? extractOfficeActivationCode(messageText) : null
    if (!matched && officeNameRaw) {
      // Name-based pattern only applies to offices that have NOT set a
      // custom activation command (a custom command fully replaces it).
      const nameCandidates = allCandidates.filter((c) => !c.activation_code)
      matched = matchOfficeByName(nameCandidates, officeNameRaw)
    }

    if (matched) {
      const expiresAt = new Date(Date.now() + SHARED_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
      await DB.prepare(
        `INSERT INTO shared_number_sessions (whatsapp_number_id, sender_phone, customer_id, expires_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(whatsapp_number_id, sender_phone) DO UPDATE SET customer_id=excluded.customer_id, expires_at=excluded.expires_at, updated_at=datetime('now')`
      ).bind(numberRow.id, senderPhone, matched.id, expiresAt).run()

      await sendTextMessage(
        phoneNumberId, accessToken, senderPhone,
        `تم الربط بمكتب ${matched.name} ✅ أرسل الآن صورة جواز السفر`,
        WHATSAPP_API_VERSION
      ).catch(() => {})
      return
    }

    if (officeNameRaw) {
      // A name-pattern activation attempt was made but nothing matched.
      await sendTextMessage(
        phoneNumberId, accessToken, senderPhone,
        `⚠️ لم يتم العثور على مكتب باسم "${officeNameRaw}". تأكد من كتابة اسم المكتب بشكل صحيح متبوعاً بكلمة "تفعيل"، مثال: معالم الرياض 11 تفعيل`,
        WHATSAPP_API_VERSION
      ).catch(() => {})
      return
    }

    // ---- 3) Not an activation/deactivation message: use existing session ----
    if (!existingSession) {
      await sendTextMessage(
        phoneNumberId, accessToken, senderPhone,
        '👋 مرحباً! أرسل اسم مكتبك متبوعاً بكلمة "تفعيل" أو أمر التفعيل الخاص بالمكتب لربط رقمك، مثال: معالم الرياض 11 تفعيل',
        WHATSAPP_API_VERSION
      ).catch(() => {})
      return
    }

    customerId = existingSession.customer_id as number
    // Renew the session on every successful interaction
    const newExpiresAt = new Date(Date.now() + SHARED_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    DB.prepare(`UPDATE shared_number_sessions SET expires_at=?, updated_at=datetime('now') WHERE id=?`)
      .bind(newExpiresAt, existingSession.id).run().catch(() => {})
  }

  if (!customerId) {
    console.warn(`Unable to resolve customer for phone_number_id=${phoneNumberId}, sender=${senderPhone}`)
    return
  }

  // Fetch customer preferences
  const customer = await DB.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first<any>()
  const lang = customer?.reply_language || 'ar'

  const T = lang === 'en'
    ? {
        notImage: '👋 Please send a clear photo of the passport data page to extract the information.',
        suspended: '⚠️ This service is currently suspended. Please contact the account owner.',
        limitReached: '⚠️ Monthly operation limit reached for this subscription. Please contact the account owner to upgrade.',
        unclear: (reason: string) => `⚠️ Image is not clear enough: ${reason || 'please resend a clearer photo of the passport.'}`,
        notPassport: '⚠️ This does not appear to be a passport page. Please send a clear photo of the passport data page.',
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', numberRow.extraction_fields)
      }
    : {
        notImage: '👋 من فضلك أرسل صورة واضحة لصفحة بيانات الجواز حتى نتمكن من استخراج المعلومات.',
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا الرقم، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        notPassport: '⚠️ يبدو أن هذه الصورة ليست صفحة جواز سفر. يرجى إرسال صورة واضحة لصفحة بيانات الجواز.',
        error: '❌ حدث خطأ أثناء معالجة الصورة، يرجى المحاولة مرة أخرى.',
        result: (r: any) => buildResultMessage(r, 'ar', numberRow.extraction_fields)
      }

  // Non-image messages -> friendly guidance
  if (msg.type !== 'image') {
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, customer?.welcome_message || T.notImage, WHATSAPP_API_VERSION).catch(() => {})
    return
  }

  if (customer?.status !== 'active') {
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.suspended, WHATSAPP_API_VERSION).catch(() => {})
    return
  }

  // Check active subscription + quota
  const activeSub = await DB.prepare(
    `SELECT * FROM subscriptions WHERE customer_id = ? AND status='active' AND end_date >= datetime('now') ORDER BY end_date DESC LIMIT 1`
  ).bind(customerId).first<any>()

  if (!activeSub) {
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.suspended, WHATSAPP_API_VERSION).catch(() => {})
    return
  }

  if (activeSub.operations_used >= activeSub.operations_limit) {
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.limitReached, WHATSAPP_API_VERSION).catch(() => {})
    return
  }

  // Create operation row (processing)
  const opInsert = await DB.prepare(
    `INSERT INTO operations (whatsapp_number_id, customer_id, sender_phone, message_id, status, source)
     VALUES (?, ?, ?, ?, 'processing', 'whatsapp')`
  ).bind(numberRow.id, customerId, senderPhone, messageId).run()
  const operationId = opInsert.meta.last_row_id

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY غير مهيأ على المنصة')
    }

    const media = await downloadMedia(msg.image.id, accessToken, WHATSAPP_API_VERSION)

    // Store image in R2 for audit trail (best-effort, non-blocking on failure)
    const imageKey = `passports/${customerId}/${operationId}-${Date.now()}.jpg`
    PASSPORTS_BUCKET.put(imageKey, media.bytes, { httpMetadata: { contentType: media.mimeType } }).catch(() => {})

    const extraction = await extractPassportData(GEMINI_API_KEY, media.base64, media.mimeType)
    const processingTime = Date.now() - startTime

    if (!extraction.is_passport) {
      await DB.prepare(
        `UPDATE operations SET status='failed', image_key=?, error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(imageKey, 'الصورة ليست جواز سفر', JSON.stringify(extraction), processingTime, operationId).run()
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.notPassport, WHATSAPP_API_VERSION)
      return
    }

    if (!extraction.is_clear) {
      await DB.prepare(
        `UPDATE operations SET status='unclear', image_key=?, error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(imageKey, extraction.clarity_reason || 'الصورة غير واضحة', JSON.stringify(extraction), processingTime, operationId).run()
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.unclear(extraction.clarity_reason || ''), WHATSAPP_API_VERSION)
      return
    }

    // Success: persist extracted fields and increment quota usage
    await DB.batch([
      DB.prepare(
        `UPDATE operations SET status='success', image_key=?, full_name_ar=?, full_name_en=?, passport_number=?,
           nationality=?, date_of_birth=?, date_of_expiry=?, gender=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(
        imageKey,
        extraction.full_name_ar || null,
        extraction.full_name_en || null,
        extraction.passport_number || null,
        extraction.nationality || null,
        extraction.date_of_birth || null,
        extraction.date_of_expiry || null,
        extraction.gender || null,
        JSON.stringify(extraction),
        processingTime,
        operationId
      ),
      DB.prepare('UPDATE subscriptions SET operations_used = operations_used + 1 WHERE id = ?').bind(activeSub.id)
    ])

    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.result(extraction), WHATSAPP_API_VERSION)
  } catch (err: any) {
    console.error('Passport processing error', err)
    await DB.prepare(`UPDATE operations SET status='failed', error_message=? WHERE id=?`)
      .bind(String(err?.message || err), operationId)
      .run()
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.error, WHATSAPP_API_VERSION).catch(() => {})
  }
}

// Builds the WhatsApp reply text, restricted to the fields configured for this
// number (extraction_fields JSON column; null/empty = all fields, default).
// Each value is wrapped in ``` (monospace) on its own line so the recipient
// can long-press just that line in WhatsApp and tap "Copy" — WhatsApp has no
// native "copy button" API for business messages, so this is the closest
// practical equivalent.
function buildResultMessage(r: any, lang: 'ar' | 'en', extractionFieldsRaw: string | null): string {
  const allowedKeys = parseExtractionFields(extractionFieldsRaw)
  const fieldsToShow = AVAILABLE_FIELDS.filter((f) => allowedKeys.includes(f.key) && r[f.key])

  const header = lang === 'en' ? '✅ Passport data extracted successfully:' : '✅ تم استخراج بيانات الجواز بنجاح:'
  const lines = [header, '']

  for (const f of fieldsToShow) {
    const label = lang === 'en' ? f.label_en : f.label_ar
    lines.push(`${f.emoji} ${label}:`)
    lines.push('```' + r[f.key] + '```')
  }

  return lines.join('\n')
}

export default webhook
