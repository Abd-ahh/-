-- =========================================================
-- Feature: Message Lists (قوائم رسائل) — scheduled marketing/CRM broadcasts.
--
-- Lets an office (customer) — or the platform admin on any office's behalf —
-- define a named list of WhatsApp recipients (individual agents and/or
-- groups, optionally grouped by a free-text "region" label such as "صنعاء"),
-- attach a message + a schedule (time + recurrence: daily/weekly/monthly),
-- and have the platform send it automatically without any manual action.
--
-- Delivery channel: WhatsApp ONLY (by explicit user decision, 2026-08-23) —
-- reuses the existing unofficial Baileys bridge + `group_outbox` queue
-- (migration 0007). That queue already works for ANY WhatsApp JID, not just
-- groups — `bridge.js`'s poller calls `sock.sendMessage(item.group_jid, ...)`
-- which Baileys accepts equally for a group JID (...@g.us) or an individual
-- JID (...@s.whatsapp.net), so NO bridge.js changes are needed for delivery
-- itself. The only new bridge.js behavior needed is periodically hitting
-- GET /webhook/message-lists/tick, since Cloudflare Pages has no native
-- cron/scheduled-handler support (confirmed 2026-08-23) — this mirrors the
-- exact same pattern already used for the Umrah visa periodic checker.
--
-- Official Cloud API is deliberately NOT used for this feature: Meta
-- requires pre-approved message templates (or a 24h customer-service
-- window) for any outbound marketing-style message, which would reject
-- most sends here. The personal-number bridge has no such restriction.
-- =========================================================

-- A saved WhatsApp recipient for a given office: either an individual
-- agent's personal number or a WhatsApp group, optionally tagged with a
-- free-text region so a list can target "everyone in وكلاء صنعاء" without
-- re-selecting contacts one by one as new agents are added later.
CREATE TABLE IF NOT EXISTS message_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'number', -- 'number' (individual WhatsApp number) | 'group' (WhatsApp group JID)
  value TEXT NOT NULL, -- channel='number': digits with country code (e.g. 9665XXXXXXXX); channel='group': the raw group JID (...@g.us)
  region TEXT, -- free-text region/label (e.g. 'صنعاء', 'المحويت') — optional, used for "send to a whole region" targeting
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_contacts_customer ON message_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_message_contacts_region ON message_contacts(customer_id, region);

-- The scheduled list itself.
CREATE TABLE IF NOT EXISTS message_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- e.g. 'قائمة وكلاء الجوازات'
  message_type TEXT, -- free-text category label, e.g. 'رحلاتنا مستمرة لإصدار الجوازات' (display-only, no logic depends on it)
  message_text TEXT NOT NULL,
  -- Schedule: time-of-day is stored as 'HH:MM' in Asia/Riyadh local time
  -- (UTC+3, fixed offset — matches both Yemen and Saudi Arabia, the
  -- platform's actual user base, so no DST/timezone-table complexity needed).
  schedule_time TEXT NOT NULL, -- 'HH:MM', 24h format, Riyadh-local
  recurrence TEXT NOT NULL DEFAULT 'daily', -- 'daily' | 'weekly' | 'monthly'
  -- schedule_days meaning depends on recurrence:
  --   daily   -> ignored (fires every day at schedule_time)
  --   weekly  -> JSON array of weekday numbers, JS getDay() convention (0=Sunday .. 6=Saturday)
  --   monthly -> JSON array of day-of-month numbers (1-31)
  schedule_days TEXT,
  -- Optional region filter: if set, the list ALSO includes every
  -- message_contacts row for this customer with a matching region, resolved
  -- fresh at send-time (so newly-added agents in that region are included
  -- automatically without editing the list). Explicit per-contact
  -- recipients (message_list_recipients) are always included regardless.
  target_region TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT, -- 'YYYY-MM-DD' (Riyadh-local) of the last date this list actually fired — prevents double-firing within the same day across multiple tick polls
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_lists_customer ON message_lists(customer_id);
CREATE INDEX IF NOT EXISTS idx_message_lists_active ON message_lists(is_active);

-- Explicit per-contact recipients for a list (in addition to any
-- target_region match resolved at send-time).
CREATE TABLE IF NOT EXISTS message_list_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES message_lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES message_contacts(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_list_recipients_unique ON message_list_recipients(list_id, contact_id);

-- One row per actual scheduled send (fired by the tick endpoint).
CREATE TABLE IF NOT EXISTS message_list_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES message_lists(id) ON DELETE CASCADE,
  run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' -- running | done
);
CREATE INDEX IF NOT EXISTS idx_message_list_runs_list ON message_list_runs(list_id);

-- Per-recipient delivery result for a run. Linked from group_outbox (see
-- below) via send_log_id, which the bridge's ack call updates.
CREATE TABLE IF NOT EXISTS message_list_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES message_list_runs(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES message_lists(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES message_contacts(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL, -- contact name at send time (kept even if contact is later deleted)
  jid_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_list_send_log_run ON message_list_send_log(run_id);
CREATE INDEX IF NOT EXISTS idx_message_list_send_log_list ON message_list_send_log(list_id);

-- Link group_outbox rows back to the send-log entry they fulfil, so the
-- existing bridge ack flow (POST /webhook/bridge/outbox/:id/ack) can also
-- update message_list_send_log's per-recipient status without any bridge.js
-- delivery-logic changes (it already treats group_outbox.group_jid as an
-- opaque destination JID, which works identically for individual numbers).
ALTER TABLE group_outbox ADD COLUMN send_log_id INTEGER REFERENCES message_list_send_log(id);
