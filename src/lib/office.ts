// Office identification for the shared/multi-tenant WhatsApp number.
//
// Flow: an office's own customer sends a one-time message like:
//   "معالم الرياض 11 تفعيل"   (office name + the Arabic word "تفعيل" = activation)
// The bot extracts the office-name part, matches it against the platform's
// registered customer (office) names, and — if found — links that sender's
// phone number to that office for future messages (see shared_number_sessions).

const ACTIVATION_KEYWORD = 'تفعيل'

// Normalize Arabic text for robust matching: unify alef/ya/ta-marbuta variants,
// strip diacritics/tatweel, collapse whitespace, and lowercase any Latin chars.
export function normalizeArabicText(text: string): string {
  return (text || '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // diacritics + tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// If the message text contains the activation keyword ("تفعيل") as a
// standalone word — either before or after the office name — return the
// office-name portion (trimmed). Otherwise return null (not an activation
// message at all, e.g. it's a passport photo caption or unrelated text).
export function extractOfficeActivationCode(text: string): string | null {
  if (!text) return null
  const raw = text.trim()
  if (!raw) return null

  const normalizedKeyword = normalizeArabicText(ACTIVATION_KEYWORD)
  const words = raw.split(/\s+/)
  if (words.length < 2) return null // need at least "اسم" + "تفعيل"

  const firstWord = normalizeArabicText(words[0])
  const lastWord = normalizeArabicText(words[words.length - 1])

  if (lastWord === normalizedKeyword) {
    return words.slice(0, -1).join(' ').trim() || null
  }
  if (firstWord === normalizedKeyword) {
    return words.slice(1).join(' ').trim() || null
  }
  return null
}

export interface OfficeCandidate {
  id: number
  name: string
}

// Match the extracted office-name text against the platform's customers
// (only candidates on a 'shared' package should be passed in). Tries an
// exact normalized match first, then a loose contains-match as a fallback
// for minor typos/spacing differences.
export function matchOfficeByName(candidates: OfficeCandidate[], officeNameRaw: string): OfficeCandidate | null {
  const target = normalizeArabicText(officeNameRaw)
  if (!target) return null

  let match = candidates.find((c) => normalizeArabicText(c.name) === target)
  if (match) return match

  match = candidates.find((c) => {
    const n = normalizeArabicText(c.name)
    return n.includes(target) || target.includes(n)
  })
  return match || null
}

// ---------------------- Custom activation/deactivation commands ----------------------
// Each office may optionally set its own free-text activation/deactivation
// command (instead of relying on the auto-derived "<name> تفعيل" pattern).
// Matching compares the WHOLE incoming message (normalized) against the
// stored command string.
//
// Word-order-independent by design (bug fix 2026-08-23): a real office had
// its command saved as "حجر تفعيل" but its members naturally typed
// "تفعيل حجر" (activation-word-first, matching the auto-derived pattern's
// convention) — an exact string comparison rejected it silently, and since
// the office ALSO has a custom code, the name-based fallback never even
// runs for it (custom code fully replaces name matching), so activation
// was completely impossible for that phrasing. Comparing the *sorted* word
// list instead of the raw string means either word order matches the same
// stored code, without weakening the check for anything else (a genuinely
// different phrase still won't share the same word multiset).
function normalizeWordsForCompare(text: string): string {
  return normalizeArabicText(text).split(' ').filter(Boolean).sort().join(' ')
}

export interface CustomCommandCandidate {
  id: number
  code: string | null | undefined
}

export function matchByCustomCommand<T extends CustomCommandCandidate>(
  candidates: T[],
  incomingText: string
): T | null {
  const target = normalizeWordsForCompare(incomingText)
  if (!target) return null
  const match = candidates.find((c) => {
    const code = normalizeWordsForCompare(c.code || '')
    return code.length > 0 && code === target
  })
  return match || null
}
