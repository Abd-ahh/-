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
