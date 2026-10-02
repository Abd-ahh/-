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
  | { type: 'help' }
  | null

// ---------------------- Smart Employee (الموظف الذكي) ----------------------
// Natural-language intent detection for closing/confirming a pending Umrah
// transaction (spec document section 5). Kept deliberately separate from
// parseCommand() above since these phrases are only meaningful inside an
// "agent"-type conversation with an open transaction — callers in
// webhook.ts check that context before calling this.
export type TransactionIntent = 'confirm' | 'reject' | null

// Explicit "close the transaction now" phrases — any of these immediately
// confirms+forwards the transaction to the supplier, without waiting for
// the "هل نرفع المعاملة؟" prompt. Includes both singular ("ارفع") and
// plural/"team" imperative forms ("ارفعوا") — real-world field observation
// (2026-10-02) showed staff commonly address the group in plural form.
// NOTE: real offices also close via a WhatsApp STICKER rather than typed
// text at all, and some use entirely custom wording — both of those are
// handled separately (see migration 0014: customers.se_close_phrases /
// se_accept_sticker_as_close), this list is only the code-level default
// that applies to every office regardless of their own settings.
const TRANSACTION_CLOSE_PHRASES = [
  'ارفع', 'ارفعها', 'ارفعوا', 'ارفعوها',
  'رحل', 'رحلها', 'رحلوا', 'رحلوها',
  'حول', 'حولها', 'حولوا', 'حولوها',
  'ارسلها', 'ارسلوها', 'جهزها', 'جهزوها',
  'خلاص ارفعها', 'خلص ارفعها', 'خلاص ارفعوها', 'خلص ارفعوها'
]
// Plain yes/no, only meaningful as a REPLY to the bot's own "هل نرفع
// المعاملة؟" confirmation prompt for a transaction already in
// WAITING_AGENT_CONFIRMATION — see detectTransactionIntent's `onlyAsReply` param.
const CONFIRM_REPLY_PHRASES = ['نعم', 'ايوه', 'ايوة', 'اه', 'تمام', 'صح']
const REJECT_REPLY_PHRASES = ['لا', 'لأ', 'لا تنشرها', 'توقف', 'الغاء']

// Splits an admin-entered free-text settings field (customers.se_close_phrases)
// into individual phrases. Accepts commas, Arabic commas, and/or newlines as
// separators so the admin UI textarea can be as forgiving as possible.
export function parseCustomPhraseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(/[,\u060C\n\r]+/).map((p) => p.trim()).filter((p) => p.length > 0)
}

// `awaitingConfirmation` = true when the transaction is currently in
// WAITING_AGENT_CONFIRMATION (the bot already asked "هل نرفع المعاملة؟").
// In that state a bare "نعم"/"لا" is unambiguous. Outside that state, only
// the explicit close phrases ("ارفع"، "رحّل"...) count — a stray "نعم" in
// normal chat must NOT be misread as a transaction confirmation.
// `extraClosePhrases`: office-specific additional close phrases from
// customers.se_close_phrases (migration 0014), layered ON TOP OF the
// built-in defaults above — never replacing them, so every office keeps
// the baseline words working even if they also configure their own.
export function detectTransactionIntent(
  rawText: string,
  awaitingConfirmation: boolean,
  extraClosePhrases: string[] = []
): TransactionIntent {
  const text = (rawText || '').trim()
  if (!text) return null
  const normalized = normalizeArabicText(text)

  if (TRANSACTION_CLOSE_PHRASES.some((p) => normalizeArabicText(p) === normalized)) return 'confirm'
  if (extraClosePhrases.some((p) => normalizeArabicText(p) === normalized)) return 'confirm'

  if (awaitingConfirmation) {
    if (CONFIRM_REPLY_PHRASES.some((p) => normalizeArabicText(p) === normalized)) return 'confirm'
    if (REJECT_REPLY_PHRASES.some((p) => normalizeArabicText(p) === normalized)) return 'reject'
  }

  return null
}

// Extracts a plausible host phone number from free text (spec: "رقم
// المضيف" sent as a normal text message alongside the passport/iqama
// photos). Accepts digits with optional +/spaces/dashes, 8-15 digits long
// after stripping — broad enough for Saudi/Yemeni/Gulf numbers without
// hardcoding one specific country format.
export function extractHostPhone(rawText: string): string | null {
  if (!rawText) return null
  const match = rawText.match(/(\+?\d[\d\s\-]{7,17}\d)/)
  if (!match) return null
  const digits = match[1].replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  return digits
}

// Transaction code pattern used by suppliers to reference which
// transaction their reply (hosting ready / visa ready) is about, e.g.
// "استضافة جاهزة UMR-260001". Matches the format generated in
// transactions.ts (generateTransactionCode).
const TRANSACTION_CODE_RE = /UMR-\d{6,}/i

export function extractTransactionCode(rawText: string): string | null {
  if (!rawText) return null
  const match = rawText.match(TRANSACTION_CODE_RE)
  return match ? match[0].toUpperCase() : null
}

export type SupplierReplyIntent = 'hosting_ready' | 'visa_ready' | null

const HOSTING_READY_PHRASES = ['استضافة جاهزة', 'الاستضافة جاهزة', 'تم الاستضافة', 'تمت الاستضافة']
const VISA_READY_PHRASES = ['التاشيره جاهزه', 'التأشيرة جاهزة', 'الفيزا جاهزة', 'تم اصدار التاشيره', 'تمت التاشيره']

// Detects a supplier's status-update intent from free text (used alongside
// extractTransactionCode so the reply can be matched to the right
// transaction even when the supplier group handles many at once).
export function detectSupplierReplyIntent(rawText: string): SupplierReplyIntent {
  if (!rawText) return null
  const normalized = normalizeArabicText(rawText)
  if (HOSTING_READY_PHRASES.some((p) => normalized.includes(normalizeArabicText(p)))) return 'hosting_ready'
  if (VISA_READY_PHRASES.some((p) => normalized.includes(normalizeArabicText(p)))) return 'visa_ready'
  return null
}

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

// "بوت" — a help command that replies with a welcome message plus the full
// list of every feature's enable/disable commands (by user request). Works
// identically on both channels (shared/private number + group bridge).
const HELP_PHRASES = ['بوت']

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

  if (HELP_PHRASES.some((p) => normalizeArabicText(p) === normalized)) {
    return { type: 'help' }
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
