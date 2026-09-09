/**
 * Xaman / Xumm SignIn + Payment lock helpers (Testnet only).
 * Requires env: XUMM_API_KEY, XUMM_API_SECRET
 */
const XUMM_API = "https://xumm.app/api/v1/platform";
const XRPL_RPC_TESTNET = "https://s.altnet.rippletest.net:51234";
const XRPL_WS_TESTNET = "wss://s.altnet.rippletest.net:51233";

function keysConfigured() {
  return !!(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
}

function formatXummErr(body, status) {
  const raw = body && (body.error != null ? body.error : body.message);
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 200);
  if (raw && typeof raw === "object") {
    const parts = [raw.message, raw.reference, raw.code, raw.error]
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim());
    if (parts.length) return parts.join(" — ").slice(0, 200);
    try {
      return JSON.stringify(raw).slice(0, 200);
    } catch (_) {}
  }
  if (body && typeof body.code === "string") return body.code;
  return "Xumm HTTP " + status;
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
    const err = new Error(formatXummErr(body, res.status));
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


async function cancelPayload(uuid) {
  if (!uuid || typeof uuid !== "string") return { cancelled: false, reason: "no-uuid" };
  try {
    const body = await xummFetch("/payload/" + encodeURIComponent(uuid), { method: "DELETE" });
    const result = (body && body.result) || {};
    return { cancelled: !!result.cancelled, reason: result.reason || "OK", meta: body && body.meta };
  } catch (e) {
    return { cancelled: false, reason: (e && e.message) || "cancel failed" };
  }
}

function payloadUuidFromErr(msg) {
  const m = String(msg || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

const MAX_PAYLOAD_TIP =
  "Xumm open-payload cap — reject hanging Apex prompts in Xaman on both phones, or swap to fresh API keys at apps.xumm.dev";

async function recoverMaxPayloads(msg, tried) {
  const victim = payloadUuidFromErr(msg);
  if (!victim) {
    const err = new Error(MAX_PAYLOAD_TIP);
    err.code = "MAX_PAYLOADS";
    throw err;
  }
  if (tried.has(victim)) {
    // Same UUID cited again — no new victims to cancel.
    const err = new Error(MAX_PAYLOAD_TIP + " (stuck on " + victim.slice(0, 8) + "…)");
    err.code = "MAX_PAYLOADS";
    throw err;
  }
  tried.add(victim);
  const cancel = await cancelPayload(victim);
  console.warn("[xaman] Max payloads — cancel", victim, cancel.cancelled, cancel.reason);
  // Even if this UUID is uncancellable (opened/expired/resolved), keep looping:
  // the next POST often cites a *different* open payload we can free.
  return !!cancel.cancelled;
}

async function createSignIn() {
  let lastErr;
  const tried = new Set();
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const created = await xummFetch("/payload", {
        method: "POST",
        body: JSON.stringify({
          txjson: { TransactionType: "SignIn" },
          options: {
            submit: false,
            expire: 2,
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
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || "");
      if (!/Max payloads/i.test(msg)) throw e;
      const freed = await recoverMaxPayloads(msg, tried);
      if (!freed) await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr || new Error(MAX_PAYLOAD_TIP);
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

async function createPaymentLock({ destination, amountDrops, account }) {
  if (!isClassicAddress(destination)) {
    const err = new Error("Invalid destination");
    err.code = "BAD_DEST";
    throw err;
  }
  const drops = String(amountDrops);
  const txjson = {
    TransactionType: "Payment",
    Destination: destination,
    Amount: drops,
  };
  // Do not set Account — Xaman fills the signer. Optional account is only for expect checks later.
  void account;

  let lastErr;
  let created;
  const tried = new Set();
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      created = await xummFetch("/payload", {
        method: "POST",
        body: JSON.stringify({
          txjson,
          options: {
            submit: true,
            expire: 2,
            force_network: "TESTNET",
          },
          custom_meta: {
            instruction: "Apex Jungle buy-in — 1 XRP Testnet to pot. Mainnet send is off.",
          },
        }),
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || "");
      if (!/Max payloads/i.test(msg)) throw e;
      const freed = await recoverMaxPayloads(msg, tried);
      if (!freed) await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!created) throw lastErr || new Error(MAX_PAYLOAD_TIP);
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

async function xrplTx(hash) {
  const res = await fetch(XRPL_RPC_TESTNET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "tx",
      params: [{ transaction: hash, binary: false }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error("XRPL RPC HTTP " + res.status);
    err.code = "XRPL_RPC";
    throw err;
  }
  if (body.error || (body.result && body.result.error)) {
    const msg =
      (body.result && (body.result.error_message || body.result.error)) ||
      body.error_message ||
      body.error ||
      "tx not found";
    const err = new Error(String(msg));
    err.code = "XRPL_TX";
    err.body = body;
    throw err;
  }
  return body.result || body;
}

async function getPaymentLock(uuid, { expectDestination, expectAmountDrops, expectAccount } = {}) {
  const data = await xummFetch("/payload/" + encodeURIComponent(uuid), { method: "GET" });
  const meta = data.meta || {};
  const response = data.response || {};

  if (meta.expired) {
    return { ok: false, reason: "Payment lock expired" };
  }
  if (meta.cancelled) {
    return { ok: false, reason: "Payment lock cancelled" };
  }
  if (!meta.resolved) {
    return { ok: false, pending: true, reason: "waiting" };
  }
  if (!meta.signed) {
    return { ok: false, reason: "Payment lock cancelled" };
  }

  if (!looksTestnet(meta, response)) {
    return { ok: false, reason: "Testnet only. Mainnet send is off." };
  }

  const txHash =
    response.txid ||
    response.tx_id ||
    (meta && meta.txid) ||
    null;
  if (!txHash || typeof txHash !== "string") {
    return { ok: false, reason: "Missing payment tx hash" };
  }

  let tx;
  try {
    tx = await xrplTx(txHash);
  } catch (e) {
    const msg = String((e && e.message) || "");
    // Common race: payload signed but RPC has not indexed the hash yet.
    if (/not found|txnNotFound|unknown|temporar/i.test(msg) || (e && e.code === "XRPL_TX")) {
      return { ok: false, pending: true, reason: "waiting" };
    }
    return { ok: false, reason: e.message || "Could not verify tx on Testnet" };
  }

  // Xaman can mark signed before the tx is validated / meta is present.
  // Treat that as still waiting so the client keeps polling (don't toast "unknown").
  if (tx.validated === false) {
    return { ok: false, pending: true, reason: "waiting" };
  }
  const txMeta = tx.meta || tx.metaData || {};
  const resultCode =
    txMeta.TransactionResult ||
    tx.engine_result ||
    txMeta.engine_result ||
    null;
  if (!resultCode) {
    return { ok: false, pending: true, reason: "waiting" };
  }
  if (resultCode !== "tesSUCCESS") {
    return { ok: false, reason: "Payment did not succeed on Testnet (" + resultCode + ")" };
  }

  const destination = tx.Destination || (tx.tx_json && tx.tx_json.Destination);
  const amount = tx.Amount != null ? tx.Amount : (tx.tx_json && tx.tx_json.Amount);
  const account = tx.Account || (tx.tx_json && tx.tx_json.Account) || response.account || null;

  if (expectDestination && destination !== expectDestination) {
    return { ok: false, reason: "Payment destination mismatch" };
  }
  if (expectAmountDrops != null && String(amount) !== String(expectAmountDrops)) {
    return { ok: false, reason: "Payment amount mismatch" };
  }
  if (expectAccount && account !== expectAccount) {
    return { ok: false, reason: "Payment account mismatch" };
  }
  if (!isClassicAddress(account)) {
    return { ok: false, reason: "That is not a classic XRP address." };
  }

  return { ok: true, txHash, address: account };
}


let _reserveCache = { at: 0, base: 1000000, inc: 200000 }; // drops; 1 XRP + 0.2 XRP defaults
async function getLedgerReserves() {
  const now = Date.now();
  if (now - _reserveCache.at < 300000) return _reserveCache;
  try {
    const res = await fetch(XRPL_RPC_TESTNET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "server_state", params: [{}] }),
    });
    const body = await res.json().catch(() => ({}));
    const vd = (((body.result || {}).state) || {}).validated_ledger || {};
    const base = Number(vd.reserve_base);
    const inc = Number(vd.reserve_inc);
    if (Number.isFinite(base) && base > 0 && Number.isFinite(inc) && inc >= 0) {
      _reserveCache = { at: now, base, inc };
    } else {
      _reserveCache.at = now;
    }
  } catch (_) {
    _reserveCache.at = now;
  }
  return _reserveCache;
}

async function getAccountXrp(address) {
  if (!isClassicAddress(address)) {
    const err = new Error("That is not a classic XRP address.");
    err.code = "BAD_ADDR";
    throw err;
  }
  const res = await fetch(XRPL_RPC_TESTNET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated", strict: true }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  const result = body.result || {};
  if (result.error === "actNotFound") {
    return { ok: true, address, xrp: 0, spendableXrp: 0, totalXrp: 0, reservedXrp: 0, unfunded: true };
  }
  if (body.error || result.error) {
    const err = new Error(
      result.error_message || result.error || body.error || "account_info failed"
    );
    err.code = "XRPL_ACC";
    throw err;
  }
  const data = result.account_data || {};
  const drops = Number(data.Balance);
  const ownerCount = Number(data.OwnerCount) || 0;
  if (!Number.isFinite(drops)) {
    const err = new Error("Could not read Testnet balance");
    err.code = "XRPL_BAL";
    throw err;
  }
  const reserves = await getLedgerReserves();
  const reservedDrops = reserves.base + ownerCount * reserves.inc;
  const spendableDrops = Math.max(0, drops - reservedDrops);
  const totalXrp = drops / 1e6;
  const spendableXrp = spendableDrops / 1e6;
  const reservedXrp = reservedDrops / 1e6;
  // xrp = spendable so lobby UI matches what player can actually send.
  return {
    ok: true,
    address,
    xrp: spendableXrp,
    spendableXrp,
    totalXrp,
    reservedXrp,
    ownerCount,
  };
}

async function fetchQrPng(uuid) {
  const data = await xummFetch("/payload/" + encodeURIComponent(uuid), { method: "GET" });
  const refs = data.refs || {};
  const qrUrl = refs.qr_png || (uuid ? "https://xumm.app/sign/" + uuid + "_q.png" : null);
  if (!qrUrl) {
    const err = new Error("QR not available");
    err.code = "NO_QR";
    throw err;
  }
  const res = await fetch(qrUrl);
  if (!res.ok) {
    const err = new Error("QR fetch failed HTTP " + res.status);
    err.code = "QR_FETCH";
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get("content-type") || "image/png";
  return { buf, contentType: ctype.startsWith("image/") ? ctype : "image/png" };
}

module.exports = {
  keysConfigured,
  isClassicAddress,
  createSignIn,
  cancelPayload,
  getSignIn,
  createPaymentLock,
  getPaymentLock,
  fetchQrPng,
  getAccountXrp,
  XRPL_RPC_TESTNET,
  XRPL_WS_TESTNET,
};
