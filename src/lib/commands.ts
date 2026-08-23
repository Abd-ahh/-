// Plain-text WhatsApp command detection for an already-linked/activated
// conversation (private dedicated number, shared-number session, or a
// linked group). Kept separate from office.ts (which only deals with
// activation/deactivation matching) to stay extensible: new command types
// can be added here without touching the office-matching logic.
import { normalizeArabicText } from './office'

export type ToggleableFeature = 'cumulative_list' | 'visa_check' | 'auto_extract'

export type ParsedCommand =
  | { type: 'check_now' }
  | { type: 'list' }
  | { type: 'extract_now' }
  | { type: 'report'; period: 'daily' | 'monthly' | 'yearly'; format: 'text' | 'pdf' }
  | { type: 'suggestion'; text: string }
  | { type: 'toggle_feature'; feature: ToggleableFeature; enabled: boolean }
  | null

const CHECK_NOW_PHRASES = ['فحص التاشيره', 'فحص التأشيرة', 'فحص الفيزا', 'تحقق من التاشيره', 'تحقق التاشيره']
const LIST_PHRASES = ['القائمه', 'القائمة', 'قائمه الاسماء', 'قائمة الأسماء']
// "استخراج" processes every queued/pending image for this conversation in
// one batch, right now (feature 6 — Auto-Extract toggle). Only meaningful
// when feature_auto_extract_enabled=0 (images are queued instead of
// processed on receipt), but works regardless — if nothing is queued it
// just replies with a "nothing pending" message.
const EXTRACT_NOW_PHRASES = ['استخراج', 'استخراج الان', 'استخراج الآن']

// Fixed (non-customizable) per-feature enable/disable commands. Unlike the
// office-level activation/deactivation codes (office.ts), these are the
// same for every office on purpose — they toggle a specific platform
// feature ON/OFF for an office that is already activated in general.
const ENABLE_LIST_PHRASES = ['تفعيل القائمة', 'تفعيل القائمه']
const DISABLE_LIST_PHRASES = ['الغاء القائمة', 'إلغاء القائمة', 'الغاء القائمه', 'إلغاء القائمه']
// "فحص دوري" / "إلغاء الفحص الدوري" are synonyms added later for the same
// toggle (periodic auto-check every VISA_CHECK_RETRY_INTERVAL_MIN minutes) —
// kept alongside the original "تفعيل/الغاء فحص التاشيره" phrasing so offices
// already using the old commands (e.g. مكتب النور) are unaffected.
const ENABLE_VISACHECK_PHRASES = ['تفعيل فحص التاشيره', 'تفعيل فحص التأشيرة', 'فحص دوري']
const DISABLE_VISACHECK_PHRASES = ['الغاء فحص التاشيره', 'إلغاء فحص التاشيره', 'الغاء فحص التأشيرة', 'إلغاء فحص التأشيرة', 'الغاء الفحص الدوري', 'إلغاء الفحص الدوري']
// Feature 6: Auto-Extract toggle. Default DISABLED for all offices (see
// migration 0009) — while disabled, incoming images are queued instead of
// processed immediately; "تفعيل الاستخراج التلقائي" restores the original
// immediate-processing behavior.
const ENABLE_AUTOEXTRACT_PHRASES = ['تفعيل الاستخراج التلقائي', 'تفعيل الاستخراج الالي', 'تفعيل الاستخراج الآلي']
const DISABLE_AUTOEXTRACT_PHRASES = ['الغاء الاستخراج التلقائي', 'إلغاء الاستخراج التلقائي', 'الغاء الاستخراج الالي', 'إلغاء الاستخراج الآلي']

export function parseCommand(rawText: string): ParsedCommand {
  const text = (rawText || '').trim()
  if (!text) return null
  const normalized = normalizeArabicText(text)

  // Feature toggle commands are checked first (exact match) since they are
  // fixed phrases that must not be shadowed by the more generic checks below.
  if (ENABLE_LIST_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'cumulative_list', enabled: true }
  }
  if (DISABLE_LIST_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'cumulative_list', enabled: false }
  }
  if (ENABLE_VISACHECK_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'visa_check', enabled: true }
  }
  if (DISABLE_VISACHECK_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'visa_check', enabled: false }
  }
  if (ENABLE_AUTOEXTRACT_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'auto_extract', enabled: true }
  }
  if (DISABLE_AUTOEXTRACT_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'toggle_feature', feature: 'auto_extract', enabled: false }
  }

  if (CHECK_NOW_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'check_now' }
  }

  if (LIST_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'list' }
  }

  if (EXTRACT_NOW_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'extract_now' }
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
