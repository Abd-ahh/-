import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import type { WhatsAppWebhookBody } from '../lib/whatsapp'
import { downloadMedia, sendTextMessage, sendDocumentMessage, uploadMedia, markMessageRead } from '../lib/whatsapp'
import { extractPassportData } from '../lib/gemini'
import { AVAILABLE_FIELDS, parseExtractionFields } from '../lib/fields'
import { extractOfficeActivationCode, matchOfficeByName, matchByCustomCommand } from '../lib/office'
import { buildConversationKey, parseCommand } from '../lib/commands'
import { handleTextCommand } from '../lib/commandHandlers'
import { appendToCumulativeList, buildCumulativeListMessage, parseCumulativeFields } from '../lib/cumulative'
import { getSetting, UNACTIVATED_WELCOME_KEY } from '../lib/settings'
import { deliverToConversation } from '../lib/deliver'
import { runExtractionBatch } from '../lib/extractionBatch'

const SHARED_SESSION_DAYS = 30

// Hardcoded fallback used only if the admin has never set a global welcome
// message (settings.unactivated_welcome_message). The admin dashboard lets
// this be fully customized (e.g. "for activation contact ...").
const DEFAULT_WELCOME_MESSAGE = '👋 أهلاً وسهلاً! لتفعيل الخدمة يرجى التواصل مع إدارة المنصة.'

// Umrah visa auto-check timing (feature 4): first check 30 minutes after the
// passport photo is received, then retry every 30 minutes until found
// (unified to a single interval by explicit user decision on 2026-08-23 —
// was previously 180min initial delay / 20min retry interval).
const VISA_CHECK_INITIAL_DELAY_MIN = 30
const VISA_CHECK_RETRY_INTERVAL_MIN = 30

// Feature 6 (Auto-Extract toggle, migration 0009): safety cap on how many
// queued images a single "استخراج" command processes in one call, to keep
// the request within a reasonable execution time. Any remainder stays
// queued and the summary message tells the user to send "استخراج" again.
const MAX_EXTRACTION_BATCH_SIZE = 15

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
  PASSPORTS_BUCKET?: R2Bucket
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

    // "تفعيل القائمة" / "تفعيل فحص التاشيره" are fixed per-feature toggle
    // commands (commands.ts), NOT office-activation attempts — exclude them
    // here so extractOfficeActivationCode doesn't misread "القائمة"/"فحص
    // التاشيره" as an office name and reply with a bogus "office not found".
    const isFeatureToggleCommand = parseCommand(messageText)?.type === 'toggle_feature'
    const officeNameRaw = !matched && !isFeatureToggleCommand ? extractOfficeActivationCode(messageText) : null
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

    // ---- 3) Not an activation/deactivation message and no session yet:
    // send the unified, admin-editable welcome/activation-prompt message
    // (feature 1) instead of the old hardcoded instructions. Private chats
    // only — groups keep their existing silent behavior unchanged.
    if (!existingSession) {
      const welcomeMsg = (await getSetting(DB, UNACTIVATED_WELCOME_KEY)) || DEFAULT_WELCOME_MESSAGE
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, welcomeMsg, WHATSAPP_API_VERSION).catch(() => {})
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

  const conversationKey = buildConversationKey({ whatsapp_number_id: numberRow.id, sender_phone: senderPhone })

  // Non-image messages: first try explicit commands (check-now, list,
  // report, suggestion) — these work identically whether the number is
  // private/dedicated or shared. Anything else falls back to the existing
  // per-customer welcome_message / notImage guidance (unchanged).
  if (msg.type !== 'image') {
    if (msg.type === 'text' && msg.text?.body) {
      const outcome = await handleTextCommand(DB, customer, customerId, conversationKey, lang, msg.text.body).catch((err) => {
        console.error('handleTextCommand failed', err)
        return null
      })
      if (outcome) {
        if (outcome.kind === 'text') {
          await sendTextMessage(phoneNumberId, accessToken, senderPhone, outcome.text, WHATSAPP_API_VERSION).catch(() => {})
        } else {
          await DB.prepare(
            `INSERT INTO render_jobs (customer_id, conversation_key, job_type, html, filename) VALUES (?, ?, 'report_pdf', ?, ?)`
          ).bind(customerId, conversationKey, outcome.html, outcome.filename).run()
          await sendTextMessage(
            phoneNumberId, accessToken, senderPhone,
            lang === 'en' ? '📄 Preparing your PDF report, it will arrive here shortly...' : '📄 يتم تجهيز ملف التقرير الآن، سيصلك هنا قريباً...',
            WHATSAPP_API_VERSION
          ).catch(() => {})
        }
        return
      }
    }
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

    // Store image in R2 for audit trail (best-effort, non-blocking on failure).
    // R2 binding may not be configured on every environment — guard against
    // that instead of throwing (was previously causing "Cannot read
    // properties of undefined (reading 'put')" and aborting the whole flow).
    const imageKey = `passports/${customerId}/${operationId}-${Date.now()}.jpg`
    if (PASSPORTS_BUCKET) {
      PASSPORTS_BUCKET.put(imageKey, media.bytes, { httpMetadata: { contentType: media.mimeType } }).catch((err) => {
        console.error('R2 put failed', err)
      })
    }

    const extraction = await extractPassportData(GEMINI_API_KEY, media.base64, media.mimeType)
    const processingTime = Date.now() - startTime

    if (!extraction.is_passport) {
      await DB.prepare(
        `UPDATE operations SET status='failed', image_key=?, error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(imageKey, 'الصورة ليست جواز سفر', JSON.stringify(extraction), processingTime, operationId).run()
      // Sending the WhatsApp reply is a best-effort side effect at this
      // point — the extraction outcome is already persisted, so a network
      // hiccup or a WhatsApp-side send failure (e.g. recipient not in the
      // allowed list on a test number) must NOT propagate to the outer
      // catch below and overwrite the already-correct operation status.
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.notPassport, WHATSAPP_API_VERSION).catch((err) =>
        console.error('sendTextMessage (notPassport) failed', err)
      )
      return
    }

    if (!extraction.is_clear) {
      await DB.prepare(
        `UPDATE operations SET status='unclear', image_key=?, error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(imageKey, extraction.clarity_reason || 'الصورة غير واضحة', JSON.stringify(extraction), processingTime, operationId).run()
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.unclear(extraction.clarity_reason || ''), WHATSAPP_API_VERSION).catch((err) =>
        console.error('sendTextMessage (unclear) failed', err)
      )
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

    // Extraction succeeded and is already persisted + quota already
    // incremented above. If sending the reply itself fails (WhatsApp API
    // error, e.g. recipient not in the allowed list on a test number),
    // that must NOT be reported back to the user as a processing error —
    // the operation record correctly shows 'success' either way.
    await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.result(extraction), WHATSAPP_API_VERSION).catch((err) =>
      console.error('sendTextMessage (result) failed', err)
    )

    // Cumulative running list (feature 2): append this extraction and
    // resend the updated numbered list, best-effort (must not affect the
    // already-successful main extraction outcome above). Gated behind the
    // office's own "تفعيل القائمة" command (defaults to disabled).
    if (customer?.feature_cumulative_list_enabled) {
      try {
        const fieldKeys = parseCumulativeFields(customer?.cumulative_list_fields)
        const resetHours = customer?.cumulative_list_reset_hours ?? 24
        const items = await appendToCumulativeList(DB, customerId, conversationKey, resetHours, fieldKeys, extraction)
        await sendTextMessage(
          phoneNumberId, accessToken, senderPhone,
          buildCumulativeListMessage(items, lang, fieldKeys),
          WHATSAPP_API_VERSION
        ).catch(() => {})
      } catch (err) {
        console.error('Cumulative list update failed', err)
      }
    }

    // Periodic Umrah visa auto-check (feature 4): second, parallel service
    // option alongside the extraction reply above. Only starts if we have
    // both a passport number and a first name to search MOFA with, AND the
    // office has enabled it via "تفعيل فحص التاشيره" (defaults to disabled).
    if (customer?.feature_visa_check_enabled && extraction.passport_number && extraction.full_name_ar) {
      try {
        const firstName = extraction.full_name_ar.trim().split(/\s+/)[0]
        const nextCheckAt = new Date(Date.now() + VISA_CHECK_INITIAL_DELAY_MIN * 60 * 1000).toISOString()
        await DB.prepare(
          `INSERT INTO umrah_visa_checks (operation_id, customer_id, conversation_key, passport_number, first_name, nationality, next_check_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(operationId, customerId, conversationKey, extraction.passport_number, firstName, extraction.nationality || null, nextCheckAt).run()
      } catch (err) {
        console.error('Umrah visa check scheduling failed', err)
      }
    }
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

// =========================================================
// WhatsApp GROUP bridge endpoint
// =========================================================
// Meta's official Cloud API cannot join or receive messages from WhatsApp
// groups (hard platform restriction — see README). To support offices whose
// workflow is centered on a shared WhatsApp group, a separate unofficial
// bridge process (Baileys, running on an external VPS, connected as a normal
// personal WhatsApp number added into each office's group by a human) POSTs
// every group text/image message here. This endpoint runs the exact same
// office-matching + Gemini extraction pipeline as the official number, just
// keyed by group JID instead of phone_number_id/session, and returns a
// plain { reply } string for the bridge to send back into the group —
// it never talks to Meta's Graph API directly.
webhook.post('/bridge/message', async (c) => {
  const { DB, GEMINI_API_KEY, BRIDGE_SECRET } = c.env

  // The bridge is an unofficial process on our own VPS — require a shared
  // secret so this endpoint can't be hit by anyone who finds the URL.
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let payload: {
    group_jid?: string
    group_name?: string
    sender_jid?: string
    type?: 'text' | 'image'
    text?: string
    image_base64?: string
    mime_type?: string
  }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const { group_jid, group_name, sender_jid, type, text, image_base64, mime_type } = payload
  if (!group_jid || !sender_jid || !type) {
    return c.json({ error: 'group_jid, sender_jid and type are required' }, 400)
  }

  const startTime = Date.now()

  const existingGroup = await DB.prepare('SELECT * FROM whatsapp_groups WHERE group_jid = ?').bind(group_jid).first<any>()

  // ---------------- Text message: activation / deactivation ----------------
  if (type === 'text') {
    const messageText = text || ''

    // Deactivation (only if the group is already linked)
    if (existingGroup && messageText) {
      const linkedCustomer = await DB.prepare('SELECT deactivation_code FROM customers WHERE id = ?')
        .bind(existingGroup.customer_id).first<{ deactivation_code: string | null }>()
      if (linkedCustomer?.deactivation_code) {
        const isDeactivation = matchByCustomCommand(
          [{ id: existingGroup.id, code: linkedCustomer.deactivation_code }],
          messageText
        )
        if (isDeactivation) {
          await DB.prepare('DELETE FROM whatsapp_groups WHERE id = ?').bind(existingGroup.id).run()
          return c.json({ reply: '✅ تم إلغاء ربط هذه المجموعة بالمكتب. أرسل اسم المكتب متبوعاً بكلمة "تفعيل" للربط من جديد.' })
        }
      }
    }

    // Activation attempt (custom command first, then name pattern) — same
    // office pool used by the shared official number.
    const candidates = await DB.prepare(
      `SELECT DISTINCT cu.id, cu.name, cu.activation_code FROM customers cu
       JOIN subscriptions s ON s.customer_id = cu.id
       JOIN packages p ON p.id = s.package_id
       WHERE p.number_mode = 'shared' AND s.status = 'active' AND s.end_date >= datetime('now')`
    ).all<{ id: number; name: string; activation_code: string | null }>()
    const allCandidates = candidates.results || []

    let matched: { id: number; name: string } | null = null

    const customMatch = matchByCustomCommand(
      allCandidates.filter((cc) => !!cc.activation_code).map((cc) => ({ id: cc.id, name: cc.name, code: cc.activation_code })),
      messageText
    )
    if (customMatch) matched = { id: customMatch.id, name: customMatch.name }

    // Exclude fixed per-feature toggle commands from office-name matching
    // (see equivalent comment in the private/shared-number path above).
    const isFeatureToggleCommand = parseCommand(messageText)?.type === 'toggle_feature'
    const officeNameRaw = !matched && !isFeatureToggleCommand ? extractOfficeActivationCode(messageText) : null
    if (!matched && officeNameRaw) {
      const nameCandidates = allCandidates.filter((cc) => !cc.activation_code)
      matched = matchOfficeByName(nameCandidates, officeNameRaw)
    }

    if (matched) {
      await DB.prepare(
        `INSERT INTO whatsapp_groups (group_jid, group_name, customer_id, activated_by_jid, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(group_jid) DO UPDATE SET customer_id=excluded.customer_id, group_name=excluded.group_name,
           activated_by_jid=excluded.activated_by_jid, updated_at=datetime('now')`
      ).bind(group_jid, group_name || null, matched.id, sender_jid).run()
      return c.json({ reply: `تم ربط هذه المجموعة بمكتب ${matched.name} ✅ يمكن لأي عضو الآن إرسال صور جوازات السفر داخل المجموعة.` })
    }

    if (officeNameRaw) {
      return c.json({ reply: `⚠️ لم يتم العثور على مكتب باسم "${officeNameRaw}". تأكد من كتابة اسم المكتب بشكل صحيح متبوعاً بكلمة "تفعيل".` })
    }

    if (!existingGroup) {
      // Not an activation message and the group isn't linked yet — stay
      // silent instead of replying to every unrelated chit-chat message in
      // the group (unlike the 1:1 number where every message gets a reply).
      return c.json({})
    }

    // Linked group: the only other text commands supported are the
    // per-feature enable/disable toggles (Feature 2 / Feature 4). Anything
    // else stays silent (avoid spamming an active group conversation with
    // guidance on every text message).
    const toggleCmd = parseCommand(messageText)
    if (toggleCmd?.type === 'toggle_feature') {
      const linkedCustomer = await DB.prepare('SELECT reply_language FROM customers WHERE id = ?')
        .bind(existingGroup.customer_id).first<{ reply_language: string | null }>()
      const groupLang = linkedCustomer?.reply_language === 'en' ? 'en' : 'ar'
      const outcome = await handleTextCommand(DB, { reply_language: groupLang }, existingGroup.customer_id, buildConversationKey({ group_jid }), groupLang, messageText)
      if (outcome?.kind === 'text') {
        return c.json({ reply: outcome.text })
      }
    }

    return c.json({})
  }

  // ---------------- Image message: run the extraction pipeline ----------------
  if (!existingGroup) {
    // Image sent before the group was ever activated for an office — stay
    // silent (we don't know which office/quota to charge this to).
    return c.json({})
  }

  const customerId = existingGroup.customer_id as number
  const customer = await DB.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first<any>()
  const lang = customer?.reply_language || 'ar'

  const T = lang === 'en'
    ? {
        suspended: '⚠️ This service is currently suspended. Please contact the account owner.',
        limitReached: '⚠️ Monthly operation limit reached for this subscription. Please contact the account owner to upgrade.',
        unclear: (reason: string) => `⚠️ Image is not clear enough: ${reason || 'please resend a clearer photo of the passport.'}`,
        notPassport: '⚠️ This does not appear to be a passport page. Please send a clear photo of the passport data page.',
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', null)
      }
    : {
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا المكتب، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        notPassport: '⚠️ يبدو أن هذه الصورة ليست صفحة جواز سفر. يرجى إرسال صورة واضحة لصفحة بيانات الجواز.',
        error: '❌ حدث خطأ أثناء معالجة الصورة، يرجى المحاولة مرة أخرى.',
        result: (r: any) => buildResultMessage(r, 'ar', null)
      }

  if (customer?.status !== 'active') {
    return c.json({ reply: T.suspended })
  }

  const activeSub = await DB.prepare(
    `SELECT * FROM subscriptions WHERE customer_id = ? AND status='active' AND end_date >= datetime('now') ORDER BY end_date DESC LIMIT 1`
  ).bind(customerId).first<any>()

  if (!activeSub) {
    return c.json({ reply: T.suspended })
  }
  if (activeSub.operations_used >= activeSub.operations_limit) {
    return c.json({ reply: T.limitReached })
  }

  if (!image_base64) {
    return c.json({ reply: T.error })
  }

  const opInsert = await DB.prepare(
    `INSERT INTO operations (customer_id, sender_phone, group_jid, status, source)
     VALUES (?, ?, ?, 'processing', 'whatsapp_group')`
  ).bind(customerId, sender_jid, group_jid).run()
  const operationId = opInsert.meta.last_row_id

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY غير مهيأ على المنصة')
    }

    const extraction = await extractPassportData(GEMINI_API_KEY, image_base64, mime_type || 'image/jpeg')
    const processingTime = Date.now() - startTime

    if (!extraction.is_passport) {
      await DB.prepare(
        `UPDATE operations SET status='failed', error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind('الصورة ليست جواز سفر', JSON.stringify(extraction), processingTime, operationId).run()
      return c.json({ reply: T.notPassport })
    }

    if (!extraction.is_clear) {
      await DB.prepare(
        `UPDATE operations SET status='unclear', error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(extraction.clarity_reason || 'الصورة غير واضحة', JSON.stringify(extraction), processingTime, operationId).run()
      return c.json({ reply: T.unclear(extraction.clarity_reason || '') })
    }

    await DB.batch([
      DB.prepare(
        `UPDATE operations SET status='success', full_name_ar=?, full_name_en=?, passport_number=?,
           nationality=?, date_of_birth=?, date_of_expiry=?, gender=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(
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

    let reply = T.result(extraction)

    // Cumulative running list (feature 2) + periodic Umrah visa auto-check
    // (feature 4): same behavior as the private/shared-number path, but this
    // handler only returns a single `reply` string per incoming message (the
    // Baileys bridge relays exactly one reply), so the cumulative-list
    // message is appended to the same reply instead of being sent separately.
    const conversationKey = buildConversationKey({ group_jid })

    if (customer?.feature_cumulative_list_enabled) {
      try {
        const fieldKeys = parseCumulativeFields(customer?.cumulative_list_fields)
        const resetHours = customer?.cumulative_list_reset_hours ?? 24
        const items = await appendToCumulativeList(DB, customerId, conversationKey, resetHours, fieldKeys, extraction)
        reply += '\n\n' + buildCumulativeListMessage(items, lang, fieldKeys)
      } catch (err) {
        console.error('Cumulative list update failed (group)', err)
      }
    }

    if (customer?.feature_visa_check_enabled && extraction.passport_number && extraction.full_name_ar) {
      try {
        const firstName = extraction.full_name_ar.trim().split(/\s+/)[0]
        const nextCheckAt = new Date(Date.now() + VISA_CHECK_INITIAL_DELAY_MIN * 60 * 1000).toISOString()
        await DB.prepare(
          `INSERT INTO umrah_visa_checks (operation_id, customer_id, conversation_key, passport_number, first_name, nationality, next_check_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(operationId, customerId, conversationKey, extraction.passport_number, firstName, extraction.nationality || null, nextCheckAt).run()
      } catch (err) {
        console.error('Umrah visa check scheduling failed (group)', err)
      }
    }

    return c.json({ reply })
  } catch (err: any) {
    console.error('Group passport processing error', err)
    await DB.prepare(`UPDATE operations SET status='failed', error_message=? WHERE id=?`)
      .bind(String(err?.message || err), operationId)
      .run()
    return c.json({ reply: T.error })
  }
})

// =====================================================================
// Umrah visa periodic checker API (feature 4) — consumed by the separate
// VPS process (Playwright + Gemini Vision for the captcha), which polls
// for pending checks and reports results back. Secured with
// VISA_CHECKER_SECRET (independent from BRIDGE_SECRET so either
// integration can be rotated on its own).
// =====================================================================

function requireVisaCheckerAuth(c: any): Response | null {
  const { VISA_CHECKER_SECRET } = c.env
  if (!VISA_CHECKER_SECRET || c.req.header('x-visa-checker-secret') !== VISA_CHECKER_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return null
}

// GET /webhook/visa-checks/pending
// Returns checks whose next_check_at has passed, and atomically marks them
// 'checking' (so a slow VPS run + an overlapping poll don't double-process
// the same check). limit caps how many the VPS pulls per poll cycle.
webhook.get('/visa-checks/pending', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB } = c.env
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 50)

  const due = await DB.prepare(
    `SELECT * FROM umrah_visa_checks WHERE status = 'pending' AND next_check_at <= datetime('now') ORDER BY next_check_at ASC LIMIT ?`
  ).bind(limit).all<any>()
  const rows = due.results || []
  if (rows.length === 0) return c.json({ checks: [] })

  const ids = rows.map((r) => r.id)
  await DB.batch(
    ids.map((id) => DB.prepare(
      `UPDATE umrah_visa_checks SET status='checking', check_count = check_count + 1, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(id))
  )

  return c.json({
    checks: rows.map((r) => ({
      id: r.id,
      passport_number: r.passport_number,
      first_name: r.first_name,
      nationality: r.nationality,
      check_count: r.check_count + 1
    }))
  })
})

// POST /webhook/visa-checks/:id/result
// Body: { status: 'found', pdf_base64, pdf_mime_type? } to deliver the PDF
// and mark done, OR { status: 'not_ready' } to reschedule +20 minutes, OR
// { status: 'failed', error } to record an error and reschedule +20 minutes
// (the checker keeps retrying automatically; there is no terminal failure
// state here by design — MOFA/network hiccups should not silently stop
// retries. An admin/customer can still be added later if a hard stop is
// ever needed).
webhook.post('/visa-checks/:id/result', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB, WHATSAPP_API_VERSION } = c.env
  const id = parseInt(c.req.param('id'), 10)
  if (!id) return c.json({ error: 'invalid id' }, 400)

  const check = await DB.prepare('SELECT * FROM umrah_visa_checks WHERE id = ?').bind(id).first<any>()
  if (!check) return c.json({ error: 'not found' }, 404)

  let body: { status?: string; pdf_base64?: string; pdf_mime_type?: string; error?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  if (body.status === 'found') {
    if (!body.pdf_base64) return c.json({ error: 'pdf_base64 is required when status=found' }, 400)

    const deliverResult = await deliverToConversation(
      DB,
      check.conversation_key,
      {
        kind: 'document',
        base64: body.pdf_base64,
        mimeType: body.pdf_mime_type || 'application/pdf',
        filename: `تأشيرة-عمرة-${check.passport_number}.pdf`,
        caption: `✅ تأشيرة العمرة الخاصة بـ ${check.first_name} (${check.passport_number}) جاهزة.`
      },
      WHATSAPP_API_VERSION
    )

    await DB.prepare(
      `UPDATE umrah_visa_checks SET status='found', found_at=datetime('now'), last_error=?, updated_at=datetime('now') WHERE id=?`
    ).bind(deliverResult.ok ? null : `delivery failed: ${deliverResult.error}`, id).run()

    return c.json({ ok: true, delivered: deliverResult.ok })
  }

  if (body.status === 'not_ready' || body.status === 'failed') {
    const nextCheckAt = new Date(Date.now() + VISA_CHECK_RETRY_INTERVAL_MIN * 60 * 1000).toISOString()
    await DB.prepare(
      `UPDATE umrah_visa_checks SET status='pending', next_check_at=?, last_error=?, updated_at=datetime('now') WHERE id=?`
    ).bind(nextCheckAt, body.status === 'failed' ? (body.error || 'unknown error') : null, id).run()
    return c.json({ ok: true, next_check_at: nextCheckAt })
  }

  return c.json({ error: `unrecognized status: ${body.status}` }, 400)
})

// =====================================================================
// Render jobs API (feature 5, PDF-format reports) — same VPS process
// (already running Playwright for the visa checker) renders the HTML to
// PDF via page.pdf() and delivers it to the originating conversation.
// =====================================================================

webhook.get('/render-jobs/pending', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB } = c.env
  const limit = Math.min(parseInt(c.req.query('limit') || '5', 10) || 5, 20)

  const due = await DB.prepare(
    `SELECT * FROM render_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
  ).bind(limit).all<any>()
  const rows = due.results || []
  if (rows.length === 0) return c.json({ jobs: [] })

  const ids = rows.map((r) => r.id)
  await DB.batch(
    ids.map((id) => DB.prepare(`UPDATE render_jobs SET status='rendering', updated_at=datetime('now') WHERE id = ?`).bind(id))
  )

  return c.json({
    jobs: rows.map((r) => ({ id: r.id, html: r.html, filename: r.filename }))
  })
})

// POST /webhook/render-jobs/:id/result
// Body: { status: 'done', pdf_base64 } or { status: 'failed', error }
webhook.post('/render-jobs/:id/result', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB, WHATSAPP_API_VERSION } = c.env
  const id = parseInt(c.req.param('id'), 10)
  if (!id) return c.json({ error: 'invalid id' }, 400)

  const job = await DB.prepare('SELECT * FROM render_jobs WHERE id = ?').bind(id).first<any>()
  if (!job) return c.json({ error: 'not found' }, 404)

  let body: { status?: string; pdf_base64?: string; error?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  if (body.status === 'done') {
    if (!body.pdf_base64) return c.json({ error: 'pdf_base64 is required when status=done' }, 400)

    const deliverResult = await deliverToConversation(
      DB,
      job.conversation_key,
      { kind: 'document', base64: body.pdf_base64, mimeType: 'application/pdf', filename: job.filename },
      WHATSAPP_API_VERSION
    )

    await DB.prepare(
      `UPDATE render_jobs SET status='done', error=?, updated_at=datetime('now') WHERE id=?`
    ).bind(deliverResult.ok ? null : `delivery failed: ${deliverResult.error}`, id).run()

    return c.json({ ok: true, delivered: deliverResult.ok })
  }

  if (body.status === 'failed') {
    await DB.prepare(
      `UPDATE render_jobs SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`
    ).bind(body.error || 'unknown error', id).run()
    return c.json({ ok: true })
  }

  return c.json({ error: `unrecognized status: ${body.status}` }, 400)
})

// =====================================================================
// Group outbox API — polled by the Baileys bridge process (same VPS) to
// deliver asynchronous messages (visa PDFs, PDF reports) into groups,
// since the official Cloud API has no way to push into a group and the
// bridge only otherwise replies in direct response to an inbound message.
// Reuses BRIDGE_SECRET (same trust boundary as /bridge/message).
// =====================================================================

webhook.get('/bridge/outbox', async (c) => {
  const { DB, BRIDGE_SECRET } = c.env
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 50)

  const pending = await DB.prepare(
    `SELECT * FROM group_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
  ).bind(limit).all<any>()

  return c.json({
    items: (pending.results || []).map((r: any) => ({
      id: r.id,
      group_jid: r.group_jid,
      kind: r.kind,
      text: r.text,
      document_base64: r.document_base64,
      document_mime_type: r.document_mime_type,
      filename: r.filename
    }))
  })
})

// POST /webhook/bridge/outbox/:id/ack
// Body: { status: 'delivered' } or { status: 'failed', error }
webhook.post('/bridge/outbox/:id/ack', async (c) => {
  const { DB, BRIDGE_SECRET } = c.env
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const id = parseInt(c.req.param('id'), 10)
  if (!id) return c.json({ error: 'invalid id' }, 400)

  let body: { status?: string; error?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  if (body.status === 'delivered') {
    await DB.prepare(
      `UPDATE group_outbox SET status='delivered', delivered_at=datetime('now') WHERE id=?`
    ).bind(id).run()
  } else {
    await DB.prepare(
      `UPDATE group_outbox SET status='failed', error=? WHERE id=?`
    ).bind(body.error || 'unknown error', id).run()
  }
  return c.json({ ok: true })
})

export default webhook
