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

module.exports = {
  apps: [
    {
      name: 'passport-bridge',
      script: 'bridge.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        WORKER_URL: envVars.WORKER_URL || 'https://passport-ai-whatsapp.pages.dev',
        BRIDGE_SECRET: envVars.BRIDGE_SECRET || '',
        PAIR_PHONE: envVars.PAIR_PHONE || ''
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 20,
      restart_delay: 5000
    }
  ]
}
