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
  created_at: string
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
