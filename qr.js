const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pino = require('pino');
const sessions = require('./sessions');
const metrics = require('./metrics');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  delay,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// optional server-side QR->PNG generator (best-effort)
let qrcodeLib = null;
try {
  qrcodeLib = require('qrcode');
} catch (err) {
  qrcodeLib = null;
}

const router = express.Router();

// In-memory QR state: key → { qr, qrDataUrl?, status, message }
const qrStore = new Map();
const QR_TTL_MS = 5 * 60 * 1000;

function cleanup(key, tempDir) {
  qrStore.delete(key);
  try {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
}

// POST /qr/start — kick off a QR session
router.post('/start', async (req, res) => {
  metrics.increment('qrStarts');
  const key = makeid(10);
  const baseTemp = path.join(os.tmpdir(), 'mking-temp');
  if (!fs.existsSync(baseTemp)) fs.mkdirSync(baseTemp, { recursive: true });
  const tempDir = path.join(baseTemp, key);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  qrStore.set(key, { status: 'pending', qr: null, qrDataUrl: null, message: null });

  setTimeout(() => {
    if (qrStore.has(key)) cleanup(key, tempDir);
  }, QR_TTL_MS);

  res.json({ sessionKey: key });

  startQRSession(key, tempDir).catch((err) => {
    metrics.increment('errors');
    const entry = qrStore.get(key);
    if (entry) qrStore.set(key, { ...entry, status: 'error', message: err.message });
  });
});

// GET /qr/poll/:key — frontend polls this
router.get('/poll/:key', (req, res) => {
  const { key } = req.params;
  const entry = qrStore.get(key);
  if (!entry) return res.json({ status: 'expired' });

  if (entry.status === 'done') {
    const sess = sessions.get(key);
    return res.json({
      status: 'done',
      encoded: sess ? sess.encoded : null,
      decoded: sess ? sess.decoded : null
    });
  }

  return res.json(entry);
});

async function startQRSession(key, tempDir) {
  let sessionDone = false;

  const { state, saveCreds } = await useMultiFileAuthState(tempDir);
  const logger = pino({ level: 'fatal' }).child({ level: 'fatal' });
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    logger,
    syncFullHistory: false,
    browser: Browsers.ubuntu('Chrome'),
    keepAliveIntervalMs: 10000,
    connectTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      let qrStr = null;
      try {
        if (typeof qr === 'string') qrStr = qr.trim();
        else if (qr && typeof qr.toString === 'function') qrStr = qr.toString().trim();
        else qrStr = String(qr).trim();
      } catch (_) {
        qrStr = null;
      }

      if (qrStr && qrcodeLib) {
        try {
          const dataUrl = await qrcodeLib.toDataURL(qrStr, { width: 300, margin: 1 });
          qrStore.set(key, { status: 'qr', qr: qrStr, qrDataUrl: dataUrl, message: null });
        } catch (err) {
          qrStore.set(key, { status: 'qr', qr: qrStr, qrDataUrl: null, message: null });
        }
      } else {
        qrStore.set(key, { status: 'qr', qr: qrStr, qrDataUrl: null, message: null });
      }
    }

    if (connection === 'open') {
      if (sessionDone) return;
      sessionDone = true;
      qrStore.set(key, { status: 'connected', qr: null, qrDataUrl: null, message: null });

      await delay(4000);

      try {
        const credsPath = path.join(tempDir, 'creds.json');
        const sessionData = fs.readFileSync(credsPath, 'utf8');
        const encoded = Buffer.from(sessionData).toString('base64');
        const decoded = sessionData;

        sessions.set(key, encoded, decoded);
        metrics.increment('sessionsCreated');

        qrStore.set(key, { status: 'done', qr: null, qrDataUrl: null, message: null });

        await sock.sendMessage(sock.user.id, {
          text: `👑 *M-KING BOT V1 — SESSION_ID*\n\n${encoded}\n\nPaste as SESSION_ID= in your bot's .env file.\nOwner: Mursalin King\n\n⚠️ Never share it.`
        });
        await sock.sendMessage(sock.user.id, {
          document: Buffer.from(decoded, 'utf8'),
          mimetype: 'application/json',
          fileName: 'creds.json',
          caption: '📄 M-KING creds.json — keep this file private.'
        });

        console.log(`✅ M-KING QR session created for ${sock.user.id}`);
      } catch (err) {
        console.error('QR session send error:', err.message);
        qrStore.set(key, { status: 'error', qr: null, qrDataUrl: null, message: 'Session created but send failed.' });
      } finally {
        await delay(1500);
        try { await sock.ws.close(); } catch (_) {}
        setTimeout(() => cleanup(key, tempDir), QR_TTL_MS);
      }

    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 401) {
        cleanup(key, tempDir);
      } else if (!sessionDone) {
        await delay(2000);
        const entry = qrStore.get(key);
        if (entry && entry.status !== 'done') {
          qrStore.set(key, { status: 'pending', qr: null, qrDataUrl: null, message: null });
        }
      }
    }
  });
}

module.exports = router;
