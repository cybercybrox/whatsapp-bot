import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import axios from 'axios'
import 'dotenv/config'
import fs from 'fs'
import path from 'path'

// ============ CONFIG ============
const PHONE_NUMBER = process.env.PHONE_NUMBER
const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, '')
const SESSION_DATA = process.env.SESSION_DATA || ''
const AUTH_FOLDER = './auth_info'

const logger = pino({ level: 'silent' })
let pairingCodeRequested = false

// ============ SESSION RESTORE ============
// If SESSION_DATA is set, restore the auth_info folder from base64
function restoreSession() {
  if (!SESSION_DATA) {
    console.log('ℹ️ No SESSION_DATA found — fresh login needed')
    return
  }
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true })

    const decoded = Buffer.from(SESSION_DATA, 'base64').toString('utf-8')
    const files = JSON.parse(decoded)

    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(AUTH_FOLDER, filename), content)
    }
    console.log('✅ Session restored from SESSION_DATA')
  } catch (err) {
    console.log('❌ Failed to restore session:', err.message)
  }
}

// ============ SESSION EXPORT ============
// After login, print base64 so you can paste into Render env var
function exportSession() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return

    const files = {}
    for (const f of fs.readdirSync(AUTH_FOLDER)) {
      const full = path.join(AUTH_FOLDER, f)
      if (fs.statSync(full).isFile()) {
        files[f] = fs.readFileSync(full, 'utf-8')
      }
    }

    const base64 = Buffer.from(JSON.stringify(files)).toString('base64')

    console.log('\n========== SESSION_DATA (copy this!) ==========')
    console.log(base64)
    console.log('================================================')
    console.log('👆 Paste this in Render env var: SESSION_DATA')
    console.log('================================================\n')
  } catch (err) {
    console.log('Export failed:', err.message)
  }
}

// ============ FIREBASE PUSH ============
async function pushToFirebase(payload) {
  if (!FIREBASE_URL) {
    console.log('❌ FIREBASE_URL missing')
    return
  }
  const url = `${FIREBASE_URL}/messages/${payload.message_id}_${payload.chat_id}.json`
  try {
    const res = await axios.put(url, payload, { timeout: 10000 })
    console.log(`🔥 Firebase OK (${res.status})`)
  } catch (err) {
    console.log(`❌ Firebase fail: ${err.message}`)
  }
}

function cleanJid(jid) {
  return jid?.split('@')[0]?.split(':')[0] || 'unknown'
}

// ============ MAIN BOT ============
async function startBot() {
  restoreSession()

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,   // 👈 keeps you always online
    keepAliveIntervalMs: 30000,  // 👈 heartbeat
  })

  // Pairing code
  if (!sock.authState.creds.registered && !pairingCodeRequested) {
    pairingCodeRequested = true

    if (!PHONE_NUMBER) {
      console.log('❌ PHONE_NUMBER missing')
      process.exit(1)
    }

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER)
        console.log('\n========================================')
        console.log('🔑 PAIRING CODE:', code)
        console.log('========================================')
        console.log('📱 WhatsApp → Linked Devices →')
        console.log('👉 Link with phone number instead')
        console.log('👉 Enter code above (fast! ~60s)')
        console.log('========================================\n')
      } catch (err) {
        console.log('❌ Pairing failed:', err.message)
      }
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('⚠️ Closed. Reconnect:', shouldReconnect)

      if (shouldReconnect) {
        pairingCodeRequested = false
        setTimeout(() => startBot(), 5000)
      } else {
        console.log('🚪 Logged out. Delete auth_info + SESSION_DATA')
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp ONLINE 🎉')
      console.log('💡 If this is first login, wait 10s then copy SESSION_DATA from logs')
      setTimeout(exportSession, 10000)
    }
  })

  // Incoming messages → Firebase
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid
    if (!from) return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      ''

    if (!text) return

    const pushName = msg.pushName || cleanJid(from)
    const now = new Date()

    const payload = {
      message_id: msg.key.id,
      chat_id: from,
      chat_name: pushName,
      sender_name: pushName,
      text: text,
      date: now.toISOString().split('T')[0],
      time: now.toTimeString().split(' ')[0],
      platform: 'whatsapp',
    }

    console.log(`📨 ${pushName}: ${text.slice(0, 50)}`)
    await pushToFirebase(payload)
  })
}

// Keep process alive on errors
process.on('uncaughtException', (e) => console.log('💥 Uncaught:', e.message))
process.on('unhandledRejection', (e) => console.log('💥 Rejection:', e))

startBot().catch((err) => console.log('💥 Fatal:', err))
