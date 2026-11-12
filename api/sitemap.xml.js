// GET /sitemap.xml — generated live from the article store (was a static file
// rebuilt by push_feeds.py on every publish). Same shape as the live sitemap:
// homepage + one <url> per published article, lastmod = publish date.
"use strict";
const { listArticles, siteUrl, setCache } = require("../lib/data");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).send("method not allowed");
    return;
  }
  try {
    const { articles, total } = await listArticles({ limit: 100, page: 1 });
    // listArticles caps limit at 100; page through the rest for the sitemap.
    let all = [...articles];
    const pages = Math.ceil(total / 100);
    for (let p = 2; p <= pages; p++) {
      const r = await listArticles({ limit: 100, page: p });
      all = all.concat(r.articles);
    }
    const base = siteUrl(req);
    const urls = [`  <url><loc>${esc(base)}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`];
    for (const a of all) {
      urls.push(`  <url><loc>${esc(base)}/a/${esc(a.id)}.html</loc><lastmod>${esc((a.published_at || "").slice(0, 10))}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`);
    }
    setCache(res, 600);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`);
  } catch (e) {
    res.status(500).send(String(e.message || e).slice(0, 200));
  }
};
