-- Custom per-office activation/deactivation commands for the shared WhatsApp number.
-- If set, these fully replace the auto-derived "<office name> تفعيل" pattern for that office.
ALTER TABLE customers ADD COLUMN activation_code TEXT;
ALTER TABLE customers ADD COLUMN deactivation_code TEXT;
