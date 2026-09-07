const http = require("http");
const port = process.env.PORT || 3000;
let n = 1;
let last = null;
http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  if (req.url.indexOf("/den/last") === 0) {
    res.end(JSON.stringify({ ok: true, match: last }));
    return;
  }
  if (req.url.indexOf("/den") === 0) {
    last = "den-" + n++;
    res.end(JSON.stringify({ ok: true, match: last }));
    return;
  }
  res.end(JSON.stringify({ ok: true, msg: "apex den server ok" }));
}).listen(port);
