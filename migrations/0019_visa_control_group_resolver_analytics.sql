-- Migration 0019 (2026-10-07): batch of admin-requested improvements:
--
-- 1) Visa-check start-delay now configurable per office (was a hardcoded
--    5-minute constant for ALL offices in webhook.ts). Admin can tune this
--    from the per-office settings panel (same place as the visa-check
--    enable/disable toggle already lives).
-- 2) Per-check manual stop: umrah_visa_checks.status already supports
--    'cancelled' (added in 0006) — no schema change needed there, this
--    migration only adds the supporting index for the new admin action.
-- 3) Group-invite-link -> JID resolver: a new job queue, same polling
--    pattern as umrah_visa_checks / render_jobs. The VPS bridge (which
--    already has a live Baileys socket per registered bridge number) polls
--    pending jobs, calls Baileys' groupGetInviteInfo(inviteCode) for each
--    of ITS OWN bridge numbers until one succeeds (meaning that number is
--    already a member of the group), and reports back the resolved JID +
--    group name + which bridge_number_id is actually in it.
-- 4) Message list timezone: schedule_time was always interpreted as fixed
--    UTC+3 (Yemen/Saudi). Adding an explicit column lets each list pick a
--    different fixed UTC offset per office/list (e.g. UAE +4, Egypt +2),
--    defaulting to the old +3 behavior for every existing row.

ALTER TABLE customers ADD COLUMN visa_check_initial_delay_min INTEGER NOT NULL DEFAULT 5;

CREATE INDEX IF NOT EXISTS idx_visa_checks_status ON umrah_visa_checks(status);

-- Group-invite-link resolver job queue (VPS bridge polls this, same pattern
-- as render_jobs). status: pending | resolved | failed.
CREATE TABLE IF NOT EXISTS group_resolve_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL, -- the code portion of https://chat.whatsapp.com/<code>
  status TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | failed
  resolved_jid TEXT, -- filled in on success
  resolved_group_name TEXT,
  resolved_bridge_number_id INTEGER, -- which of our bridge numbers is actually a member
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_group_resolve_jobs_status ON group_resolve_jobs(status);
CREATE INDEX IF NOT EXISTS idx_group_resolve_jobs_customer ON group_resolve_jobs(customer_id);

-- Fixed UTC offset in whole hours, per message list. Kept as a simple
-- integer (same "no timezone DB, fixed offset" approach already documented
-- in messageLists.ts for Yemen/Saudi) rather than an IANA tz name, since
-- Cloudflare Workers' Date math here never needs DST handling for this
-- platform's customer base (Gulf + Yemen countries are all fixed-offset,
-- DST-free). Default 3 preserves the exact previous behavior for every
-- existing row (Yemen/Saudi, UTC+3).
ALTER TABLE message_lists ADD COLUMN timezone_offset_hours INTEGER NOT NULL DEFAULT 3;
