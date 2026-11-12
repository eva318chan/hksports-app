// GET /api/meta — { updated_at, dates: [{date, count}], total, source }
// Replaces data/manifest.json for the homepage (date chips + counts).
"use strict";
const { getMeta, setCache } = require("../lib/data");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  try {
    const m = await getMeta();
    setCache(res, 60);
    res.status(200).json({ ok: true, ...m });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
