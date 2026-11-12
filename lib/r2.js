// R2 upload helper — SigV4-signed S3 PUT, Node built-in crypto only, no SDK.
//   Credentials come from process.env (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_ENDPOINT, R2_BUCKET). They are stored encrypted in Vercel — readable
//   by serverless functions at runtime, NOT readable back through the Vercel
//   API — which is why uploads happen from inside a function instead of an
//   external script. Lives in root lib/ (NOT under api/) so Vercel does not
//   count it as a serverless function.
//   PUTs are idempotent, so re-uploading the same key is safe.
//   Never log or return credential values from this module.
"use strict";
const crypto = require("crypto");

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data).digest(); }
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function r2Configured() {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_ENDPOINT && process.env.R2_BUCKET);
}

function r2PublicBase() {
  return (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

// SigV4-signed PUT of one object to R2 (S3-compatible API, region "auto").
//   { key, body (Buffer), contentType } — key is the full object key, e.g.
//   "design/202611/<file>.jpg". Returns { key, bytes, url } where url is the
//   public URL when R2_PUBLIC_BASE_URL is set, else null. Throws on any
//   failure; the message never contains a credential.
async function putObject({ key, body, contentType }) {
  const accessKey = process.env.R2_ACCESS_KEY_ID || "";
  const secretKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const endpoint = (process.env.R2_ENDPOINT || "").replace(/\/$/, "");
  const bucket = process.env.R2_BUCKET || "";
  if (!accessKey || !secretKey || !endpoint || !bucket) {
    throw new Error("R2 credentials not configured");
  }
  const ct = contentType || "image/jpeg";
  const url = new URL(`${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const amzdate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const canonicalHeaders = `content-type:${ct}\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");
  const scope = `${datestamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzdate, scope, sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, datestamp), "auto"), "s3"), "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  const r = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": ct,
      "x-amz-date": amzdate,
      "x-amz-content-sha256": payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`R2 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const base = r2PublicBase();
  return { key, bytes: body.length, url: base ? `${base}/${key}` : null };
}

module.exports = { r2Configured, r2PublicBase, putObject };
