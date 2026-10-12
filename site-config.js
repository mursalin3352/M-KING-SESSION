const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const dataDir = path.join(__dirname, 'data');
const configPath = path.join(dataDir, 'site-config.json');
const defaults = {
  siteName: 'M-KING BOT V1',
  tagline: 'By Mursalin-King 👑 | Your session. Your control.',
  maintenance: false
};

let pool = null;
let current = {...defaults };

function sanitize(next) {
  const requestedName = String(next.siteName || defaults.siteName).trim();
  // Purana Daratech naam aaye to auto M-KING bana do
  const siteName = requestedName.includes('DARATECH')? defaults.siteName : requestedName;
  return {
    siteName: siteName.slice(0, 60) || defaults.siteName,
    tagline: String(next.tagline || defaults.tagline).trim().slice(0, 120) || defaults.tagline,
    maintenance: Boolean(next.maintenance)
  };
}

function readLocal() {
  try { return sanitize({...defaults,...JSON.parse(fs.readFileSync(configPath, 'utf8')) }); }
  catch (_) { return {...defaults }; }
}

function writeLocal(next) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const safe = sanitize(next);
  fs.writeFileSync(configPath, JSON.stringify(safe, null, 2) + '\n');
  return safe;
}

async function init() {
  if (!process.env.DATABASE_URL) {
    current = readLocal();
    console.warn('⚠ DATABASE_URL is not configured; admin settings use the local development fallback.');
    return current;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable'? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mking_site_settings (
      id INTEGER PRIMARY KEY,
      site_name VARCHAR(60) NOT NULL,
      tagline VARCHAR(120) NOT NULL,
      maintenance BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const result = await pool.query('SELECT site_name, tagline, maintenance FROM mking_site_settings WHERE id = 1');
  if (result.rowCount === 0) {
    current = {...defaults };
    await pool.query('INSERT INTO mking_site_settings (id, site_name, tagline, maintenance) VALUES (1, $1, $2, $3)', [current.siteName, current.tagline, current.maintenance]);
  } else {
    current = sanitize({ siteName: result.rows[0].site_name, tagline: result.rows[0].tagline, maintenance: result.rows[0].maintenance });
  }
  console.log('✅ M-KING Admin settings database connected');
  return current;
}

function read() { return {...current }; }

async function write(next) {
  const safe = sanitize(next);
  if (!pool) {
    current = writeLocal(safe);
    return {...current };
  }
  const result = await pool.query(
    `UPDATE mking_site_settings SET site_name = $1, tagline = $2, maintenance = $3, updated_at = NOW() WHERE id = 1 RETURNING site_name, tagline, maintenance`,
    [safe.siteName, safe.tagline, safe.maintenance]
  );
  current = sanitize({ siteName: result.rows[0].site_name, tagline: result.rows[0].tagline, maintenance: result.rows[0].maintenance });
  return {...current };
}

async function close() { if (pool) await pool.end(); }

module.exports = { init, read, write, close, defaults };
