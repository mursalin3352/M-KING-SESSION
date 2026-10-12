require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sessions = require('./sessions');
const metrics = require('./metrics');
const siteConfig = require('./site-config');

const app = express();
const pairRouter = require('./pair');
const qrRouter = require('./qr');
const PORT = process.env.PORT || 3000;
const tempDir = path.join(os.tmpdir(), 'mking-temp');
const rateWindowMs = 60 * 1000;
const rateLimit = 12;
const requestBuckets = new Map();
const adminSessions = new Map();
const ADMIN_ROUTE = '/unknownofrun';
const ADMIN_PASSWORD = 'M-KING@2025';

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

app.set('trust proxy', 1);
app.use((req, res, next) => {
  metrics.increment('requests');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors());
app.use(express.json({ limit: '32kb' }));

function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function throttlePairing(req, res, next) {
  if (req.path.startsWith('/poll/')) return next();
  const key = `${clientIp(req)}:${req.baseUrl === '/qr'? 'qr' : 'pair'}`;
  const now = Date.now();
  const recent = (requestBuckets.get(key) || []).filter(timestamp => now - timestamp < rateWindowMs);
  if (recent.length >= rateLimit) { metrics.increment('blockedRequests'); res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' }); }
  recent.push(now); requestBuckets.set(key, recent); next();
}
function adminToken(req) { const raw = req.headers.cookie || ''; const match = raw.match(/mking_admin=([^;]+)/); return match? match[1] : null; }
function isAdmin(req) { const token = adminToken(req); return token && adminSessions.has(token); }
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Admin authentication required.' }); next(); }

app.get('/healthz', (req, res) => res.json({ ok: true, service: siteConfig.read().siteName, uptime: metrics.snapshot().uptimeSeconds }));
app.get('/status', (req, res) => { const config = siteConfig.read(); res.json({ ok:!config.maintenance, service: config.siteName, message: config.maintenance? 'Website is temporarily under maintenance.' : 'Pairing service is operational.', checkedAt: new Date().toISOString() }); });
app.get('/site-config', (req, res) => { const config = siteConfig.read(); res.setHeader('Cache-Control', 'no-store'); res.json({ siteName: config.siteName, tagline: config.tagline, maintenance: config.maintenance }); });

app.get(`${ADMIN_ROUTE}`, (req, res) => { if (isAdmin(req)) return res.redirect(`${ADMIN_ROUTE}/dashboard`); res.sendFile(path.join(__dirname, 'public', 'admin-login.html')); });
app.post(`${ADMIN_ROUTE}/login`, (req, res) => {
  if (req.body?.password!== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid credentials.' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `mking_admin=${token}; HttpOnly; SameSite=Strict; Path=${ADMIN_ROUTE}; Max-Age=28800${req.secure? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post(`${ADMIN_ROUTE}/logout`, (req, res) => { const token = adminToken(req); if (token) adminSessions.delete(token); res.setHeader('Set-Cookie', `mking_admin=; HttpOnly; SameSite=Strict; Path=${ADMIN_ROUTE}; Max-Age=0`); res.json({ ok: true }); });
app.get(`${ADMIN_ROUTE}/dashboard`, (req, res) => { if (!isAdmin(req)) return res.redirect(ADMIN_ROUTE); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get(`${ADMIN_ROUTE}/api/settings`, requireAdmin, (req, res) => res.json(siteConfig.read()));
app.put(`${ADMIN_ROUTE}/api/settings`, requireAdmin, async (req, res) => {
  try { res.json(await siteConfig.write({...siteConfig.read(),...req.body })); }
  catch (error) { console.error('Settings update error:', error.message); res.status(500).json({ error: 'Could not save settings.' }); }
});
app.get(`${ADMIN_ROUTE}/api/metrics`, requireAdmin, (req, res) => res.json(metrics.snapshot()));

app.use('/code', (req, res, next) => { const config = siteConfig.read(); if (config.maintenance) return res.status(503).json({ error: 'Website is under maintenance. Please try again later.' }); next(); }, throttlePairing, pairRouter);
app.use('/api/pair', (req, res, next) => { const config = siteConfig.read(); if (config.maintenance) return res.status(503).json({ error: 'Website is under maintenance. Please try again later.' }); next(); }, throttlePairing, pairRouter);
app.use('/qr', (req, res, next) => { const config = siteConfig.read(); if (config.maintenance) return res.status(503).json({ error: 'Website is under maintenance. Please try again later.' }); next(); }, throttlePairing, qrRouter);

app.get('/download/:key', (req, res) => {
  const { key } = req.params; const type = (req.query.type || 'encoded').toLowerCase(); const sess = sessions.get(key);
  if (!sess) return res.status(404).json({ error: 'Session not found or expired.' });
  let content, filename;
  if (type === 'decoded') { try { content = JSON.stringify(JSON.parse(sess.decoded), null, 2); } catch (_) { content = sess.decoded; } filename = `mking-session-decoded-${key}.txt`; }
  else { content = `M-KING BOT V1 — SESSION ID (Encoded / Base64)\n============================================\nGenerated: ${new Date().toUTCString()}\nOwner: Mursalin King\n\nPaste this value into your.env file:\nSESSION_ID=${sess.encoded}\n\n⚠ Never share this file with anyone.\n`; filename = `mking-session-encoded-${key}.txt`; }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); res.send(content);
});

app.get(['/api', '/api-docs'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'api.html')));
app.get('/', (req, res) => {
  if (siteConfig.read().maintenance) return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('*', (req, res) => {
  if (siteConfig.read().maintenance &&!req.path.startsWith(ADMIN_ROUTE)) return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const cleanupTemp = () => { const cutoff = Date.now() - 20 * 60 * 1000; try { for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) { if (!entry.isDirectory()) continue; const folder = path.join(tempDir, entry.name); if (fs.statSync(folder).mtimeMs < cutoff) fs.rmSync(folder, { recursive: true, force: true }); } } catch (error) { console.error('Temp cleanup error:', error.message); } };
setInterval(cleanupTemp, 10 * 60 * 1000).unref();
setInterval(() => { const now = Date.now(); for (const [token, expires] of adminSessions) if (expires < now) adminSessions.delete(token); }, 15 * 60 * 1000).unref();
cleanupTemp();
siteConfig.init()
 .then(() => app.listen(PORT, () => console.log(`✅ ${siteConfig.read().siteName} running on port ${PORT}`)))
 .catch(error => { console.error('❌ Settings database initialization failed:', error); process.exit(1); });
module.exports = app;
