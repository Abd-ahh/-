// Feature: AI-generated Knowledge Base from office WhatsApp conversations
// (requested 2026-08-24). See migrations/0011_add_knowledge_base.sql for the
// full privacy-design rationale and the explicit user decisions this
// implementation follows:
//   1) Raw conversation text is stored (new — previously nothing was kept).
//   2) Only messages from a sender explicitly registered by the office in
//      `staff_numbers` are ever treated as "confirmed staff answer" — every
//      other sender defaults to role='customer' and the analysis prompt is
//      instructed to NEVER treat customer claims as verified facts.
//   3) Rolled out to every existing office immediately (no single-office
//      pilot).
//   4) Raw text is purged KB_RAW_RETENTION_DAYS after being analyzed —
//      only the derived, anonymized knowledge_base rows persist after that.
import type { KnowledgeConfidence, KnowledgeExtractionItem, SenderRole } from './types'

export const KB_RAW_RETENTION_DAYS = 90
// Only analyze once at least this many new (unanalyzed) messages have piled
// up for a customer, OR it's been a while — avoids burning Gemini calls on
// near-empty batches. Actual scheduling trigger lives in the /tick endpoint
// (webhook.ts), mirroring the existing message-lists / visa-check pattern.
export const KB_MIN_BATCH_SIZE = 20
// Cap per analysis run so a single Gemini call / prompt never grows
// unbounded for a very active office.
export const KB_MAX_BATCH_SIZE = 200

// ---------------------------------------------------------------------------
// Staff/customer identity resolution
// ---------------------------------------------------------------------------
export async function resolveSenderRole(
  DB: D1Database,
  customerId: number,
  identifier: string | null,
  direction: 'in' | 'out',
  isBot: boolean
): Promise<SenderRole> {
  if (isBot) return 'bot'
  if (direction === 'out') {
    // Outbound messages sent by the bot are tagged isBot=true by the caller;
    // anything else classified as 'out' without isBot is a human staff reply
    // typed directly in the app/group (rare on the group bridge, but
    // possible), so still resolve it against staff_numbers below.
  }
  if (!identifier) return 'unknown'
  const row = await DB.prepare('SELECT id FROM staff_numbers WHERE customer_id = ? AND identifier = ?')
    .bind(customerId, identifier)
    .first<{ id: number }>()
  return row ? 'staff' : 'customer'
}

export async function logConversationMessage(
  DB: D1Database,
  params: {
    customerId: number
    conversationKey: string
    direction: 'in' | 'out'
    text: string
    senderIdentifier: string | null
    isBot?: boolean
  }
): Promise<void> {
  const text = (params.text || '').trim()
  if (!text) return // nothing useful to learn from an empty/media-only message
  const role = await resolveSenderRole(DB, params.customerId, params.senderIdentifier, params.direction, !!params.isBot)
  await DB.prepare(
    `INSERT INTO conversation_messages (customer_id, conversation_key, direction, sender_role, sender_identifier, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(params.customerId, params.conversationKey, params.direction, role, params.senderIdentifier || null, text).run()
}

// ---------------------------------------------------------------------------
// Staff number management (used by admin.ts / customer.ts routes)
// ---------------------------------------------------------------------------
export async function listStaffNumbers(DB: D1Database, customerId: number) {
  const res = await DB.prepare('SELECT * FROM staff_numbers WHERE customer_id = ? ORDER BY created_at DESC')
    .bind(customerId).all()
  return res.results || []
}

export async function addStaffNumber(DB: D1Database, customerId: number, identifier: string, label: string | null) {
  const clean = (identifier || '').trim()
  if (!clean) throw new Error('identifier is required')
  await DB.prepare(
    `INSERT INTO staff_numbers (customer_id, identifier, label) VALUES (?, ?, ?)
     ON CONFLICT(customer_id, identifier) DO UPDATE SET label = excluded.label`
  ).bind(customerId, clean, label || null).run()
}

export async function removeStaffNumber(DB: D1Database, customerId: number, id: number) {
  await DB.prepare('DELETE FROM staff_numbers WHERE id = ? AND customer_id = ?').bind(id, customerId).run()
}

// ---------------------------------------------------------------------------
// Gemini analysis prompt — mirrors, verbatim in intent, the extraction rules
// the user specified in chat (13 extraction targets + strict no-fabrication
// rules + the exact per-item output shape).
// ---------------------------------------------------------------------------
const ANALYSIS_INSTRUCTIONS = `أنت نظام تدريب ذكي لمساعد خدمة عملاء يعمل عبر واتساب.

مهمتك هي تحليل محادثات المكتب السابقة (مزوّدة أدناه، كل رسالة معلَّمة بدورها: [موظف مؤكد] أو [عميل] أو [بوت]) واستخراج المعرفة المفيدة التي يمكن استخدامها لاحقاً للرد على العملاء.

قواعد صارمة يجب الالتزام بها دون استثناء:
- لا تفترض أي معلومة غير موجودة حرفياً في المحادثات المرفقة.
- لا تخترع أسعاراً أو مواعيد أو إجراءات أبداً.
- لا تعتبر كلام العميل ([عميل]) حقيقة أو مصدراً موثوقاً؛ اعتمد فقط على المعلومات التي أكدها [موظف مؤكد]. رسائل [عميل] قد تُستخدم فقط لفهم "السؤال/النية"، وليس كمصدر للإجابة.
- لا تتعلم بيانات شخصية لأي عميل (اسم، رقم جواز، رقم هاتف، كلمة مرور) كمعرفة عامة — تجاهلها تماماً حتى لو ظهرت في النص.
- إذا وجدت إجابتين مختلفتين من [موظف مؤكد] لنفس السؤال، لا تختر واحدة بنفسك؛ ضع is_conflicting=true واجعل needs_review=true واذكر كلا الإجابتين في حقل knowledge.
- إذا كانت المعلومة مرتبطة بتاريخ أو سعر قد يتغير مستقبلاً، اذكر ذلك صراحة داخل نص knowledge (مثلاً: "قابل للتغيير").
- لا تُنشئ أي بند من رسالة [عميل] لم يؤكدها [موظف مؤكد] أو [بوت] بمصدر رسمي داخل النظام.
- لا تعتبر معلومة صحيحة لمجرد أنها تكررت كثيراً إن لم يؤكدها موظف.
- عند عدم وجود إجابة مؤكدة واضحة لسؤال متكرر، اجعل category="غير_معروف" و confidence="unknown" و suggested_answer=null بدلاً من التخمين.

لكل محادثة أو مجموعة رسائل متعلقة، حاول استخراج ما ينطبق من هذه المحاور: (1) الأسئلة المتكررة، (2) إجابات الموظفين المؤكدة، (3) الخدمات التي يقدمها المكتب، (4) الأسعار المذكورة من موظف، (5) الأوراق/المستندات المطلوبة، (6) خطوات وإجراءات المعاملات، (7) أماكن ومواعيد تقديم الخدمة، (8) مواعيد رحلات/حجوزات إن ذُكرت من موظف، (9) حالات المعاملات ومعنى كل حالة، (10) الردود التي يفضلها المكتب، (11) معلومات تحتاج تحديثاً دورياً (اذكر ذلك في knowledge)، (12) معلومات متعارضة (is_conflicting=true)، (13) أسئلة لم يجد لها الموظفون إجابة واضحة (category="غير_معروف").

أعد الإجابة بصيغة JSON فقط بدون أي نص إضافي، على شكل مصفوفة (array) من عناصر، كل عنصر بهذا الشكل بالضبط:
{
  "category": "تصنيف قصير بالعربي (مثال: أسعار | مستندات | إجراءات | مواعيد | حالات_المعاملة | سؤال_متكرر | متعارضة | غير_معروف)",
  "question_intent": "السؤال أو نية العميل المتكررة",
  "knowledge": "المعرفة المستخلصة فعلياً، بلا أي بيانات شخصية",
  "suggested_answer": "إجابة مقترحة جاهزة للاستخدام أو null إن لم تكن هناك إجابة مؤكدة",
  "source": "وصف عام للمصدر بدون أي هوية عميل، مثال: رد موظف مؤكد في المحادثة",
  "confidence": "high أو medium أو low أو unknown",
  "is_conflicting": false,
  "needs_review": true
}

إذا لم تجد أي معرفة قابلة للاستخراج بثقة من هذه الدفعة، أعد مصفوفة فارغة [].`

function roleLabel(role: SenderRole): string {
  if (role === 'staff') return 'موظف مؤكد'
  if (role === 'bot') return 'بوت'
  if (role === 'customer') return 'عميل'
  return 'غير معروف'
}

export function buildAnalysisPrompt(messages: { sender_role: SenderRole; text: string; conversation_key: string }[]): string {
  // Group by conversation so Gemini sees each thread's context together,
  // in chronological order (messages are already fetched ORDER BY id ASC).
  const byConv = new Map<string, string[]>()
  for (const m of messages) {
    const line = `[${roleLabel(m.sender_role)}] ${m.text}`
    if (!byConv.has(m.conversation_key)) byConv.set(m.conversation_key, [])
    byConv.get(m.conversation_key)!.push(line)
  }
  const sections: string[] = []
  let i = 1
  for (const [, lines] of byConv) {
    sections.push(`--- محادثة ${i} ---\n${lines.join('\n')}`)
    i++
  }
  return `${ANALYSIS_INSTRUCTIONS}\n\nالمحادثات المطلوب تحليلها:\n\n${sections.join('\n\n')}`
}

const GEMINI_MODEL = 'gemini-flash-lite-latest' // same model already validated in production for this platform (see gemini.ts)

export async function analyzeConversationsWithGemini(
  apiKey: string,
  messages: { sender_role: SenderRole; text: string; conversation_key: string }[]
): Promise<KnowledgeExtractionItem[]> {
  if (messages.length === 0) return []
  const prompt = buildAnalysisPrompt(messages)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, response_mime_type: 'application/json' }
    })
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Gemini analysis error ${resp.status}: ${errText}`)
  }

  const data = await resp.json<any>()
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) return []

  let parsed: any
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const ALLOWED_CONFIDENCE: KnowledgeConfidence[] = ['high', 'medium', 'low', 'unknown']
  const items: KnowledgeExtractionItem[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const knowledge = typeof raw.knowledge === 'string' ? raw.knowledge.trim() : ''
    if (!knowledge) continue // never store an empty knowledge item
    const confidence: KnowledgeConfidence = ALLOWED_CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'unknown'
    items.push({
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'غير_مصنّف',
      question_intent: typeof raw.question_intent === 'string' ? raw.question_intent.trim() : '',
      knowledge,
      suggested_answer: typeof raw.suggested_answer === 'string' && raw.suggested_answer.trim() ? raw.suggested_answer.trim() : null,
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'تحليل محادثات آلي',
      confidence,
      is_conflicting: raw.is_conflicting === true,
      needs_review: raw.needs_review !== false // default true unless explicitly false
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Per-customer analysis run — fetch new messages, call Gemini, persist
// results, mark messages analyzed. Called from the /knowledge-base/tick
// endpoint (polled by the VPS bridge, same pattern as visa-checks /
// message-lists) and can also be triggered on-demand from the admin UI.
// ---------------------------------------------------------------------------
export async function runKnowledgeBaseAnalysis(
  DB: D1Database,
  GEMINI_API_KEY: string | undefined,
  customerId: number
): Promise<{ analyzed: number; extracted: number } | { error: string }> {
  if (!GEMINI_API_KEY) return { error: 'GEMINI_API_KEY غير مهيأ على المنصة' }

  const runRow = await DB.prepare('SELECT last_message_id FROM knowledge_base_runs WHERE customer_id = ?')
    .bind(customerId).first<{ last_message_id: number }>()
  const lastId = runRow?.last_message_id || 0

  const pending = await DB.prepare(
    `SELECT id, sender_role, text, conversation_key FROM conversation_messages
     WHERE customer_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
  ).bind(customerId, lastId, KB_MAX_BATCH_SIZE).all<{ id: number; sender_role: SenderRole; text: string; conversation_key: string }>()

  const rows = pending.results || []
  if (rows.length < KB_MIN_BATCH_SIZE) {
    return { analyzed: 0, extracted: 0 }
  }

  const items = await analyzeConversationsWithGemini(GEMINI_API_KEY, rows)

  for (const item of items) {
    await DB.prepare(
      `INSERT INTO knowledge_base
         (customer_id, category, question_intent, knowledge, suggested_answer, source, confidence, is_conflicting, needs_review, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`
    ).bind(
      customerId,
      item.category,
      item.question_intent || null,
      item.knowledge,
      item.suggested_answer,
      item.source,
      item.confidence,
      item.is_conflicting ? 1 : 0,
      item.needs_review ? 1 : 0
    ).run()
  }

  const maxId = rows[rows.length - 1].id
  const nowIso = new Date().toISOString()
  await DB.prepare(
    `INSERT INTO knowledge_base_runs (customer_id, last_run_at, last_message_id) VALUES (?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_message_id = excluded.last_message_id`
  ).bind(customerId, nowIso, maxId).run()

  await DB.prepare(`UPDATE conversation_messages SET analyzed_at = ? WHERE customer_id = ? AND id <= ? AND analyzed_at IS NULL`)
    .bind(nowIso, customerId, maxId).run()

  return { analyzed: rows.length, extracted: items.length }
}

// Runs analysis for every customer that has at least KB_MIN_BATCH_SIZE
// unanalyzed messages. Called from the periodic /tick endpoint.
export async function runDueKnowledgeBaseAnalysis(DB: D1Database, GEMINI_API_KEY: string | undefined) {
  const candidates = await DB.prepare(
    `SELECT cm.customer_id, COUNT(*) as pending_count
     FROM conversation_messages cm
     LEFT JOIN knowledge_base_runs r ON r.customer_id = cm.customer_id
     WHERE cm.id > COALESCE(r.last_message_id, 0)
     GROUP BY cm.customer_id
     HAVING pending_count >= ?`
  ).bind(KB_MIN_BATCH_SIZE).all<{ customer_id: number; pending_count: number }>()

  const results: Record<number, any> = {}
  for (const row of candidates.results || []) {
    results[row.customer_id] = await runKnowledgeBaseAnalysis(DB, GEMINI_API_KEY, row.customer_id)
  }
  return results
}

// Deletes raw conversation text older than KB_RAW_RETENTION_DAYS that has
// already been analyzed (analyzed_at IS NOT NULL) — the derived
// knowledge_base rows are untouched. Never deletes un-analyzed messages
// even if old, so a slow-moving office doesn't lose data before its first
// analysis run.
export async function purgeOldConversationMessages(DB: D1Database) {
  const result = await DB.prepare(
    `DELETE FROM conversation_messages
     WHERE analyzed_at IS NOT NULL AND analyzed_at <= datetime('now', ?)`
  ).bind(`-${KB_RAW_RETENTION_DAYS} days`).run()
  return result.meta?.changes || 0
}
