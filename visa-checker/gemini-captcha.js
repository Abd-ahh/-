// Uses Gemini Vision to OCR the MOFA captcha image (small, distorted,
// numeric-only in all samples observed during feasibility testing:
// e.g. "838681", "619206"). Mirrors the retry/backoff pattern already used
// in the Worker's src/lib/gemini.ts for passport extraction, kept
// intentionally simple/independent here since this runs on the VPS, not on
// Cloudflare Workers (plain Node fetch, no c.env bindings).
const GEMINI_MODEL = 'gemini-flash-lite-latest'
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1200

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CAPTCHA_PROMPT = `هذه صورة captcha (رمز تحقق) من موقع رسمي، تحتوي عادة على 6 أرقام (أحياناً قد تتضمن حروفاً إنجليزية) بخط مموّه بألوان وخطوط تشويش في الخلفية.
اقرأ الرمز بدقة شديدة وتجاهل خطوط/نقاط التشويش الملونة في الخلفية.
أعد الإجابة بصيغة JSON فقط بدون أي نص إضافي، وفق هذا الشكل بالضبط:
{"text": "الرمز المقروء بدون أي مسافات"}`

async function solveCaptcha(apiKey, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const body = {
    contents: [
      {
        parts: [
          { text: CAPTCHA_PROMPT },
          { inline_data: { mime_type: 'image/png', data: imageBase64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0, response_mime_type: 'application/json' }
  }

  let lastError = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (err) {
      lastError = new Error(`Gemini network error: ${err?.message || err}`)
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue }
      throw lastError
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      const isTransient = resp.status === 503 || resp.status === 429
      lastError = new Error(`Gemini API error (${resp.status}): ${errText}`)
      if (isTransient && attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * (attempt + 1)); continue }
      throw lastError
    }

    const data = await resp.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('لم يتم استلام رد صالح من Gemini (captcha)')

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('تعذر تحليل رد Gemini كـ JSON (captcha)')
      parsed = JSON.parse(match[0])
    }

    const raw = String(parsed.text || '').replace(/\s+/g, '').trim()
    if (!raw) throw new Error('Gemini لم يستطع قراءة الكابتشا')
    return raw
  }

  throw lastError || new Error('فشل قراءة الكابتشا لسبب غير معروف')
}

module.exports = { solveCaptcha }
