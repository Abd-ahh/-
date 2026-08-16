// Shared definition of extractable passport fields.
// A WhatsApp number can be configured to extract/reply with only a subset
// of these fields (e.g. "name only"), instead of always returning everything.

export interface FieldDef {
  key: string
  label_ar: string
  label_en: string
  emoji: string
}

export const AVAILABLE_FIELDS: FieldDef[] = [
  { key: 'full_name_ar', label_ar: 'الاسم بالعربي', label_en: 'Name (Arabic)', emoji: '👤' },
  { key: 'full_name_en', label_ar: 'الاسم بالإنجليزي', label_en: 'Name (English)', emoji: '👤' },
  { key: 'passport_number', label_ar: 'رقم الجواز', label_en: 'Passport No.', emoji: '🛂' },
  { key: 'nationality', label_ar: 'الجنسية', label_en: 'Nationality', emoji: '🌍' },
  { key: 'date_of_birth', label_ar: 'تاريخ الميلاد', label_en: 'Date of Birth', emoji: '🎂' },
  { key: 'date_of_expiry', label_ar: 'تاريخ الانتهاء', label_en: 'Expiry Date', emoji: '📅' },
  { key: 'gender', label_ar: 'الجنس', label_en: 'Gender', emoji: '⚧' }
]

export const ALL_FIELD_KEYS = AVAILABLE_FIELDS.map((f) => f.key)

// Parses the `extraction_fields` JSON column (nullable) into a clean list of
// valid field keys. Empty/invalid/missing -> returns ALL fields (default behavior).
export function parseExtractionFields(raw: string | null | undefined): string[] {
  if (!raw) return ALL_FIELD_KEYS
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || arr.length === 0) return ALL_FIELD_KEYS
    const valid = arr.filter((k) => ALL_FIELD_KEYS.includes(k))
    return valid.length > 0 ? valid : ALL_FIELD_KEYS
  } catch {
    return ALL_FIELD_KEYS
  }
}

// Validates and normalizes an array of field keys coming from a request body
// into a JSON string ready to store in the DB. Returns null (= "all fields")
// when the input is empty/invalid so we keep the DB column meaning consistent.
export function normalizeExtractionFields(input: unknown): string | null {
  if (!Array.isArray(input)) return null
  const valid = input.filter((k) => typeof k === 'string' && ALL_FIELD_KEYS.includes(k))
  if (valid.length === 0 || valid.length === ALL_FIELD_KEYS.length) return null
  return JSON.stringify(valid)
}
