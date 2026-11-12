// GET /api/article?slug=<id> — one published article as JSON, or 404.
"use strict";
const { getArticle, setCache } = require("../lib/data");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  const slug = String((req.query || {}).slug || "").trim();
  if (!slug) { res.status(400).json({ ok: false, error: "missing slug" }); return; }
  try {
    const a = await getArticle(slug);
    if (!a) { res.status(404).json({ ok: false, error: "not found" }); return; }
    setCache(res, 60);
    res.status(200).json({ ok: true, article: a });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
