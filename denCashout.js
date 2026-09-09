/**
 * Apex.XRP Step 3 slice 1 — Testnet cash-out ledger sends from pot.
 * Env: POT_SEED, POT_ADDRESS; optional OWNER_TREASURY, XRPL_WS_TESTNET.
 * Never logs or returns the seed.
 */
const xrpl = require("xrpl");
const { isClassicAddress, XRPL_WS_TESTNET } = require("./xaman");

const FEE_RATE = 0.10;
const FEE_EPS = 1e-4; // XRP epsilon for fee/net/gross checks

let busy = false;

function potConfigured() {
  return !!(process.env.POT_SEED && process.env.POT_ADDRESS && isClassicAddress(process.env.POT_ADDRESS));
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function validateAmounts(grossXrp, netXrp, feeXrp) {
  const gross = toNum(grossXrp);
  const net = toNum(netXrp);
  const fee = toNum(feeXrp);
  if (!(gross > 0) || !(net > 0) || !(fee > 0)) {
    return { ok: false, reason: "Amounts must be positive" };
  }
  const expectFee = +(gross * FEE_RATE).toFixed(6);
  if (Math.abs(fee - expectFee) > FEE_EPS && Math.abs(fee - gross * FEE_RATE) > FEE_EPS) {
    return { ok: false, reason: "Fee must be ~10% of gross" };
  }
  if (Math.abs(net + fee - gross) > FEE_EPS) {
    return { ok: false, reason: "net + fee must equal gross" };
  }
  return { ok: true, gross, net, fee };
}

function toDrops(xrp) {
  try {
    return xrpl.xrpToDrops(String(xrp));
  } catch (e) {
    const err = new Error("Invalid XRP amount");
    err.code = "BAD_DROPS";
    throw err;
  }
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
  const hash =
    (result.result && result.result.hash) ||
    (signed && signed.hash) ||
    null;
  if (!hash) {
    const err = new Error("Missing tx hash after submit");
    err.code = "NO_HASH";
    throw err;
  }
  return hash;
}

/**
 * @param {{ hunter: string, treasury: string, grossXrp: number, netXrp: number, feeXrp: number, lockTx?: string|null }} body
 * @returns {Promise<{ ok: true, netTxHash: string, feeTxHash: string } | { ok: false, reason: string, busy?: boolean }>}
 */
async function runCashout(body) {
  if (busy) {
    return { ok: false, reason: "Cash-out busy — try again", busy: true };
  }
  if (!potConfigured()) {
    return { ok: false, reason: "POT_SEED/POT_ADDRESS not configured" };
  }

  const hunter = body && body.hunter ? String(body.hunter) : "";
  const treasury = body && body.treasury ? String(body.treasury) : "";
  if (!isClassicAddress(hunter)) {
    return { ok: false, reason: "That is not a classic XRP hunter address." };
  }
  if (!isClassicAddress(treasury)) {
    return { ok: false, reason: "That is not a classic XRP treasury address." };
  }

  const expectedTreasury = process.env.OWNER_TREASURY || "";
  if (expectedTreasury && isClassicAddress(expectedTreasury) && treasury !== expectedTreasury) {
    return { ok: false, reason: "Treasury address mismatch" };
  }

  const amounts = validateAmounts(body.grossXrp, body.netXrp, body.feeXrp);
  if (!amounts.ok) return amounts;

  let netDrops;
  let feeDrops;
  try {
    netDrops = toDrops(amounts.net);
    feeDrops = toDrops(amounts.fee);
  } catch (_) {
    return { ok: false, reason: "Could not convert amounts to drops" };
  }
  if (!/^\d+$/.test(netDrops) || !/^\d+$/.test(feeDrops) || netDrops === "0" || feeDrops === "0") {
    return { ok: false, reason: "Drop amounts must be positive integers" };
  }

  const potAddress = process.env.POT_ADDRESS;
  const seed = process.env.POT_SEED;
  const wsUrl = process.env.XRPL_WS_TESTNET || XRPL_WS_TESTNET;

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

    const netTxHash = await submitPayment(client, wallet, hunter, netDrops);
    const feeTxHash = await submitPayment(client, wallet, treasury, feeDrops);

    return { ok: true, netTxHash, feeTxHash };
  } catch (e) {
    const reason = e && e.message ? String(e.message) : "Cash-out ledger send failed";
    // Never include seed or env secrets in reason
    const safe = reason.replace(/s[a-zA-Z0-9]{20,}/g, "[redacted]");
    return { ok: false, reason: safe.slice(0, 200) };
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
};
