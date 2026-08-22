// Helpers for the official WhatsApp Business Cloud API (Meta Graph API)

const DEFAULT_API_VERSION = 'v21.0'

export function graphBase(apiVersion?: string): string {
  return `https://graph.facebook.com/${apiVersion || DEFAULT_API_VERSION}`
}

export async function sendTextMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
  apiVersion?: string
): Promise<void> {
  const url = `${graphBase(apiVersion)}/${phoneNumberId}/messages`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    })
  })
  if (!resp.ok) {
    const err = await resp.text().catch(() => '')
    throw new Error(`WhatsApp send message failed (${resp.status}): ${err}`)
  }
}

// Sends a document (e.g. the Umrah visa PDF, or a PDF-format report) via the
// official Cloud API. WhatsApp requires either a previously-uploaded media id
// or a publicly reachable URL — since Cloudflare Workers has no R2/public file
// serving configured for this yet, callers pass a `link` (e.g. a temporary
// signed URL, or a data: URL is NOT supported by WhatsApp) OR a `mediaId`
// obtained via uploadMedia() below.
export async function sendDocumentMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  document: { link?: string; mediaId?: string; filename?: string; caption?: string },
  apiVersion?: string
): Promise<void> {
  const url = `${graphBase(apiVersion)}/${phoneNumberId}/messages`
  const documentPayload: any = {}
  if (document.mediaId) documentPayload.id = document.mediaId
  else if (document.link) documentPayload.link = document.link
  else throw new Error('sendDocumentMessage requires either link or mediaId')
  if (document.filename) documentPayload.filename = document.filename
  if (document.caption) documentPayload.caption = document.caption

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: documentPayload
    })
  })
  if (!resp.ok) {
    const err = await resp.text().catch(() => '')
    throw new Error(`WhatsApp send document failed (${resp.status}): ${err}`)
  }
}

// Uploads binary media (e.g. a PDF) to Meta so it can be sent by mediaId via
// sendDocumentMessage without needing a public URL. Meta requires multipart/
// form-data; Cloudflare Workers' fetch supports FormData + Blob natively.
export async function uploadMedia(
  phoneNumberId: string,
  accessToken: string,
  bytes: ArrayBuffer,
  mimeType: string,
  apiVersion?: string
): Promise<string> {
  const url = `${graphBase(apiVersion)}/${phoneNumberId}/media`
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', new Blob([bytes], { type: mimeType }), 'document.pdf')
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form
  })
  const json: any = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error(`WhatsApp media upload failed (${resp.status}): ${json?.error?.message || ''}`)
  }
  return json.id as string
}

export async function markMessageRead(
  phoneNumberId: string,
  accessToken: string,
  messageId: string,
  apiVersion?: string
): Promise<void> {
  const url = `${graphBase(apiVersion)}/${phoneNumberId}/messages`
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    })
  }).catch(() => {})
}

export interface WabaPhoneNumber {
  id: string // this is the phone_number_id we need to store
  display_phone_number: string
  verified_name: string
  quality_rating?: string
}

// Given a WhatsApp Business Account ID + access token, fetch the phone numbers
// registered under it (so the admin doesn't have to manually look up/copy the
// phone_number_id from Meta's dashboard — WABA ID + token is enough).
export async function fetchPhoneNumbersForWaba(
  wabaId: string,
  accessToken: string,
  apiVersion?: string
): Promise<WabaPhoneNumber[]> {
  const url = `${graphBase(apiVersion)}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const json: any = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = json?.error?.message || `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return (json.data || []) as WabaPhoneNumber[]
}

// Keep digits only, so "+967 77 826 0004", "00967778260004" and "967778260004"
// all normalize to the same comparable string regardless of how the admin typed it.
export function normalizePhoneDigits(phone: string): string {
  return (phone || '').replace(/\D/g, '')
}

// Match a plain customer phone number (as typed by the admin, any format) against
// the list of numbers Meta returns for a WABA. Handles missing/extra leading
// country-code zeros by comparing digit suffixes, not just exact equality.
export function findMatchingWabaNumber(
  numbers: WabaPhoneNumber[],
  phoneNumber: string
): WabaPhoneNumber | null {
  const target = normalizePhoneDigits(phoneNumber)
  if (!target) return null
  // 1) exact digit match first
  let match = numbers.find((n) => normalizePhoneDigits(n.display_phone_number) === target)
  if (match) return match
  // 2) fallback: suffix match (handles missing/extra leading 0 or country code),
  // require a reasonably long overlap to avoid false positives
  const minLen = 7
  match = numbers.find((n) => {
    const d = normalizePhoneDigits(n.display_phone_number)
    if (d.length < minLen || target.length < minLen) return false
    return d.endsWith(target) || target.endsWith(d)
  })
  return match || null
}

export interface MediaDownloadResult {
  base64: string
  mimeType: string
  bytes: ArrayBuffer
}

// Fetch media URL then download the binary, per Meta's two-step media retrieval flow
export async function downloadMedia(
  mediaId: string,
  accessToken: string,
  apiVersion?: string
): Promise<MediaDownloadResult> {
  const metaUrl = `${graphBase(apiVersion)}/${mediaId}`
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!metaResp.ok) {
    throw new Error(`Failed to fetch media metadata (${metaResp.status})`)
  }
  const meta = await metaResp.json<any>()
  const fileUrl = meta.url
  const mimeType = meta.mime_type || 'image/jpeg'

  const fileResp = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!fileResp.ok) {
    throw new Error(`Failed to download media file (${fileResp.status})`)
  }
  const bytes = await fileResp.arrayBuffer()
  const base64 = arrayBufferToBase64(bytes)
  return { base64, mimeType, bytes }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

// Incoming webhook payload types (subset of what we need)
export interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    field: string
    value: {
      messaging_product: 'whatsapp'
      metadata: { display_phone_number: string; phone_number_id: string }
      contacts?: Array<{ profile: { name: string }; wa_id: string }>
      messages?: Array<{
        from: string
        id: string
        timestamp: string
        type: string
        image?: { id: string; mime_type: string; sha256: string }
        document?: { id: string; mime_type: string; filename?: string }
        text?: { body: string }
      }>
      statuses?: Array<any>
    }
  }>
}

export interface WhatsAppWebhookBody {
  object: string
  entry: WhatsAppWebhookEntry[]
}
