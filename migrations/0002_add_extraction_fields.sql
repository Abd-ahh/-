-- =========================================================
-- Add per-number extraction_fields configuration
-- Lets each WhatsApp number choose which passport fields the
-- bot should extract & reply with (e.g. name only, or name + passport number).
-- Stored as a JSON array of field keys, e.g. ["full_name_ar","passport_number"].
-- NULL / empty means "all fields" (default behavior, backward compatible).
-- =========================================================

ALTER TABLE whatsapp_numbers ADD COLUMN extraction_fields TEXT;
