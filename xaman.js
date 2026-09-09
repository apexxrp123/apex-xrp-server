/**
 * Xaman / Xumm SignIn helpers (Testnet only).
 * Requires env: XUMM_API_KEY, XUMM_API_SECRET
 */
const XUMM_API = "https://xumm.app/api/v1/platform";

function keysConfigured() {
  return !!(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
}

async function xummFetch(path, opts = {}) {
  const key = process.env.XUMM_API_KEY;
  const secret = process.env.XUMM_API_SECRET;
  if (!key || !secret) {
    const err = new Error("XUMM_API_KEY/SECRET not configured");
    err.code = "NO_KEYS";
    throw err;
  }
  const res = await fetch(XUMM_API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      "X-API-Secret": secret,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || body.message || ("Xumm HTTP " + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function isClassicAddress(addr) {
  return typeof addr === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr);
}

function looksTestnet(meta, response) {
  const candidates = [
    meta && meta.network,
    meta && meta.force_network,
    response && response.network,
    response && response.environment,
    meta && meta.resolved_destination,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
  if (candidates.some((c) => c.includes("main") || c === "mainnet")) return false;
  if (candidates.some((c) => c.includes("test") || c.includes("altnet"))) return true;
  return true;
}

async function createSignIn() {
  const created = await xummFetch("/payload", {
    method: "POST",
    body: JSON.stringify({
      txjson: { TransactionType: "SignIn" },
      options: {
        submit: false,
        expire: 5,
        force_network: "TESTNET",
      },
      custom_meta: {
        instruction: "Apex.XRP den — Testnet SignIn only. Mainnet send is off.",
      },
    }),
  });
  const uuid = created.uuid;
  const refs = created.refs || {};
  const next = created.next || {};
  return {
    uuid,
    qr: refs.qr_png || refs.qr_uri || null,
    deepLink: next.always || refs.deeplink_web || (uuid ? "https://xumm.app/sign/" + uuid : null),
    push: next.no_push_msg_received || null,
  };
}

async function getSignIn(uuid) {
  const data = await xummFetch("/payload/" + encodeURIComponent(uuid), { method: "GET" });
  const meta = data.meta || {};
  const response = data.response || {};

  if (meta.expired) {
    return { ok: false, reason: "Xaman sign-in cancelled" };
  }
  if (meta.cancelled) {
    return { ok: false, reason: "Xaman sign-in cancelled" };
  }
  if (!meta.resolved) {
    return { ok: false, pending: true, reason: "waiting" };
  }
  if (!meta.signed) {
    return { ok: false, reason: "Xaman sign-in cancelled" };
  }

  if (!looksTestnet(meta, response)) {
    return { ok: false, reason: "Testnet only. Mainnet send is off." };
  }

  const address = response.account || response.signer || null;
  if (!isClassicAddress(address)) {
    return { ok: false, reason: "That is not a classic XRP address." };
  }

  return { ok: true, address };
}

module.exports = {
  keysConfigured,
  createSignIn,
  getSignIn,
};
