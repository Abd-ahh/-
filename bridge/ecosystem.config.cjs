// Load secrets from .env.production (not committed to git) instead of
// hardcoding them here.
const fs = require('fs')
const path = require('path')
const envPath = path.join(__dirname, '.env.production')
const envVars = {}
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    envVars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
}

// ---------------------------------------------------------------------
// Multi-number support (2026-10-03).
//
// Each entry below is ONE separate bridge.js process = ONE separate
// WhatsApp number/Baileys socket. The `id` MUST match a real row's id in
// the `bridge_numbers` table (create it first from the admin panel's
// "أرقام الجسر" tab, note the id it's assigned, then add an entry here
// with that same id and that number's PAIR_PHONE for first-time linking).
//
// By default this config only runs number 1 (the original/default number
// every pre-existing install already has, auto-created by migration
// 0015) — exactly the same single-process behavior as before this
// feature existed. To add a second number:
//   1. Admin panel -> "أرقام الجسر" -> أضف رقم جديد -> note its id (e.g. 2)
//   2. Add a PAIR_PHONE_<id> line to .env.production, e.g. PAIR_PHONE_2=9665XXXXXXXX
//   3. Add { id: 2, pm2Name: 'passport-bridge-2' } to BRIDGE_NUMBERS below
//   4. pm2 start ecosystem.config.cjs (only starts NEW apps; existing ones
//      are untouched) then pm2 save
//   5. Watch `pm2 logs passport-bridge-2 --nostream` for the pairing code,
//      link it from that WhatsApp number's Linked Devices menu
// ---------------------------------------------------------------------
const BRIDGE_NUMBERS = [
  { id: 1, pm2Name: 'passport-bridge' }
  // { id: 2, pm2Name: 'passport-bridge-2' },
  // { id: 3, pm2Name: 'passport-bridge-3' },
]

module.exports = {
  apps: BRIDGE_NUMBERS.map(({ id, pm2Name }) => ({
    name: pm2Name,
    script: 'bridge.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      WORKER_URL: envVars.WORKER_URL || 'https://passport-ai-whatsapp.pages.dev',
      BRIDGE_SECRET: envVars.BRIDGE_SECRET || '',
      BRIDGE_NUMBER_ID: String(id),
      // Looks up PAIR_PHONE_<id> for numbers 2+, falls back to the plain
      // PAIR_PHONE key for number 1 so existing .env.production files
      // (which only ever had PAIR_PHONE, no suffix) keep working as-is.
      PAIR_PHONE: (id === 1 ? envVars.PAIR_PHONE : envVars[`PAIR_PHONE_${id}`]) || ''
    },
    watch: false,
    instances: 1,
    exec_mode: 'fork',
    max_restarts: 20,
    restart_delay: 5000
  }))
}
