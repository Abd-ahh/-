import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import type { WhatsAppWebhookBody } from '../lib/whatsapp'
import { downloadMedia, sendTextMessage, sendDocumentMessage, uploadMedia, markMessageRead } from '../lib/whatsapp'
import { extractPassportData } from '../lib/gemini'
import { extractOfficeActivationCode, matchOfficeByName, matchByCustomCommand } from '../lib/office'
import { buildConversationKey, parseCommand } from '../lib/commands'
import { handleTextCommand } from '../lib/commandHandlers'
import { appendToCumulativeList, buildCumulativeListMessage, parseCumulativeFields } from '../lib/cumulative'
import { getSetting, UNACTIVATED_WELCOME_KEY } from '../lib/settings'
import { deliverToConversation } from '../lib/deliver'
import { runExtractionBatch } from '../lib/extractionBatch'
import { buildResultMessage } from '../lib/passportMessage'
import { runDueMessageLists, applyMessageListAck } from '../lib/messageLists'
import { logConversationMessage, runDueKnowledgeBaseAnalysis, runKnowledgeBaseAnalysis, purgeOldConversationMessages } from '../lib/knowledgeBase'

const SHARED_SESSION_DAYS = 30

// Hardcoded fallback used only if the admin has never set a global welcome
// message (settings.unactivated_welcome_message). The admin dashboard lets
// this be fully customized (e.g. "for activation contact ...").
const DEFAULT_WELCOME_MESSAGE = '👋 أهلاً وسهلاً! لتفعيل الخدمة يرجى التواصل مع إدارة المنصة.'

// Umrah visa auto-check timing (feature 4): first check 5 minutes after the
// passport photo is received, then retry every 5 minutes until found.
// History:
//  - 2026-08-23: unified to 30min/30min (was 180min initial / 20min retry)
//    specifically to reduce load on the official MOFA government website.
//  - 2026-08-24: lowered to 5min/5min by explicit user decision, prioritizing
//    near-instant visa delivery over further reducing MOFA request frequency
//    (accepted tradeoff: ~12 checks/hour per pending passport instead of ~2).
const VISA_CHECK_INITIAL_DELAY_MIN = 5
const VISA_CHECK_RETRY_INTERVAL_MIN = 5

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
        // notPassport intentionally removed (2026-08-23): the bot now stays
        // silent instead of replying when the image isn't a passport page.
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', numberRow.extraction_fields)
      }
    : {
        notImage: '👋 من فضلك أرسل صورة واضحة لصفحة بيانات الجواز حتى نتمكن من استخراج المعلومات.',
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا الرقم، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        // notPassport تمت إزالتها (2026-08-23): البوت أصبح يتجاهل الصورة بصمت
        // بدلاً من الرد بتحذير عندما لا تكون صفحة جواز سفر.
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
      // Knowledge Base (feature requested 2026-08-24): log every inbound
      // text message so office FAQs/answers can be mined later. On this
      // channel the sender is always the office's own end-customer (the
      // bot answers automatically), so sender_role will resolve to
      // 'customer' unless this phone was explicitly registered in
      // staff_numbers. Best-effort — must never break message handling.
      logConversationMessage(DB, {
        customerId, conversationKey, direction: 'in', text: msg.text.body, senderIdentifier: senderPhone
      }).catch((err) => console.error('logConversationMessage failed', err))

      const outcome = await handleTextCommand(DB, customer, customerId, conversationKey, lang, msg.text.body).catch((err) => {
        console.error('handleTextCommand failed', err)
        return null
      })
      if (outcome) {
        if (outcome.kind === 'text') {
          await sendTextMessage(phoneNumberId, accessToken, senderPhone, outcome.text, WHATSAPP_API_VERSION).catch(() => {})
        } else if (outcome.kind === 'pdf_report') {
          await DB.prepare(
            `INSERT INTO render_jobs (customer_id, conversation_key, job_type, html, filename) VALUES (?, ?, 'report_pdf', ?, ?)`
          ).bind(customerId, conversationKey, outcome.html, outcome.filename).run()
          await sendTextMessage(
            phoneNumberId, accessToken, senderPhone,
            lang === 'en' ? '📄 Preparing your PDF report, it will arrive here shortly...' : '📄 يتم تجهيز ملف التقرير الآن، سيصلك هنا قريباً...',
            WHATSAPP_API_VERSION
          ).catch(() => {})
        } else if (outcome.kind === 'run_extraction_batch') {
          // "استخراج" (feature 6): process everything queued for this
          // conversation in one batch, then send each result in sequence —
          // the private/shared-number channel can send multiple messages
          // directly via the Graph API, unlike the group bridge below.
          const batchResult = await runExtractionBatch(
            { DB, PASSPORTS_BUCKET, GEMINI_API_KEY, WHATSAPP_API_VERSION },
            customerId,
            conversationKey,
            customer,
            lang,
            MAX_EXTRACTION_BATCH_SIZE,
            new Map([[numberRow.id as number, accessToken as string]])
          ).catch((err) => {
            console.error('runExtractionBatch failed', err)
            return null
          })

          if (batchResult) {
            for (const item of batchResult.processed) {
              // 'not_passport' items carry an empty message by design
              // (2026-08-23: stay silent instead of warning) — skip sending.
              if (!item.message) continue
              await sendTextMessage(phoneNumberId, accessToken, senderPhone, item.message, WHATSAPP_API_VERSION).catch(() => {})
            }
            if (batchResult.remainingQueued > 0) {
              await sendTextMessage(
                phoneNumberId, accessToken, senderPhone,
                lang === 'en'
                  ? `ℹ️ ${batchResult.remainingQueued} image(s) are still queued. Send "استخراج" again to continue processing.`
                  : `ℹ️ لا تزال هناك ${batchResult.remainingQueued} صورة بانتظار الاستخراج. أرسل "استخراج" مرة أخرى للمتابعة.`,
                WHATSAPP_API_VERSION
              ).catch(() => {})
            }
          }
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

  // Feature 6 (Auto-Extract toggle, migration 0009): by explicit user
  // decision on 2026-08-23, extraction ALWAYS runs immediately for every
  // incoming image — it is the platform's own job, not something an office
  // should have to trigger manually. This toggle now controls ONLY whether
  // the detailed "✅ تم استخراج بيانات الجواز بنجاح..." result text is sent
  // back into the conversation (default DISABLED = stay silent on success;
  // the extraction + cumulative-list update still happen in the background
  // regardless). Warning/error replies (not a passport / unclear / failed)
  // are NEVER gated by this toggle — the sender needs to know to retry.
  // See the `feature_auto_extract_enabled` check further below, right
  // before T.result is sent.
  //
  // NOTE: `pending_extractions` / "استخراج" (batch mode) is legacy from an
  // earlier design where disabling this toggle queued images instead of
  // extracting them. No NEW rows are inserted here anymore, but the queue
  // drain path (runExtractionBatch, the "استخراج" command) is kept so any
  // rows created before this change can still be processed by offices that
  // already had images queued.

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
      // By explicit user request (2026-08-23): stay completely silent when
      // the image isn't a passport page at all (e.g. a forwarded document,
      // screenshot, or unrelated photo) — no WhatsApp reply is sent. The
      // outcome is still persisted for audit/reporting purposes.
      await DB.prepare(
        `UPDATE operations SET status='failed', image_key=?, error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind(imageKey, 'الصورة ليست جواز سفر', JSON.stringify(extraction), processingTime, operationId).run()
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
    // incremented above. Feature 6 toggle (default DISABLED) controls ONLY
    // this detailed result text — sending it is best-effort either way (a
    // WhatsApp API error here, e.g. recipient not in the allowed list on a
    // test number, must NOT be reported back to the user as a processing
    // error; the operation record correctly shows 'success' regardless).
    if (customer?.feature_auto_extract_enabled) {
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.result(extraction), WHATSAPP_API_VERSION).catch((err) =>
        console.error('sendTextMessage (result) failed', err)
      )
    }

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
        const fullName = extraction.full_name_ar.trim()
        const firstName = fullName.split(/\s+/)[0]
        const nextCheckAt = new Date(Date.now() + VISA_CHECK_INITIAL_DELAY_MIN * 60 * 1000).toISOString()
        await DB.prepare(
          `INSERT INTO umrah_visa_checks (operation_id, customer_id, conversation_key, passport_number, first_name, full_name, nationality, next_check_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(operationId, customerId, conversationKey, extraction.passport_number, firstName, fullName, extraction.nationality || null, nextCheckAt).run()
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

    // Knowledge Base (feature requested 2026-08-24): log every text message
    // exchanged inside an already-linked group — this is exactly where real
    // staff<->client Q&A happens (general chat, not just bot commands), so
    // it must be logged here regardless of whether it also matches a
    // command below. sender_jid resolves to 'staff' only if the office
    // explicitly registered it in staff_numbers; everyone else is
    // 'customer' and is never treated as a confirmed answer by the
    // analysis prompt. Best-effort — must never break message handling.
    logConversationMessage(DB, {
      customerId: existingGroup.customer_id, conversationKey: buildConversationKey({ group_jid }),
      direction: 'in', text: messageText, senderIdentifier: sender_jid
    }).catch((err) => console.error('logConversationMessage failed (group)', err))

    // Linked group: the only other text commands supported are the
    // per-feature enable/disable toggles (Feature 2 / Feature 4 / Feature 6),
    // "استخراج" (Feature 6, run the queued-images batch), and "بوت" (help
    // message listing every command). Anything else stays silent (avoid
    // spamming an active group conversation with guidance on every text
    // message).
    const groupCmd = parseCommand(messageText)
    if (groupCmd?.type === 'toggle_feature' || groupCmd?.type === 'extract_now' || groupCmd?.type === 'help') {
      const linkedCustomer = await DB.prepare('SELECT * FROM customers WHERE id = ?')
        .bind(existingGroup.customer_id).first<any>()
      const groupLang = linkedCustomer?.reply_language === 'en' ? 'en' : 'ar'
      const groupConversationKey = buildConversationKey({ group_jid })
      const outcome = await handleTextCommand(DB, linkedCustomer, existingGroup.customer_id, groupConversationKey, groupLang, messageText)
      if (outcome?.kind === 'text') {
        return c.json({ reply: outcome.text })
      }
      if (outcome?.kind === 'run_extraction_batch') {
        // Group bridge only supports a single { reply } string per inbound
        // webhook call — concatenate every processed item's message plus an
        // optional "remaining queued" note into one reply.
        const batchResult = await runExtractionBatch(
          { DB, GEMINI_API_KEY },
          existingGroup.customer_id,
          groupConversationKey,
          linkedCustomer,
          groupLang,
          MAX_EXTRACTION_BATCH_SIZE,
          null
        ).catch((err) => {
          console.error('runExtractionBatch failed (group)', err)
          return null
        })

        if (!batchResult) {
          return c.json({ reply: groupLang === 'en' ? '❌ An error occurred while processing the queued images.' : '❌ حدث خطأ أثناء معالجة الصور المنتظرة.' })
        }

        // 'not_passport' items carry an empty message by design (2026-08-23:
        // stay silent instead of warning) — filter them out before joining.
        const parts = batchResult.processed.map((item) => item.message).filter((m) => m.length > 0)
        if (batchResult.remainingQueued > 0) {
          parts.push(
            groupLang === 'en'
              ? `ℹ️ ${batchResult.remainingQueued} image(s) are still queued. Send "استخراج" again to continue processing.`
              : `ℹ️ لا تزال هناك ${batchResult.remainingQueued} صورة بانتظار الاستخراج. أرسل "استخراج" مرة أخرى للمتابعة.`
          )
        }
        // If every queued item was 'not_passport' (now silent) and nothing
        // remains queued, parts can end up empty — return no reply at all
        // rather than an empty string.
        return parts.length > 0 ? c.json({ reply: parts.join('\n\n') }) : c.json({})
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
        // notPassport intentionally removed (2026-08-23): the bot now stays
        // silent instead of replying when the image isn't a passport page.
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', null)
      }
    : {
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا المكتب، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        // notPassport تمت إزالتها (2026-08-23): البوت أصبح يتجاهل الصورة بصمت
        // بدلاً من الرد بتحذير عندما لا تكون صفحة جواز سفر.
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

  const groupConversationKey = buildConversationKey({ group_jid })

  // Feature 6 (Auto-Extract toggle, migration 0009): by explicit user
  // decision on 2026-08-23, extraction ALWAYS runs immediately for every
  // incoming group image — see the matching comment in the private/shared-
  // number handler above for the full rationale. This toggle now only
  // gates the detailed result text sent below (default DISABLED = silent
  // on success; warning/error replies are never gated by it).

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
      // By explicit user request (2026-08-23): stay completely silent when
      // the image isn't a passport page at all — no reply is sent to the
      // group. The outcome is still persisted for audit/reporting purposes.
      await DB.prepare(
        `UPDATE operations SET status='failed', error_message=?, extracted_json=?, processing_time_ms=? WHERE id=?`
      ).bind('الصورة ليست جواز سفر', JSON.stringify(extraction), processingTime, operationId).run()
      return c.json({})
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

    // Feature 6 toggle (default DISABLED) controls ONLY this detailed result
    // text — the extraction itself already ran and was persisted above
    // regardless of this flag. Starts empty; the cumulative-list text below
    // is appended independently (its own "تفعيل القائمة" flag, unrelated to
    // this one) so it still reaches the group even when this is off.
    let reply = customer?.feature_auto_extract_enabled ? T.result(extraction) : ''

    // Cumulative running list (feature 2) + periodic Umrah visa auto-check
    // (feature 4): same behavior as the private/shared-number path, but this
    // handler only returns a single `reply` string per incoming message (the
    // Baileys bridge relays exactly one reply), so the cumulative-list
    // message is appended to the same reply instead of being sent separately.
    if (customer?.feature_cumulative_list_enabled) {
      try {
        const fieldKeys = parseCumulativeFields(customer?.cumulative_list_fields)
        const resetHours = customer?.cumulative_list_reset_hours ?? 24
        const items = await appendToCumulativeList(DB, customerId, groupConversationKey, resetHours, fieldKeys, extraction)
        reply += (reply ? '\n\n' : '') + buildCumulativeListMessage(items, lang, fieldKeys)
      } catch (err) {
        console.error('Cumulative list update failed (group)', err)
      }
    }

    if (customer?.feature_visa_check_enabled && extraction.passport_number && extraction.full_name_ar) {
      try {
        const fullName = extraction.full_name_ar.trim()
        const firstName = fullName.split(/\s+/)[0]
        const nextCheckAt = new Date(Date.now() + VISA_CHECK_INITIAL_DELAY_MIN * 60 * 1000).toISOString()
        await DB.prepare(
          `INSERT INTO umrah_visa_checks (operation_id, customer_id, conversation_key, passport_number, first_name, full_name, nationality, next_check_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(operationId, customerId, groupConversationKey, extraction.passport_number, firstName, fullName, extraction.nationality || null, nextCheckAt).run()
      } catch (err) {
        console.error('Umrah visa check scheduling failed (group)', err)
      }
    }

    // Both feature 6 (detailed result) and feature 2 (cumulative list) may
    // be disabled at once, leaving `reply` empty — stay silent rather than
    // sending a blank message into the group.
    return reply ? c.json({ reply }) : c.json({})
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

  // Self-healing recovery (fixed 2026-08-24): a row is marked 'checking'
  // right when it's handed to the VPS checker, but nothing previously ever
  // moved it back if the checker crashed/restarted mid-check (e.g. Chromium
  // page.click hanging on a leftover MOFA error modal — see checker.js
  // dismissErrorModal fix — or a PM2 restart) before it could POST a
  // result back. Such rows stayed 'checking' forever and were silently
  // never retried, which is the root cause behind "visas not printing".
  // Any 'checking' row older than this staleness window is assumed
  // abandoned and is recovered back to 'pending' so it re-enters the
  // normal poll queue.
  const STALE_CHECKING_MINUTES = 5
  await DB.prepare(
    `UPDATE umrah_visa_checks SET status='pending', last_error='تمت إعادة الجدولة تلقائياً بعد انقطاع الفحص السابق', updated_at=datetime('now')
     WHERE status='checking' AND last_checked_at <= datetime('now', '-' || ? || ' minutes')`
  ).bind(STALE_CHECKING_MINUTES).run()

  const due = await DB.prepare(
    `SELECT * FROM umrah_visa_checks WHERE status = 'pending' AND datetime(next_check_at) <= datetime('now') ORDER BY next_check_at ASC LIMIT ?`
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

// Builds the visa-ready delivery caption. Uses the richer template (name /
// passport / visa type / valid-from date) whenever the VPS checker managed
// to scrape those structured fields from the MOFA result page; falls back
// to the older simple caption if visa_type/valid_from weren't provided
// (e.g. MOFA page layout changed and the scrape came up empty) so delivery
// never silently fails just because the extra detail is missing.
function buildVisaReadyCaption(check: any, visaType?: string | null, validFrom?: string | null): string {
  const name = check.full_name || check.first_name
  if (visaType || validFrom) {
    const lines = [
      '✨ تأشيرتك جاهزة ! ✅',
      `👤 الاسم: ${name}`,
      `🎫 الجواز: ${check.passport_number}`
    ]
    if (visaType) lines.push(`نوع التأشيرة: ${visaType}`)
    if (validFrom) lines.push(`صالحة اعتباراً من : ${validFrom}`)
    return lines.join('\n')
  }
  return `✅ تأشيرة العمرة الخاصة بـ ${check.first_name} (${check.passport_number}) جاهزة.`
}

// POST /webhook/visa-checks/:id/result
// Body: { status: 'found', pdf_base64, pdf_mime_type?, visa_type?, valid_from? }
// to deliver the PDF and mark done (visa_type/valid_from are the structured
// fields scraped from the MOFA result page, used to build the detailed
// caption — see buildVisaReadyCaption above), OR { status: 'not_ready' } to
// reschedule +VISA_CHECK_RETRY_INTERVAL_MIN minutes, OR { status: 'failed',
// error } to record an error and reschedule the same way (the checker keeps
// retrying automatically; there is no terminal failure state here by design
// — MOFA/network hiccups should not silently stop retries. An admin/customer
// can still be added later if a hard stop is ever needed).
webhook.post('/visa-checks/:id/result', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB, WHATSAPP_API_VERSION } = c.env
  const id = parseInt(c.req.param('id'), 10)
  if (!id) return c.json({ error: 'invalid id' }, 400)

  const check = await DB.prepare('SELECT * FROM umrah_visa_checks WHERE id = ?').bind(id).first<any>()
  if (!check) return c.json({ error: 'not found' }, 404)

  let body: { status?: string; pdf_base64?: string; pdf_mime_type?: string; error?: string; visa_type?: string; valid_from?: string }
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
        caption: buildVisaReadyCaption(check, body.visa_type, body.valid_from)
      },
      WHATSAPP_API_VERSION
    )

    await DB.prepare(
      `UPDATE umrah_visa_checks SET status='found', found_at=datetime('now'), visa_type=?, valid_from=?, last_error=?, updated_at=datetime('now') WHERE id=?`
    ).bind(body.visa_type || null, body.valid_from || null, deliverResult.ok ? null : `delivery failed: ${deliverResult.error}`, id).run()

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

  // Look up send_log_id BEFORE updating, so we can propagate the result to
  // message_list_send_log (Message Lists feature, 2026-08-23) — this is the
  // ONLY change needed on the shared outbox/ack flow to support that
  // feature's per-recipient sent/failed tracking, since the bridge already
  // treats group_outbox.group_jid as an opaque destination JID regardless
  // of whether it's a group or an individual number.
  const outboxRow = await DB.prepare('SELECT send_log_id FROM group_outbox WHERE id = ?').bind(id).first<{ send_log_id: number | null }>()

  if (body.status === 'delivered') {
    await DB.prepare(
      `UPDATE group_outbox SET status='delivered', delivered_at=datetime('now') WHERE id=?`
    ).bind(id).run()
    if (outboxRow?.send_log_id) {
      await applyMessageListAck(DB, outboxRow.send_log_id, 'sent')
    }
  } else {
    await DB.prepare(
      `UPDATE group_outbox SET status='failed', error=? WHERE id=?`
    ).bind(body.error || 'unknown error', id).run()
    if (outboxRow?.send_log_id) {
      await applyMessageListAck(DB, outboxRow.send_log_id, 'failed', body.error)
    }
  }
  return c.json({ ok: true })
})

// =====================================================================
// Message Lists (قوائم رسائل) — scheduled WhatsApp broadcast lists.
// Cloudflare Pages has no native cron/scheduled-handler support, so this
// endpoint is polled once/minute by the same VPS bridge process (see
// bridge/bridge.js's pollMessageListTick), mirroring the exact pattern
// already used for the Umrah visa periodic checker. Reuses BRIDGE_SECRET
// (same trust boundary as every other /bridge/* endpoint).
// =====================================================================
webhook.get('/message-lists/tick', async (c) => {
  const { DB, BRIDGE_SECRET } = c.env
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const result = await runDueMessageLists(DB)
  return c.json({ ok: true, ...result })
})

// =====================================================================
// Knowledge Base (قاعدة المعرفة) — periodic analysis tick, requested
// 2026-08-24. Same polling pattern as visa-checks / message-lists: the VPS
// bridge process calls this once every few minutes; it analyzes any
// customer with enough newly-logged conversation messages and purges raw
// text past its retention window (see knowledgeBase.ts for full rationale).
// =====================================================================
webhook.get('/knowledge-base/tick', async (c) => {
  const { DB, GEMINI_API_KEY, BRIDGE_SECRET } = c.env
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const analyzed = await runDueKnowledgeBaseAnalysis(DB, GEMINI_API_KEY)
  const purged = await purgeOldConversationMessages(DB).catch((err) => {
    console.error('purgeOldConversationMessages failed', err)
    return 0
  })
  return c.json({ ok: true, analyzed, purged_messages: purged })
})

export default webhook
