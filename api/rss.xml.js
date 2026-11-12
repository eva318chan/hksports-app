// GET /rss.xml — latest 50 published articles (was a static file rebuilt by
// push_feeds.py). Same item fields as the live feed: title/link/guid/pubDate/
// description in zh_hant, description truncated at 500 chars like the old feed.
"use strict";
const { listArticles, siteUrl, setCache } = require("../lib/data");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// published_at is already a Hong Kong wall time (+08:00); keep its wall time
// and label +0800 (do NOT convert through UTC, which would shift it 8 hours).
function rfcDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]}, ${m[3]} ${months[+m[2] - 1]} ${m[1]} ${m[4]}:${m[5]}:${m[6]} +0800`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).send("method not allowed");
    return;
  }
  try {
    const { articles } = await listArticles({ limit: 50, page: 1 });
    const base = siteUrl(req);
    const last = articles[0]?.published_at || "";
    const items = articles.map((a) => {
      const link = `${base}/a/${a.id}.html`;
      const desc = (a.summary?.zh_hant || a.summary?.en || "").slice(0, 500);
      return `<item>\n<title>${esc(a.title?.zh_hant || a.title?.en || "")}</title>\n<link>${esc(link)}</link>\n<guid>${esc(link)}</guid>\n<pubDate>${esc(rfcDate(a.published_at))}</pubDate>\n<description>${esc(desc)}</description>\n</item>`;
    });
    setCache(res, 600);
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n<title>港體育</title><link>${esc(base)}</link><description>港體育最新體育新聞</description><language>zh-hk</language><lastBuildDate>${esc(rfcDate(last))}</lastBuildDate>\n${items.join("\n")}\n</channel>\n</rss>`);
  } catch (e) {
    res.status(500).send(String(e.message || e).slice(0, 200));
  }
};
