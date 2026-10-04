-- Per-agent / per-supplier self-service WhatsApp activation codes (feature
-- requested 2026-10-04): "تحديد الوكيل والمورد للمكتب عن طريق انشاء رمز يتم
-- تفعيل في المجموعه للمورد والوكيل خاص بهم مثل أوامر التفعيل".
--
-- Mirrors the EXISTING office-level activation_code/deactivation_code pattern
-- (migration 0004, customers table) one level deeper: any agent or supplier
-- record may optionally have its own activation_code. Sending that exact
-- code as a plain WhatsApp text message inside ANY group (handled in
-- webhook.ts's /bridge/message text branch) classifies that group AS that
-- agent's/supplier's group in one step -- it does NOT require the group to
-- already be linked to the office first; the agent/supplier record already
-- implies which office/customer_id owns it. A matching deactivation_code
-- unlinks the group back to a plain, unclassified state (group_type='bot',
-- agent_id/supplier_id cleared) the same way the office-level deactivation
-- command works.
ALTER TABLE agents ADD COLUMN activation_code TEXT;
ALTER TABLE agents ADD COLUMN deactivation_code TEXT;
ALTER TABLE suppliers ADD COLUMN activation_code TEXT;
ALTER TABLE suppliers ADD COLUMN deactivation_code TEXT;
