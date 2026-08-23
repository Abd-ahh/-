// =========================================================
// Passport AI - WhatsApp Group Bridge
// =========================================================
// Unofficial bridge process (uses Baileys, the WhatsApp-Web protocol
// library) that lets a normal personal WhatsApp number be added into
// office WhatsApp groups, since Meta's official Cloud API cannot join or
// receive messages from groups. Every group text/image message is
// forwarded to the main Cloudflare Worker's /webhook/bridge/message
// endpoint, which runs the same office-matching + Gemini passport
// extraction pipeline used for the official number, and returns a reply
// that this bridge sends back into the group.
//
// Run with PM2 (see ecosystem.config.cjs). Required env vars:
//   WORKER_URL      - e.g. https://passport-ai-whatsapp.pages.dev
//   BRIDGE_SECRET   - shared secret, must match the Worker's BRIDGE_SECRET
//   PAIR_PHONE      - (only needed once, for first-time linking) the phone
//                     number to link, digits only with country code,
//                     e.g. 9665XXXXXXXX (no +, no spaces)
// =========================================================

import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'

const WORKER_URL = (process.env.WORKER_URL || 'https://passport-ai-whatsapp.pages.dev').replace(/\/$/, '')
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const PAIR_PHONE = process.env.PAIR_PHONE || '' // digits only, e.g. 9665XXXXXXXX
const AUTH_DIR = path.join(process.cwd(), 'auth_state')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

if (!BRIDGE_SECRET) {
  console.error('❌ BRIDGE_SECRET env var is required (must match the Cloudflare Worker secret). Exiting.')
  process.exit(1)
}

async function forwardToWorker(payload) {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/bridge/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': BRIDGE_SECRET
      },
      body: JSON.stringify(payload)
    })
    if (!resp.ok) {
      logger.error({ status: resp.status, text: await resp.text().catch(() => '') }, 'Worker responded with error')
      return null
    }
    const data = await resp.json()
    return data?.reply || null
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to reach Worker')
    return null
  }
}

// ---- Outbox poller (async group delivery) ----
// The official Cloud API can't push into a group, and this bridge only
// otherwise replies synchronously to an inbound message. For asynchronous
// results (Umrah visa PDF ready hours later, PDF report ready), the Worker
// queues into `group_outbox` and this poller delivers + acks them.
const OUTBOX_POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '15000', 10)

function base64ToBuffer(b64) {
  return Buffer.from(b64, 'base64')
}

async function pollOutbox(sock) {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/bridge/outbox?limit=10`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET }
    })
    if (!resp.ok) return
    const data = await resp.json()
    const items = data?.items || []

    for (const item of items) {
      try {
        if (item.kind === 'document' && item.document_base64) {
          await sock.sendMessage(item.group_jid, {
            document: base64ToBuffer(item.document_base64),
            mimetype: item.document_mime_type || 'application/pdf',
            fileName: item.filename || 'document.pdf',
            caption: item.text || undefined
          })
        } else if (item.text) {
          await sock.sendMessage(item.group_jid, { text: item.text })
        }

        await fetch(`${WORKER_URL}/webhook/bridge/outbox/${item.id}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
          body: JSON.stringify({ status: 'delivered' })
        })
      } catch (err) {
        logger.error({ err: err?.message, itemId: item.id }, 'Failed to deliver outbox item')
        await fetch(`${WORKER_URL}/webhook/bridge/outbox/${item.id}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
          body: JSON.stringify({ status: 'failed', error: String(err?.message || err) })
        }).catch(() => {})
      }
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to poll outbox')
  }
}

// ---- Message Lists tick (scheduled WhatsApp broadcast lists) ----
// Cloudflare Pages has no native cron/scheduled-handler support, so the
// Worker's src/lib/messageLists.ts logic (which lists are due right now)
// is triggered from here instead — the same "external process polls a
// Worker endpoint on a timer" pattern already used above for group_outbox
// and, before this bridge existed, for the Umrah visa periodic checker.
// The endpoint itself queues group_outbox rows for anything due, which the
// existing pollOutbox() above then delivers on its own next tick — no
// separate delivery code needed here since Baileys' sendMessage() already
// accepts an individual-number JID exactly like a group JID.
const MESSAGE_LIST_TICK_INTERVAL_MS = parseInt(process.env.MESSAGE_LIST_TICK_INTERVAL_MS || '60000', 10)

async function tickMessageLists() {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/message-lists/tick`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET }
    })
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'message-lists tick failed')
      return
    }
    const data = await resp.json()
    if (data?.lists_fired > 0) {
      logger.info(data, 'message-lists tick fired lists')
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to reach message-lists tick endpoint')
  }
}

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false, // we handle QR display ourselves below
    browser: Browsers.ubuntu('Chrome')
  })

  sock.ev.on('creds.update', saveCreds)

  // ---- First-time linking: pairing code (preferred) or QR fallback ----
  let pairingRequested = false
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !pairingRequested) {
      if (PAIR_PHONE) {
        try {
          pairingRequested = true
          const code = await sock.requestPairingCode(PAIR_PHONE)
          console.log('\n=========================================')
          console.log(`📱 PAIRING CODE for ${PAIR_PHONE}: ${code}`)
          console.log('Open WhatsApp on that phone -> Linked Devices -> Link a Device -> Link with phone number instead, then enter this code.')
          console.log('=========================================\n')
        } catch (err) {
          console.error('Failed to request pairing code, falling back to QR:', err?.message)
          qrcodeTerminal.generate(qr, { small: true })
        }
      } else {
        console.log('\n📷 Scan this QR code with WhatsApp (Linked Devices -> Link a Device):\n')
        qrcodeTerminal.generate(qr, { small: true })
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      logger.warn({ statusCode, loggedOut }, 'Connection closed')
      if (loggedOut) {
        console.error('❌ Logged out from WhatsApp. Delete auth_state/ and restart to re-link.')
      } else {
        console.log('🔄 Reconnecting...')
        setTimeout(startBridge, 3000)
      }
    } else if (connection === 'open') {
      pairingRequested = false
      console.log('✅ Connected to WhatsApp successfully. Bridge is now listening for group messages.')
      // Start the outbox poller once the socket is actually connected.
      setInterval(() => pollOutbox(sock), OUTBOX_POLL_INTERVAL_MS)
      // Start the message-lists scheduler tick (queues due lists into group_outbox,
      // which the poller above then delivers on its own next cycle).
      setInterval(tickMessageLists, MESSAGE_LIST_TICK_INTERVAL_MS)
    }
  })

  // ---- Incoming messages ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid || ''
        const isGroup = remoteJid.endsWith('@g.us')
        if (!isGroup) continue // this bridge only cares about group messages
        if (msg.key?.fromMe) continue
        if (!msg.message) continue

        const senderJid = msg.key.participant || msg.key.remoteJid

        const textBody =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''

        const hasImage = !!msg.message.imageMessage

        let groupName = null
        try {
          const meta = await sock.groupMetadata(remoteJid)
          groupName = meta?.subject || null
        } catch {
          // non-fatal, group_name is just for admin visibility
        }

        if (hasImage) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const base64 = buffer.toString('base64')
          const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg'

          const reply = await forwardToWorker({
            group_jid: remoteJid,
            group_name: groupName,
            sender_jid: senderJid,
            type: 'image',
            image_base64: base64,
            mime_type: mimeType
          })
          if (reply) {
            await sock.sendMessage(remoteJid, { text: reply })
          }
        } else if (textBody) {
          const reply = await forwardToWorker({
            group_jid: remoteJid,
            group_name: groupName,
            sender_jid: senderJid,
            type: 'text',
            text: textBody
          })
          if (reply) {
            await sock.sendMessage(remoteJid, { text: reply })
          }
        }
      } catch (err) {
        logger.error({ err: err?.message }, 'Error handling incoming message')
      }
    }
  })
}

startBridge().catch((err) => {
  console.error('Fatal bridge error:', err)
  process.exit(1)
})
