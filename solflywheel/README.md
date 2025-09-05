# Flywheel Basic (Drop & Upload)

This is the simplest setup:
- `backend/` → Node/Express server with 20‑minute cron, Jupiter swap, SPL burn/incinerate, public metrics API.
- `public/` → Plain HTML+JS dashboard (no React). Drag this folder into **Netlify Drop** (or any static host).

## Deploy steps (fast)
1) **Backend** (Render Web Service or any Node host)
   - Create a new Web Service from the `backend/` folder.
   - Build: `npm install`
   - Start: `npm start`
   - Set env vars from `backend/.env.example` in your host dashboard.
   - After deploy, note your backend URL (e.g., `https://your-api.onrender.com`).

2) **Frontend**
   - Open **https://app.netlify.com/drop** and drag the **`public/`** folder.
   - After it uploads, click **Site settings → Environment** and add:
     - `BACKEND_BASE_URL` = your backend URL (e.g., `https://your-api.onrender.com`)
   - (Alternatively, edit `public/config.js` and hardcode your backend URL, then re-upload.)

3) **CORS (backend)**
   - In your backend env var `FRONTEND_ORIGIN`, add your Netlify site domain (comma‑separated if multiple).

4) **Use it**
   - Visit your public site → Click **Connect** (Phantom) → Press **Start** (dev wallet only).
   - Every 20 minutes the backend buys then burns/sends tokens.
   - The table shows totals and **Solscan links** for verification.

## Env (backend/.env)
See `backend/.env.example` for all options. Key ones:
- `RPC_URL` — Solana RPC
- `TARGET_MINT` — token mint
- `ALLOWED_PUBKEY` — dev wallet pubkey (only this wallet can start/stop)
- `DEV_WALLET_KEYPAIR` or `DEV_WALLET_SECRET_KEY`
- `FEE_RESERVE_SOL`, `MIN_SPEND_SOL`, `MAX_SPEND_SOL`, `SLIPPAGE_BPS`, `BURN_MODE`
- `FRONTEND_ORIGIN` — allowed frontend origins (CORS), comma-separated.

**Security**: Host the backend yourself, keep keys off Git, prefer keypair file on disk.
