import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const ROOT = "C:/tech/ship/marketing/x";
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".png":"image/png", ".webp":"image/webp", ".svg":"image/svg+xml", ".json":"application/json", ".wav":"audio/wav", ".mp4":"video/mp4", ".woff2":"font/woff2" };
http.createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    let p = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end("404"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(data);
    });
  } catch { res.writeHead(500); res.end(); }
}).listen(8137, "127.0.0.1", () => console.log("serving on 8137"));
