-- =========================================================
-- "الموظف الذكي" (Smart Employee) — core schema, phase 1: Umrah transactions
-- management between an office (customer, existing tenant concept) and its
-- own agents (الوكلاء، من يرسلون المعاملات) and suppliers (الموردون، من
-- تُرسل لهم المعاملات لتنفيذ الاستضافة/التأشيرة).
--
-- Architecture decisions (explicit, since the spec document left these to
-- our own judgment — user: "اللي يناسبك"):
--
-- 1) NO new Postgres/Redis/Docker stack. Everything lives in the existing
--    Cloudflare D1 database alongside the current tables, reusing the exact
--    same multi-tenant pattern (`customer_id` scoping) already used by
--    customers/subscriptions/whatsapp_groups/etc.
--
-- 2) Agents/suppliers are modeled as their own tables (not reusing
--    `customers`, which represents the platform's own paying office
--    tenants) — an agent/supplier is a contact *belonging to* one office,
--    identified by a WhatsApp conversation_key (private number or group),
--    exactly like `message_contacts` (migration 0010) already does for
--    broadcast recipients, but extended with their own workflow role.
--
-- 3) Reuses the EXISTING WhatsApp Group Bridge (`whatsapp_groups`,
--    migration 0005) rather than inventing a parallel bridge concept. A new
--    `group_type` column distinguishes:
--      'bot'      (default, current behavior, 100% unchanged — passport
--                  extraction bot inside a generic office group)
--      'agent'    the group where an agent sends passport/iqama photos +
--                 host number to open/build a transaction
--      'supplier' the group transactions are forwarded to, and where the
--                 supplier's replies (hosting ready / visa ready) are read
--    This keeps the proven activation flow ("<اسم المكتب> تفعيل") and the
--    BRIDGE_SECRET trust boundary fully intact — group_type is just an
--    extra admin-set classification on top of the exact same linked group.
--    EXISTING customers are entirely unaffected (every row defaults to
--    group_type='bot', and the whole Smart Employee pipeline is additionally
--    gated behind a new opt-in `customers.feature_smart_employee_enabled`
--    flag so it can be rolled out office-by-office).
--
-- 4) Redis+BullMQ (follow-up timers) is replaced by a plain D1 table
--    (`follow_up_tasks`) polled by the VPS bridge process — the exact same
--    "polling tick" pattern already proven by `umrah_visa_checks` (0006),
--    `message_lists` (0010) and `knowledge_base` (0011). No new
--    infrastructure needed.
--
-- 5) Transaction numbering: "UMR-260001" = "UMR-" + 2-digit year + 4-digit
--    sequence, reset every year, PER OFFICE (keeps each office's own
--    numbering series independent, matching the multi-tenant isolation
--    principle in section 13 of the spec document).
-- =========================================================

-- ---------------------- Agents (الوكلاء) ----------------------
-- An agent is the office's own client who sends passport/iqama photos +
-- host number via WhatsApp to open Umrah transactions. One agent is
-- identified by a single WhatsApp conversation (private shared-number
-- session OR a linked group) — conversation_key reuses the exact same
-- format as everywhere else ('wn:<id>:<phone>' | 'grp:<jid>').
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  conversation_key TEXT, -- nullable: an admin can pre-create an agent record before first contact
  phone TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agents_customer ON agents(customer_id, is_active);
CREATE INDEX IF NOT EXISTS idx_agents_conversation_key ON agents(conversation_key);

-- ---------------------- Suppliers (الموردون) ----------------------
-- A supplier is who the office forwards a confirmed transaction to, to
-- actually execute the hosting/visa work. Identified the same way as an
-- agent (one WhatsApp conversation — typically a group — per supplier).
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  conversation_key TEXT,
  phone TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suppliers_customer ON suppliers(customer_id, is_active);
CREATE INDEX IF NOT EXISTS idx_suppliers_conversation_key ON suppliers(conversation_key);

-- Default supplier a transaction is forwarded to when the office hasn't
-- picked one explicitly for that agent/conversation (simplest routing rule
-- for phase 1 — can be made per-agent later without a schema change, since
-- `agents` already has room for a future default_supplier_id column).
ALTER TABLE agents ADD COLUMN default_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

-- ---------------------- Per-year transaction numbering ----------------------
CREATE TABLE IF NOT EXISTS transaction_counters (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  year_key TEXT NOT NULL, -- 2-digit year, e.g. '26'
  next_seq INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (customer_id, year_key)
);

-- ---------------------- Transactions (المعاملات) ----------------------
-- One transaction bundles N passport-holders + at most one iqama + one host
-- phone number, all sent by the same agent before being closed/confirmed.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  transaction_code TEXT NOT NULL UNIQUE, -- e.g. UMR-260001
  conversation_key TEXT NOT NULL, -- the agent's conversation this transaction was built from
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  -- Full state machine, see src/lib/transactions.ts for the transition map.
  status TEXT NOT NULL DEFAULT 'NEW',
  host_phone TEXT,
  host_name TEXT,
  notes TEXT,
  needs_review_reason TEXT,
  confirmed_at DATETIME,
  sent_to_supplier_at DATETIME,
  hosting_received_at DATETIME,
  hosting_sent_to_agent_at DATETIME,
  visa_received_at DATETIME,
  visa_sent_to_agent_at DATETIME,
  completed_at DATETIME,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transactions_customer_status ON transactions(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_transactions_conversation ON transactions(conversation_key, status);
CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(supplier_id);

-- ---------------------- People within a transaction ----------------------
-- Each passport-holder (and the single iqama holder, if sent) belonging to
-- a transaction. Reuses the same OCR confidence/review philosophy as the
-- existing passport pipeline (operations table), but as its own table since
-- a transaction holds MULTIPLE people, unlike one `operations` row per
-- image. `operation_id` optionally links back to the original `operations`
-- audit row (image stored in R2, raw extracted_json, etc.) for traceability.
CREATE TABLE IF NOT EXISTS transaction_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
  document_type TEXT NOT NULL DEFAULT 'passport', -- 'passport' | 'iqama'
  full_name_ar TEXT,
  full_name_en TEXT,
  document_number TEXT, -- passport_number (passport) or iqama/ID number (iqama)
  nationality TEXT,
  date_of_birth TEXT,
  date_of_issue TEXT,
  date_of_expiry TEXT,
  place_of_issue TEXT,
  gender TEXT,
  profession TEXT, -- iqama-only field (المهنة)
  sponsor TEXT, -- iqama-only field (الكفيل)
  mrz_raw TEXT,
  confidence REAL,
  image_key TEXT, -- R2 object key, same bucket/convention as `operations.image_key`
  status TEXT NOT NULL DEFAULT 'extracted', -- extracted | needs_review | confirmed
  review_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transaction_people_tx ON transaction_people(transaction_id);

-- ---------------------- Transaction status history (dedicated audit trail) ----------------------
CREATE TABLE IF NOT EXISTS transaction_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by TEXT NOT NULL DEFAULT 'system', -- 'system' | 'agent' | 'supplier' | 'ai' | 'admin:<email>'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_status_log_tx ON transaction_status_log(transaction_id, created_at);

-- ---------------------- Follow-up tasks (replaces Redis+BullMQ) ----------------------
-- Scheduled one-shot reminders tied to a transaction's current stage (e.g.
-- "still waiting on hosting after 60 minutes"). Polled by the VPS bridge
-- process exactly like `umrah_visa_checks`/`message_lists` — see
-- GET /webhook/follow-up/tick. A task is cancelled (status='cancelled')
-- automatically whenever the transaction moves past the stage it was
-- watching, before it ever fires.
CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 'hosting_followup' | 'visa_followup' | 'agent_confirmation_reminder'
  watched_status TEXT NOT NULL, -- the transaction.status this task is only valid while still true
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | cancelled
  due_at DATETIME NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  message_text TEXT NOT NULL,
  target_conversation_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_follow_up_due ON follow_up_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_tx ON follow_up_tasks(transaction_id);

-- ---------------------- Per-office configuration ----------------------
-- Follow-up timers (admin-configurable, minutes) + the master opt-in flag
-- that keeps this entire module invisible/inert for every office until the
-- admin explicitly turns it on for them (zero behavior change for existing
-- customers like مكتب النور, exactly like every other feature toggle so far).
ALTER TABLE customers ADD COLUMN feature_smart_employee_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN followup_confirmation_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE customers ADD COLUMN followup_hosting_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE customers ADD COLUMN followup_visa_minutes INTEGER NOT NULL DEFAULT 120;

-- ---------------------- WhatsApp group role classification ----------------------
-- Distinguishes an "agent" group / "supplier" group from the default
-- generic "bot" group (today's only behavior, fully preserved). Set by the
-- admin from the dashboard after the group is linked via the normal
-- "<اسم المكتب> تفعيل" flow — activation itself is completely unchanged.
ALTER TABLE whatsapp_groups ADD COLUMN group_type TEXT NOT NULL DEFAULT 'bot'; -- 'bot' | 'agent' | 'supplier'
-- When group_type='agent', this optionally pins the group to one specific
-- agent record (so transactions created from it are auto-linked); nullable
-- because an admin may classify the group before creating the agent row,
-- or let the system auto-create the agent on first contact.
ALTER TABLE whatsapp_groups ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_groups ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

-- ---------------------- Generic audit log (admin actions, platform-wide) ----------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL, -- 'admin' | 'customer' | 'system'
  actor_id INTEGER,
  actor_label TEXT, -- email/name snapshot, kept even if the actor is later deleted
  action TEXT NOT NULL, -- e.g. 'transaction.status_change', 'agent.create', 'supplier.delete'
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT, -- JSON blob, free-form per action
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
