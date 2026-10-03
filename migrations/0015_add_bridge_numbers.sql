-- =========================================================
-- Multi-number support for the WhatsApp Group Bridge (Baileys).
--
-- Until now the bridge supported exactly ONE personal WhatsApp number
-- (configured once via the bridge process's PAIR_PHONE env var, see
-- bridge/bridge.js), shared across every office's group. This migration
-- lets the admin register and manage MULTIPLE bridge numbers from the
-- dashboard instead of editing VPS env vars/redeploying — each registered
-- number still needs its OWN running `bridge.js` process (one Node
-- process = one live Baileys socket = one WhatsApp number), but the admin
-- can now track pairing status, label each number, and assign/reassign
-- which bridge number a given office's group is reachable through, all
-- from the admin panel.
--
-- A single VPS can run several bridge.js processes side-by-side (each with
-- its own BRIDGE_NUMBER_ID + auth_state/<id> folder + PM2 app name) — see
-- bridge/ecosystem.config.cjs and the updated README section for the
-- multi-instance PM2 setup.
-- =========================================================

CREATE TABLE IF NOT EXISTS bridge_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Admin-facing label only (e.g. "الرقم الرئيسي", "رقم مكاتب صنعاء") —
  -- purely descriptive, has no effect on routing.
  label TEXT NOT NULL,
  -- Digits-only phone number with country code (e.g. 9665XXXXXXXX), used
  -- for the pairing-code flow and admin display. Nullable until the admin
  -- fills it in (pairing can also be done via QR without ever typing it,
  -- though the pairing-code flow is preferred — see bridge.js).
  phone_number TEXT,
  -- Status is informational, self-reported by the bridge process itself
  -- via POST /webhook/bridge/numbers/:id/status (added alongside this
  -- migration) whenever its connection.update fires — the Worker has no
  -- way to directly observe a VPS process's live socket state.
  --   pending      -> registered in the dashboard, no bridge.js process
  --                   has reported in yet (default on creation)
  --   connecting   -> a bridge.js process started up using this id and is
  --                   mid-handshake (QR/pairing-code shown, or reconnecting)
  --   connected    -> actively connected to WhatsApp right now
  --   disconnected -> was connected before but the process/socket dropped
  status TEXT NOT NULL DEFAULT 'pending',
  -- Free-text, e.g. a disconnect reason or last error, for admin visibility.
  status_detail TEXT,
  is_active INTEGER NOT NULL DEFAULT 1, -- soft on/off switch, independent of status
  last_seen_at DATETIME, -- updated on every status self-report from the bridge process
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A single implicit default row so every EXISTING linked group (which has
-- no bridge_number_id yet) keeps working unchanged against whichever one
-- VPS process the admin already has running — this row represents that
-- pre-existing, already-paired number. The admin can rename/relabel it
-- freely; its id=1 is only used as the default below, not hardcoded in app code.
INSERT INTO bridge_numbers (id, label, status, status_detail)
  VALUES (1, 'الرقم الافتراضي (الأصلي)', 'pending', 'تمت الترقية التلقائية لدعم تعدد الأرقام — راجع حالة الاتصال الفعلية من سجلات VPS');

-- Which bridge number a linked group is reachable through. Defaults to the
-- pre-existing number (id=1) above so this migration is a no-op for every
-- group linked before multi-number support existed.
--
-- NOTE: no inline REFERENCES/FK clause here — SQLite's ALTER TABLE ADD
-- COLUMN explicitly disallows a non-NULL DEFAULT combined with a column-level
-- REFERENCES constraint ("Cannot add a REFERENCES column with non-NULL
-- default value"). The relationship to bridge_numbers(id) is enforced at
-- the application layer only (same pattern already used elsewhere in this
-- schema for less-critical FKs), not by SQLite itself.
ALTER TABLE whatsapp_groups ADD COLUMN bridge_number_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_bridge_number ON whatsapp_groups(bridge_number_id);

-- group_outbox needs the same routing info: when the Worker queues an
-- async delivery (visa PDF, broadcast list item, etc.) for a group/number
-- JID, it must know which bridge.js process's poller should pick it up —
-- each process only polls for items tagged with its OWN bridge_number_id
-- (see updated GET /webhook/bridge/outbox?bridge_number_id=... below).
ALTER TABLE group_outbox ADD COLUMN bridge_number_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_group_outbox_bridge_number ON group_outbox(bridge_number_id, status);

-- Message Lists (migration 0010) individual-number contacts (channel='number')
-- are not linked to any whatsapp_groups row, so there is no other way to
-- infer which bridge number should deliver them — the admin picks it
-- explicitly per contact (defaults to the pre-existing number, id=1, so
-- every contact created before multi-number support keeps working as-is).
-- Group-channel contacts (channel='group') ignore this column; their
-- actual group's whatsapp_groups.bridge_number_id is used instead (see
-- fireMessageList in src/lib/messageLists.ts), kept in sync automatically.
ALTER TABLE message_contacts ADD COLUMN bridge_number_id INTEGER NOT NULL DEFAULT 1;
