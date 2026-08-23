-- Per-feature activation/deactivation via WhatsApp text commands.
-- Office-level activation (activation_code/deactivation_code, migration 0004)
-- turns the bot ON for the office in general. These two flags gate the
-- Cumulative List (Feature 2) and Umrah Visa Auto-Check (Feature 4)
-- individually, ON TOP of that — the office must additionally send a
-- fixed command to enable each one.
--
-- Default is DISABLED (0) for ALL customers, both new and existing/
-- production ones. This is an intentional behavior change: any office
-- that was previously relying on Feature 2 and/or Feature 4 running
-- automatically after office activation (e.g. مكتب النور's Umrah visa
-- auto-check) must send the matching activation command again to resume.
ALTER TABLE customers ADD COLUMN feature_cumulative_list_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN feature_visa_check_enabled INTEGER NOT NULL DEFAULT 0;
