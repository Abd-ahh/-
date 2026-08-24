-- =========================================================
-- Feature: AI Knowledge Base extracted from office conversations.
--
-- Context: the office (customer) staff answer real questions from their
-- own clients inside WhatsApp conversations (private shared-number chats
-- or linked groups). This feature stores the raw text of those
-- conversations long enough to run a periodic Gemini analysis pass that
-- extracts reusable knowledge (FAQs, prices, required documents,
-- procedures, etc.) per the office's explicit request (2026-08-24).
--
-- Privacy design (explicit user decisions, 2026-08-24):
--   1) Raw conversation text IS now stored (previously nothing was stored) —
--      user confirmed "نعم".
--   2) Only messages from a number/JID the office has explicitly registered
--      as "staff" (`staff_numbers`) are ever treated as confirmed
--      office-sourced knowledge. Everyone else defaults to `customer` and
--      is NEVER treated as ground truth by the analysis prompt.
--   3) Rolled out to all existing offices immediately (user: "نطاق الحالي"),
--      not scoped to a single pilot office.
--   4) Raw text in `conversation_messages` is deleted after
--      KB_RAW_RETENTION_DAYS (90, see knowledgeBase.ts) once it has been
--      analyzed — only the derived, anonymized `knowledge_base` rows
--      persist after that. Passport numbers / secrets are never written
--      here in the first place (this only logs WhatsApp text, never the
--      structured passport-extraction fields already stored in
--      `operations`).
-- =========================================================

-- ---------- Staff number registry (per office) ----------
-- Lets each office explicitly mark which sender identities (phone number
-- for shared-number chats, or WhatsApp JID for group members) are their
-- own staff, so the analysis pipeline can tell "staff-confirmed answer"
-- apart from "unverified customer claim" per the office's own request.
CREATE TABLE IF NOT EXISTS staff_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL, -- phone number (digits) or WhatsApp JID (e.g. 9665...@s.whatsapp.net / ...@lid)
  label TEXT, -- optional free-text name, e.g. "أحمد - موظف الاستقبال"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_numbers_unique ON staff_numbers(customer_id, identifier);

-- ---------- Raw conversation log (temporary, purged after analysis+90d) ----------
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL, -- same key format as cumulative_lists/umrah_visa_checks ('wn:<id>:<phone>' | 'grp:<jid>')
  direction TEXT NOT NULL, -- 'in' (received) | 'out' (sent, bot or staff reply)
  sender_role TEXT NOT NULL, -- 'staff' | 'customer' | 'bot' | 'unknown'
  sender_identifier TEXT, -- raw phone/JID, only used to resolve sender_role at write time; not exposed in analysis output
  text TEXT NOT NULL,
  analyzed_at DATETIME, -- set once included in a knowledge_base extraction run
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_messages_customer ON conversation_messages(customer_id, analyzed_at);
CREATE INDEX IF NOT EXISTS idx_conv_messages_created ON conversation_messages(created_at);

-- ---------- Extracted knowledge base (persists indefinitely, anonymized) ----------
CREATE TABLE IF NOT EXISTS knowledge_base (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category TEXT NOT NULL, -- التصنيف (e.g. أسعار | مستندات | إجراءات | مواعيد | حالات | سؤال_متكرر | متعارضة | غير_معروف ...)
  question_intent TEXT, -- السؤال/النية
  knowledge TEXT NOT NULL, -- المعرفة (المعلومة الفعلية المستخلصة)
  suggested_answer TEXT, -- الإجابة المقترحة (فقط إن وُجدت إجابة موظف مؤكدة وغير متعارضة)
  source TEXT, -- مصدر المعرفة (وصف عام، بلا هوية عميل: مثال "رد موظف بتاريخ المحادثة")
  confidence TEXT NOT NULL DEFAULT 'unknown', -- درجة الثقة: high | medium | low | unknown
  is_conflicting INTEGER NOT NULL DEFAULT 0, -- 1 إذا وُجدت إجابتان مختلفتان لنفس السؤال
  needs_review INTEGER NOT NULL DEFAULT 1, -- تحتاج مراجعة؟
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | approved | rejected
  extracted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- تاريخ الاستخراج
  reviewed_at DATETIME,
  reviewed_by TEXT, -- admin/customer email who approved/rejected, for audit only
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_customer ON knowledge_base(customer_id, status);

-- ---------- Per-customer analysis run bookkeeping ----------
CREATE TABLE IF NOT EXISTS knowledge_base_runs (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  last_run_at DATETIME,
  last_message_id INTEGER NOT NULL DEFAULT 0 -- highest conversation_messages.id included in the last run
);
