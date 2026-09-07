const http = require("http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
  });
  if (req.url.indexOf("/den") === 0) {
    res.end("den awake\n");
    return;
  }
  res.end("apex den server ok\n");
}).listen(port);
