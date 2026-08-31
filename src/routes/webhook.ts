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

const DEFAULT_WELCOME_MESSAGE = '👋 أهلاً وسهلاً! لتفعيل الخدمة يرجى التواصل مع إدارة المنصة.'

// تم التعديل: كل 30 دقيقة بدل 5 دقائق
const VISA_CHECK_INITIAL_DELAY_MIN = 30
const VISA_CHECK_RETRY_INTERVAL_MIN = 30

const MAX_EXTRACTION_BATCH_SIZE = 15

const webhook = new Hono<AppEnv>()

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

webhook.post('/whatsapp', async (c) => {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY, WHATSAPP_API_VERSION } = c.env
  let body: WhatsAppWebhookBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: true })
  }
  if (body.object !== 'whatsapp_business_account') {
    return c.json({ ok: true })
  }
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value
      if (!value?.messages || value.messages.length === 0) continue
      const phoneNumberId = value.metadata.phone_number_id
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

  // === ميزة تفعيل الفحص لكل محادثة على حدة ===
  const rawText = msg.type === 'text' ? (msg.text?.body || '').trim() : ''
  if (rawText === 'تفعيل الفحص' || rawText === 'تفعيل فحص التأشيرة' || rawText === 'تفعيل فحص التاشيره') {
    const convKey = buildConversationKey({ whatsapp_number_id: numberRow.id, sender_phone: senderPhone })
    await DB.prepare(`INSERT INTO conversation_settings (conversation_key, auto_visa_check) VALUES (?, 1) ON CONFLICT(conversation_key) DO UPDATE SET auto_visa_check=1`).bind(convKey).run()
    await sendTextMessage(phoneNumberId, numberRow.access_token, senderPhone, `تم التفعيل`, WHATSAPP_API_VERSION).catch(()=>{})
    return
  }
  if (rawText === 'إلغاء تفعيل فحص' || rawText === 'الغاء تفعيل فحص' || rawText === 'إلغاء تفعيل فحص التأشيرة' || rawText === 'الغاء تفعيل فحص التاشيره' || rawText === 'الغاء تفعيل الفحص' || rawText === 'إلغاء تفعيل الفحص') {
    const convKey = buildConversationKey({ whatsapp_number_id: numberRow.id, sender_phone: senderPhone })
    await DB.prepare(`INSERT INTO conversation_settings (conversation_key, auto_visa_check) VALUES (?, 0) ON CONFLICT(conversation_key) DO UPDATE SET auto_visa_check=0`).bind(convKey).run()
    await sendTextMessage(phoneNumberId, numberRow.access_token, senderPhone, `تم إلغاء التفعيل`, WHATSAPP_API_VERSION).catch(()=>{})
    return
  }

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

  if (numberRow.is_shared) {
    const messageText: string = msg.type === 'text' ? (msg.text?.body || '') : ''

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

    const isFeatureToggleCommand = parseCommand(messageText)?.type === 'toggle_feature'
    const officeNameRaw = !matched && !isFeatureToggleCommand ? extractOfficeActivationCode(messageText) : null
    if (!matched && officeNameRaw) {
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
      await sendTextMessage(
        phoneNumberId, accessToken, senderPhone,
        `⚠️ لم يتم العثور على مكتب باسم "${officeNameRaw}". تأكد من كتابة اسم المكتب بشكل صحيح متبوعاً بكلمة "تفعيل"، مثال: معالم الرياض 11 تفعيل`,
        WHATSAPP_API_VERSION
      ).catch(() => {})
      return
    }

    if (!existingSession) {
      const welcomeMsg = (await getSetting(DB, UNACTIVATED_WELCOME_KEY)) || DEFAULT_WELCOME_MESSAGE
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, welcomeMsg, WHATSAPP_API_VERSION).catch(() => {})
      return
    }

    customerId = existingSession.customer_id as number
    const newExpiresAt = new Date(Date.now() + SHARED_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    DB.prepare(`UPDATE shared_number_sessions SET expires_at=?, updated_at=datetime('now') WHERE id=?`)
      .bind(newExpiresAt, existingSession.id).run().catch(() => {})
  }

  if (!customerId) {
    console.warn(`Unable to resolve customer for phone_number_id=${phoneNumberId}, sender=${senderPhone}`)
    return
  }

  const customer = await DB.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first<any>()
  const lang = customer?.reply_language || 'ar'

  const T = lang === 'en'
    ? {
        notImage: '👋 Please send a clear photo of the passport data page to extract the information.',
        suspended: '⚠️ This service is currently suspended. Please contact the account owner.',
        limitReached: '⚠️ Monthly operation limit reached for this subscription. Please contact the account owner to upgrade.',
        unclear: (reason: string) => `⚠️ Image is not clear enough: ${reason || 'please resend a clearer photo of the passport.'}`,
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', numberRow.extraction_fields)
      }
    : {
        notImage: '👋 من فضلك أرسل صورة واضحة لصفحة بيانات الجواز حتى نتمكن من استخراج المعلومات.',
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا الرقم، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        error: '❌ حدث خطأ أثناء معالجة الصورة، يرجى المحاولة مرة أخرى.',
        result: (r: any) => buildResultMessage(r, 'ar', numberRow.extraction_fields)
      }

  const conversationKey = buildConversationKey({ whatsapp_number_id: numberRow.id, sender_phone: senderPhone })

  if (msg.type !== 'image') {
    if (msg.type === 'text' && msg.text?.body) {
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

    if (customer?.feature_auto_extract_enabled) {
      await sendTextMessage(phoneNumberId, accessToken, senderPhone, T.result(extraction), WHATSAPP_API_VERSION).catch((err) =>
        console.error('sendTextMessage (result) failed', err)
      )
    }

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

    // تعديل: يدعم التفعيل لكل محادثة على حدة
    const convSettings = await DB.prepare(`SELECT auto_visa_check FROM conversation_settings WHERE conversation_key = ?`).bind(conversationKey).first<any>()
    const isConvEnabled = convSettings?.auto_visa_check === 1

    if ((customer?.feature_visa_check_enabled || isConvEnabled) && extraction.passport_number && extraction.full_name_ar) {
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

webhook.post('/bridge/message', async (c) => {
  const { DB, GEMINI_API_KEY, BRIDGE_SECRET } = c.env
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

  if (type === 'text') {
    const messageText = text || ''

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
      return c.json({})
    }

    logConversationMessage(DB, {
      customerId: existingGroup.customer_id, conversationKey: buildConversationKey({ group_jid }),
      direction: 'in', text: messageText, senderIdentifier: sender_jid
    }).catch((err) => console.error('logConversationMessage failed (group)', err))

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
        const parts = batchResult.processed.map((item) => item.message).filter((m) => m.length > 0)
        if (batchResult.remainingQueued > 0) {
          parts.push(
            groupLang === 'en'
              ? `ℹ️ ${batchResult.remainingQueued} image(s) are still queued. Send "استخراج" again to continue processing.`
              : `ℹ️ لا تزال هناك ${batchResult.remainingQueued} صورة بانتظار الاستخراج. أرسل "استخراج" مرة أخرى للمتابعة.`
          )
        }
        return parts.length > 0 ? c.json({ reply: parts.join('\n\n') }) : c.json({})
      }
    }
    return c.json({})
  }

  if (!existingGroup) {
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
        error: '❌ An error occurred while processing the image. Please try again.',
        result: (r: any) => buildResultMessage(r, 'en', null)
      }
    : {
        suspended: '⚠️ الخدمة موقوفة حالياً على هذا المكتب، يرجى التواصل مع صاحب الحساب.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية المسموح بها في الاشتراك الحالي. يرجى التواصل مع صاحب الحساب للترقية.',
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
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

    let reply = customer?.feature_auto_extract_enabled ? T.result(extraction) : ''

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

    const convSettingsGroup = await DB.prepare(`SELECT auto_visa_check FROM conversation_settings WHERE conversation_key = ?`).bind(groupConversationKey).first<any>()
    const isConvEnabledGroup = convSettingsGroup?.auto_visa_check === 1

    if ((customer?.feature_visa_check_enabled || isConvEnabledGroup) && extraction.passport_number && extraction.full_name_ar) {
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

    return reply ? c.json({ reply }) : c.json({})
  } catch (err: any) {
    console.error('Group passport processing error', err)
    await DB.prepare(`UPDATE operations SET status='failed', error_message=? WHERE id=?`)
      .bind(String(err?.message || err), operationId)
      .run()
    return c.json({ reply: T.error })
  }
})

function requireVisaCheckerAuth(c: any): Response | null {
  const { VISA_CHECKER_SECRET } = c.env
  if (!VISA_CHECKER_SECRET || c.req.header('x-visa-checker-secret') !== VISA_CHECKER_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return null
}

webhook.get('/visa-checks/pending', async (c) => {
  const authErr = requireVisaCheckerAuth(c)
  if (authErr) return authErr
  const { DB } = c.env
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 50)

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
  return `✅ تأشيرة العمرة الخاصة بـ ${check.first_name} (${check.passport_number}) جاهزة.\n👤 الاسم: ${check.full_name}`
}

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
        filename: `${check.full_name || check.first_name}-${check.passport_number}.pdf`,
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

webhook.get('/message-lists/tick', async (c) => {
  const { DB, BRIDGE_SECRET } = c.env
  if (!BRIDGE_SECRET || c.req.header('x-bridge-secret') !== BRIDGE_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const result = await runDueMessageLists(DB)
  return c.json({ ok: true, ...result })
})

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