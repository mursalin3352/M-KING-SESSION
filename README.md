# M-KING-BOT V1 — Session ID Generator

A web app that generates your WhatsApp `SESSION_ID` for M-KING BOT V1 using QR code or phone-number pairing.

---

## How It Works

1. User enters their WhatsApp number on the website
2. A pairing code is shown — they enter it in WhatsApp under **Linked Devices → Link with phone number**
3. The bot connects and sends the `SESSION_ID` directly to their own WhatsApp chat
4. User copies the `SESSION_ID` into their bot's `.env` file

---

## Deploy on Render

1. Push this `session_generator/` folder as its own GitHub repo (or use a sub-path deploy)
2. Create a new **Web Service** on [Render](https://render.com)
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Create or attach a Render PostgreSQL database to the Web Service.
5. Add `DATABASE_URL` using the database's **Internal Database URL**. Render exposes `PORT` automatically.
6. Optional locally: set `DATABASE_SSL=disable` for a non-SSL local PostgreSQL server.
7. Deploy. The app creates the `mking_site_settings` table automatically and keeps admin branding/maintenance settings across redeploys.

---

## Run Locally

```bash
cd session_generator
npm install
npm start
# Open http://localhost:3000
```

---

## Deploy Anywhere Else

The app needs **Node.js 18+**, reads `PORT` from the environment (defaults to `3000`), and uses `DATABASE_URL` for persistent admin settings.

Works on: Render · Railway · Heroku · Koyeb · VPS

---

## Project Structure

```
session_generator/
├── index.js        → Express entry point
├── pair.js         → WhatsApp Baileys pairing logic
├── gen-id.js       → random temp-folder ID helper
├── public/
│   └── index.html  → frontend UI
├── package.json
├── .env.example
└── .gitignore
```

---

## Notes

- `SESSION_ID` generated here is plain base64 — compatible with M-KING-BOT-V1's `.env` format
- Each pairing creates a temp folder under `temp/` that is deleted automatically after the session is created
- The app does **not** store or log any session data

## Operational endpoints

- `GET /healthz` — lightweight health check for Render or uptime monitors.
- `GET /status` — public pairing-service status used by the website.
- `/unknownofrun` — password-protected admin console for maintenance, branding, and live metrics.
- `POST /api/pair` — bot API that accepts a phone number and returns an 8-character Pair Code.
- `GET /api/pair/poll/:sessionKey` — poll the API session until the WhatsApp connection is complete.
- `/api` — public API showcase and interactive documentation page.

The service also applies security headers, per-IP pairing throttling, automatic cleanup of stale temporary folders, automatic session expiry, and a maintenance screen that pauses new pairing sessions.

## Bot Pair Code API

Request a code with JSON:

```bash
curl -X POST https://your-render-service.onrender.com/api/pair \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"923292460360"}'
```

The response includes `code`/`pairingCode`, `sessionKey`, `pollUrl`, and `expiresIn`:

```json
{
  "ok": true,
  "code": "AB12CD34",
  "pairingCode": "AB12CD34",
  "sessionKey": "examplekey",
  "pollUrl": "/api/pair/poll/examplekey",
  "expiresIn": 600
}
```

Enter the returned eight-character code in WhatsApp under **Linked Devices → Link with phone number instead**, then poll the returned URL. When complete, the poll response contains `encoded` (the `SESSION_ID`) and `decoded` (the raw `creds.json` content). The API is protected by the same per-IP rate limit as the website; keep the endpoint private or place an API gateway/authentication layer in front of it for production bot use.
