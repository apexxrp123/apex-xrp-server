const http = require("http");
const port = process.env.PORT || 3000;
let n = 1;
let last = null;
const who = [];
const jungle = [];
http.createServer((req, res) => {
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
  if (url.pathname === "/room/jungle") {
    const name = url.searchParams.get("name");
    if (name) {
      const nme = name.slice(0, 16);
      if (jungle.indexOf(nme) === -1) jungle.push(nme);
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
}).listen(port);
