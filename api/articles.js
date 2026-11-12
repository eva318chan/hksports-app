// GET /api/articles?sport=&date=&tag=&q=&page=&limit=&sort=
// List published articles, newest first (live homepage order). sort=image_first
// gives the rule-5C order (with-image first, then imageless, newest first).
// Same JSON shape as the old data/*.json files.
"use strict";
const { listArticles, setCache } = require("../lib/data");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  const q = req.query || {};
  try {
    const out = await listArticles({
      sport: (q.sport || "").trim() || undefined,
      date: (q.date || "").trim() || undefined,
      tag: (q.tag || "").trim() || undefined,
      q: (q.q || "").trim() || undefined,
      page: q.page, limit: q.limit, sort: q.sort,
    });
    setCache(res, 60);
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
