-- =========================================================
-- Passport AI WhatsApp Platform - Initial Schema
-- =========================================================

-- Global platform settings (key/value store)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Platform administrators
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Subscription packages / plans
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  max_numbers INTEGER NOT NULL DEFAULT 1,
  monthly_operations INTEGER NOT NULL DEFAULT 500,
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'SAR',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Customers (platform subscribers)
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  reply_language TEXT NOT NULL DEFAULT 'ar', -- ar | en
  welcome_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Subscriptions linking customers to packages with a validity period
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  start_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_date DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | expired | cancelled
  operations_limit INTEGER NOT NULL,
  operations_used INTEGER NOT NULL DEFAULT 0,
  price_paid REAL NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- WhatsApp numbers connected to customers (Meta Cloud API credentials)
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  phone_number_id TEXT UNIQUE, -- Meta Cloud API phone_number_id
  waba_id TEXT, -- WhatsApp Business Account ID
  access_token TEXT, -- Per-number system user access token (optional, can be shared)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | connected | disconnected
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Log of every passport processing operation
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  sender_phone TEXT,
  message_id TEXT,
  image_key TEXT, -- R2 object key (if stored)
  status TEXT NOT NULL DEFAULT 'processing', -- processing | success | unclear | failed
  full_name_ar TEXT,
  full_name_en TEXT,
  passport_number TEXT,
  nationality TEXT,
  date_of_birth TEXT,
  date_of_expiry TEXT,
  gender TEXT,
  extracted_json TEXT, -- full raw JSON from Gemini
  error_message TEXT,
  processing_time_ms INTEGER,
  source TEXT NOT NULL DEFAULT 'whatsapp', -- whatsapp | portal_test
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_customer ON whatsapp_numbers(customer_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_phone_number_id ON whatsapp_numbers(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_operations_customer ON operations(customer_id);
CREATE INDEX IF NOT EXISTS idx_operations_whatsapp_number ON operations(whatsapp_number_id);
CREATE INDEX IF NOT EXISTS idx_operations_created_at ON operations(created_at);
