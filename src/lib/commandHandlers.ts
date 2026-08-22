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
