export type Bindings = {
  DB: D1Database
  // Optional: not every environment has R2 configured (requires a Cloudflare
  // API token with R2 permissions). Code must guard before using it.
  PASSPORTS_BUCKET?: R2Bucket
  GEMINI_API_KEY?: string
  JWT_SECRET?: string
  WHATSAPP_VERIFY_TOKEN?: string
  WHATSAPP_API_VERSION?: string
  // Shared secret used to authenticate requests coming from the external
  // WhatsApp-group bridge process (Baileys, running on a separate VPS since
  // Meta's official Cloud API cannot join/receive messages from groups).
  // The bridge sends it in the X-Bridge-Secret header on every request.
  BRIDGE_SECRET?: string
  // Shared secret for the Umrah-visa periodic checker process (Playwright +
  // Gemini Vision, running on the same VPS as the group bridge). It polls
  // GET /webhook/visa-checks/pending and posts results to
  // POST /webhook/visa-checks/:id/result. Separate secret from BRIDGE_SECRET
  // so either integration can be rotated independently.
  VISA_CHECKER_SECRET?: string
}

export type Variables = {
  admin?: { id: number; email: string; name: string }
  customer?: { id: number; email: string; name: string }
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }

export interface PackageRow {
  id: number
  name_ar: string
  name_en: string
  max_numbers: number
  monthly_operations: number
  price: number
  currency: string
  is_active: number
  sort_order: number
  number_mode: 'private' | 'shared'
  created_at: string
}

export interface CustomerRow {
  id: number
  name: string
  email: string
  phone: string | null
  status: string
  reply_language: string
  welcome_message: string | null
  // Custom commands for the shared platform number. When set, they fully
  // replace the auto-derived "<office name> تفعيل" matching for this office.
  activation_code: string | null
  deactivation_code: string | null
  // Cumulative running list of extracted fields per conversation (feature 2).
  cumulative_list_fields: string | null // JSON array of field keys, null = default [full_name_ar, passport_number]
  cumulative_list_reset_hours: number
  // ---------------------- Smart Employee (الموظف الذكي, migration 0013) ----------------------
  // Master opt-in: everything in transactions.ts/agents/suppliers stays
  // completely inert for an office until the admin explicitly enables it.
  feature_smart_employee_enabled: number
  followup_confirmation_minutes: number
  followup_hosting_minutes: number
  followup_visa_minutes: number
  // Admin-configurable close triggers (migration 0014) — real-world field
  // observation showed office staff close transactions with a WhatsApp
  // STICKER and/or office-specific phrases, not a fixed code-level list.
  // se_close_phrases: newline/comma-separated extra phrases (on top of the
  // built-in defaults in commands.ts), null/empty = defaults only.
  se_close_phrases: string | null
  // se_accept_sticker_as_close: any sticker sent in an agent group counts
  // as an explicit close signal for the open transaction. Default 0 (off)
  // so no office's behavior changes until an admin opts in.
  se_accept_sticker_as_close: number
  created_at: string
}

// ---------------------- Cumulative running list (per conversation) ----------------------
export interface CumulativeListRow {
  id: number
  customer_id: number
  conversation_key: string // 'wn:<whatsapp_number_id>:<sender_phone>' | 'grp:<group_jid>'
  items_json: string // JSON array of { [fieldKey]: value } snapshots, oldest first
  started_at: string
  updated_at: string
}

// ---------------------- Suggestion box ----------------------
export interface SuggestionRow {
  id: number
  customer_id: number | null
  type: string // 'feature_suggestion' by default; kept generic for future office-submitted content types
  message: string
  conversation_key: string | null
  status: 'new' | 'reviewed' | 'done'
  created_at: string
}

// ---------------------- Umrah visa periodic check ----------------------
export interface UmrahVisaCheckRow {
  id: number
  operation_id: number | null
  customer_id: number
  conversation_key: string
  passport_number: string
  first_name: string
  nationality: string | null
  status: 'pending' | 'checking' | 'found' | 'failed' | 'cancelled'
  check_count: number
  next_check_at: string
  last_checked_at: string | null
  last_error: string | null
  found_at: string | null
  pdf_r2_key: string | null
  created_at: string
  updated_at: string
}

export interface SubscriptionRow {
  id: number
  customer_id: number
  package_id: number
  start_date: string
  end_date: string
  status: string
  operations_limit: number
  operations_used: number
  price_paid: number
  created_at: string
}

export interface WhatsAppNumberRow {
  id: number
  customer_id: number | null // null = platform-owned shared number (is_shared = 1)
  is_shared: number // 1 = this is the platform's single shared WhatsApp number
  display_name: string
  phone_number: string
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  status: string
  extraction_fields: string | null // JSON array of field keys, null = all fields
  created_at: string
}

// Binds an end-user's WhatsApp number (talking to the shared platform number)
// to a specific office/customer, after they send "<office name> تفعيل" once.
// Expires 30 days after the last interaction (renewed on each message).
// Binds an unofficial WhatsApp group (via the Baileys bridge) to a specific
// office/customer, after a member sends "<office name> تفعيل" once inside it.
export interface WhatsAppGroupRow {
  id: number
  group_jid: string
  group_name: string | null
  customer_id: number
  activated_by_jid: string | null
  // Smart Employee (migration 0013): classifies a linked group's role.
  // 'bot' (default) = today's only behavior, fully unchanged (generic
  // passport-extraction group). 'agent' = this group is where an agent
  // sends passport/iqama photos + host number to build transactions.
  // 'supplier' = transactions are forwarded here for hosting/visa execution.
  group_type: 'bot' | 'agent' | 'supplier'
  agent_id: number | null
  supplier_id: number | null
  created_at: string
  updated_at: string
}

export interface SharedNumberSessionRow {
  id: number
  whatsapp_number_id: number
  sender_phone: string
  customer_id: number
  expires_at: string
  created_at: string
  updated_at: string
}

export interface OperationRow {
  id: number
  whatsapp_number_id: number | null
  customer_id: number | null
  sender_phone: string | null
  message_id: string | null
  image_key: string | null
  status: string
  full_name_ar: string | null
  full_name_en: string | null
  passport_number: string | null
  nationality: string | null
  date_of_birth: string | null
  date_of_expiry: string | null
  gender: string | null
  extracted_json: string | null
  error_message: string | null
  processing_time_ms: number | null
  source: string
  created_at: string
}

export interface RenderJobRow {
  id: number
  customer_id: number
  conversation_key: string
  job_type: string
  html: string
  filename: string
  status: 'pending' | 'done' | 'failed'
  error: string | null
  created_at: string
  updated_at: string
}

export interface PassportExtractionResult {
  is_passport: boolean
  is_clear: boolean
  clarity_reason?: string
  full_name_ar?: string
  full_name_en?: string
  passport_number?: string
  nationality?: string
  date_of_birth?: string
  date_of_expiry?: string
  gender?: string
  confidence?: number
}

// ---------------------- Knowledge Base (قاعدة المعرفة, migration 0011) ----------------------
export interface StaffNumberRow {
  id: number
  customer_id: number
  identifier: string // phone digits or WhatsApp JID
  label: string | null
  created_at: string
}

export type SenderRole = 'staff' | 'customer' | 'bot' | 'unknown'

export interface ConversationMessageRow {
  id: number
  customer_id: number
  conversation_key: string
  direction: 'in' | 'out'
  sender_role: SenderRole
  sender_identifier: string | null
  text: string
  analyzed_at: string | null
  created_at: string
}

export type KnowledgeConfidence = 'high' | 'medium' | 'low' | 'unknown'
export type KnowledgeStatus = 'pending_review' | 'approved' | 'rejected'

export interface KnowledgeBaseRow {
  id: number
  customer_id: number
  category: string
  question_intent: string | null
  knowledge: string
  suggested_answer: string | null
  source: string | null
  confidence: KnowledgeConfidence
  is_conflicting: number
  needs_review: number
  status: KnowledgeStatus
  extracted_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
}

// Shape returned by Gemini for each extracted knowledge item (see
// knowledgeBase.ts buildAnalysisPrompt / parseAnalysisResponse).
export interface KnowledgeExtractionItem {
  category: string
  question_intent: string
  knowledge: string
  suggested_answer: string | null
  source: string
  confidence: KnowledgeConfidence
  is_conflicting: boolean
  needs_review: boolean
}

// ---------------------- Message Lists (قوائم رسائل, migration 0010) ----------------------
// Scheduled WhatsApp marketing/broadcast lists. Delivery goes exclusively
// through the unofficial Baileys bridge's group_outbox queue (see
// src/lib/deliver.ts and src/lib/messageLists.ts) — never the official
// Cloud API, which requires pre-approved templates for this kind of
// unsolicited outbound message.
export interface MessageContactRow {
  id: number
  customer_id: number
  name: string
  channel: 'number' | 'group'
  value: string // channel='number': digits with country code; channel='group': raw group JID
  region: string | null
  created_at: string
}

export interface MessageListRow {
  id: number
  customer_id: number
  name: string
  message_type: string | null
  message_text: string
  schedule_time: string // 'HH:MM', Riyadh-local (UTC+3)
  recurrence: 'daily' | 'weekly' | 'monthly'
  schedule_days: string | null // JSON array — weekday numbers (weekly) or day-of-month numbers (monthly)
  target_region: string | null
  is_active: number
  last_run_date: string | null // 'YYYY-MM-DD' Riyadh-local, last date this list fired
  created_at: string
  updated_at: string
}

export interface MessageListRunRow {
  id: number
  list_id: number
  run_at: string
  total_recipients: number
  sent_count: number
  failed_count: number
  status: 'running' | 'done'
}

export interface MessageListSendLogRow {
  id: number
  run_id: number
  list_id: number
  contact_id: number | null
  name_snapshot: string
  jid_snapshot: string
  status: 'queued' | 'sent' | 'failed'
  error: string | null
  created_at: string
  updated_at: string
}

// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — Umrah transactions
// module: agents, suppliers, transactions, transaction people, follow-up
// tasks and the generic audit log. See migrations/0013_add_smart_employee_core.sql
// for full design rationale.
// =========================================================================

export interface AgentRow {
  id: number
  customer_id: number
  name: string
  conversation_key: string | null
  phone: string | null
  notes: string | null
  default_supplier_id: number | null
  is_active: number
  created_at: string
  updated_at: string
}

export interface SupplierRow {
  id: number
  customer_id: number
  name: string
  conversation_key: string | null
  phone: string | null
  notes: string | null
  is_active: number
  created_at: string
  updated_at: string
}

// Full transaction lifecycle state machine (spec document section 7).
// See src/lib/transactions.ts for the allowed transition map and the
// natural-language command -> transition mapping.
export type TransactionStatus =
  | 'NEW'
  | 'RECEIVED_FROM_AGENT'
  | 'WAITING_AGENT_CONFIRMATION'
  | 'SENT_TO_SUPPLIER'
  | 'WAITING_HOSTING'
  | 'HOSTING_RECEIVED'
  | 'HOSTING_SENT_TO_AGENT'
  | 'VISA_WAITING'
  | 'VISA_RECEIVED'
  | 'VISA_SENT_TO_AGENT'
  | 'COMPLETED'
  | 'NEEDS_REVIEW'
  | 'MISSING_DOCUMENT'
  | 'WRONG_PERSON'
  | 'DUPLICATE_DOCUMENT'
  | 'FAILED_TRANSFER'
  | 'CANCELLED'

export interface TransactionRow {
  id: number
  customer_id: number
  transaction_code: string // e.g. UMR-260001
  conversation_key: string
  agent_id: number | null
  supplier_id: number | null
  status: TransactionStatus
  host_phone: string | null
  host_name: string | null
  notes: string | null
  needs_review_reason: string | null
  confirmed_at: string | null
  sent_to_supplier_at: string | null
  hosting_received_at: string | null
  hosting_sent_to_agent_at: string | null
  visa_received_at: string | null
  visa_sent_to_agent_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type TransactionPersonDocType = 'passport' | 'iqama'
export type TransactionPersonStatus = 'extracted' | 'needs_review' | 'confirmed'

export interface TransactionPersonRow {
  id: number
  transaction_id: number
  operation_id: number | null
  document_type: TransactionPersonDocType
  full_name_ar: string | null
  full_name_en: string | null
  document_number: string | null
  nationality: string | null
  date_of_birth: string | null
  date_of_issue: string | null
  date_of_expiry: string | null
  place_of_issue: string | null
  gender: string | null
  profession: string | null // iqama-only
  sponsor: string | null // iqama-only
  mrz_raw: string | null
  confidence: number | null
  image_key: string | null
  status: TransactionPersonStatus
  review_reason: string | null
  created_at: string
}

// Shape returned by Gemini for an iqama/residency document extraction
// (see gemini.ts extractIqamaData). Mirrors PassportExtractionResult's
// is_passport/is_clear contract so both can share the same calling pattern.
export interface IqamaExtractionResult {
  is_iqama: boolean
  is_clear: boolean
  clarity_reason?: string
  full_name_ar?: string
  full_name_en?: string
  id_number?: string
  nationality?: string
  date_of_birth?: string
  date_of_expiry?: string
  profession?: string
  sponsor?: string
  gender?: string
  confidence?: number
}

export interface TransactionStatusLogRow {
  id: number
  transaction_id: number
  from_status: string | null
  to_status: string
  reason: string | null
  changed_by: string
  created_at: string
}

export type FollowUpTaskKind = 'hosting_followup' | 'visa_followup' | 'agent_confirmation_reminder'
export type FollowUpTaskStatus = 'pending' | 'sent' | 'cancelled'

export interface FollowUpTaskRow {
  id: number
  transaction_id: number
  customer_id: number
  kind: FollowUpTaskKind
  watched_status: TransactionStatus
  status: FollowUpTaskStatus
  due_at: string
  attempt_count: number
  message_text: string
  target_conversation_key: string
  created_at: string
  updated_at: string
}

export interface AuditLogRow {
  id: number
  actor_type: 'admin' | 'customer' | 'system'
  actor_id: number | null
  actor_label: string | null
  action: string
  entity_type: string | null
  entity_id: number | null
  details: string | null
  created_at: string
}

// ---------------------- Transaction attachments (migration 0014) ----------------------
// The "الزمام" PDF/document an agent sends alongside the ID photos — stored
// as a reference only (not OCR'd), purely so it travels with the
// transaction and the bot can auto-forward it to the supplier instead of a
// human doing a manual WhatsApp "forward" of every message.
export interface TransactionAttachmentRow {
  id: number
  transaction_id: number
  filename: string | null
  mime_type: string | null
  r2_key: string | null
  caption: string | null
  source: 'agent' | 'supplier'
  created_at: string
}
