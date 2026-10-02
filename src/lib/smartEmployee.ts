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
import { extractPassportData, extractIqamaData, extractPhoneFromImage } from './gemini'
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
  defaultSupplierConversationKey: string | null,
  PASSPORTS_BUCKET?: R2Bucket
): Promise<string> {
  if (tx.status === 'NEW') {
    await transitionTransaction(DB, tx.id, 'RECEIVED_FROM_AGENT', null, 'system')
    tx.status = 'RECEIVED_FROM_AGENT'
  }

  const ready = await isTransactionReadyForConfirmation(DB, tx.id)
  if (!ready) return ''

  if (explicitCloseRequested) {
    return await closeTransactionToSupplier(DB, tx.id, defaultSupplierConversationKey, 'agent', PASSPORTS_BUCKET)
  }

  if (tx.status === 'RECEIVED_FROM_AGENT') {
    await transitionTransaction(DB, tx.id, 'WAITING_AGENT_CONFIRMATION', null, 'system')
    return '\n\n' + CONFIRMATION_PROMPT
  }

  return ''
}

// Confirms + forwards a transaction to its supplier (or NEEDS_REVIEW if no
// supplier is configured for this agent/office yet). Returns reply text for
// the agent's conversation. `PASSPORTS_BUCKET` is optional (not every
// deployment configures R2 yet — see wrangler.jsonc) and is only needed to
// auto-forward the "الزمام" document attachment, if any was sent.
async function closeTransactionToSupplier(
  DB: D1Database,
  transactionId: number,
  supplierConversationKey: string | null,
  changedBy: string,
  PASSPORTS_BUCKET?: R2Bucket
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

  // Auto-forward any attachments ("الزمام" PDF/document) the agent sent
  // for this transaction — this is the automated replacement for the
  // manual WhatsApp "forward" a human previously had to do for every
  // message (field observation, 2026-10-02).
  if (PASSPORTS_BUCKET) {
    const attachments = await DB.prepare(
      `SELECT * FROM transaction_attachments WHERE transaction_id = ? AND source = 'agent' ORDER BY created_at ASC`
    ).bind(transactionId).all<any>()
    for (const att of attachments.results || []) {
      if (!att.r2_key) continue
      try {
        const obj = await PASSPORTS_BUCKET.get(att.r2_key)
        if (!obj) continue
        const bytes = await obj.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
        await deliverToConversation(DB, supplierConversationKey, {
          kind: 'document', base64, mimeType: att.mime_type || 'application/octet-stream',
          filename: att.filename || 'document', caption: `📎 مرفق معاملة ${tx.transaction_code}`
        }).catch(() => {})
      } catch {
        // best-effort only — never block closing the transaction on an attachment re-upload failure
      }
    }
  }

  await transitionTransaction(DB, transactionId, 'WAITING_HOSTING', null, 'system')
  // Reply kept deliberately minimal per office request (2026-10-02): just
  // "تم الرفع" — no transaction code, no agent/supplier name in the
  // agent-facing reply. (The supplier still gets the full summary above,
  // which is a different audience and needs the transaction code.)
  return `\n\n✅ تم الرفع.`
}

// ---------------------- Agent group: identity document (shared core) ----------------------
// Shared by handleAgentGroupImage AND handleAgentGroupDocument — a passport
// or iqama can arrive either as a photo (imageMessage) OR as a PDF/scan
// (documentMessage) per office requirement (2026-10-02): "جواز من 1 إلى 5
// جوازات... ممكن يكونوا صور أو صيغات PDF، اقامة واحدة فقط صورة أو PDF".
// Gemini's inline_data accepts PDF bytes exactly like image bytes, so the
// same extraction call works for both — only the stored file extension
// (imageKey) and R2 content-type differ.
// Tries passport extraction first; if it isn't a passport, tries iqama.
// Returns null (stay silent) if it's neither — e.g. a document/image sent
// that turns out to be the "الزمام" manifest rather than an ID page; the
// caller falls back to storing it as a plain attachment in that case.
async function processAgentIdentityMedia(
  deps: SmartEmployeeDeps,
  customerId: number,
  groupJid: string,
  senderJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  mediaBase64: string,
  mimeType: string
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY } = deps
  if (!GEMINI_API_KEY) return null
  const conversationKey = buildConversationKey({ group_jid: groupJid })

  let docType: 'passport' | 'iqama' | null = null
  let fields: any = null

  const passportResult = await extractPassportData(GEMINI_API_KEY, mediaBase64, mimeType).catch(() => null)
  if (passportResult?.is_passport) {
    docType = 'passport'
    fields = passportResult
  } else {
    const iqamaResult = await extractIqamaData(GEMINI_API_KEY, mediaBase64, mimeType).catch(() => null)
    if (iqamaResult?.is_iqama) {
      docType = 'iqama'
      fields = iqamaResult
    }
  }

  if (!docType || !fields) return null // not a recognizable ID document -> let caller decide fallback

  if (!fields.is_clear) {
    return `⚠️ المستند غير واضح بشكل كافٍ: ${fields.clarity_reason || 'يرجى إرسال نسخة أوضح.'}`
  }

  const tx = await findOrCreateOpenTransaction(DB, customerId, conversationKey, agentId)

  // Umrah transaction composition rule (office requirement, 2026-10-02):
  // - 1 to 5 PASSPORTS per transaction (image or PDF)
  // - exactly 1 IQAMA per transaction (image or PDF)
  // A second iqama replaces the previous one (never duplicates — a
  // transaction only ever has one). A 6th passport is rejected outright
  // rather than silently accepted, so the office notices and opens a new
  // transaction for the extra traveler instead of overflowing this one.
  if (docType === 'iqama') {
    await DB.prepare(`DELETE FROM transaction_people WHERE transaction_id = ? AND document_type = 'iqama'`).bind(tx.id).run()
  } else {
    const passportCount = await DB.prepare(
      `SELECT COUNT(*) as cnt FROM transaction_people WHERE transaction_id = ? AND document_type = 'passport'`
    ).bind(tx.id).first<{ cnt: number }>()
    if ((passportCount?.cnt || 0) >= 5) {
      return `⚠️ المعاملة ${tx.transaction_code} تحتوي بالفعل على 5 جوازات (الحد الأقصى). يرجى إنهاء هذه المعاملة أو فتح معاملة جديدة لهذا الشخص.`
    }
  }

  const opInsert = await DB.prepare(
    `INSERT INTO operations (customer_id, sender_phone, group_jid, status, source) VALUES (?, ?, ?, 'success', 'smart_employee_agent')`
  ).bind(customerId, senderJid, groupJid).run()
  const operationId = opInsert.meta.last_row_id
  const isPdf = mimeType === 'application/pdf'
  const mediaKey = `smart-employee/${customerId}/${tx.id}/${operationId}-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`
  if (PASSPORTS_BUCKET) {
    const bytes = Uint8Array.from(atob(mediaBase64), (c) => c.charCodeAt(0))
    PASSPORTS_BUCKET.put(mediaKey, bytes, { httpMetadata: { contentType: mimeType } }).catch(() => {})
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
      confidence, mediaKey, personStatus
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
      fields.profession || null, fields.sponsor || null, confidence, mediaKey, personStatus
    ).run()
  }

  if (lowConfidence) {
    await transitionTransaction(DB, tx.id, 'NEEDS_REVIEW', `ثقة استخراج منخفضة (${confidence})`, 'system')
    return `⚠️ تم استلام المستند لكن درجة الثقة منخفضة — تم تحويل المعاملة ${tx.transaction_code} للمراجعة اليدوية.`
  }

  // Reply kept deliberately minimal per office request (2026-10-02): no
  // name/transaction-code recap needed here — just confirm receipt. The
  // transaction code still surfaces later in the final "تم الرفع" / review
  // messages where it's actually actionable.
  const docLabel = docType === 'iqama' ? 'إقامة' : 'جواز'
  let reply = `✅ تم استلام ${docLabel}.`
  reply += await advanceAfterDataReceived(DB, tx, false, defaultSupplierConversationKey, PASSPORTS_BUCKET)
  return reply
}

// ---------------------- Agent group: incoming IMAGE ----------------------
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
  const idReply = await processAgentIdentityMedia(deps, customerId, groupJid, senderJid, agentId, defaultSupplierConversationKey, imageBase64, mimeType)
  if (idReply !== null) return idReply // recognized as passport/iqama (or a clarity warning) -> handled

  // Not a passport/iqama — office requirement (2026-10-02): "رقم هاتف واحد
  // فقط جه اتصال أو نص أو صورة", the host phone may also arrive as a PHOTO
  // (e.g. a screenshot of a contact entry or a handwritten number) rather
  // than a contact card or typed text. Try a narrow phone-only extraction
  // before giving up silently.
  return attemptHostPhoneFromImage(deps, customerId, groupJid, agentId, defaultSupplierConversationKey, imageBase64, mimeType)
}

// ---------------------- Agent group: host phone via IMAGE (fallback) ----------------------
// Only reached once an incoming agent-group image has already been ruled
// out as a passport/iqama scan (processAgentIdentityMedia returned null).
// Mirrors the "host phone via text" handling in handleAgentGroupText —
// same reply shape, same advanceAfterDataReceived call — just sourced from
// a narrow Gemini phone-in-image extraction instead of a regex match.
async function attemptHostPhoneFromImage(
  deps: SmartEmployeeDeps,
  customerId: number,
  groupJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY } = deps
  if (!GEMINI_API_KEY) return null

  const phoneResult = await extractPhoneFromImage(GEMINI_API_KEY, imageBase64, mimeType).catch(() => null)
  const phone = phoneResult?.found ? (phoneResult.phone || '').replace(/\D/g, '') : ''
  if (!phone || phone.length < 8 || phone.length > 15) return null // no clear phone in the image -> stay silent

  const conversationKey = buildConversationKey({ group_jid: groupJid })
  const tx = await findOrCreateOpenTransaction(DB, customerId, conversationKey, agentId)
  await DB.prepare('UPDATE transactions SET host_phone = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(phone, tx.id).run()

  let reply = `📞 تم تسجيل رقم المضيف للمعاملة ${tx.transaction_code}`
  reply += await advanceAfterDataReceived(DB, tx, false, defaultSupplierConversationKey, PASSPORTS_BUCKET)
  return reply
}

// ---------------------- Agent group: incoming TEXT ----------------------
// `extraClosePhrases`: office-specific additional close phrases from
// customers.se_close_phrases (migration 0014) — layered on top of the
// built-in defaults in commands.ts, never replacing them.
export async function handleAgentGroupText(
  deps: SmartEmployeeDeps,
  customerId: number,
  groupJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  text: string,
  extraClosePhrases: string[] = []
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET } = deps
  const conversationKey = buildConversationKey({ group_jid: groupJid })

  const hostPhone = extractHostPhone(text)
  const openTx = await DB.prepare(
    `SELECT * FROM transactions WHERE customer_id = ? AND conversation_key = ?
     AND status IN ('NEW','RECEIVED_FROM_AGENT','WAITING_AGENT_CONFIRMATION') ORDER BY created_at DESC LIMIT 1`
  ).bind(customerId, conversationKey).first<any>()

  // ---- 1) Waiting on an explicit confirmation reply ----
  if (openTx && openTx.status === 'WAITING_AGENT_CONFIRMATION') {
    const intent = detectTransactionIntent(text, true, extraClosePhrases)
    if (intent === 'confirm') {
      return (await closeTransactionToSupplier(DB, openTx.id, defaultSupplierConversationKey, 'agent', PASSPORTS_BUCKET)).trim()
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
    const closePhrase = detectTransactionIntent(text, false, extraClosePhrases)
    if (closePhrase === 'confirm') {
      return (await closeTransactionToSupplier(DB, openTx.id, defaultSupplierConversationKey, 'agent', PASSPORTS_BUCKET)).trim()
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
  const intent = detectTransactionIntent(text, false, extraClosePhrases)
  if (intent === 'confirm') {
    if (!tx) return 'ℹ️ لا توجد معاملة مفتوحة حالياً لرفعها. أرسل صور الجوازات أولاً.'
    const ready = await isTransactionReadyForConfirmation(DB, tx.id)
    if (!ready) return `⚠️ المعاملة ${tx.transaction_code} غير مكتملة بعد (يلزم مستند هوية واحد على الأقل + رقم المضيف).`
    return (await closeTransactionToSupplier(DB, tx.id, defaultSupplierConversationKey, 'agent', PASSPORTS_BUCKET)).trim()
  }

  if (reply && tx) {
    reply += await advanceAfterDataReceived(DB, tx, false, defaultSupplierConversationKey, PASSPORTS_BUCKET)
  }

  return reply
}

// ---------------------- Agent group: incoming DOCUMENT ("الزمام") ----------------------
// Stored as a plain attachment reference (NOT OCR'd — Smart Employee data
// extraction continues to come solely from the passport/iqama IMAGE
// messages). Attaches to the currently-open transaction (creating one if
// none exists yet, same as a host-phone text message would), and the
// attachment is forwarded to the supplier automatically when the
// transaction closes (see closeTransactionToSupplier).
// A document (PDF) can be EITHER a passport/iqama scan OR the "الزمام"
// manifest — office requirement (2026-10-02): "جواز... ممكن يكونوا صور او
// صيغات pdf" / "اقامه واحدة فقط صورة أو pdf". So a PDF is first tried
// through the same identity-extraction pipeline as an image; only if
// Gemini doesn't recognize it as a passport/iqama does it fall back to
// being stored as a plain "الزمام" attachment (never OCR'd).
export async function handleAgentGroupDocument(
  deps: SmartEmployeeDeps,
  customerId: number,
  groupJid: string,
  senderJid: string,
  agentId: number | null,
  defaultSupplierConversationKey: string | null,
  documentBase64: string,
  mimeType: string,
  filename: string,
  caption: string
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET, GEMINI_API_KEY } = deps

  // Only PDFs are worth trying as an identity document — other document
  // types (e.g. .docx/.xlsx "الزمام" manifests) go straight to attachment
  // storage, Gemini's inline_data doesn't support those formats anyway.
  if (mimeType === 'application/pdf' && GEMINI_API_KEY) {
    const idReply = await processAgentIdentityMedia(
      deps, customerId, groupJid, senderJid, agentId, defaultSupplierConversationKey, documentBase64, mimeType
    ).catch((err) => { console.error('processAgentIdentityMedia (PDF) failed', err); return null })
    if (idReply) return idReply // recognized as passport/iqama -> handled, don't also store as a manifest attachment
  }

  // Fallback: plain "الزمام" manifest attachment (not OCR'd) — reuses the
  // same "open transaction" matching used for text/image so it attaches to
  // whichever transaction is currently being built in this conversation.
  const conversationKey = buildConversationKey({ group_jid: groupJid })
  const tx = await findOrCreateOpenTransaction(DB, customerId, conversationKey, agentId)

  let r2Key: string | null = null
  if (PASSPORTS_BUCKET) {
    r2Key = `smart-employee/${customerId}/${tx.id}/doc-${Date.now()}-${filename}`
    const bytes = Uint8Array.from(atob(documentBase64), (c) => c.charCodeAt(0))
    await PASSPORTS_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } }).catch(() => { r2Key = null })
  }

  await DB.prepare(
    `INSERT INTO transaction_attachments (transaction_id, filename, mime_type, r2_key, caption, source) VALUES (?, ?, ?, ?, ?, 'agent')`
  ).bind(tx.id, filename, mimeType, r2Key, caption || null).run()

  return `📎 تم استلام المستند.`
}

// ---------------------- Agent group: incoming STICKER (close signal) ----------------------
// Real-world field observation: office staff close a transaction by
// sending a WhatsApp sticker rather than typing a fixed phrase. We cannot
// read which sticker image was sent — only called when the office opted in
// via customers.se_accept_sticker_as_close (migration 0014), so ANY sticker
// in that case counts as "رفع المعاملة" for the currently open transaction.
export async function handleAgentGroupSticker(
  deps: { DB: D1Database; PASSPORTS_BUCKET?: R2Bucket },
  customerId: number,
  groupJid: string,
  defaultSupplierConversationKey: string | null
): Promise<string | null> {
  const { DB, PASSPORTS_BUCKET } = deps
  const conversationKey = buildConversationKey({ group_jid: groupJid })
  const tx = await DB.prepare(
    `SELECT * FROM transactions WHERE customer_id = ? AND conversation_key = ?
     AND status IN ('NEW','RECEIVED_FROM_AGENT','WAITING_AGENT_CONFIRMATION') ORDER BY created_at DESC LIMIT 1`
  ).bind(customerId, conversationKey).first<any>()
  if (!tx) return null // no open transaction -> nothing to close, stay silent

  const ready = await isTransactionReadyForConfirmation(DB, tx.id)
  if (!ready) return `⚠️ المعاملة ${tx.transaction_code} غير مكتملة بعد (يلزم مستند هوية واحد على الأقل + رقم المضيف).`
  return (await closeTransactionToSupplier(DB, tx.id, defaultSupplierConversationKey, 'agent', PASSPORTS_BUCKET)).trim()
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
