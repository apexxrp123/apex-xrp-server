/**
 * Apex.XRP Testnet cash-out — freeze slice.
 * Env: POT_SEED, POT_ADDRESS, OWNER_TREASURY (required).
 * Optional: WEEKLY_DRAW_POT (2% of fee); XRPL_WS_TESTNET; CASHOUT_CAP_XRP.
 * Never logs or returns the seed.
 *
 * Rules: no validated lockTx → no pay. Consume lock once. Server 90/10.
 * Of the 10% fee: 2% → WEEKLY_DRAW_POT (when set), 98% → OWNER_TREASURY.
 * Cap gross by verified lock (and optional CASHOUT_CAP_XRP).
 */
const xrpl = require("xrpl");
const { isClassicAddress, XRPL_WS_TESTNET } = require("./xaman");

const FEE_RATE = 0.1;
const DRAW_OF_FEE = 0.02; // 2% of the fee → weekly draw
const LOCK_DROPS_DEFAULT = "1000000";
const TESTNET_WS_ALLOW = [
  "wss://s.altnet.rippletest.net:51233",
  "wss://testnet.xrpl-labs.com",
  "wss://s.devnet.rippletest.net:51233",
];

let busy = false;
/** @type {Map<string, object>} */
const lockSettlements = new Map();

function potConfigured() {
  return !!(
    process.env.POT_SEED &&
    process.env.POT_ADDRESS &&
    isClassicAddress(process.env.POT_ADDRESS) &&
    process.env.OWNER_TREASURY &&
    isClassicAddress(process.env.OWNER_TREASURY)
  );
}

function drawPotAddress() {
  const a = (process.env.WEEKLY_DRAW_POT || "").trim();
  return isClassicAddress(a) ? a : null;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function toDrops(xrp) {
  try {
    return xrpl.xrpToDrops(String(xrp));
  } catch (_) {
    const err = new Error("Invalid XRP amount");
    err.code = "BAD_DROPS";
    throw err;
  }
}

function resolveWsUrl() {
  const raw = (process.env.XRPL_WS_TESTNET || XRPL_WS_TESTNET || "").trim();
  if (!raw) return XRPL_WS_TESTNET;
  const ok = TESTNET_WS_ALLOW.some((u) => raw === u || raw.startsWith(u));
  if (!ok) {
    const err = new Error("XRPL_WS_TESTNET must be an allowlisted Testnet endpoint");
    err.code = "BAD_WS";
    throw err;
  }
  return raw;
}

function isTxHash(h) {
  return typeof h === "string" && /^[A-Fa-f0-9]{64}$/.test(h);
}

function safeReason(e, fallback) {
  const reason = e && e.message ? String(e.message) : fallback;
  return reason.replace(/s[a-zA-Z0-9]{20,}/g, "[redacted]").slice(0, 200);
}

async function fetchTx(client, hash) {
  const res = await client.request({ command: "tx", transaction: hash, binary: false });
  return res.result || res;
}

async function verifyLockTx(client, lockTx, hunter, potAddress) {
  if (!isTxHash(lockTx)) {
    return { ok: false, reason: "lockTx required (64-hex Payment hash)" };
  }
  let tx;
  try {
    tx = await fetchTx(client, lockTx);
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/not found|txnNotFound|unknown/i.test(msg)) {
      return { ok: false, reason: "lockTx not found on Testnet" };
    }
    return { ok: false, reason: "Could not verify lockTx" };
  }
  if (tx.validated === false) {
    return { ok: false, reason: "lockTx not validated yet" };
  }
  const meta = tx.meta || tx.metaData || {};
  const code = meta.TransactionResult || tx.engine_result || null;
  if (code !== "tesSUCCESS") {
    return { ok: false, reason: "lockTx did not succeed (" + (code || "unknown") + ")" };
  }
  const tt = tx.TransactionType || (tx.tx_json && tx.tx_json.TransactionType);
  if (tt !== "Payment") {
    return { ok: false, reason: "lockTx must be a Payment" };
  }
  const account = tx.Account || (tx.tx_json && tx.tx_json.Account);
  const destination = tx.Destination || (tx.tx_json && tx.tx_json.Destination);
  const amount = tx.Amount != null ? tx.Amount : tx.tx_json && tx.tx_json.Amount;
  if (account !== hunter) {
    return { ok: false, reason: "lockTx hunter mismatch" };
  }
  if (destination !== potAddress) {
    return { ok: false, reason: "lockTx destination is not the pot" };
  }
  if (amount == null || typeof amount === "object") {
    return { ok: false, reason: "lockTx must be pure XRP" };
  }
  const drops = String(amount);
  const expect = process.env.LOCK_DROPS || LOCK_DROPS_DEFAULT;
  if (drops !== String(expect)) {
    return { ok: false, reason: "lockTx amount mismatch" };
  }
  const lockXrp = Number(drops) / 1e6;
  if (!Number.isFinite(lockXrp) || !(lockXrp > 0)) {
    return { ok: false, reason: "lockTx amount invalid" };
  }
  return { ok: true, lockXrp, drops };
}

function serverAmounts(requestedGross, lockXrp) {
  const capEnv = toNum(process.env.CASHOUT_CAP_XRP);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? Math.min(capEnv, lockXrp) : lockXrp;
  let gross = toNum(requestedGross);
  if (!(gross > 0)) {
    return { ok: false, reason: "Gross must be positive" };
  }
  if (gross > cap) gross = cap;
  gross = +gross.toFixed(6);
  const fee = +(gross * FEE_RATE).toFixed(6);
  const net = +(gross - fee).toFixed(6);
  if (!(fee > 0) || !(net > 0)) {
    return { ok: false, reason: "Payout too small after 90/10 split" };
  }
  return { ok: true, gross, net, fee, cap };
}

/** Split fee: 2% draw / 98% treasury when WEEKLY_DRAW_POT set; else 100% treasury. */
function splitFee(feeXrp) {
  const drawAddr = drawPotAddress();
  const fee = +Number(feeXrp).toFixed(6);
  if (!drawAddr) {
    return { treasuryXrp: fee, drawXrp: 0, drawAddr: null };
  }
  let drawXrp = +(fee * DRAW_OF_FEE).toFixed(6);
  let treasuryXrp = +(fee - drawXrp).toFixed(6);
  // Dust: if draw would be 0 drops, send all fee to treasury.
  try {
    if (toDrops(drawXrp) === "0") {
      drawXrp = 0;
      treasuryXrp = fee;
    }
  } catch (_) {
    drawXrp = 0;
    treasuryXrp = fee;
  }
  if (!(treasuryXrp > 0)) {
    return { ok: false, reason: "Treasury fee share must be positive" };
  }
  return { treasuryXrp, drawXrp, drawAddr, ok: true };
}

async function submitPayment(client, wallet, destination, drops) {
  const prepared = await client.autofill({
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: destination,
    Amount: String(drops),
  });
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const meta = result.result && result.result.meta;
  const code =
    (meta && meta.TransactionResult) ||
    (result.result && result.result.engine_result) ||
    null;
  if (code !== "tesSUCCESS") {
    const err = new Error("Payment failed (" + (code || "unknown") + ")");
    err.code = "TX_FAIL";
    err.engine = code;
    throw err;
  }
  const hash = (result.result && result.result.hash) || (signed && signed.hash) || null;
  if (!hash) {
    const err = new Error("Missing tx hash after submit");
    err.code = "NO_HASH";
    throw err;
  }
  return hash;
}

/**
 * Pay treasury (+ optional draw) after net. Never retries net.
 * @returns {{ ok: true, feeTxHash: string, drawTxHash: string|null } | { ok: false, reason: string, feeTxHash?: string }}
 */
async function payFeeLegs(client, wallet, treasury, feeXrp, prior) {
  const split = splitFee(feeXrp);
  if (split.ok === false) return split;

  let feeTxHash = prior && prior.feeTxHash ? prior.feeTxHash : null;
  let drawTxHash = prior && prior.drawTxHash ? prior.drawTxHash : null;

  if (!feeTxHash) {
    const treasuryDrops = toDrops(split.treasuryXrp);
    if (treasuryDrops === "0") {
      return { ok: false, reason: "Treasury fee drops invalid" };
    }
    feeTxHash = await submitPayment(client, wallet, treasury, treasuryDrops);
  }

  if (split.drawAddr && split.drawXrp > 0 && !drawTxHash) {
    const drawDrops = toDrops(split.drawXrp);
    if (drawDrops !== "0") {
      drawTxHash = await submitPayment(client, wallet, split.drawAddr, drawDrops);
    }
  }

  return { ok: true, feeTxHash, drawTxHash: drawTxHash || null, treasuryXrp: split.treasuryXrp, drawXrp: split.drawXrp };
}

async function runCashout(body) {
  if (busy) {
    return { ok: false, reason: "Cash-out busy — try again", busy: true };
  }
  if (!potConfigured()) {
    return { ok: false, reason: "POT_SEED/POT_ADDRESS/OWNER_TREASURY not configured" };
  }

  const hunter = body && body.hunter ? String(body.hunter) : "";
  const lockTx = body && body.lockTx ? String(body.lockTx).trim() : "";
  if (!isClassicAddress(hunter)) {
    return { ok: false, reason: "That is not a classic XRP hunter address." };
  }
  if (!isTxHash(lockTx)) {
    return { ok: false, reason: "No validated lock — lockTx required" };
  }

  const prior = lockSettlements.get(lockTx);
  if (prior && prior.status === "complete" && prior.netTxHash && prior.feeTxHash) {
    if (prior.hunter !== hunter) {
      return { ok: false, reason: "lockTx already consumed" };
    }
    return {
      ok: true,
      netTxHash: prior.netTxHash,
      feeTxHash: prior.feeTxHash,
      drawTxHash: prior.drawTxHash || null,
      replay: true,
      grossXrp: prior.gross,
      netXrp: prior.net,
      feeXrp: prior.fee,
    };
  }

  const potAddress = process.env.POT_ADDRESS;
  const treasury = process.env.OWNER_TREASURY;
  const seed = process.env.POT_SEED;

  let wsUrl;
  try {
    wsUrl = resolveWsUrl();
  } catch (e) {
    return { ok: false, reason: e.message || "Bad XRPL websocket" };
  }

  busy = true;
  let client;
  try {
    let wallet;
    try {
      wallet = xrpl.Wallet.fromSeed(seed, { algorithm: "secp256k1" });
    } catch (_) {
      return { ok: false, reason: "Invalid pot key configuration" };
    }
    if (wallet.classicAddress !== potAddress) {
      return { ok: false, reason: "Pot wallet does not match POT_ADDRESS" };
    }

    client = new xrpl.Client(wsUrl);
    await client.connect();

    // Resume fee legs if net already sent.
    if (prior && prior.status === "net_sent" && prior.netTxHash && prior.hunter === hunter) {
      try {
        const fees = await payFeeLegs(client, wallet, treasury, prior.fee, prior);
        if (!fees.ok) {
          return { ok: false, reason: fees.reason || "Fee payment failed", netTxHash: prior.netTxHash, feePending: true };
        }
        const done = {
          status: "complete",
          hunter,
          netTxHash: prior.netTxHash,
          feeTxHash: fees.feeTxHash,
          drawTxHash: fees.drawTxHash,
          gross: prior.gross,
          net: prior.net,
          fee: prior.fee,
          at: Date.now(),
        };
        lockSettlements.set(lockTx, done);
        return {
          ok: true,
          netTxHash: done.netTxHash,
          feeTxHash: done.feeTxHash,
          drawTxHash: done.drawTxHash,
          grossXrp: done.gross,
          netXrp: done.net,
          feeXrp: done.fee,
          resumedFee: true,
        };
      } catch (e) {
        return { ok: false, reason: safeReason(e, "Fee payment failed"), netTxHash: prior.netTxHash, feePending: true };
      }
    }

    if (prior && prior.netTxHash) {
      return { ok: false, reason: "lockTx already consumed" };
    }

    const lock = await verifyLockTx(client, lockTx, hunter, potAddress);
    if (!lock.ok) return lock;

    const amounts = serverAmounts(body && body.grossXrp, lock.lockXrp);
    if (!amounts.ok) return amounts;

    let netDrops;
    try {
      netDrops = toDrops(amounts.net);
    } catch (_) {
      return { ok: false, reason: "Could not convert amounts to drops" };
    }
    if (!/^\d+$/.test(netDrops) || netDrops === "0") {
      return { ok: false, reason: "Drop amounts must be positive integers" };
    }

    lockSettlements.set(lockTx, {
      status: "pending",
      hunter,
      gross: amounts.gross,
      net: amounts.net,
      fee: amounts.fee,
      at: Date.now(),
    });

    let netTxHash;
    try {
      netTxHash = await submitPayment(client, wallet, hunter, netDrops);
    } catch (e) {
      lockSettlements.delete(lockTx);
      return { ok: false, reason: safeReason(e, "Net payment failed") };
    }

    lockSettlements.set(lockTx, {
      status: "net_sent",
      hunter,
      netTxHash,
      gross: amounts.gross,
      net: amounts.net,
      fee: amounts.fee,
      at: Date.now(),
    });

    let fees;
    try {
      fees = await payFeeLegs(client, wallet, treasury, amounts.fee, null);
    } catch (e) {
      return {
        ok: false,
        reason: safeReason(e, "Fee payment failed"),
        netTxHash,
        feePending: true,
      };
    }
    if (!fees.ok) {
      return { ok: false, reason: fees.reason || "Fee payment failed", netTxHash, feePending: true };
    }

    lockSettlements.set(lockTx, {
      status: "complete",
      hunter,
      netTxHash,
      feeTxHash: fees.feeTxHash,
      drawTxHash: fees.drawTxHash,
      gross: amounts.gross,
      net: amounts.net,
      fee: amounts.fee,
      at: Date.now(),
    });

    return {
      ok: true,
      netTxHash,
      feeTxHash: fees.feeTxHash,
      drawTxHash: fees.drawTxHash,
      grossXrp: amounts.gross,
      netXrp: amounts.net,
      feeXrp: amounts.fee,
      drawConfigured: !!drawPotAddress(),
    };
  } catch (e) {
    return { ok: false, reason: safeReason(e, "Cash-out ledger send failed") };
  } finally {
    busy = false;
    if (client) {
      try {
        await client.disconnect();
      } catch (_) {}
    }
  }
}

module.exports = {
  runCashout,
  potConfigured,
  FEE_RATE,
  DRAW_OF_FEE,
  verifyLockTx,
  serverAmounts,
  splitFee,
  lockSettlements,
};
