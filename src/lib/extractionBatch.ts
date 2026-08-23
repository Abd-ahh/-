// Feature 6 (Auto-Extract toggle): processes every image queued in
// `pending_extractions` for a given conversation, in one batch, when the
// office sends "استخراج". Shared between the official/shared-number path
// (webhook.ts, private reply per image) and the WhatsApp-group bridge path
// (webhook.ts /bridge/message, single aggregated reply string).
//
// Design notes:
//  - Each queued image is removed from the queue as soon as an extraction
//    ATTEMPT completes (success, not-a-passport, or unclear) so re-sending
//    "استخراج" can never reprocess (and re-charge) the same image. Only a
//    transient error (Gemini/network/download failure) leaves the row in
//    the queue (status='failed') so the next "استخراج" retries it.
//  - Quota (operations_used) is incremented exactly once per successfully
//    extracted image, identically to the immediate-processing path.
//  - Capped at MAX_EXTRACTION_BATCH_SIZE per call (see webhook.ts) to keep
//    a single Worker invocation within a reasonable execution time; any
//    remainder stays queued for the next "استخراج".
import { downloadMedia } from './whatsapp'
import { extractPassportData } from './gemini'
import { buildResultMessage } from './passportMessage'
import { appendToCumulativeList, buildCumulativeListMessage, parseCumulativeFields } from './cumulative'

export interface ExtractionBatchDeps {
  DB: D1Database
  PASSPORTS_BUCKET?: R2Bucket
  GEMINI_API_KEY?: string
  WHATSAPP_API_VERSION?: string
}

export interface ExtractionBatchItemResult {
  id: number
  outcome: 'success' | 'not_passport' | 'unclear' | 'failed'
  // Ready-to-send text for this single item (already includes cumulative-list
  // append if applicable). Empty string for 'not_passport' (2026-08-23, by
  // explicit user request: stay silent instead of warning when an image
  // isn't a passport page at all) — callers must skip empty messages rather
  // than sending/joining them.
  message: string
}

export interface ExtractionBatchResult {
  processed: ExtractionBatchItemResult[]
  remainingQueued: number // items still queued after this batch (either over the cap, or newly-failed retries)
}

// Runs the batch for a resolved customer/conversation. Caller is
// responsible for: resolving customerId/conversationKey, checking the
// active subscription + quota BEFORE calling (quota is re-checked per item
// inside the loop too, since a large batch can exhaust it partway through),
// and delivering the returned messages to WhatsApp (this function does not
// send anything itself — it only mutates the DB and returns text).
export async function runExtractionBatch(
  deps: ExtractionBatchDeps,
  customerId: number,
  conversationKey: string,
  customer: any,
  lang: 'ar' | 'en',
  maxBatchSize: number,
  accessTokenByNumberId: Map<number, string> | null // for channel='number' items, to re-download media
): Promise<ExtractionBatchResult> {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY, WHATSAPP_API_VERSION } = deps

  const queued = await DB.prepare(
    `SELECT * FROM pending_extractions WHERE customer_id = ? AND conversation_key = ? AND status = 'queued' ORDER BY created_at ASC LIMIT ?`
  ).bind(customerId, conversationKey, maxBatchSize).all<any>()
  const rows = queued.results || []

  const T = lang === 'en'
    ? {
        unclear: (reason: string) => `⚠️ Image is not clear enough: ${reason || 'please resend a clearer photo of the passport.'}`,
        error: '❌ An error occurred while processing this queued image. It will be retried on the next "استخراج".',
        limitReached: '⚠️ Monthly operation limit reached for this subscription. Remaining queued images were left for later.'
      }
    : {
        unclear: (reason: string) => `⚠️ الصورة غير واضحة بشكل كافٍ: ${reason || 'يرجى إرسال صورة أوضح للجواز.'}`,
        error: '❌ حدث خطأ أثناء معالجة إحدى الصور المنتظرة. ستتم إعادة المحاولة عند إرسال "استخراج" مرة أخرى.',
        limitReached: '⚠️ تم الوصول للحد الأقصى من العمليات الشهرية. الصور المتبقية بقيت بانتظار الاستخراج.'
      }

  const results: ExtractionBatchItemResult[] = []

  for (const row of rows) {
    // Re-check quota on every iteration — a large batch can exhaust the
    // remaining quota partway through, and we must stop cleanly (leaving
    // the rest queued) rather than keep calling Gemini for nothing.
    const activeSub = await DB.prepare(
      `SELECT * FROM subscriptions WHERE customer_id = ? AND status='active' AND end_date >= datetime('now') ORDER BY end_date DESC LIMIT 1`
    ).bind(customerId).first<any>()

    if (!activeSub || activeSub.operations_used >= activeSub.operations_limit) {
      results.push({ id: row.id, outcome: 'failed', message: T.limitReached })
      break // leave this row + everything after it queued
    }

    try {
      if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY غير مهيأ على المنصة')

      let base64: string
      let mimeType: string
      let bytes: ArrayBuffer | null = null

      if (row.channel === 'number') {
        const accessToken = accessTokenByNumberId?.get(row.whatsapp_number_id)
        if (!accessToken) throw new Error('access_token غير متوفر لهذا الرقم')
        const media = await downloadMedia(row.media_id, accessToken, WHATSAPP_API_VERSION)
        base64 = media.base64
        mimeType = media.mimeType
        bytes = media.bytes
      } else {
        base64 = row.image_base64
        mimeType = row.mime_type || 'image/jpeg'
      }

      const opInsert = await DB.prepare(
        `INSERT INTO operations (whatsapp_number_id, customer_id, sender_phone, group_jid, status, source)
         VALUES (?, ?, ?, ?, 'processing', ?)`
      ).bind(
        row.channel === 'number' ? row.whatsapp_number_id : null,
        customerId,
        row.channel === 'number' ? row.sender_phone : row.sender_jid,
        row.channel === 'group' ? row.group_jid : null,
        row.channel === 'group' ? 'whatsapp_group' : 'whatsapp'
      ).run()
      const operationId = opInsert.meta.last_row_id

      const imageKey = `passports/${customerId}/${operationId}-${Date.now()}.jpg`
      if (PASSPORTS_BUCKET && bytes) {
        PASSPORTS_BUCKET.put(imageKey, bytes, { httpMetadata: { contentType: mimeType } }).catch(() => {})
      }

      const extraction = await extractPassportData(GEMINI_API_KEY, base64, mimeType)

      if (!extraction.is_passport) {
        // By explicit user request (2026-08-23): stay completely silent for
        // this item — no warning text — while still removing it from the
        // queue (so re-sending "استخراج" never reprocesses it).
        await DB.prepare(
          `UPDATE operations SET status='failed', image_key=?, error_message=?, extracted_json=? WHERE id=?`
        ).bind(imageKey, 'الصورة ليست جواز سفر', JSON.stringify(extraction), operationId).run()
        await DB.prepare(`DELETE FROM pending_extractions WHERE id = ?`).bind(row.id).run()
        results.push({ id: row.id, outcome: 'not_passport', message: '' })
        continue
      }

      if (!extraction.is_clear) {
        await DB.prepare(
          `UPDATE operations SET status='unclear', image_key=?, error_message=?, extracted_json=? WHERE id=?`
        ).bind(imageKey, extraction.clarity_reason || 'الصورة غير واضحة', JSON.stringify(extraction), operationId).run()
        await DB.prepare(`DELETE FROM pending_extractions WHERE id = ?`).bind(row.id).run()
        results.push({ id: row.id, outcome: 'unclear', message: T.unclear(extraction.clarity_reason || '') })
        continue
      }

      await DB.batch([
        DB.prepare(
          `UPDATE operations SET status='success', image_key=?, full_name_ar=?, full_name_en=?, passport_number=?,
             nationality=?, date_of_birth=?, date_of_expiry=?, gender=?, extracted_json=? WHERE id=?`
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
          operationId
        ),
        DB.prepare('UPDATE subscriptions SET operations_used = operations_used + 1 WHERE id = ?').bind(activeSub.id)
      ])
      await DB.prepare(`DELETE FROM pending_extractions WHERE id = ?`).bind(row.id).run()

      const extractionFieldsRaw = row.channel === 'number'
        ? await DB.prepare('SELECT extraction_fields FROM whatsapp_numbers WHERE id = ?').bind(row.whatsapp_number_id).first<{ extraction_fields: string | null }>().then((r) => r?.extraction_fields ?? null)
        : null
      let message = buildResultMessage(extraction, lang, extractionFieldsRaw)

      if (customer?.feature_cumulative_list_enabled) {
        try {
          const fieldKeys = parseCumulativeFields(customer?.cumulative_list_fields)
          const resetHours = customer?.cumulative_list_reset_hours ?? 24
          const items = await appendToCumulativeList(DB, customerId, conversationKey, resetHours, fieldKeys, extraction)
          message += '\n\n' + buildCumulativeListMessage(items, lang, fieldKeys)
        } catch (err) {
          console.error('Cumulative list update failed (extraction batch)', err)
        }
      }

      results.push({ id: row.id, outcome: 'success', message })
    } catch (err: any) {
      console.error('Extraction batch item failed', err)
      await DB.prepare(`UPDATE pending_extractions SET status='failed', last_error=? WHERE id=?`)
        .bind(String(err?.message || err), row.id).run()
      results.push({ id: row.id, outcome: 'failed', message: T.error })
    }
  }

  const remaining = await DB.prepare(
    `SELECT COUNT(*) as cnt FROM pending_extractions WHERE customer_id = ? AND conversation_key = ? AND status = 'queued'`
  ).bind(customerId, conversationKey).first<{ cnt: number }>()

  return { processed: results, remainingQueued: remaining?.cnt || 0 }
}
