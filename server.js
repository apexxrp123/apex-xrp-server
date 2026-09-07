const http = require("http");
const { WebSocketServer } = require("ws");
const port = process.env.PORT || 3000;
let n = 1;
let last = null;
const who = [];
const jungle = [];

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/hello") {
    const name = (url.searchParams.get("name") || "hunter").slice(0, 16);
    if (who.indexOf(name) === -1) who.push(name);
    if (who.length > 20) who.shift();
    res.end(JSON.stringify({ ok: true, name: name, count: who.length }));
    return;
  }
  if (url.pathname === "/who") {
    res.end(JSON.stringify({ ok: true, who: who }));
    return;
  }
  if (url.pathname === "/room/jungle/leave") {
    const name = (url.searchParams.get("name") || "").slice(0, 16);
    const i = jungle.indexOf(name);
    if (i >= 0) jungle.splice(i, 1);
    res.end(JSON.stringify({ ok: true, room: "jungle", who: jungle }));
    return;
  }
  if (url.pathname === "/room/jungle") {
    const name = url.searchParams.get("name");
        if (name) {
      const nme = name.slice(0, 16);
      if (jungle.indexOf(nme) === -1) {
        if (jungle.length >= 8) {
          res.end(JSON.stringify({ ok: false, full: true, room: "jungle", who: jungle }));
          return;
        }
        jungle.push(nme);
      }
    }
    res.end(JSON.stringify({ ok: true, room: "jungle", who: jungle }));
    return;
  }
  if (url.pathname === "/den/last") {
    res.end(JSON.stringify({ ok: true, match: last }));
    return;
  }
  if (url.pathname === "/den") {
    last = "den-" + n++;
    res.end(JSON.stringify({ ok: true, match: last }));
    return;
  }
  res.end(JSON.stringify({ ok: true, msg: "apex den server ok" }));
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ ok: true, t: "hi" }));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch (_) { return; }
    if (m && m.t === "name" && m.name) {
      ws.name = String(m.name).slice(0, 16);
      const names = [];
      wss.clients.forEach((c) => { if (c.name) names.push(c.name); });
      const payload = JSON.stringify({ t: "peers", who: names });
      wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
    }
        if (m && m.t === "pos") {
      const payload = JSON.stringify({
        t: "pos",
        name: ws.name || m.name,
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
    pts: Array.isArray(m.pts) ? m.pts.slice(0, 24) : [],
        skin: m.skin && typeof m.skin === "object" ? {
          a: String(m.skin.a || ""),
          b: String(m.skin.b || ""),
          p: String(m.skin.p || ""),
          sp: String(m.skin.sp || ""),
          h: String(m.skin.h || ""),
          t: String(m.skin.t || ""),
          e: String(m.skin.e || ""),
        } : null,
      });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1) c.send(payload);
      });
    }
    if (m && m.t === "dead") {
      const payload = JSON.stringify({ t: "dead", name: ws.name || m.name, by: m.by || "", stake: Number(m.stake) || 0 });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1) c.send(payload);
      });
    }
    if (m && m.t === "shed") {
      const drops = Array.isArray(m.drops) ? m.drops.slice(0, 40) : [];
      const payload = JSON.stringify({ t: "shed", name: ws.name || m.name, drops: drops });
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1) c.send(payload);
      });
    }
  });
});

server.listen(port);
