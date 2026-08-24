-- Adds columns needed to deliver a richer visa-ready message matching the
-- office's desired template (name / passport / visa type / valid-from date),
-- instead of the previous simple caption. full_name is captured at scheduling
-- time (already available from the passport extraction); visa_type and
-- valid_from are populated later by the VPS checker after it scrapes the
-- MOFA result page's structured fields (see checker.js scrapeVisaFields()).
ALTER TABLE umrah_visa_checks ADD COLUMN full_name TEXT;
ALTER TABLE umrah_visa_checks ADD COLUMN visa_type TEXT;
ALTER TABLE umrah_visa_checks ADD COLUMN valid_from TEXT;
