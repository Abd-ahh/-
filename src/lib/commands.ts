// Plain-text WhatsApp command detection for an already-linked/activated
// conversation (private dedicated number, shared-number session, or a
// linked group). Kept separate from office.ts (which only deals with
// activation/deactivation matching) to stay extensible: new command types
// can be added here without touching the office-matching logic.
import { normalizeArabicText } from './office'

export type ParsedCommand =
  | { type: 'check_now' }
  | { type: 'list' }
  | { type: 'report'; period: 'daily' | 'monthly' | 'yearly'; format: 'text' | 'pdf' }
  | { type: 'suggestion'; text: string }
  | null

const CHECK_NOW_PHRASES = ['فحص التاشيره', 'فحص التأشيرة', 'فحص الفيزا', 'تحقق من التاشيره', 'تحقق التاشيره']
const LIST_PHRASES = ['القائمه', 'القائمة', 'قائمه الاسماء', 'قائمة الأسماء']

export function parseCommand(rawText: string): ParsedCommand {
  const text = (rawText || '').trim()
  if (!text) return null
  const normalized = normalizeArabicText(text)

  if (CHECK_NOW_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'check_now' }
  }

  if (LIST_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'list' }
  }

  // "تقرير يومي" | "تقرير شهري" | "تقرير سنوي" (+ optional "pdf"/"مستند" suffix)
  if (normalized.startsWith(normalizeArabicText('تقرير'))) {
    const isPdf = normalized.includes(normalizeArabicText('pdf')) || normalized.includes(normalizeArabicText('مستند'))
    let period: 'daily' | 'monthly' | 'yearly' | null = null
    if (normalized.includes(normalizeArabicText('يومي'))) period = 'daily'
    else if (normalized.includes(normalizeArabicText('شهري'))) period = 'monthly'
    else if (normalized.includes(normalizeArabicText('سنوي'))) period = 'yearly'
    if (period) return { type: 'report', period, format: isPdf ? 'pdf' : 'text' }
  }

  // "اقتراح: <text>" or "اقتراح <text>"
  const suggestionPrefix = normalizeArabicText('اقتراح')
  if (normalized.startsWith(suggestionPrefix)) {
    const rest = text.replace(/^\s*اقتراح\s*[:\-]?\s*/i, '').trim()
    if (rest) return { type: 'suggestion', text: rest }
  }

  return null
}

// Conversation identity used consistently to key cumulative lists, visa
// checks, and reports across the three delivery channels.
export function buildConversationKey(
  params: { whatsapp_number_id: number; sender_phone: string } | { group_jid: string }
): string {
  if ('group_jid' in params) return `grp:${params.group_jid}`
  return `wn:${params.whatsapp_number_id}:${params.sender_phone}`
}

export function parseConversationKey(key: string): { channel: 'group'; group_jid: string } | { channel: 'number'; whatsapp_number_id: number; sender_phone: string } | null {
  if (key.startsWith('grp:')) return { channel: 'group', group_jid: key.slice(4) }
  if (key.startsWith('wn:')) {
    const rest = key.slice(3)
    const idx = rest.indexOf(':')
    if (idx === -1) return null
    return { channel: 'number', whatsapp_number_id: parseInt(rest.slice(0, idx), 10), sender_phone: rest.slice(idx + 1) }
  }
  return null
}
