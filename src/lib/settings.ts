// Generic platform-wide settings helpers (key/value store, see `settings`
// table from migration 0001). Used for the unified welcome/activation
// message (feature 1) — a single global value, editable from the admin
// dashboard, independent of the existing per-customer `welcome_message`.
export const UNACTIVATED_WELCOME_KEY = 'unactivated_welcome_message'

export async function getSetting(DB: D1Database, key: string): Promise<string | null> {
  const row = await DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(DB: D1Database, key: string, value: string): Promise<void> {
  await DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
  ).bind(key, value).run()
}
