-- =========================================================
-- Shared / multi-tenant WhatsApp number support
-- Lets low-tier packages (e.g. free trial / Starter) share ONE platform-wide
-- WhatsApp number across many customer offices, instead of each customer
-- needing their own dedicated number. Higher tiers keep a private/dedicated
-- number exactly as before (fully backward compatible).
--
-- How office routing works on the shared number:
--   1. Admin marks exactly one whatsapp_numbers row as is_shared = 1
--      (customer_id = NULL for that row).
--   2. An office's end customer sends: "<اسم المكتب> تفعيل" once
--      (e.g. "معالم الرياض 11 تفعيل") to the shared number.
--   3. The bot matches "<اسم المكتب>" against customers.name (only among
--      customers on a 'shared' package) and creates a row in
--      shared_number_sessions binding that WhatsApp sender to that office
--      for 30 days, auto-renewed on every successful interaction.
--   4. Subsequent messages from that sender are routed to that office
--      automatically without repeating the code.
-- =========================================================

-- 1) Packages: number_mode decides whether customers on this package get a
--    private/dedicated number or use the platform's shared number.
ALTER TABLE packages ADD COLUMN number_mode TEXT NOT NULL DEFAULT 'private'; -- 'private' | 'shared'

-- 2) whatsapp_numbers: allow a platform-owned "shared" number with no single
--    customer owner. SQLite/D1 cannot relax a NOT NULL / FK constraint via a
--    plain ALTER TABLE, so the table is rebuilt preserving all existing data.
CREATE TABLE whatsapp_numbers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE, -- NULL = platform shared number
  is_shared INTEGER NOT NULL DEFAULT 0, -- 1 = this is the platform's single shared WhatsApp number
  display_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  phone_number_id TEXT UNIQUE, -- Meta Cloud API phone_number_id
  waba_id TEXT, -- WhatsApp Business Account ID
  access_token TEXT, -- Per-number system user access token (optional, can be shared)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | connected | disconnected
  extraction_fields TEXT, -- JSON array of field keys, null = all fields
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO whatsapp_numbers_new
  (id, customer_id, is_shared, display_name, phone_number, phone_number_id, waba_id, access_token, status, extraction_fields, created_at)
SELECT
  id, customer_id, 0, display_name, phone_number, phone_number_id, waba_id, access_token, status, extraction_fields, created_at
FROM whatsapp_numbers;

DROP TABLE whatsapp_numbers;
ALTER TABLE whatsapp_numbers_new RENAME TO whatsapp_numbers;

CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_customer ON whatsapp_numbers(customer_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_phone_number_id ON whatsapp_numbers(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_is_shared ON whatsapp_numbers(is_shared);

-- 3) Sessions binding an end-user's WhatsApp number (on the shared number) to
--    an office (customer). Created on first successful office-code match,
--    expires 30 days after the last interaction (renewed on each message).
CREATE TABLE IF NOT EXISTS shared_number_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number_id INTEGER NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  sender_phone TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_sessions_number_sender ON shared_number_sessions(whatsapp_number_id, sender_phone);
CREATE INDEX IF NOT EXISTS idx_shared_sessions_customer ON shared_number_sessions(customer_id);
