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

import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
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

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false, // we handle QR display ourselves below
    browser: ['Passport AI Bridge', 'Chrome', '1.0.0']
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
