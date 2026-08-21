-- =========================================================
-- WhatsApp Group Bridge support
-- Adds support for an UNOFFICIAL secondary WhatsApp number (run via a
-- separate Node.js "bridge" process on an external VPS using a
-- WhatsApp-Web-protocol library, since Meta's official Cloud API does not
-- allow phone numbers to join or receive messages inside WhatsApp groups).
--
-- Flow:
--   1. The bridge number is manually added to an office's WhatsApp group by
--      a human (a normal WhatsApp group-add action).
--   2. Any member of that group sends "<اسم المكتب> تفعيل" once. The bridge
--      forwards this text message to POST /webhook/bridge/message on this
--      Worker, which matches the office name against active customers and
--      creates a whatsapp_groups row binding that group's JID to the office.
--   3. From then on, any member of that group can send a passport photo;
--      the bridge forwards it the same way, the Worker runs the same Gemini
--      extraction pipeline used for the official Cloud API number, and
--      returns { reply } which the bridge sends back into the group.
-- =========================================================

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid TEXT NOT NULL UNIQUE, -- e.g. "1203630XXXXXXXXXX@g.us"
  group_name TEXT, -- group subject at the time of activation, for admin visibility
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  activated_by_jid TEXT, -- sender_jid who sent the activation message
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_customer ON whatsapp_groups(customer_id);

-- Track operations coming from the group bridge alongside the official
-- Cloud API ones (source column already existed: 'whatsapp' | 'portal_test',
-- now also 'whatsapp_group'). group_jid records which group it came from;
-- sender_phone is repurposed to store the sending member's JID for this source.
ALTER TABLE operations ADD COLUMN group_jid TEXT;

CREATE INDEX IF NOT EXISTS idx_operations_group_jid ON operations(group_jid);
