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

const router = express.Router();

// In-memory pair status: sessionKey → { done, error }
const pairStatus = new Map();

function removeFolder(folderPath) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// GET /code?number=... or POST /api/pair { phoneNumber } — generate pairing code
async function generatePairingCode(req, res) {
  metrics.increment('pairStarts');
  const id = makeid();
  const sessionKey = makeid(10);
  const tempDir = path.join(os.tmpdir(), 'mking-temp', id);
  
  // FIXED: Make sure /tmp/mking-temp exists
  const baseTemp = path.join(os.tmpdir(), 'mking-temp');
  if (!fs.existsSync(baseTemp)) fs.mkdirSync(baseTemp, { recursive: true });
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const phoneNumber = (req.query.number || req.body?.phoneNumber || req.body?.number || '').replace(/\D/g, '');

  if (!phoneNumber || phoneNumber.length < 7) {
    return res.status(400).json({ error: 'Please provide a valid phone number with country code.' });
  }

  pairStatus.set(sessionKey, { done: false, error: null });

  let pairingCodeSent = false;
  let sessionDone = false;

  async function createSocketSession() {
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
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        if (sessionDone) return;
        sessionDone = true;

        await delay(4000);

        try {
          const credsPath = path.join(tempDir, 'creds.json');
          const sessionData = fs.readFileSync(credsPath, 'utf8');
          const encoded = Buffer.from(sessionData).toString('base64');
          const decoded = sessionData;

          // Store for polling + download
          sessions.set(sessionKey, encoded, decoded);
          metrics.increment('sessionsCreated');
          pairStatus.set(sessionKey, { done: true, error: null });

          await sock.sendMessage(sock.user.id, {
            text: `👑 *M-KING BOT V1 — SESSION_ID*\n\n${encoded}\n\nPaste as SESSION_ID= in your bot's .env file.\nOwner: Mursalin King\n\n⚠️ Never share it.`
          });
          await sock.sendMessage(sock.user.id, {
            document: Buffer.from(decoded, 'utf8'),
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: '📄 M-KING creds.json — keep this file private.'
          });

          console.log(`✅ M-KING Pair session created for ${sock.user.id}`);
        } catch (err) {
          metrics.increment('errors');
          console.error('Session send error:', err.message);
          pairStatus.set(sessionKey, { done: true, error: err.message });
          try {
            await sock.sendMessage(sock.user.id, {
              text: `❌ Error creating session: ${err.message}`
            });
          } catch (_) {}
        } finally {
          await delay(1500);
          try { await sock.ws.close(); } catch (_) {}
          removeFolder(tempDir);
        }

      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === 401) {
          removeFolder(tempDir);
        } else if (!sessionDone) {
          await delay(2000);
          createSocketSession().catch(() => removeFolder(tempDir));
        }
      }
    });

    if (!sock.authState.creds.registered) {
      await delay(3000);
      try {
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        if (!pairingCodeSent && !res.headersSent) {
          pairingCodeSent = true;
          const code = String(pairingCode).replace(/\s/g, '');
          return res.json({ ok: true, code, pairingCode: code, sessionKey, pollUrl: `/api/pair/poll/${sessionKey}`, expiresIn: 600 });
        }
      } catch (err) {
        console.error('Pairing code error:', err.message);
        pairStatus.delete(sessionKey);
        if (!res.headersSent) {
          const msg = err.message?.includes('rate-limit') || err.message?.includes('rate limit')
            ? 'Too many requests from this server. Please wait 60 seconds and try again.'
            : 'Could not generate pairing code. Make sure your number is correct and try again.';
          return res.status(500).json({ error: msg });
        }
      }
    }
  }

  try {
    await createSocketSession();
  } catch (err) {
    metrics.increment('errors');
    console.error('Fatal session error:', err.message);
    removeFolder(tempDir);
    pairStatus.delete(sessionKey);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Service unavailable. Please try again later.' });
    }
  }
}

router.get('/', generatePairingCode);
router.post('/', generatePairingCode);

// GET /code/poll/:key or /api/pair/poll/:key — check if pair session is done
router.get('/poll/:key', (req, res) => {
  const { key } = req.params;
  const status = pairStatus.get(key);
  if (!status) return res.json({ done: false, expired: true });

  if (status.done) {
    const sess = sessions.get(key);
    return res.json({
      done: true,
      encoded: sess ? sess.encoded : null,
      decoded: sess ? sess.decoded : null,
      error: status.error || null
    });
  }

  res.json({ done: false });
});

module.exports = router;
