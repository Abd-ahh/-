// Centralized "deliver a message to a conversation" helper, used by the new
// visa-check / render-job result endpoints (called by the VPS periodic
// checker) to reply to whichever conversation originally sent the passport
// photo — regardless of whether that conversation is a private number, a
// shared-number session, or an unofficial WhatsApp group.
//
// Private/shared number -> call Meta's Graph API directly (synchronous).
// Group -> Meta's Graph API cannot push into groups; the only way in is the
// Baileys bridge's live socket, which only replies in direct response to an
// inbound message. So group deliveries are queued in `group_outbox` and
// picked up by the bridge process's outbox poller (see /webhook/bridge/outbox).
import { parseConversationKey } from './commands'
import { sendTextMessage, sendDocumentMessage, uploadMedia } from './whatsapp'

export type DeliverPayload =
  | { kind: 'text'; text: string }
  | { kind: 'document'; base64: string; mimeType: string; filename: string; caption?: string }

export interface DeliverResult {
  ok: boolean
  channel: 'group' | 'number'
  error?: string
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export async function deliverToConversation(
  DB: D1Database,
  conversationKey: string,
  payload: DeliverPayload,
  apiVersion?: string
): Promise<DeliverResult> {
  const parsed = parseConversationKey(conversationKey)
  if (!parsed) {
    return { ok: false, channel: 'number', error: `invalid conversation key: ${conversationKey}` }
  }

  if (parsed.channel === 'group') {
    try {
      if (payload.kind === 'text') {
        await DB.prepare(
          `INSERT INTO group_outbox (group_jid, kind, text) VALUES (?, 'text', ?)`
        ).bind(parsed.group_jid, payload.text).run()
      } else {
        await DB.prepare(
          `INSERT INTO group_outbox (group_jid, kind, text, document_base64, document_mime_type, filename)
           VALUES (?, 'document', ?, ?, ?, ?)`
        ).bind(parsed.group_jid, payload.caption || null, payload.base64, payload.mimeType, payload.filename).run()
      }
      return { ok: true, channel: 'group' }
    } catch (err: any) {
      return { ok: false, channel: 'group', error: String(err?.message || err) }
    }
  }

  // Private / shared number: call Meta's Graph API directly.
  const numberRow = await DB.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?')
    .bind(parsed.whatsapp_number_id).first<any>()
  if (!numberRow || !numberRow.access_token || !numberRow.phone_number_id) {
    return { ok: false, channel: 'number', error: 'whatsapp number not found or missing credentials' }
  }

  try {
    if (payload.kind === 'text') {
      await sendTextMessage(numberRow.phone_number_id, numberRow.access_token, parsed.sender_phone, payload.text, apiVersion)
    } else {
      const bytes = base64ToArrayBuffer(payload.base64)
      const mediaId = await uploadMedia(numberRow.phone_number_id, numberRow.access_token, bytes, payload.mimeType, apiVersion)
      await sendDocumentMessage(
        numberRow.phone_number_id, numberRow.access_token, parsed.sender_phone,
        { mediaId, filename: payload.filename, caption: payload.caption }, apiVersion
      )
    }
    return { ok: true, channel: 'number' }
  } catch (err: any) {
    return { ok: false, channel: 'number', error: String(err?.message || err) }
  }
}
