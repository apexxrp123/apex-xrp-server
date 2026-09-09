const http = require("http");
const { WebSocketServer } = require("ws");
const xaman = require("./xaman");
const denCashout = require("./denCashout");

const port = process.env.PORT || 3000;
const POT_ADDRESS = process.env.POT_ADDRESS || "";
const LOCK_DROPS = "1000000";
const lockExpectAccount = new Map(); // uuid -> classic address (optional)
let n = 1;
let last = null;
let eatenHop = -1;
const who = [];
const jungle = [];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Xaman SignIn (Step 1) ---
  if (req.method === "POST" && url.pathname === "/xaman/signin") {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    try {
      await readBody(req).catch(() => ({}));
      const out = await xaman.createSignIn();
      sendJson(res, 200, out);
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 502;
      sendJson(res, status, { ok: false, reason: e.message || "Xaman create failed" });
    }
    return;
  }

  const qrMatch = url.pathname.match(/^\/xaman\/signin\/([^/]+)\/qr$/);
  if (req.method === "GET" && qrMatch) {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    try {
      const { buf, contentType } = await xaman.fetchQrPng(qrMatch[1]);
      cors(res);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 404;
      sendJson(res, status, { ok: false, reason: e.message || "QR not found" });
    }
    return;
  }

  const signinMatch = url.pathname.match(/^\/xaman\/signin\/([^/]+)$/);
  if (req.method === "GET" && signinMatch) {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    try {
      const out = await xaman.getSignIn(signinMatch[1]);
      sendJson(res, 200, out);
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 502;
      sendJson(res, status, { ok: false, reason: e.message || "Xaman poll failed" });
    }
    return;
  }


  // --- Jungle Payment lock (Step 2 slice 2) ---
  if (req.method === "POST" && url.pathname === "/den/lock") {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    if (!POT_ADDRESS || !xaman.isClassicAddress(POT_ADDRESS)) {
      sendJson(res, 503, { ok: false, reason: "POT_ADDRESS not configured" });
      return;
    }
    try {
      const body = await readBody(req).catch(() => ({}));
      const address = body && body.address ? String(body.address) : "";
      if (address && !xaman.isClassicAddress(address)) {
        sendJson(res, 400, { ok: false, reason: "That is not a classic XRP address." });
        return;
      }
      const out = await xaman.createPaymentLock({
        destination: POT_ADDRESS,
        amountDrops: LOCK_DROPS,
        account: address || undefined,
      });
      if (address && out.uuid) lockExpectAccount.set(out.uuid, address);
      sendJson(res, 200, {
        uuid: out.uuid,
        qr: out.qr,
        deepLink: out.deepLink,
        amountXrp: 1,
        destination: POT_ADDRESS,
      });
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 502;
      sendJson(res, status, { ok: false, reason: e.message || "Payment lock create failed" });
    }
    return;
  }

  const lockQrMatch = url.pathname.match(/^\/den\/lock\/([^/]+)\/qr$/);
  if (req.method === "GET" && lockQrMatch) {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    try {
      const { buf, contentType } = await xaman.fetchQrPng(lockQrMatch[1]);
      cors(res);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 404;
      sendJson(res, status, { ok: false, reason: e.message || "QR not found" });
    }
    return;
  }

  const lockMatch = url.pathname.match(/^\/den\/lock\/([^/]+)$/);
  if (req.method === "GET" && lockMatch) {
    if (!xaman.keysConfigured()) {
      sendJson(res, 503, { ok: false, reason: "XUMM_API_KEY/SECRET not configured" });
      return;
    }
    if (!POT_ADDRESS || !xaman.isClassicAddress(POT_ADDRESS)) {
      sendJson(res, 503, { ok: false, reason: "POT_ADDRESS not configured" });
      return;
    }
    try {
      const uuid = lockMatch[1];
      const expectAccount = lockExpectAccount.get(uuid);
      const out = await xaman.getPaymentLock(uuid, {
        expectDestination: POT_ADDRESS,
        expectAmountDrops: LOCK_DROPS,
        expectAccount: expectAccount || undefined,
      });
      if (out.ok) lockExpectAccount.delete(uuid);
      sendJson(res, 200, out);
    } catch (e) {
      const status = e.code === "NO_KEYS" ? 503 : 502;
      sendJson(res, status, { ok: false, reason: e.message || "Payment lock poll failed" });
    }
    return;
  }


  // --- Cash-out ledger send (Step 3 slice 1, Testnet only) ---
  if (req.method === "POST" && url.pathname === "/den/cashout") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const out = await denCashout.runCashout(body || {});
      const status = out.ok ? 200 : out.busy ? 429 : 400;
      sendJson(res, status, out);
    } catch (e) {
      sendJson(res, 500, { ok: false, reason: e.message || "Cash-out failed" });
    }
    return;
  }

  // --- existing routes ---
  if (url.pathname === "/hello") {
    const name = (url.searchParams.get("name") || "hunter").slice(0, 16);
    if (who.indexOf(name) === -1) who.push(name);
    if (who.length > 20) who.shift();
    sendJson(res, 200, { ok: true, name: name, count: who.length });
    return;
  }
  if (url.pathname === "/who") {
    sendJson(res, 200, { ok: true, who: who });
    return;
  }
  if (url.pathname === "/room/jungle/leave") {
    const name = (url.searchParams.get("name") || "").slice(0, 16);
    const i = jungle.indexOf(name);
    if (i >= 0) jungle.splice(i, 1);
    sendJson(res, 200, { ok: true, room: "jungle", who: jungle });
    return;
  }
  if (url.pathname === "/room/jungle") {
    const name = url.searchParams.get("name");
    if (name) {
      const nme = name.slice(0, 16);
      if (jungle.indexOf(nme) === -1) {
        if (jungle.length >= 8) {
          sendJson(res, 200, { ok: false, full: true, room: "jungle", who: jungle });
          return;
        }
        jungle.push(nme);
      }
    }
    sendJson(res, 200, { ok: true, room: "jungle", who: jungle });
    return;
  }
  if (url.pathname === "/den/last") {
    sendJson(res, 200, { ok: true, match: last });
    return;
  }
  if (url.pathname === "/den") {
    last = "den-" + n++;
    sendJson(res, 200, { ok: true, match: last });
    return;
  }
  sendJson(res, 200, { ok: true, msg: "apex den server ok" });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ ok: true, t: "hi" }));
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (m && m.t === "name" && m.name) {
      ws.name = String(m.name).slice(0, 16);
      if (m.room) ws.room = String(m.room).slice(0, 32);
      const names = [];
      wss.clients.forEach((c) => {
        if (c.name) names.push(c.name);
      });
      const payload = JSON.stringify({ t: "peers", who: names });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
    }
    if (m && m.t === "pos") {
      const payload = JSON.stringify({
        t: "pos",
        name: ws.name || m.name,
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
        seq: Number(m.seq) || 0,
        pts: Array.isArray(m.pts) ? m.pts.slice(0, 40) : [],
        skin:
          m.skin && typeof m.skin === "object"
            ? {
                a: String(m.skin.a || ""),
                b: String(m.skin.b || ""),
                p: String(m.skin.p || ""),
                sp: String(m.skin.sp || ""),
                h: String(m.skin.h || ""),
                t: String(m.skin.t || ""),
                e: String(m.skin.e || ""),
              }
            : null,
      });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1 && c.room === ws.room) c.send(payload);
      });
    }
    if (m && m.t === "dead") {
      const payload = JSON.stringify({
        t: "dead",
        name: ws.name || m.name,
        by: m.by || "",
        stake: Number(m.stake) || 0,
      });
      const di = jungle.indexOf(ws.name || m.name || "");
      if (di >= 0) jungle.splice(di, 1);
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1 && c.room === ws.room) c.send(payload);
      });
    }
    if (m && m.t === "shed") {
      const drops = Array.isArray(m.drops) ? m.drops.slice(0, 40) : [];
      const payload = JSON.stringify({ t: "shed", name: ws.name || m.name, drops: drops });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1 && c.room === ws.room) c.send(payload);
      });
    }
    if (m && m.t === "prey") {
      const hop = Number(m.hop) || 0;
      if (hop === eatenHop) return;
      eatenHop = hop;
      const payload = JSON.stringify({ t: "prey", hop: hop, name: ws.name || m.name });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1 && c.room === ws.room) c.send(payload);
      });
    }
    if (m && m.t === "chal") {
      const payload = JSON.stringify({
        t: "chal",
        from: ws.name || m.from,
        to: String(m.to || "").slice(0, 16),
        amt: Number(m.amt) || 1,
      });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1) c.send(payload);
      });
    }
    if (m && m.t === "chalok") {
      const payload = JSON.stringify({
        t: "chalok",
        from: ws.name || m.from,
        to: String(m.to || "").slice(0, 16),
        amt: Number(m.amt) || 1,
      });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1) c.send(payload);
      });
    }
  });
  ws.on("close", () => {
    const nme = ws.name;
    if (!nme) return;
    const i = jungle.indexOf(nme);
    if (i >= 0) jungle.splice(i, 1);
    const j = who.indexOf(nme);
    if (j >= 0) who.splice(j, 1);
  });
});

server.listen(port);
