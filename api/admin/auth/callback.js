// POST /api/admin/auth/callback — Google Sign-In exchange.
//   Body: { credential } — the Google ID token from Google Identity Services.
//   Body: { action: "logout" } — expires the session cookie server-side
//     (the cookie is HttpOnly, so the browser cannot clear it itself).
//   Verifies the token with Google (tokeninfo), checks the audience is this
//   app's GOOGLE_CLIENT_ID, the email is verified, and the email is on the
//   ADMIN_EMAILS allowlist. On success sets a signed httpOnly session cookie.
//   Fails closed (503) when any admin env var is missing, and 401 for an
//   invalid token or an email that is not allowlisted. The token is never
//   logged or stored.
"use strict";
const { googleClientId, adminEmails, adminConfigured, sessionCookieHeader, clearCookieHeader } = require("../../../lib/admin-auth");

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  if (!adminConfigured()) {
    res.status(503).json({ ok: false, error: "admin not configured" });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
  // Logout: POST { action: "logout" } clears the HttpOnly session cookie
  // server-side — JavaScript cannot touch an HttpOnly cookie, so the old
  // client-side document.cookie clear never worked. Handled before the
  // adminConfigured check so a stale session can always be cleared, even
  // if the env vars are misconfigured. No new function needed.
  if (body && body.action === "logout") {
    res.setHeader("Set-Cookie", clearCookieHeader());
    res.status(200).json({ ok: true, loggedOut: true });
    return;
  }
  const credential = (body.credential || "").trim();
  if (!credential) { res.status(400).json({ ok: false, error: "missing credential" }); return; }

  try {
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { headers: { Accept: "application/json" } });
    if (!r.ok) { res.status(401).json({ ok: false, error: "invalid Google token" }); return; }
    const info = await r.json();
    if (info.aud !== googleClientId()) {
      res.status(401).json({ ok: false, error: "token audience mismatch" });
      return;
    }
    if (info.email_verified !== "true" && info.email_verified !== true) {
      res.status(401).json({ ok: false, error: "email not verified" });
      return;
    }
    if (!info.exp || Number(info.exp) * 1000 < Date.now()) {
      res.status(401).json({ ok: false, error: "token expired" });
      return;
    }
    const email = String(info.email || "").toLowerCase();
    if (!email || !adminEmails().includes(email)) {
      res.status(401).json({ ok: false, error: "email not on the admin allowlist" });
      return;
    }
    res.setHeader("Set-Cookie", sessionCookieHeader(email));
    res.status(200).json({ ok: true, email });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
