// GET /api/admin/config — what the admin page needs to render the Google
// Sign-In button. The client id is a public identifier, not a secret, so
// this endpoint needs no auth — but it reveals nothing else. When any admin
// env var is missing, `configured` is false and the page shows a setup note
// instead of the sign-in button.
"use strict";
const { googleClientId, adminConfigured } = require("../../lib/admin-auth");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  res.status(200).json({
    ok: true,
    clientId: googleClientId() || null,
    configured: adminConfigured(),
  });
};
