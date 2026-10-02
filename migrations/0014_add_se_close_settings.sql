-- =========================================================================
-- Smart Employee (الموظف الذكي) — admin-configurable transaction CLOSE
-- triggers, per office.
--
-- Real-world field observation (2026-10-02, screenshots supplied by the
-- user showing an actual agent/supplier WhatsApp flow): office staff do
-- NOT reliably type a fixed set of hardcoded phrases like "ارفع"/"ارفعها"
-- to close/forward a transaction. In practice they send a WhatsApp STICKER
-- (e.g. a green "ارفع المعاملة" branded sticker) as the closing signal, and
-- the exact text phrases used vary by office. Per user decision: this must
-- be an admin-configurable setting per customer/office rather than a fixed
-- code-level phrase list.
--
-- - close_phrases: a customer-editable, newline/comma-separated list of
--   Arabic phrases that close a transaction when sent as plain text in an
--   agent group (in addition to — not replacing — the built-in defaults
--   already in commands.ts, so existing office behavior from before this
--   migration keeps working). NULL/empty = use built-in defaults only.
-- - accept_sticker_as_close: when enabled (1), ANY WhatsApp sticker
--   message sent in an agent group counts as an explicit close signal for
--   the currently open transaction (we cannot reliably read which sticker
--   image was sent, only that a stickerMessage arrived — see bridge.js).
--   Defaults to 0 so this zero-impact-by-default pattern is preserved:
--   no behavior changes for any office until an admin opts in.
-- =========================================================================

ALTER TABLE customers ADD COLUMN se_close_phrases TEXT;
ALTER TABLE customers ADD COLUMN se_accept_sticker_as_close INTEGER NOT NULL DEFAULT 0;

-- Transaction attachments (the "الزمام" PDF/document the agent sends
-- alongside the ID photos). Stored as a reference (not OCR'd) — Smart
-- Employee data extraction continues to come solely from the passport/iqama
-- IMAGE messages; this table exists purely so the document travels with
-- the transaction and gets forwarded to the supplier automatically instead
-- of relying on a human doing a manual WhatsApp "forward".
CREATE TABLE IF NOT EXISTS transaction_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  r2_key TEXT,
  caption TEXT,
  source TEXT NOT NULL DEFAULT 'agent', -- 'agent' | 'supplier'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tx_attachments_tx ON transaction_attachments(transaction_id);
