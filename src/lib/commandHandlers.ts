// Handles explicit WhatsApp text commands for an already-resolved conversation
// (private dedicated number, shared-number session, or a linked group).
// Returns null when the text isn't a recognized command, so callers fall
// through to their normal "not an image" / welcome-message behavior.
import { parseCommand } from './commands'
import { getCumulativeList, buildCumulativeListMessage, parseCumulativeFields } from './cumulative'
import { reportDateRange, buildReportTextMessage, buildReportHtml, VisaReportRow } from './reports'

export type CommandOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'pdf_report'; html: string; filename: string }
  // Signals the caller (webhook.ts) to run the queued-images batch
  // extraction pipeline itself — that pipeline needs GEMINI_API_KEY, R2,
  // and channel-specific delivery (direct WhatsApp send vs. a single
  // bridge reply string), none of which this module has access to.
  | { kind: 'run_extraction_batch' }

export async function handleTextCommand(
  DB: D1Database,
  customer: any,
  customerId: number,
  conversationKey: string,
  lang: 'ar' | 'en',
  text: string
): Promise<CommandOutcome | null> {
  const cmd = parseCommand(text)
  if (!cmd) return null

  if (cmd.type === 'toggle_feature') {
    const columnByFeature: Record<string, string> = {
      cumulative_list: 'feature_cumulative_list_enabled',
      visa_check: 'feature_visa_check_enabled',
      auto_extract: 'feature_auto_extract_enabled'
    }
    const column = columnByFeature[cmd.feature]
    await DB.prepare(`UPDATE customers SET ${column} = ? WHERE id = ?`).bind(cmd.enabled ? 1 : 0, customerId).run()

    const namesAr: Record<string, string> = { cumulative_list: 'القائمة التراكمية', visa_check: 'فحص التأشيرة', auto_extract: 'الاستخراج التلقائي' }
    const namesEn: Record<string, string> = { cumulative_list: 'the cumulative list', visa_check: 'the visa auto-check', auto_extract: 'auto-extract' }
    const featureNameAr = namesAr[cmd.feature]
    const featureNameEn = namesEn[cmd.feature]

    // Auto-extract has an extra nuance worth mentioning in the confirmation
    // itself: disabling it changes what happens to future images (queued
    // instead of processed immediately), and re-enabling it does NOT
    // retroactively process anything already queued (still needs "استخراج").
    if (cmd.feature === 'auto_extract') {
      return {
        kind: 'text',
        text: cmd.enabled
          ? (lang === 'en'
              ? '✅ Auto-extract enabled — new passport photos will be processed immediately again.'
              : '✅ تم تفعيل الاستخراج التلقائي — سيتم استخراج بيانات أي صورة جواز جديدة فوراً عند استلامها.')
          : (lang === 'en'
              ? '✅ Auto-extract disabled — new passport photos will be queued instead of processed immediately. Send "استخراج" anytime to process everything queued so far.'
              : '✅ تم إلغاء الاستخراج التلقائي — سيتم حفظ أي صورة جواز جديدة بانتظار الاستخراج بدل معالجتها فوراً. أرسل "استخراج" في أي وقت لمعالجة كل الصور المنتظرة دفعة واحدة.')
      }
    }

    return {
      kind: 'text',
      text: cmd.enabled
        ? (lang === 'en' ? `✅ ${featureNameEn} has been enabled for this conversation.` : `✅ تم تفعيل ${featureNameAr} لهذه المحادثة.`)
        : (lang === 'en' ? `✅ ${featureNameEn} has been disabled for this conversation.` : `✅ تم إلغاء تفعيل ${featureNameAr} لهذه المحادثة.`)
    }
  }

  // "list" and "check_now" only make sense once their respective feature is
  // enabled via the matching activation command.
  if (cmd.type === 'list' && !customer?.feature_cumulative_list_enabled) {
    return {
      kind: 'text',
      text: lang === 'en'
        ? '⚠️ The cumulative list feature is not enabled. Send "تفعيل القائمة" to enable it.'
        : '⚠️ ميزة القائمة التراكمية غير مفعّلة. أرسل "تفعيل القائمة" لتفعيلها.'
    }
  }

  if (cmd.type === 'check_now' && !customer?.feature_visa_check_enabled) {
    return {
      kind: 'text',
      text: lang === 'en'
        ? '⚠️ The visa auto-check feature is not enabled. Send "تفعيل فحص التاشيره" or "فحص دوري" to enable it.'
        : '⚠️ ميزة فحص التأشيرة غير مفعّلة. أرسل "تفعيل فحص التاشيره" أو "فحص دوري" لتفعيلها.'
    }
  }

  if (cmd.type === 'check_now') {
    const pending = await DB.prepare(
      `SELECT id FROM umrah_visa_checks WHERE customer_id = ? AND conversation_key = ? AND status IN ('pending','checking')`
    ).bind(customerId, conversationKey).all<{ id: number }>()

    if (!pending.results || pending.results.length === 0) {
      return {
        kind: 'text',
        text: lang === 'en'
          ? '⚠️ No pending visa check found for this conversation.'
          : '⚠️ لا يوجد فحص تأشيرة معلّق لهذه المحادثة حالياً.'
      }
    }

    await DB.prepare(
      `UPDATE umrah_visa_checks SET next_check_at = datetime('now'), status='pending', updated_at=datetime('now')
       WHERE customer_id = ? AND conversation_key = ? AND status IN ('pending','checking')`
    ).bind(customerId, conversationKey).run()

    return {
      kind: 'text',
      text: lang === 'en'
        ? '🔄 Got it, checking the visa status now — you will receive the PDF here as soon as it is ready.'
        : '🔄 تم، جاري فحص حالة التأشيرة الآن — سيصلك ملف PDF هنا فوراً عند جهوزيتها.'
    }
  }

  if (cmd.type === 'extract_now') {
    const pending = await DB.prepare(
      `SELECT id FROM pending_extractions WHERE customer_id = ? AND conversation_key = ? AND status = 'queued'`
    ).bind(customerId, conversationKey).all<{ id: number }>()

    if (!pending.results || pending.results.length === 0) {
      return {
        kind: 'text',
        text: lang === 'en'
          ? '⚠️ No images are currently queued for this conversation.'
          : '⚠️ لا توجد صور منتظرة للاستخراج في هذه المحادثة حالياً.'
      }
    }

    return { kind: 'run_extraction_batch' }
  }

  if (cmd.type === 'list') {
    const fieldKeys = parseCumulativeFields(customer?.cumulative_list_fields)
    const resetHours = customer?.cumulative_list_reset_hours ?? 24
    const items = await getCumulativeList(DB, customerId, conversationKey, resetHours)
    return { kind: 'text', text: buildCumulativeListMessage(items, lang, fieldKeys) }
  }

  if (cmd.type === 'report') {
    const { from, label } = reportDateRange(cmd.period)
    const rows = await DB.prepare(
      `SELECT first_name, passport_number, status, created_at FROM umrah_visa_checks
       WHERE customer_id = ? AND conversation_key = ? AND created_at >= ? ORDER BY created_at DESC`
    ).bind(customerId, conversationKey, from).all<VisaReportRow>()
    const results = rows.results || []

    if (cmd.format === 'pdf') {
      return { kind: 'pdf_report', html: buildReportHtml(results, label, customer?.name || ''), filename: `report-${cmd.period}.pdf` }
    }
    return { kind: 'text', text: buildReportTextMessage(results, label, lang) }
  }

  if (cmd.type === 'suggestion') {
    await DB.prepare(
      `INSERT INTO suggestions (customer_id, type, message, conversation_key) VALUES (?, 'feature_suggestion', ?, ?)`
    ).bind(customerId, cmd.text, conversationKey).run()
    return {
      kind: 'text',
      text: lang === 'en'
        ? '✅ Thank you! Your suggestion was sent to the platform admin.'
        : '✅ شكراً لك! تم إرسال اقتراحك إلى إدارة المنصة.'
    }
  }

  return null
}
