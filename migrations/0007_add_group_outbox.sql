-- =========================================================
-- Group outbox: asynchronous message delivery to WhatsApp groups.
--
-- The official Cloud API cannot push a message into a group; only the
-- Baileys bridge (a live socket connection) can. But the bridge process
-- only sends a reply in direct response to an inbound message it just
-- relayed to the Worker — there is no channel for the Worker to push a
-- message into a group asynchronously (e.g. "the Umrah visa PDF is ready"
-- 3+ hours after the passport photo was sent, with no new inbound message
-- to piggyback a reply on).
--
-- This table is the fix: whenever the Worker needs to deliver a text or
-- document to a *group* conversation asynchronously (visa PDF ready, PDF
-- report ready, etc.), it inserts a row here instead of calling Meta's
-- Graph API (which doesn't work for groups anyway). The bridge process
-- polls GET /webhook/bridge/outbox periodically and relays + acks each
-- item via POST /webhook/bridge/outbox/:id/ack.
--
-- For non-group (private/shared number) conversations, no queue is
-- needed — the Worker calls Meta's Graph API directly and delivery is
-- synchronous, so this table is only ever used for grp: conversation keys.
-- =========================================================
CREATE TABLE IF NOT EXISTS group_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text', -- text | document
  text TEXT, -- used when kind='text', or as a document caption when kind='document'
  document_base64 TEXT, -- used when kind='document'
  document_mime_type TEXT,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_group_outbox_status ON group_outbox(status);
CREATE INDEX IF NOT EXISTS idx_group_outbox_group ON group_outbox(group_jid);
