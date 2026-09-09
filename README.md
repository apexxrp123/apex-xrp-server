# apex-xrp-server

Den / WebSocket match server for Apex.XRP.

## Env (Railway)

- `PORT` — set by Railway
- `XUMM_API_KEY` — Xumm/Xaman app API key (required for `/xaman/signin`)
- `XUMM_API_SECRET` — Xumm/Xaman app API secret (server only)

Create a Testnet-capable app at https://apps.xumm.dev

## Step 1 routes

- `POST /xaman/signin` → `{ uuid, qr, deepLink, push }`
- `GET /xaman/signin/:uuid` → `{ ok:true, address }` or `{ ok:false, reason }` / `{ pending:true }`

Without XUMM keys these routes return **503** `{ ok:false, reason:"XUMM_API_KEY/SECRET not configured" }`. Existing den/WS routes still work.
