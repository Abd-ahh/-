// Shared "build the WhatsApp reply text for a successful extraction" helper.
// Extracted out of webhook.ts so both the immediate-processing path and the
// queued-batch extraction path (feature 6, "استخراج") can reuse it without
// duplicating the formatting logic or creating a circular import.
import { AVAILABLE_FIELDS, parseExtractionFields } from './fields'

// Restricted to the fields configured for this number (extraction_fields
// JSON column; null/empty = all fields, default). Each value is wrapped in
// ``` (monospace) on its own line so the recipient can long-press just that
// line in WhatsApp and tap "Copy" — WhatsApp has no native "copy button" API
// for business messages, so this is the closest practical equivalent.
export function buildResultMessage(r: any, lang: 'ar' | 'en', extractionFieldsRaw: string | null): string {
  const allowedKeys = parseExtractionFields(extractionFieldsRaw)
  const fieldsToShow = AVAILABLE_FIELDS.filter((f) => allowedKeys.includes(f.key) && r[f.key])

  const header = lang === 'en' ? '✅ Passport data extracted successfully:' : '✅ تم استخراج بيانات الجواز بنجاح:'
  const lines = [header, '']

  for (const f of fieldsToShow) {
    const label = lang === 'en' ? f.label_en : f.label_ar
    lines.push(`${f.emoji} ${label}:`)
    lines.push('```' + r[f.key] + '```')
  }

  return lines.join('\n')
}
