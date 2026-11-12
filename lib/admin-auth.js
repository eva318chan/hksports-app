// Admin auth — Google SSO only, no passwords.
//   * The admin page signs the user in with Google Identity Services and
//     POSTs the ID token to /api/admin/auth/callback.
//   * The callback verifies the token with Google, checks the email against
//     ADMIN_EMAILS, and sets a signed httpOnly session cookie.
//   * Every /api/admin/ route calls requireAdmin() first.
// Env vars (all read at runtime; missing any of them fails closed):
//   GOOGLE_CLIENT_ID — Google OAuth client id (public id, not a secret)
//   ADMIN_EMAILS — comma-separated allowlist, e.g. eddiehlk@gmail.com
//   ADMIN_SESSION_SECRET — random HMAC key for the session cookie
// No secret is ever logged or returned by this module.
"use strict";

const crypto = require("crypto");

const COOKIE = "hksports_admin_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch (e) { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function sessionSecret() { return process.env.ADMIN_SESSION_SECRET || ""; }

function adminEmails() {
  return (process.env.ADMIN_EMAILS || "").split(",")
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function googleClientId() { return process.env.GOOGLE_CLIENT_ID || ""; }

// All three must be present or the admin is unusable — fail closed.
function adminConfigured() {
  return Boolean(sessionSecret() && adminEmails().length && googleClientId());
}

function signSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email, exp: Date.now() + SESSION_TTL_MS,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(req) {
  const token = parseCookies(req)[COOKIE] || "";
  const secret = sessionSecret();
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch (e) { return null; }
  if (!data.email || !data.exp || data.exp < Date.now()) return null;
  const email = String(data.email).toLowerCase();
  if (!adminEmails().includes(email)) return null;
  return email;
}

// Returns the signed-in admin email, or sends 401 and returns null.
function requireAdmin(req, res) {
  const email = verifySession(req);
  if (!email) {
    res.status(401).json({ ok: false, error: "unauthorized: sign in with Google" });
    return null;
  }
  return email;
}

function sessionCookieHeader(email) {
  return `${COOKIE}=${signSession(email)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = {
  COOKIE, adminEmails, googleClientId, adminConfigured,
  signSession, verifySession, requireAdmin,
  sessionCookieHeader, clearCookieHeader,
};
