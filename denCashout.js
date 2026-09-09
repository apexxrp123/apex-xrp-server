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
/** @type {Map} */
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
