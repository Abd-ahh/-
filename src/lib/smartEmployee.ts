// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — WhatsApp group message
// handling for 'agent' and 'supplier' classified groups (see
// migrations/0013_add_smart_employee_core.sql). Called from webhook.ts's
// /bridge/message handler ONLY when the linked group's group_type is
// 'agent' or 'supplier' AND the office has feature_smart_employee_enabled
// — every existing 'bot' group (the only type that existed before this
// migration) is completely unaffected; none of this file's code path is
// ever reached for it.
// =========================================================================
import { extractPassportData, extractIqamaData } from './gemini'
import { buildConversationKey, extractHostPhone, detectTransactionIntent, extractTransactionCode, detectSupplierReplyIntent } from './commands'
import { deliverToConversation } from './deliver'
import {
  generateTransactionCode, transitionTransaction, isTransactionReadyForConfirmation,
  buildTransactionSummary, CONFIRMATION_PROMPT
} from './transactions'

export interface SmartEmployeeDeps {
  DB: D1Database
  PASSPORTS_BUCKET?: R2Bucket
  GEMINI_API_KEY?: string
}

// Finds (or creates) the "open" transaction for an agent's conversation —
// the most recent one that hasn't left the agent-facing intake stage yet
// (NEW / RECEIVED_FROM_AGENT / WAITING_AGENT_CONFIRMATION). Spec section 3:
// "إذا أرسل الوكيل بيانات مستقلة لاحقًا تُنشأ معاملة جديدة ولا تختلط
// بالسابقة" — once a transaction moves to SENT_TO_SUPPLIER it is no longer
// "open" for new incoming documents, and the next image/host-phone starts a
// brand new transaction automatically.
async function findOrCreateOpenTransaction(
  DB: D1Database,
  customerId: number,
  conversationKey: string,
  agentId: number | null
): Promise<any> {
  const existing = await DB.prepare(
    `SELECT * FROM transactions WHERE customer_id = ? AND conversation_key = ?
     AND status IN ('NEW','RECEIVED_FROM_AGENT','WAITING_AGENT_CONFIRMATION')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(customerId, conversationKey).first<any>()
  if (existing) return existing

  const code = await generateTransactionCode(DB, customerId)
  const insert = await DB.prepare(
    `INSERT INTO transactions (customer_id, transaction_code, conversation_key, agent_id, status) VALUES (?, ?, ?, ?, 'NEW')`
  ).bind(customerId, code, conversationKey, agentId).run()
  return DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(insert.meta.last_row_id).first<any>()
}

// After any new data lands on an open transaction (image or host phone),
// bumps NEW -> RECEIVED_FROM_AGENT (first data point) and, once the
// transaction has everything needed, either closes immediately (if THIS
// same message was also an explicit "ارفع" command) or asks for
// confirmation. Returns the extra reply text to append, if any.
async function advanceAfterDataReceived(
  DB: D1Database,
  tx: any,
  explicitCloseRequested: boolean,
  defaultSupplierConversationKey: string | null
): Promise<string> {
  if (tx.status === 'NEW') {
    await transitionTransaction(DB, tx.id, 'RECEIVED_FROM_AGENT', null, 'system')
    tx.status = 'RECEIVED_FROM_AGENT'
  }

  const ready = await isTransactionReadyForConfirmation(DB, tx.id)
  if (!ready) return ''

  if (explicitCloseRequested) {
    return await closeTransactionToSupplier(DB, tx.id, defaultSupplierConversationKey, 'agent')
  }

  if (tx.status === 'RECEIVED_FROM_AGENT') {
    await transitionTransaction(DB, tx.id, 'WAITING_AGENT_CONFIRMATION', null, 'system')
    return '\n\n' + CONFIRMATION_PROMPT
  }

  return ''
}

// Confirms + forwards a transaction to its supplier (or NEEDS_REVIEW if no
// supplier is configured for this agent/office yet). Returns reply text for
// the agent's conversation.
async function closeTransactionToSupplier(
  DB: D1Database,
  transactionId: number,
  supplierConversationKey: string | null,
  changedBy: string
): Promise<string> {
  const tx = await DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(transactionId).first<any>()
  if (!tx) return ''

  if (!supplierConversationKey) {
    await transitionTransaction(DB, transactionId, 'NEEDS_REVIEW', 'لا يوجد مورد مرتبط بهذا الوكيل بعد', changedBy)
    return `\n\n⚠️ تم تأكيد المعاملة ${tx.transaction_code} لكن لا يوجد مورد مرتبط بعد — يرجى التواصل مع إدارة المنصة.`
  }

  await transitionTransaction(DB, transactionId, 'SENT_TO_SUPPLIER', null, changedBy)
  const summary = await buildTransactionSummary(DB, transactionId)
  await deliverToConversation(DB, supplierConversationKey, { kind: 'text', text: summary }).catch(() => {})
  await transitionTransaction(DB, transactionId, 'WAITING_HOSTING', null, 'system')
  return `\n\n✅ تم تأكيد وإرسال المعاملة ${tx.transaction_code} إلى المورد.`
}

// ---------------------- Agent group: incoming IMAGE ----------------------
// Tries passport extraction first; if the image isn't a passport, tries
// iqama extraction. Silent (no reply) if it's neither — same "stay quiet on
// unrelated images" philosophy as the existing bot pipeline.
export async function handleAgentGroupImage(
  deps: SmartEmployeeDeps,
  customerId: number,
  customer: any,
  groupJid: string,
  senderJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY } = deps
  if (!GEMINI_API_KEY) return null
  const conversationKey = buildConversationKey({ group_jid: groupJid })

  let docType: 'passport' | 'iqama' | null = null
  let fields: any = null

  const passportResult = await extractPassportData(GEMINI_API_KEY, imageBase64, mimeType).catch(() => null)
  if (passportResult?.is_passport) {
    docType = 'passport'
    fields = passportResult
  } else {
    const iqamaResult = await extractIqamaData(GEMINI_API_KEY, imageBase64, mimeType).catch(() => null)
    if (iqamaResult?.is_iqama) {
      docType = 'iqama'
      fields = iqamaResult
    }
  }

  if (!docType || !fields) return null // not a recognizable document -> stay silent

  if (!fields.is_clear) {
    return `⚠️ الصورة غير واضحة بشكل كافٍ: ${fields.clarity_reason || 'يرجى إرسال صورة أوضح.'}`
  }

  const tx = await findOrCreateOpenTransaction(DB, customerId, conversationKey, agentId)

  // A transaction holds at most one iqama (spec section 3) — if a second
  // iqama arrives, replace the previous one rather than duplicating.
  if (docType === 'iqama') {
    await DB.prepare(`DELETE FROM transaction_people WHERE transaction_id = ? AND document_type = 'iqama'`).bind(tx.id).run()
  }

  const opInsert = await DB.prepare(
    `INSERT INTO operations (customer_id, sender_phone, group_jid, status, source) VALUES (?, ?, ?, 'success', 'smart_employee_agent')`
  ).bind(customerId, senderJid, groupJid).run()
  const operationId = opInsert.meta.last_row_id
  const imageKey = `smart-employee/${customerId}/${tx.id}/${operationId}-${Date.now()}.jpg`
  if (PASSPORTS_BUCKET) {
    const bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0))
    PASSPORTS_BUCKET.put(imageKey, bytes, { httpMetadata: { contentType: mimeType } }).catch(() => {})
  }

  const confidence = typeof fields.confidence === 'number' ? fields.confidence : null
  const lowConfidence = confidence !== null && confidence < 0.5
  const personStatus = lowConfidence ? 'needs_review' : 'extracted'

  if (docType === 'passport') {
    await DB.prepare(
      `INSERT INTO transaction_people
         (transaction_id, operation_id, document_type, full_name_ar, full_name_en, document_number, nationality,
          date_of_birth, date_of_expiry, gender, confidence, image_key, status)
       VALUES (?, ?, 'passport', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      tx.id, operationId, fields.full_name_ar || null, fields.full_name_en || null, fields.passport_number || null,
      fields.nationality || null, fields.date_of_birth || null, fields.date_of_expiry || null, fields.gender || null,
      confidence, imageKey, personStatus
    ).run()
  } else {
    await DB.prepare(
      `INSERT INTO transaction_people
         (transaction_id, operation_id, document_type, full_name_ar, full_name_en, document_number, nationality,
          date_of_birth, date_of_expiry, gender, profession, sponsor, confidence, image_key, status)
       VALUES (?, ?, 'iqama', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      tx.id, operationId, fields.full_name_ar || null, fields.full_name_en || null, fields.id_number || null,
      fields.nationality || null, fields.date_of_birth || null, fields.date_of_expiry || null, fields.gender || null,
      fields.profession || null, fields.sponsor || null, confidence, imageKey, personStatus
    ).run()
  }

  if (lowConfidence) {
    await transitionTransaction(DB, tx.id, 'NEEDS_REVIEW', `ثقة استخراج منخفضة (${confidence})`, 'system')
    return `⚠️ تم استلام المستند لكن درجة الثقة منخفضة — تم تحويل المعاملة ${tx.transaction_code} للمراجعة اليدوية.`
  }

  const docLabel = docType === 'iqama' ? 'إقامة' : 'جواز'
  let reply = `✅ تم استلام ${docLabel}: ${fields.full_name_ar || ''} — معاملة ${tx.transaction_code}`
  reply += await advanceAfterDataReceived(DB, tx, false, defaultSupplierConversationKey)
  return reply
}

// ---------------------- Agent group: incoming TEXT ----------------------
export async function handleAgentGroupText(
  deps: SmartEmployeeDeps,
  customerId: number,
  groupJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  text: string
): Promise<string | null> {
  const { DB } = deps
  const conversationKey = buildConversationKey({ group_jid: groupJid })

  const hostPhone = extractHostPhone(text)
  const openTx = await DB.prepare(
    `SELECT * FROM transactions WHERE customer_id = ? AND conversation_key = ?
     AND status IN ('NEW','RECEIVED_FROM_AGENT','WAITING_AGENT_CONFIRMATION') ORDER BY created_at DESC LIMIT 1`
  ).bind(customerId, conversationKey).first<any>()

  // ---- 1) Waiting on an explicit confirmation reply ----
  if (openTx && openTx.status === 'WAITING_AGENT_CONFIRMATION') {
    const intent = detectTransactionIntent(text, true)
    if (intent === 'confirm') {
      return (await closeTransactionToSupplier(DB, openTx.id, defaultSupplierConversationKey, 'agent')).trim()
    }
    if (intent === 'reject') {
      await transitionTransaction(DB, openTx.id, 'CANCELLED', 'agent rejected confirmation', 'agent')
      return `🚫 تم إلغاء المعاملة ${openTx.transaction_code}.`
    }
    // Ambiguous reply while a confirmation is pending -> route to review
    // rather than silently ignoring it (spec section 5).
    if (hostPhone) {
      await DB.prepare('UPDATE transactions SET host_phone = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(hostPhone, openTx.id).run()
    }
    const closePhrase = detectTransactionIntent(text, false)
    if (closePhrase === 'confirm') {
      return (await closeTransactionToSupplier(DB, openTx.id, defaultSupplierConversationKey, 'agent')).trim()
    }
    return null // unrelated chit-chat while awaiting confirmation -> stay silent
  }

  // ---- 2) Host phone number message ----
  let reply: string | null = null
  let tx = openTx
  if (hostPhone) {
    tx = tx || (await findOrCreateOpenTransaction(DB, customerId, conversationKey, agentId))
    await DB.prepare('UPDATE transactions SET host_phone = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(hostPhone, tx.id).run()
    reply = `📞 تم تسجيل رقم المضيف للمعاملة ${tx.transaction_code}`
  }

  // ---- 3) Explicit close command ("ارفع"/"رحّل"/...) ----
  const intent = detectTransactionIntent(text, false)
  if (intent === 'confirm') {
    if (!tx) return 'ℹ️ لا توجد معاملة مفتوحة حالياً لرفعها. أرسل صور الجوازات أولاً.'
    const ready = await isTransactionReadyForConfirmation(DB, tx.id)
    if (!ready) return `⚠️ المعاملة ${tx.transaction_code} غير مكتملة بعد (يلزم جواز واحد على الأقل + رقم المضيف).`
    return (await closeTransactionToSupplier(DB, tx.id, defaultSupplierConversationKey, 'agent')).trim()
  }

  if (reply && tx) {
    reply += await advanceAfterDataReceived(DB, tx, false, defaultSupplierConversationKey)
  }

  return reply
}

// ---------------------- Supplier group: incoming TEXT ----------------------
// Suppliers reply with free text referencing the transaction code (e.g.
// "استضافة جاهزة UMR-260001"). Matches the exact transaction scoped to this
// office (customer_id) so one supplier serving multiple offices never
// leaks across tenants.
export async function handleSupplierGroupText(
  deps: SmartEmployeeDeps,
  customerId: number,
  text: string
): Promise<string | null> {
  const { DB } = deps
  const code = extractTransactionCode(text)
  const intent = detectSupplierReplyIntent(text)
  if (!code || !intent) return null

  const tx = await DB.prepare('SELECT * FROM transactions WHERE customer_id = ? AND transaction_code = ?')
    .bind(customerId, code).first<any>()
  if (!tx) return `⚠️ لم يتم العثور على معاملة بالرقم ${code}.`

  if (intent === 'hosting_ready' && tx.status === 'WAITING_HOSTING') {
    await transitionTransaction(DB, tx.id, 'HOSTING_RECEIVED', null, 'supplier')
    await deliverToConversation(DB, tx.conversation_key, { kind: 'text', text: `✅ تم استلام الاستضافة لمعاملة ${code}.` }).catch(() => {})
    await transitionTransaction(DB, tx.id, 'HOSTING_SENT_TO_AGENT', null, 'system')
    await transitionTransaction(DB, tx.id, 'VISA_WAITING', null, 'system')
    return `👍 تم تسجيل استلام الاستضافة وإبلاغ الوكيل — بانتظار التأشيرة الآن لمعاملة ${code}.`
  }

  if (intent === 'visa_ready' && tx.status === 'VISA_WAITING') {
    await transitionTransaction(DB, tx.id, 'VISA_RECEIVED', null, 'supplier')
    await deliverToConversation(DB, tx.conversation_key, { kind: 'text', text: `✅ تأشيرتكم جاهزة لمعاملة ${code}.` }).catch(() => {})
    await transitionTransaction(DB, tx.id, 'VISA_SENT_TO_AGENT', null, 'system')
    await transitionTransaction(DB, tx.id, 'COMPLETED', null, 'system')
    return `🎉 تم إبلاغ الوكيل وإغلاق المعاملة ${code}.`
  }

  return `ℹ️ معاملة ${code} حالتها الحالية "${tx.status}" — لا يمكن تطبيق هذا التحديث عليها الآن.`
}

// ---------------------- Supplier group: incoming IMAGE (document) ----------------------
// Supplier sends the hosting confirmation / visa PDF as an image (the
// bridge only relays imageMessage, not documentMessage, from groups today —
// see bridge/bridge.js). Matched to a transaction either by a code
// mentioned in the image caption, or — if omitted — the sole eligible
// pending transaction for this supplier's linked transactions, to stay
// usable even without disciplined captioning.
export async function handleSupplierGroupImage(
  deps: SmartEmployeeDeps,
  customerId: number,
  supplierId: number | null,
  imageBase64: string,
  mimeType: string,
  caption: string
): Promise<string | null> {
  const { DB } = deps
  const codeFromCaption = extractTransactionCode(caption)

  let tx: any = null
  if (codeFromCaption) {
    tx = await DB.prepare('SELECT * FROM transactions WHERE customer_id = ? AND transaction_code = ?')
      .bind(customerId, codeFromCaption).first<any>()
  } else if (supplierId) {
    tx = await DB.prepare(
      `SELECT * FROM transactions WHERE customer_id = ? AND supplier_id = ? AND status IN ('WAITING_HOSTING','VISA_WAITING')
       ORDER BY CASE status WHEN 'WAITING_HOSTING' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`
    ).bind(customerId, supplierId).first<any>()
  }

  if (!tx) return null // can't confidently match -> stay silent, admin can resolve manually

  if (tx.status === 'WAITING_HOSTING') {
    await transitionTransaction(DB, tx.id, 'HOSTING_RECEIVED', null, 'supplier')
    await deliverToConversation(DB, tx.conversation_key, {
      kind: 'document', base64: imageBase64, mimeType, filename: `استضافة-${tx.transaction_code}.jpg`,
      caption: `✅ تم استلام الاستضافة لمعاملة ${tx.transaction_code}.`
    }).catch(() => {})
    await transitionTransaction(DB, tx.id, 'HOSTING_SENT_TO_AGENT', null, 'system')
    await transitionTransaction(DB, tx.id, 'VISA_WAITING', null, 'system')
    return `👍 تم تحويل ملف الاستضافة للوكيل — بانتظار التأشيرة لمعاملة ${tx.transaction_code}.`
  }

  if (tx.status === 'VISA_WAITING') {
    await transitionTransaction(DB, tx.id, 'VISA_RECEIVED', null, 'supplier')
    await deliverToConversation(DB, tx.conversation_key, {
      kind: 'document', base64: imageBase64, mimeType, filename: `تاشيرة-${tx.transaction_code}.jpg`,
      caption: `✨ تأشيرتكم جاهزة لمعاملة ${tx.transaction_code}!`
    }).catch(() => {})
    await transitionTransaction(DB, tx.id, 'VISA_SENT_TO_AGENT', null, 'system')
    await transitionTransaction(DB, tx.id, 'COMPLETED', null, 'system')
    return `🎉 تم تحويل التأشيرة للوكيل وإغلاق المعاملة ${tx.transaction_code}.`
  }

  return null
}
