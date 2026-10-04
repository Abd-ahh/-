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
  apiVersion?: string,
  // Optional link back to the Smart Employee transaction this delivery
  // belongs to (fix 2026-10-04, real production bug UMR-260002: a group
  // delivery silently failed — 'Connection Closed' from a stale bridge.js
  // socket — while closeTransactionToSupplier() had already told the agent
  // "✅ تم الرفع." and advanced the transaction to WAITING_HOSTING, with
  // zero visible trace anywhere that the supplier never actually got the
  // summary). Tagging the outbox row lets /webhook/bridge/outbox/:id/ack
  // retry automatically, and — if retries are exhausted — flip the
  // transaction back to NEEDS_REVIEW and warn the AGENT'S group instead of
  // leaving it silently stuck. Omit for non-transaction deliveries (visa
  // PDFs, message lists, etc.) — purely additive, no behavior change for
  // those callers.
  transactionId?: number
): Promise<DeliverResult> {
  const parsed = parseConversationKey(conversationKey)
  if (!parsed) {
    return { ok: false, channel: 'number', error: `invalid conversation key: ${conversationKey}` }
  }

  if (parsed.channel === 'group') {
    try {
      // Multi-number bridge support (migration 0015): route this outbox row
      // to the SAME bridge.js process (bridge number) this group is
      // actually linked to, not whichever one happens to be default —
      // otherwise a reply could silently be picked up by the wrong VPS
      // process (which has no socket open in this group at all) and never
      // actually get delivered. Falls back to 1 (the original/default
      // number) if the group was somehow deleted between activation and
      // this delivery, matching the column's DB-level DEFAULT.
      const groupRow = await DB.prepare('SELECT bridge_number_id FROM whatsapp_groups WHERE group_jid = ?')
        .bind(parsed.group_jid).first<{ bridge_number_id: number }>()
      const bridgeNumberId = groupRow?.bridge_number_id ?? 1

      if (payload.kind === 'text') {
        await DB.prepare(
          `INSERT INTO group_outbox (group_jid, kind, text, bridge_number_id, transaction_id) VALUES (?, 'text', ?, ?, ?)`
        ).bind(parsed.group_jid, payload.text, bridgeNumberId, transactionId ?? null).run()
      } else {
        await DB.prepare(
          `INSERT INTO group_outbox (group_jid, kind, text, document_base64, document_mime_type, filename, bridge_number_id, transaction_id)
           VALUES (?, 'document', ?, ?, ?, ?, ?, ?)`
        ).bind(parsed.group_jid, payload.caption || null, payload.base64, payload.mimeType, payload.filename, bridgeNumberId, transactionId ?? null).run()
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
