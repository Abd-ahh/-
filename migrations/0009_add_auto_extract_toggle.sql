-- Feature: Auto-Extract toggle (per office/conversation).
--
-- When ENABLED, every incoming image is processed immediately by Gemini,
-- exactly as the platform has always behaved (the original, only behavior
-- before this migration).
--
-- When DISABLED, incoming images are queued in `pending_extractions`
-- instead of being processed right away (no Gemini call, no quota
-- deduction yet). The office must send "استخراج" to process everything
-- queued for that conversation in one batch — useful e.g. when several
-- passport photos are sent close together and should be extracted together
-- rather than one-by-one as they arrive.
--
-- Default is DISABLED (0) for ALL customers, both new and existing/
-- production ones, per EXPLICIT user decision (2026-08-23) after being
-- warned this is a breaking behavior change: unlike feature_cumulative_list
-- and feature_visa_check (migration 0008, purely additive opt-in features),
-- this toggle gates the CORE extraction behavior itself. Every office —
-- including live production offices such as مكتب النور — will stop getting
-- automatic extraction on image receipt immediately upon deploy, and must
-- either send "تفعيل الاستخراج التلقائي" to restore the original behavior,
-- or adopt the new queue+"استخراج" batch workflow.
ALTER TABLE customers ADD COLUMN feature_auto_extract_enabled INTEGER NOT NULL DEFAULT 0;

-- Images received while feature_auto_extract_enabled=0, awaiting the
-- "استخراج" command to be processed. Each row is deleted immediately after
-- a successful (or definitively-classified, e.g. not-a-passport) extraction
-- attempt, so re-sending "استخراج" never reprocesses/re-charges the same
-- image. On a transient failure (Gemini/network error) the row is kept
-- with status='failed' so the next "استخراج" retries it.
--
-- Two storage strategies depending on channel, to stay well under D1's
-- 2MB-per-row limit and avoid unnecessary storage:
--   - Official/shared number (channel='number'): only the lightweight
--     WhatsApp `media_id` + access is stored; the actual image bytes are
--     downloaded from Meta's Graph API on demand when "استخراج" runs.
--     NOTE: Meta expires inbound media IDs ~7 days after receipt, so a
--     backlog left unprocessed for over a week may fail to download by
--     the time "استخراج" is finally sent (rare in practice, but real).
--   - WhatsApp-group bridge (channel='group'): the Baileys VPS process has
--     no persistent media_id concept and sends the image as base64 in the
--     original webhook payload, so that base64 must be stored directly.
CREATE TABLE IF NOT EXISTS pending_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL,
  channel TEXT NOT NULL, -- 'number' | 'group'
  -- channel='number' fields
  whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  sender_phone TEXT,
  media_id TEXT,
  -- channel='group' fields
  group_jid TEXT,
  sender_jid TEXT,
  image_base64 TEXT,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  status TEXT NOT NULL DEFAULT 'queued', -- queued | failed
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_extractions_lookup ON pending_extractions(customer_id, conversation_key, status, created_at);
