export type Bindings = {
  DB: D1Database
  PASSPORTS_BUCKET: R2Bucket
  GEMINI_API_KEY?: string
  JWT_SECRET?: string
  WHATSAPP_VERIFY_TOKEN?: string
  WHATSAPP_API_VERSION?: string
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
  customer_id: number
  display_name: string
  phone_number: string
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  status: string
  extraction_fields: string | null // JSON array of field keys, null = all fields
  created_at: string
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
