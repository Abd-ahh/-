-- =========================================================
-- Advanced features batch:
--   1) Unified welcome/activation message for non-activated senders on
--      private chats (dedicated + shared number). Groups stay silent
--      (unchanged). Stored as a single platform-wide row in `settings`
--      (key = 'unactivated_welcome_message') — no DDL needed for that part,
--      documented here for completeness.
--   2) Cumulative running list of extracted fields per conversation
--      (auto-resent after each new passport + on-demand command), resets
--      after a configurable number of hours per office.
--   3) Suggestion box: offices submit free-text feature suggestions via a
--      WhatsApp command, visible to the admin. `type` column keeps this
--      extensible for future similar "office-submitted content" features.
--   4) Periodic Umrah visa auto-check + PDF delivery: triggered on a
--      successful passport extraction as a second, parallel service option.
--      A separate VPS process (Playwright + Gemini Vision for the captcha)
--      polls the pending list and posts results back.
-- =========================================================

-- ---------- 2) Cumulative list ----------
ALTER TABLE customers ADD COLUMN cumulative_list_fields TEXT; -- JSON array of field keys, null = default [full_name_ar, passport_number]
ALTER TABLE customers ADD COLUMN cumulative_list_reset_hours INTEGER NOT NULL DEFAULT 24;

CREATE TABLE IF NOT EXISTS cumulative_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL, -- 'wn:<whatsapp_number_id>:<sender_phone>' | 'grp:<group_jid>'
  items_json TEXT NOT NULL DEFAULT '[]', -- JSON array of extracted-field snapshots, oldest first
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- used with cumulative_list_reset_hours to know when to auto-clear
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cumulative_lists_conv ON cumulative_lists(customer_id, conversation_key);

-- ---------- 3) Suggestion box ----------
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'feature_suggestion', -- extensible: future office-submitted content types reuse this table
  message TEXT NOT NULL,
  conversation_key TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new | reviewed | done
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suggestions_customer ON suggestions(customer_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

-- ---------- 4) Umrah visa periodic check ----------
CREATE TABLE IF NOT EXISTS umrah_visa_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL, -- where to deliver the result (same conversation that sent the passport photo)
  passport_number TEXT NOT NULL,
  first_name TEXT NOT NULL, -- Arabic first name as extracted; MOFA accepts Arabic or MRZ English interchangeably
  nationality TEXT, -- raw extracted nationality text; the VPS checker resolves it to MOFA's dropdown code at check time
  status TEXT NOT NULL DEFAULT 'pending', -- pending | checking | found | failed | cancelled
  check_count INTEGER NOT NULL DEFAULT 0,
  next_check_at DATETIME NOT NULL, -- when the VPS checker should try again (3h after creation, then +20min each retry)
  last_checked_at DATETIME,
  last_error TEXT,
  found_at DATETIME,
  pdf_r2_key TEXT, -- R2 object key of the generated visa PDF once found
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visa_checks_customer ON umrah_visa_checks(customer_id);
CREATE INDEX IF NOT EXISTS idx_visa_checks_status_next ON umrah_visa_checks(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_visa_checks_conversation ON umrah_visa_checks(conversation_key);

-- ---------- Generic HTML->PDF->WhatsApp-document render jobs ----------
-- Used for PDF-format reports (and any future "render this HTML as a PDF and
-- send it to a conversation" need) without re-scheduling logic like visa
-- checks need. The VPS process (already running Playwright for the visa
-- checker) picks these up, renders page.pdf(), and delivers via WhatsApp.
CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'report_pdf', -- extensible for future PDF-delivery needs
  html TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT 'report.pdf',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);
