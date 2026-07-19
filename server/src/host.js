// Wisp host: serves the POC static app + the AG-UI SSE endpoint.
//   POST /agent/:app/run   body {sessionId, message?|approve?|deny?}  → SSE event stream
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "../apps.config.js";

// server/src/host.js → up three levels to the repo root (wisp/).
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const POC = path.join(ROOT, "examples", "poc");
const PORT = Number(process.env.PORT || 4600);
const HOST = process.env.HOST || "127.0.0.1";

const backends = {
  mock: () => import("./backends/mock.js"),
  claude: () => import("./backends/claude.js"),
};

const sessions = new Map(); // "app:sessionId" -> app-specific session object

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};
async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(POC, path.normalize(rel));
  if (!file.startsWith(POC)) return end(res, 403, "text/plain", "no");
  try {
    if (!(await stat(file)).isFile()) throw 0;
  } catch {
    return end(res, 404, "text/plain", "not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}
const end = (res, s, t, b) => (res.writeHead(s, { "Content-Type": t }), res.end(b));

async function runAgent(req, res, app) {
  const cfg = registry[app];
  if (!cfg) return end(res, 404, "application/json", JSON.stringify({ error: "unknown app" }));
  let body;
  try {
    body = await readJson(req);
  } catch {
    return end(res, 400, "application/json", JSON.stringify({ error: "bad json" }));
  }
  const key = `${app}:${body.sessionId || "default"}`;
  const session = sessions.get(key) || {};
  sessions.set(key, session);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let aborted = false;
  req.on("close", () => (aborted = true));

  try {
    const mod = await backends[cfg.backend]();
    for await (const ev of mod.run(session, body, cfg)) {
      if (aborted || res.writableEnded) break;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (e) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", message: e.message })}\n\n`);
    console.error(`agent ${app} error:`, e.message);
  }
  if (!res.writableEnded) res.end();
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const { pathname } = new URL(req.url, "http://x");
  const m = pathname.match(/^\/agent\/([^/]+)\/run$/);
  try {
    if (m && req.method === "POST") await runAgent(req, res, m[1]);
    else await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) end(res, 500, "application/json", JSON.stringify({ error: e.message }));
    console.error("ERROR", pathname, e);
  }
  console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - t0}ms)`);
});
server.requestTimeout = 0;
server.listen(PORT, HOST, () => console.log(`wisp host on http://${HOST}:${PORT}  (apps: ${Object.keys(registry).join(", ")})`));
