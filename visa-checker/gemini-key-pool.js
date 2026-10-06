// Manages a pool of Gemini API keys for captcha-solving (added 2026-10-06,
// multi-key scale-up). Before this, the whole visa-checker shared a SINGLE
// Gemini key with a 500 req/day free-tier ceiling. With N independent keys
// (each its own Google AI Studio project, each with its own 500/day quota),
// the effective daily captcha-solving ceiling becomes ~N * 500/day.
//
// NOTE: this only raises the captcha-OCR ceiling. It does NOT raise how
// fast we can safely visit the MOFA website itself — that remains bottle-
// necked by MOFA's own anti-bot/rate-limiting and is a separate, harder
// constraint (see README "فحص التأشيرات" section).
//
// Keys are read from GEMINI_API_KEYS (comma-separated) in .env.production,
// falling back to the legacy single GEMINI_API_KEY for backward
// compatibility. To add more keys later ("إتاحة إضافات مفاتيح أخرى"),
// just append them (comma-separated) to GEMINI_API_KEYS and restart the
// PM2 process — no code changes needed.
//
// Rotation: round-robin across keys NOT currently marked exhausted. When a
// key hits a quota error (429/RESOURCE_EXHAUSTED), it's marked exhausted
// for EXHAUST_COOLDOWN_MS (24h — a daily free-tier quota only resets once
// per day, so retrying that specific key sooner just wastes another call
// confirming it's still exhausted). The caller (checker.js) only treats the
// WHOLE POOL as exhausted — and only then trips the global circuit breaker
// that pauses all polling — once every key is simultaneously in cooldown.

const EXHAUST_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

function parseKeys() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || ''
  const keys = raw.split(',').map((k) => k.trim()).filter(Boolean)
  // De-dupe while preserving order, in case the same key is listed twice
  // (e.g. the legacy single key being re-sent again as part of a new batch).
  return [...new Set(keys)]
}

class GeminiKeyPool {
  constructor() {
    this.keys = parseKeys()
    this.exhaustedUntil = new Map() // key -> timestamp until which it's skipped
    this.cursor = 0
    if (this.keys.length === 0) {
      throw new Error(
        'لا توجد مفاتيح Gemini مُهيّأة. عيّن GEMINI_API_KEYS (مفصولة بفواصل) أو GEMINI_API_KEY في .env.production'
      )
    }
  }

  size() {
    return this.keys.length
  }

  _isExhausted(key) {
    const until = this.exhaustedUntil.get(key)
    return !!until && Date.now() < until
  }

  availableCount() {
    return this.keys.filter((k) => !this._isExhausted(k)).length
  }

  // The whole pool is exhausted only when EVERY key is currently in its
  // cooldown window. This is the condition that should trip the global
  // circuit breaker (full polling pause) in checker.js.
  allExhausted() {
    return this.availableCount() === 0
  }

  markExhausted(key) {
    this.exhaustedUntil.set(key, Date.now() + EXHAUST_COOLDOWN_MS)
  }

  // Returns the next available (non-exhausted) key, round-robin, or null if
  // every key is currently exhausted.
  nextKey() {
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length
      const key = this.keys[idx]
      if (!this._isExhausted(key)) {
        this.cursor = (idx + 1) % this.keys.length
        return key
      }
    }
    return null
  }

  // Never log a full key — only a short masked preview, for safe debugging.
  maskKey(key) {
    if (!key) return '(none)'
    return key.slice(0, 10) + '...' + key.slice(-4)
  }
}

module.exports = { GeminiKeyPool }
