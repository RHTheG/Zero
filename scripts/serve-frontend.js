#!/usr/bin/env node
/**
 * Zero-dependency static server for the dApp.
 *
 *   node scripts/serve-frontend.js       (or: npm run frontend)
 *   PORT=8080 npm run frontend
 *
 * The frontend `fetch()`es its ABI and deployment map as JSON, which the
 * file:// origin blocks. This serves `frontend/` over http instead.
 *
 * Binds to 127.0.0.1 ONLY - never 0.0.0.0. This is a local dev tool that will
 * be pointed at a wallet holding real keys; it has no business being reachable
 * from the network.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "frontend");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  // Strip the query string, then resolve inside ROOT.
  const requested = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);

  // Path-traversal guard: refuse anything that escapes ROOT.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  TaxToken dApp -> http://${HOST}:${PORT}\n  serving ${ROOT}\n  Ctrl+C to stop\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is in use. Try: PORT=5174 npm run frontend\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
});
