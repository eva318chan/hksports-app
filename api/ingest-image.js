// POST /api/ingest-image — permanent image-upload endpoint for the pipeline.
//   Headers: x-ingest-secret: <INGEST_SECRET env var> (same auth as
//   /api/ingest — the pipeline cron can read INGEST_SECRET back through the
//   Vercel API, but cannot hold a Google SSO session, so admin endpoints
//   are unusable by the cron).
//   Body: { key, sourceUrl } — fetch the image server-side and PUT it to R2;
//         or { key, contentBase64, contentType } — direct upload.
//   Key must match ^design/YYYYMM/<name>.(jpg|jpeg|png|webp)$ or
//   ^assets/<path>.(jpg|jpeg|png|webp)$ (the 9 self-hosted images) — anything else
//   is rejected with 400 (no path traversal, no other prefixes). Content-Type
//   comes from the source response (or the supplied contentType), defaulting
//   to the extension's type. Uploads are idempotent: re-uploading the same
//   key overwrites it. Response: { ok:true, key, url, bytes } where url is
//   R2_PUBLIC_BASE_URL + "/" + key. Source fetch failure returns 502.
//   Without INGEST_SECRET configured this returns 503. Never expose a
//   credential value in any response or log.
"use strict";
const { r2Configured, putObject } = require("../lib/r2");

const KEY_RE = /^(?:design\/\d{6}|assets)\/[A-Za-z0-9._\/-]+\.(jpg|jpeg|png|webp)$/i;
const EXT_TYPE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MAX_BYTES = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const secret = process.env.INGEST_SECRET || "";
  if (!secret) {
    res.status(503).json({ ok: false, error: "ingest not configured: INGEST_SECRET is not set" });
    return;
  }
  const given = req.headers["x-ingest-secret"] || "";
  if (given !== secret) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  if (!r2Configured()) {
    res.status(503).json({ ok: false, error: "R2 credentials not configured" });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
  const key = String(body.key || "").trim();
  if (!KEY_RE.test(key)) {
    res.status(400).json({ ok: false, error: "key must match design/YYYYMM/<name> or assets/<path> .(jpg|jpeg|png|webp)" });
    return;
  }
  const ext = key.split(".").pop().toLowerCase();
  try {
    let buf;
    let contentType;
    if (body.sourceUrl) {
      const src = String(body.sourceUrl);
      let u;
      try { u = new URL(src); }
      catch (e) { res.status(400).json({ ok: false, error: "sourceUrl must be an absolute URL" }); return; }
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        res.status(400).json({ ok: false, error: "sourceUrl must be http(s)" });
        return;
      }
      const g = await fetch(src);
      if (!g.ok) { res.status(502).json({ ok: false, error: `source fetch ${g.status}` }); return; }
      buf = Buffer.from(await g.arrayBuffer());
      contentType = (g.headers.get("content-type") || "").split(";")[0].trim() || EXT_TYPE[ext];
    } else if (body.contentBase64) {
      contentType = String(body.contentType || EXT_TYPE[ext] || "image/jpeg");
      buf = Buffer.from(String(body.contentBase64), "base64");
    } else {
      res.status(400).json({ ok: false, error: "provide sourceUrl or contentBase64" });
      return;
    }
    if (!buf.length) { res.status(400).json({ ok: false, error: "empty image" }); return; }
    if (buf.length > MAX_BYTES) { res.status(400).json({ ok: false, error: "image too large (max 10 MB)" }); return; }
    const out = await putObject({ key, body: buf, contentType });
    res.status(200).json({ ok: true, key: out.key, url: out.url, bytes: out.bytes });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
