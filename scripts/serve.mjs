// Local dev server — serves this app exactly as Vercel would (static files +
// api/*.js handlers), without deploying. Usage: node scripts/serve.mjs [port]
// Env vars are read from process.env (see .env.example). No secrets here.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = parseInt(process.argv[2] || "3100", 10);
const require = createRequire(import.meta.url);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".xml": "application/xml; charset=utf-8",
};

function loadHandler(name) {
  const mod = require(join(ROOT, "api", name));
  return mod.default || mod;
}

const handlers = {
  "/api/articles": loadHandler("articles.js"),
  "/api/article": loadHandler("article.js"),
  "/api/article-page": loadHandler("article-page.js"),
  "/api/meta": loadHandler("meta.js"),
  "/api/ingest": loadHandler("ingest.js"),
  "/api/ingest-image": loadHandler("ingest-image.js"),
  "/api/sitemap.xml": loadHandler("sitemap.xml.js"),
  "/api/rss.xml": loadHandler("rss.xml.js"),
  "/api/admin/config": loadHandler("admin/config.js"),
  "/api/admin/auth/callback": loadHandler("admin/auth/callback.js"),
  "/api/admin/articles": loadHandler("admin/articles.js"),
};

function makeRes(nodeRes) {
  let status = 200;
  const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status: (c) => { status = c; return res; },
    json: (o) => {
      nodeRes.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      nodeRes.end(JSON.stringify(o));
    },
    send: (b) => {
      nodeRes.writeHead(status, { ...headers });
      nodeRes.end(b);
    },
  };
  return res;
}

const server = http.createServer(async (req, nodeRes) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let path = decodeURIComponent(url.pathname);

    // vercel.json rewrites (local mirror)
    const aMatch = path.match(/^\/a\/([^/]+)\.html$/);
    if (aMatch) { path = "/api/article-page"; url.searchParams.set("slug", aMatch[1]); }
    if (path === "/sitemap.xml") path = "/api/sitemap.xml";
    if (path === "/rss.xml") path = "/api/rss.xml";

    if (handlers[path]) {
      const body = await new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => resolve(raw));
      });
      let parsed = {};
      if (body) { try { parsed = JSON.parse(body); } catch { parsed = {}; } }
      const mockReq = {
        method: req.method, query: Object.fromEntries(url.searchParams),
        headers: req.headers, body: parsed,
        on: (ev, cb) => { if (ev === "data" && body) cb(body); if (ev === "end") cb(); },
      };
      const res = makeRes(nodeRes);
      await handlers[path](mockReq, res);
      return;
    }

    if (path === "/") path = "/index.html";
    if (path.endsWith("/")) path += "index.html"; // e.g. /admin/ -> /admin/index.html
    const file = join(ROOT, path);
    if (!existsSync(file) || !statSync(file).isFile() || !file.startsWith(ROOT)) {
      nodeRes.writeHead(404); nodeRes.end("not found"); return;
    }
    nodeRes.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    nodeRes.end(readFileSync(file));
  } catch (e) {
    console.error(e);
    nodeRes.writeHead(500); nodeRes.end(String(e.message || e));
  }
});

server.listen(PORT, () => console.log(`hksports-app dev server: http://localhost:${PORT}`));
