// Duplicate passport/iqama warning (feature requested 2026-10-04): "التنبيه
// عد إرسال او استلام صوره او ملف جواز مكرر ... تنبية عن الجواز مكرر تم
// ارساله بتاريخ ووقت لنفس المحادثه". Required across EVERY channel.
//
// Design: a document is considered a duplicate when the exact same
// document_number (passport_number for passports, document_number for
// iqamas in the Smart Employee flow) was already successfully extracted
// before for the EXACT SAME conversation (same WhatsApp group, or same
// sender on the same private/shared number) — not globally across all
// offices/conversations, since two different travelers in two different
// offices can legitimately share no relation, and the same traveler's
// passport legitimately reappears across multiple *different* conversations
// (e.g. agent -> office) as it moves through a workflow.
//
// This is a WARNING, not a hard block: the new extraction still proceeds
// normally (the office may genuinely need to resend an old passport, e.g.
// to start a new transaction for a repeat traveler) — we just surface the
// date/time of the earlier submission so staff notice and can decide.
//
// Two independent sources are checked because the platform has two
// separate tables that each store successful extractions:
//   - `operations` (passport_number column) for every private/shared-number
//     AND plain 'bot'-type group passport, across all three delivery
//     channels (Cloud API handler, group bridge, extraction batch drain).
//   - `transaction_people` (document_number column) for Smart Employee
//     agent-group passports/iqamas, which live in their own transaction
//     records rather than plain `operations` rows with a group_jid.
import { parseStoredTimestamp } from './cumulative'

export interface DuplicateCheckResult {
  isDuplicate: boolean
  firstSeenAt: string | null // original DB timestamp (UTC), for formatting by the caller
}

// Riyadh-local (UTC+3, no DST) formatting of a DB UTC timestamp into a
// human-readable Arabic date+time string for the warning message — mirrors
// the same fixed-offset approach already used in messageLists.ts.
const RIYADH_OFFSET_MIN = 3 * 60
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']

export function formatRiyadhDateTime(utcTimestamp: string): string {
  const d = parseStoredTimestamp(utcTimestamp)
  const shifted = new Date(d.getTime() + RIYADH_OFFSET_MIN * 60 * 1000)
  const day = shifted.getUTCDate()
  const month = AR_MONTHS[shifted.getUTCMonth()]
  const year = shifted.getUTCFullYear()
  const hours24 = shifted.getUTCHours()
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0')
  const period = hours24 < 12 ? 'ص' : 'م'
  let hours12 = hours24 % 12
  if (hours12 === 0) hours12 = 12
  return `${day} ${month} ${year} الساعة ${hours12}:${minutes} ${period}`
}

// Checks `operations` for a prior SUCCESSFUL extraction of the same
// passport_number in the same conversation (private number: same
// whatsapp_number_id + sender_phone; group: same group_jid). `excludeOperationId`
// skips the just-inserted row for the current extraction itself.
export async function checkDuplicatePassportInOperations(
  DB: D1Database,
  passportNumber: string,
  conversation: { whatsapp_number_id: number; sender_phone: string } | { group_jid: string },
  excludeOperationId?: number
): Promise<DuplicateCheckResult> {
  if (!passportNumber) return { isDuplicate: false, firstSeenAt: null }

  let row: { created_at: string } | null = null
  if ('group_jid' in conversation) {
    row = await DB.prepare(
      `SELECT created_at FROM operations
       WHERE status = 'success' AND passport_number = ? AND group_jid = ? AND id != ?
       ORDER BY created_at ASC LIMIT 1`
    ).bind(passportNumber, conversation.group_jid, excludeOperationId || 0).first<{ created_at: string }>()
  } else {
    row = await DB.prepare(
      `SELECT created_at FROM operations
       WHERE status = 'success' AND passport_number = ? AND whatsapp_number_id = ? AND sender_phone = ? AND id != ?
       ORDER BY created_at ASC LIMIT 1`
    ).bind(passportNumber, conversation.whatsapp_number_id, conversation.sender_phone, excludeOperationId || 0).first<{ created_at: string }>()
  }

  return row ? { isDuplicate: true, firstSeenAt: row.created_at } : { isDuplicate: false, firstSeenAt: null }
}

// Checks `transaction_people` for a prior extraction of the same
// document_number within the SAME agent/office conversation (Smart
// Employee agent-group flow — transactions are scoped to one
// conversation_key per office). `excludePersonId` skips the row just
// inserted for the current document.
export async function checkDuplicateDocumentInTransactionPeople(
  DB: D1Database,
  documentNumber: string,
  conversationKey: string,
  excludePersonId?: number
): Promise<DuplicateCheckResult> {
  if (!documentNumber) return { isDuplicate: false, firstSeenAt: null }

  const row = await DB.prepare(
    `SELECT tp.created_at as created_at FROM transaction_people tp
     JOIN transactions t ON t.id = tp.transaction_id
     WHERE tp.document_number = ? AND t.conversation_key = ? AND tp.id != ?
     ORDER BY tp.created_at ASC LIMIT 1`
  ).bind(documentNumber, conversationKey, excludePersonId || 0).first<{ created_at: string }>()

  return row ? { isDuplicate: true, firstSeenAt: row.created_at } : { isDuplicate: false, firstSeenAt: null }
}

// Builds the one-line Arabic warning appended to the normal reply.
export function buildDuplicateWarning(firstSeenAt: string, lang: 'ar' | 'en' = 'ar'): string {
  const whenAr = formatRiyadhDateTime(firstSeenAt)
  if (lang === 'en') {
    // English offices are rare on this platform but keep parity.
    return `⚠️ Note: This same passport/ID was already sent before, on ${whenAr} (Riyadh time), in this same conversation.`
  }
  return `⚠️ تنبيه: هذا الجواز/المستند تم إرساله من قبل بتاريخ ${whenAr} في نفس المحادثة.`
}
