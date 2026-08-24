// Periodic Umrah-visa checker + generic PDF renderer (Feature 4 + Feature 5
// VPS-side component).
//
// Runs as a long-lived PM2 process. Every POLL_INTERVAL_MS it:
//   1. Polls GET /webhook/visa-checks/pending on the Worker, automates the
//      MOFA "Search Visa" form with Playwright (selectors/flow proven in the
//      /home/user/visa_test/ feasibility scripts from the prior cycle),
//      solves the numeric captcha via Gemini Vision, and reports the result
//      back via POST /webhook/visa-checks/:id/result.
//   2. Polls GET /webhook/render-jobs/pending, renders the given HTML to PDF
//      with the same headless browser, and reports back via
//      POST /webhook/render-jobs/:id/result.
//
// Both endpoints require the shared secret in `x-visa-checker-secret`
// (VISA_CHECKER_SECRET, independent from the bridge's BRIDGE_SECRET so the
// two integrations can be rotated separately).
require('dotenv').config({ path: __dirname + '/.env.production' })

const { chromium } = require('playwright')
const { resolveNationality } = require('./mofa-nationalities')
const { solveCaptcha } = require('./gemini-captcha')

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '')
const VISA_CHECKER_SECRET = process.env.VISA_CHECKER_SECRET || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10)
const VISA_CHECKS_LIMIT = parseInt(process.env.VISA_CHECKS_LIMIT || '5', 10)
const RENDER_JOBS_LIMIT = parseInt(process.env.RENDER_JOBS_LIMIT || '5', 10)
const MAX_CAPTCHA_ATTEMPTS = 3
const MOFA_SEARCH_URL = 'https://visa.mofa.gov.sa/visaservices/searchvisa'

if (!WORKER_URL || !VISA_CHECKER_SECRET || !GEMINI_API_KEY) {
  console.error('[visa-checker] Missing required env vars (WORKER_URL, VISA_CHECKER_SECRET, GEMINI_API_KEY). Check .env.production')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ROOT CAUSE FIX (confirmed 2026-08-24 by direct reproduction on the live
// MOFA site): after a wrong-captcha submission, MOFA shows a Bootstrap
// modal (#dlgMessage, text "رمز الصورة غير صحيح") with a `.modal-backdrop`
// overlay that intercepts ALL clicks — including on #btnSubmit — until the
// modal's own "إغلاق" button is clicked. The previous code never closed
// this modal before retrying, so every retry after a wrong captcha
// silently hung on page.click() for the full 30s Playwright timeout and
// the check was reported as a generic ERROR (even though the underlying
// visa search itself may have succeeded on a later attempt if the click
// hadn't been blocked). This helper must be called before every submit
// click to clear any leftover modal from the previous attempt.
async function dismissErrorModal(page) {
  const backdrop = await page.$('.modal-backdrop.in, .modal-backdrop.fade.in').catch(() => null)
  if (!backdrop) return false
  const closeBtn = await page.$('#dlgMessage .modal-footer button, #dlgMessage .close').catch(() => null)
  if (closeBtn) {
    await closeBtn.click().catch(() => {})
  } else {
    // Fallback: press Escape, which Bootstrap modals also respond to.
    await page.keyboard.press('Escape').catch(() => {})
  }
  await page.waitForTimeout(500)
  return true
}

async function apiGet(path) {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    headers: { 'x-visa-checker-secret': VISA_CHECKER_SECRET }
  })
  if (!resp.ok) throw new Error(`GET ${path} -> ${resp.status} ${await resp.text().catch(() => '')}`)
  return resp.json()
}
async function apiPost(path, body) {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-visa-checker-secret': VISA_CHECKER_SECRET },
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw new Error(`POST ${path} -> ${resp.status} ${await resp.text().catch(() => '')}`)
  return resp.json()
}

// ---------------------------------------------------------------------
// MOFA automation. Selectors/flow proven in the prior feasibility tests
// (/home/user/visa_test/full_session.js, test_arabic_name.js): search by
// passport number + first name + nationality, solve the numeric captcha,
// submit, then detect success by URL (PrintedUmrahVisa / Print) and render
// the result page to a landscape A4 PDF.
// ---------------------------------------------------------------------
// Scrapes the structured labeled fields from the MOFA result page (each
// field is a `.col-3` block: Arabic label / value / English label — see
// /home/user/visa_test/final_result.html for a captured sample). Used to
// build the detailed visa-ready message ("نوع التأشيرة" / "صالحة اعتباراً
// من") instead of the older blind full-page PDF-only delivery. Best-effort:
// if the page layout ever changes and a field can't be found, the value is
// simply omitted and the Worker falls back to the older simple caption
// rather than failing the whole check.
async function scrapeVisaFields(page) {
  try {
    const data = await page.evaluate(() => {
      const result = {}
      document.querySelectorAll('.col-3').forEach((block) => {
        const labelEl = block.querySelector('.col-3-1')
        const valueEl = block.querySelector('.col-3-2')
        if (!labelEl || !valueEl) return
        const label = labelEl.innerText.trim()
        const value = valueEl.innerText.trim()
        if (label.includes('نوع التأشيرة')) result.visa_type = value
        if (label.includes('صالحة اعتبارا من')) result.valid_from = value
      })
      return result
    })
    return { visa_type: data.visa_type || null, valid_from: data.valid_from || null }
  } catch (err) {
    log('  ! scrapeVisaFields failed (non-fatal, falling back to simple caption):', err?.message || err)
    return { visa_type: null, valid_from: null }
  }
}

async function runMofaSearch(browser, { passport_number, first_name, nationality_code }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(MOFA_SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(1200)

    // Dismiss any consent/notice popups if present (best-effort, non-fatal).
    for (const label of ['أوافق', 'إغلاق']) {
      try {
        const btn = await page.$(`text=${label}`)
        if (btn) { await btn.click(); await page.waitForTimeout(400) }
      } catch { /* ignore */ }
    }

    await page.selectOption('#ddlFirstValue', 'PassPortNo')
    await page.selectOption('#ddlSecondValue', 'fName')
    await page.selectOption('#NationalityId', nationality_code)
    await page.fill('#tbFirstValue', passport_number)
    await page.fill('#tbSecondValue', first_name)
    await page.waitForTimeout(400)

    let lastCaptchaError = null
    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
      // FIX: clear any leftover error modal/backdrop from a previous wrong
      // captcha attempt — otherwise the click below silently hangs for 30s
      // (see dismissErrorModal doc comment above for full root-cause).
      await dismissErrorModal(page)

      const captchaEl = await page.$('#imgCaptcha')
      if (!captchaEl) throw new Error('لم يتم العثور على عنصر الكابتشا في الصفحة')
      const captchaBuf = await captchaEl.screenshot()
      const answer = await solveCaptcha(GEMINI_API_KEY, captchaBuf.toString('base64'))
      log(`  captcha attempt ${attempt}/${MAX_CAPTCHA_ATTEMPTS}: "${answer}"`)

      await page.fill('#Captcha', answer)
      await page.waitForTimeout(300)
      await page.click('#btnSubmit', { timeout: 10000 })
      await page.waitForTimeout(4000)

      const url = page.url()
      const success = url.includes('PrintedUmrahVisa') || url.includes('Print')
      if (success) {
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, landscape: true })
        const fields = await scrapeVisaFields(page)
        return { outcome: 'found', pdfBuffer, ...fields }
      }

      // Not a success URL yet. The same #dlgMessage modal is reused by MOFA
      // for two distinct cases, confirmed by direct reproduction
      // 2026-08-24: "رمز الصورة غير صحيح" (wrong captcha — worth retrying
      // with a fresh code) vs "لا يوجد بيانات مطابقة للقيم المدخلة" (no visa
      // record matches these details — the search itself ran fine, so
      // retrying the captcha again is pointless; this is the normal
      // steady-state before a visa is issued and should go straight to
      // not_ready). Any other/unrecognized modal wording falls back to the
      // previous heuristic ("still on the search form") and retries, so
      // it doesn't silently hang instead.
      const modalText = await page.$eval('#dlgMessageContent', (el) => el.innerText.trim()).catch(() => null)
      const isWrongCaptcha = modalText && modalText.includes('رمز الصورة')
      const isNoMatch = modalText && modalText.includes('لا يوجد بيانات مطابقة')
      const stillOnSearchForm = await page.$('#Captcha').catch(() => null)

      if (isNoMatch) {
        // Not a captcha problem — the visa just isn't issued yet. No point
        // burning remaining captcha attempts; report not_ready immediately.
        return { outcome: 'not_ready', error: `لم تصدر التأشيرة بعد: "${modalText}"` }
      }

      if ((isWrongCaptcha || (modalText === null && stillOnSearchForm)) && attempt < MAX_CAPTCHA_ATTEMPTS) {
        lastCaptchaError = isWrongCaptcha ? `رمز الكابتشا رُفض من الموقع: "${modalText}"` : 'captcha rejected, retrying with new code'
        await dismissErrorModal(page)
        await page.waitForTimeout(800)
        continue
      }

      // No visa found yet (or out of captcha retries) -> not_ready, the
      // Worker will reschedule this check automatically in 20 minutes.
      return { outcome: 'not_ready', error: lastCaptchaError || modalText || 'لم يتم العثور على نتيجة (لم تصدر التأشيرة بعد)' }
    }

    return { outcome: 'not_ready', error: lastCaptchaError || 'فشل تجاوز الكابتشا بعد عدة محاولات' }
  } finally {
    await page.close().catch(() => {})
  }
}

async function processVisaChecks(browser) {
  const { checks } = await apiGet(`/webhook/visa-checks/pending?limit=${VISA_CHECKS_LIMIT}`)
  if (!checks || checks.length === 0) return
  log(`visa-checks: ${checks.length} due`)

  for (const check of checks) {
    log(`  checking #${check.id} passport=${check.passport_number} name=${check.first_name} nationality=${check.nationality}`)
    const nationality_code = resolveNationality(check.nationality)
    if (!nationality_code) {
      const msg = `تعذر تحديد رمز الجنسية في نظام MOFA لقيمة: "${check.nationality}"`
      log(`  ! ${msg}`)
      await apiPost(`/webhook/visa-checks/${check.id}/result`, { status: 'failed', error: msg }).catch((e) => log('  ! failed to post result', e.message))
      continue
    }

    try {
      const result = await runMofaSearch(browser, {
        passport_number: check.passport_number,
        first_name: check.first_name,
        nationality_code
      })

      if (result.outcome === 'found') {
        await apiPost(`/webhook/visa-checks/${check.id}/result`, {
          status: 'found',
          pdf_base64: result.pdfBuffer.toString('base64'),
          pdf_mime_type: 'application/pdf',
          visa_type: result.visa_type || undefined,
          valid_from: result.valid_from || undefined
        })
        log(`  #${check.id} -> FOUND, PDF delivered (visa_type=${result.visa_type || 'n/a'}, valid_from=${result.valid_from || 'n/a'})`)
      } else {
        await apiPost(`/webhook/visa-checks/${check.id}/result`, { status: 'not_ready', error: result.error })
        log(`  #${check.id} -> not_ready (${result.error})`)
      }
    } catch (err) {
      const msg = String(err?.message || err)
      log(`  #${check.id} -> ERROR: ${msg}`)
      await apiPost(`/webhook/visa-checks/${check.id}/result`, { status: 'failed', error: msg }).catch((e) => log('  ! failed to post error result', e.message))
    }
  }
}

async function processRenderJobs(browser) {
  const { jobs } = await apiGet(`/webhook/render-jobs/pending?limit=${RENDER_JOBS_LIMIT}`)
  if (!jobs || jobs.length === 0) return
  log(`render-jobs: ${jobs.length} due`)

  for (const job of jobs) {
    const page = await browser.newPage()
    try {
      await page.setContent(job.html, { waitUntil: 'networkidle', timeout: 30000 })
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true })
      await apiPost(`/webhook/render-jobs/${job.id}/result`, {
        status: 'done',
        pdf_base64: pdfBuffer.toString('base64')
      })
      log(`  render-job #${job.id} -> done`)
    } catch (err) {
      const msg = String(err?.message || err)
      log(`  render-job #${job.id} -> ERROR: ${msg}`)
      await apiPost(`/webhook/render-jobs/${job.id}/result`, { status: 'failed', error: msg }).catch((e) => log('  ! failed to post error result', e.message))
    } finally {
      await page.close().catch(() => {})
    }
  }
}

async function mainLoop() {
  log(`visa-checker starting. WORKER_URL=${WORKER_URL} poll interval=${POLL_INTERVAL_MS}ms`)
  const browser = await chromium.launch({ headless: true })
  log('Chromium launched.')

  process.on('SIGTERM', async () => { log('SIGTERM received, closing browser...'); await browser.close(); process.exit(0) })
  process.on('SIGINT', async () => { log('SIGINT received, closing browser...'); await browser.close(); process.exit(0) })

  while (true) {
    try {
      await processVisaChecks(browser)
    } catch (err) {
      log('processVisaChecks failed:', err?.message || err)
    }
    try {
      await processRenderJobs(browser)
    } catch (err) {
      log('processRenderJobs failed:', err?.message || err)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

mainLoop().catch((err) => {
  console.error('Fatal error in visa-checker:', err)
  process.exit(1)
})
