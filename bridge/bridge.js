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
// --- Multi-number support (2026-10-03) ---
// A single VPS can run SEVERAL bridge.js processes side by side, each one
// a completely separate WhatsApp number/Baileys socket (see
// ecosystem.config.cjs's bridgeNumbers array). BRIDGE_NUMBER_ID identifies
// which registered bridge_numbers row (created from the admin panel, see
// src/routes/admin.ts's /bridge-numbers endpoints) THIS process instance
// is. It is sent with every forwarded message and used to:
//   - keep each number's auth_state in its own subfolder (auth_state/<id>)
//     so pairing one number can never touch another's saved session
//   - filter the outbox poll (GET /bridge/outbox?bridge_number_id=<id>) so
//     a process only ever tries to deliver items meant for ITS OWN socket
//   - self-report live connection status to the Worker (POST
//     /bridge/numbers/<id>/status) so the admin panel shows real status
//     without ever needing direct access to the VPS
// Every env var below defaults such that a single-number setup (the
// original behavior) keeps working completely unchanged if
// BRIDGE_NUMBER_ID is simply left unset (defaults to "1", matching the
// bridge_numbers row the 0015 migration auto-creates for pre-existing
// installs).
//
// Run with PM2 (see ecosystem.config.cjs — ONE app block per number).
// Required env vars:
//   WORKER_URL       - e.g. https://passport-ai-whatsapp.pages.dev
//   BRIDGE_SECRET    - shared secret, must match the Worker's BRIDGE_SECRET
//   BRIDGE_NUMBER_ID - (optional, default "1") the bridge_numbers.id this
//                      process instance represents. Every PM2 app in a
//                      multi-number setup MUST use a distinct value here.
//   PAIR_PHONE       - (only needed once, for first-time linking) the phone
//                      number to link, digits only with country code,
//                      e.g. 9665XXXXXXXX (no +, no spaces)
// =========================================================

import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'

const WORKER_URL = (process.env.WORKER_URL || 'https://passport-ai-whatsapp.pages.dev').replace(/\/$/, '')
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const PAIR_PHONE = process.env.PAIR_PHONE || '' // digits only, e.g. 9665XXXXXXXX
const BRIDGE_NUMBER_ID = parseInt(process.env.BRIDGE_NUMBER_ID || '1', 10) || 1
// Each number gets its own auth_state subfolder so multiple processes on
// the same VPS never share/corrupt each other's Baileys session files.
// Number 1 (the default/original) keeps using the exact same path it
// always used (auth_state/, no subfolder) so upgrading an existing
// single-number install needs ZERO file moves — it just keeps working.
const AUTH_DIR = BRIDGE_NUMBER_ID === 1
  ? path.join(process.cwd(), 'auth_state')
  : path.join(process.cwd(), 'auth_state', String(BRIDGE_NUMBER_ID))

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
      body: JSON.stringify({ ...payload, bridge_number_id: BRIDGE_NUMBER_ID })
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

// Self-reports this process's live connection state to the Worker so the
// admin panel's "أرقام الجسر" tab can show real status (the Worker has no
// other way to observe a VPS process's socket). Best-effort — a failed
// report here never affects the bridge's own operation.
async function reportStatus(status, detail, phoneNumber) {
  try {
    await fetch(`${WORKER_URL}/webhook/bridge/numbers/${BRIDGE_NUMBER_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
      body: JSON.stringify({ status, detail: detail || undefined, phone_number: phoneNumber || undefined })
    })
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to report bridge number status')
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
    const resp = await fetch(`${WORKER_URL}/webhook/bridge/outbox?limit=10&bridge_number_id=${BRIDGE_NUMBER_ID}`, {
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

// Knowledge Base periodic analysis (requested 2026-08-24) — same
// once-every-few-minutes polling pattern as the ticks above. Deliberately
// less frequent (default 10 min) since this only decides whether enough new
// messages piled up to justify a Gemini analysis call, unlike the
// time-sensitive message-lists/visa-check ticks.
const KNOWLEDGE_BASE_TICK_INTERVAL_MS = parseInt(process.env.KNOWLEDGE_BASE_TICK_INTERVAL_MS || '600000', 10)

async function tickKnowledgeBase() {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/knowledge-base/tick`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET }
    })
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'knowledge-base tick failed')
      return
    }
    const data = await resp.json()
    logger.info(data, 'knowledge-base tick done')
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to reach knowledge-base tick endpoint')
  }
}

// Smart Employee (الموظف الذكي) follow-up reminders — same tick pattern,
// checked once a minute (follow-up delays are measured in tens of minutes,
// so this granularity is more than enough while staying cheap).
const FOLLOW_UP_TICK_INTERVAL_MS = parseInt(process.env.FOLLOW_UP_TICK_INTERVAL_MS || '60000', 10)

async function tickFollowUp() {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/follow-up/tick`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET }
    })
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'follow-up tick failed')
      return
    }
    const data = await resp.json()
    if (data?.sent > 0 || data?.failed > 0) {
      logger.info(data, 'follow-up tick done')
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to reach follow-up tick endpoint')
  }
}

// ---- Group invite-link resolver tick (migration 0019, 2026-10-07) ----
// Every bridge number's process polls the SAME pending-jobs list and tries
// each invite code against ITS OWN socket via groupGetInviteInfo() — a
// read-only call (does NOT join the group) that only succeeds if this
// specific number is already a member. See webhook.ts's
// /group-resolve-jobs/* handlers for the full non-exclusive-race design
// rationale (unlike outbox/visa-checks, there's no single process holding
// every number's socket, so claiming exclusively isn't possible here).
const GROUP_RESOLVE_TICK_INTERVAL_MS = parseInt(process.env.GROUP_RESOLVE_TICK_INTERVAL_MS || '20000', 10)

async function tickGroupResolveJobs(sock) {
  try {
    const resp = await fetch(`${WORKER_URL}/webhook/group-resolve-jobs/pending?limit=5`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET }
    })
    if (!resp.ok) return
    const data = await resp.json()
    const jobs = data?.jobs || []
    if (jobs.length === 0) return

    for (const job of jobs) {
      try {
        // groupGetInviteInfo throws if this number isn't a member of the
        // group the code points to (or the code is invalid/expired) — that
        // is the EXPECTED outcome for most of our numbers on most jobs,
        // not a real error, so it's reported as 'attempt_failed' (no-op)
        // rather than logged loudly.
        const info = await sock.groupGetInviteInfo(job.invite_code)
        await fetch(`${WORKER_URL}/webhook/group-resolve-jobs/${job.id}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
          body: JSON.stringify({
            status: 'resolved',
            jid: info.id,
            group_name: info.subject || null,
            bridge_number_id: BRIDGE_NUMBER_ID
          })
        })
        logger.info({ jobId: job.id, jid: info.id, bridgeNumberId: BRIDGE_NUMBER_ID }, 'Resolved group invite link')
      } catch (err) {
        // Not a member of this group (or bad/expired code) — expected for
        // most number/job combinations in a multi-number setup. No DB
        // write; the job stays 'pending' for other numbers to try, and
        // auto-fails via the Worker's lazy timeout sweep if nobody ever
        // succeeds.
        await fetch(`${WORKER_URL}/webhook/group-resolve-jobs/${job.id}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
          body: JSON.stringify({ status: 'attempt_failed' })
        }).catch(() => {})
      }
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to poll group-resolve-jobs')
  }
}

// Fix 2026-10-04 (real production bug, transaction UMR-260002 — summary
// never reached the supplier's group despite the bot replying "✅ تم
// الرفع." and the transaction advancing to WAITING_HOSTING): startBridge()
// is called again via setTimeout on every reconnect (normal/expected with
// Baileys — sockets drop periodically). Each call used to register a FRESH
// setInterval(() => pollOutbox(sock), ...) bound to that call's `sock`
// WITHOUT ever clearing the previous one. After N reconnects there were N
// pollOutbox intervals running concurrently, several of them still
// capturing an OLD, already-dead `sock` — calling sock.sendMessage() on a
// dead socket is exactly what throws Baileys' "Connection Closed" (and
// sometimes a corrupted-session "Cannot destructure property 'user' of
// jidDecode(...)"). Production evidence: 104 of 130 group_outbox rows ever
// created (80%) ended in permanent 'failed', almost all "Connection
// Closed" — this was the silent, default behavior, not a rare edge case.
// Fix: track the ONE current interval handle at module scope and clear it
// before starting a new one, so there is only ever a single live
// pollOutbox interval, always bound to the CURRENT socket.
let outboxIntervalHandle = null
// The platform-wide ticks (message lists / knowledge base / follow-up) are
// started once per PROCESS lifetime, not once per reconnect — same root
// cause as above (each reconnect of bridge_number_id===1 was stacking a
// fresh trio of setIntervals on top of any already running).
let platformTicksStarted = false
// Group-resolve-jobs tick (2026-10-07): unlike the platform-wide ticks
// above, this one runs on EVERY bridge number's process (not just #1),
// since resolving requires trying the invite code against THIS specific
// number's own socket — but it still needs the same "clear before
// restart" guard as outboxIntervalHandle so a reconnect doesn't stack a
// second interval bound to a now-dead sock on top of the first.
let groupResolveIntervalHandle = null

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
          console.log(`📱 PAIRING CODE for ${PAIR_PHONE} (bridge_number_id=${BRIDGE_NUMBER_ID}): ${code}`)
          console.log('Open WhatsApp on that phone -> Linked Devices -> Link a Device -> Link with phone number instead, then enter this code.')
          console.log('=========================================\n')
          reportStatus('connecting', `pairing code issued for ${PAIR_PHONE}`, PAIR_PHONE)
        } catch (err) {
          console.error('Failed to request pairing code, falling back to QR:', err?.message)
          qrcodeTerminal.generate(qr, { small: true })
          reportStatus('connecting', 'pairing code failed, showing QR')
        }
      } else {
        console.log('\n📷 Scan this QR code with WhatsApp (Linked Devices -> Link a Device):\n')
        qrcodeTerminal.generate(qr, { small: true })
        reportStatus('connecting', 'awaiting QR scan')
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      logger.warn({ statusCode, loggedOut }, 'Connection closed')
      if (loggedOut) {
        console.error('❌ Logged out from WhatsApp. Delete auth_state/ and restart to re-link.')
        reportStatus('disconnected', 'logged out — needs re-pairing')
      } else {
        console.log('🔄 Reconnecting...')
        reportStatus('disconnected', `statusCode=${statusCode}, reconnecting`)
        setTimeout(startBridge, 3000)
      }
    } else if (connection === 'open') {
      pairingRequested = false
      console.log(`✅ Connected to WhatsApp successfully (bridge_number_id=${BRIDGE_NUMBER_ID}). Bridge is now listening for group messages.`)
      reportStatus('connected', null, sock.user?.id ? sock.user.id.split(':')[0] : undefined)
      // Start the outbox poller once the socket is actually connected —
      // every number's process polls its OWN filtered queue (see pollOutbox
      // above). Fix 2026-10-04: clear any previous interval FIRST so a
      // reconnect never leaves an old interval (bound to a now-dead sock)
      // running alongside the new one — see comment above startBridge().
      if (outboxIntervalHandle) clearInterval(outboxIntervalHandle)
      outboxIntervalHandle = setInterval(() => pollOutbox(sock), OUTBOX_POLL_INTERVAL_MS)

      // Group-resolve-jobs: runs on every number (see doc comment above
      // groupResolveIntervalHandle's declaration), always rebound to the
      // CURRENT sock on every (re)connect, same pattern as outbox above.
      if (groupResolveIntervalHandle) clearInterval(groupResolveIntervalHandle)
      groupResolveIntervalHandle = setInterval(() => tickGroupResolveJobs(sock), GROUP_RESOLVE_TICK_INTERVAL_MS)

      // The platform-wide scheduler ticks (message lists, knowledge base,
      // follow-up reminders) are NOT per-number — they operate across the
      // whole platform regardless of which bridge number ends up
      // delivering each result. Running them from every number's process
      // in a multi-number setup would fire each one multiple times
      // (duplicate broadcasts, duplicate analysis calls, duplicate
      // reminders). Only the default number (id=1, always the first one
      // configured) drives these; additional numbers (2, 3, ...) only
      // relay group messages + their own outbox. Fix 2026-10-04: guard with
      // platformTicksStarted so a reconnect of number 1 doesn't stack a
      // second/third/Nth trio of these intervals on top of the first.
      if (BRIDGE_NUMBER_ID === 1 && !platformTicksStarted) {
        platformTicksStarted = true
        setInterval(tickMessageLists, MESSAGE_LIST_TICK_INTERVAL_MS)
        setInterval(tickKnowledgeBase, KNOWLEDGE_BASE_TICK_INTERVAL_MS)
        setInterval(tickFollowUp, FOLLOW_UP_TICK_INTERVAL_MS)
      }
    } else if (connection === 'connecting') {
      reportStatus('connecting')
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
        // "الزمام" PDF/Excel/Word document the agent sends alongside the ID
        // photos (Smart Employee real-world field observation, 2026-10-02).
        // Stored as a plain attachment reference by the Worker — not OCR'd.
        const hasDocument = !!msg.message.documentMessage
        // WhatsApp sticker — real offices close a transaction by sending a
        // branded sticker (e.g. a green "ارفع المعاملة" sticker) rather than
        // typing a fixed phrase. We cannot read which sticker image was
        // sent, only that a stickerMessage arrived; the Worker treats any
        // sticker in an agent group as a close signal ONLY if the office
        // opted in via customers.se_accept_sticker_as_close (migration 0014).
        const hasSticker = !!msg.message.stickerMessage
        // Shared WhatsApp CONTACT card — office staff commonly share the
        // host's phone number as a contact card ("جهة اتصال") rather than
        // typing the digits. The vCard text embeds the number as a TEL
        // line (e.g. "TEL;type=CELL;waid=9665...:+966 5X XXX XXXX") — the
        // Worker extracts the number from the raw vcard text the same way
        // it already extracts phone numbers from free text.
        const contactMsg = msg.message.contactMessage
        const hasContact = !!contactMsg

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
            mime_type: mimeType,
            // Caption text, used by the Smart Employee supplier-image
            // handler to match a transaction code mentioned alongside the
            // photo (e.g. "UMR-260001" as the image caption). Harmless/
            // unused by the regular passport-extraction group path.
            text: msg.message.imageMessage?.caption || ''
          })
          if (reply) {
            await sock.sendMessage(remoteJid, { text: reply })
          }
        } else if (hasDocument) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const base64 = buffer.toString('base64')
          const doc = msg.message.documentMessage
          const reply = await forwardToWorker({
            group_jid: remoteJid,
            group_name: groupName,
            sender_jid: senderJid,
            type: 'document',
            document_base64: base64,
            mime_type: doc?.mimetype || 'application/octet-stream',
            filename: doc?.fileName || 'document',
            text: doc?.caption || ''
          })
          if (reply) {
            await sock.sendMessage(remoteJid, { text: reply })
          }
        } else if (hasSticker) {
          const reply = await forwardToWorker({
            group_jid: remoteJid,
            group_name: groupName,
            sender_jid: senderJid,
            type: 'sticker'
          })
          if (reply) {
            await sock.sendMessage(remoteJid, { text: reply })
          }
        } else if (hasContact) {
          const reply = await forwardToWorker({
            group_jid: remoteJid,
            group_name: groupName,
            sender_jid: senderJid,
            type: 'text',
            // Send the raw vcard text — the Worker's existing phone-number
            // regex (extractHostPhone) already scans free text for digit
            // runs, and a vcard's TEL line matches that pattern directly,
            // so no extra parsing is needed on either side.
            text: contactMsg?.vcard || ''
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
