// /api/admin/articles — article management (Google SSO admin session only).
//   GET    ?page=&limit=&q=&status=        list, all statuses, newest first
//   GET    ?id=<slug>                       one article (any status)
//   POST   {slug?, title_*, summary_*, tags_*, sport, published_at,
//           source_name, source_url, image_url, image_r2_key,
//           image_caption, footer_note, image_prompt?, status}
//                                          create — slug auto-derived from
//                                          the English title when omitted;
//                                          409 when the slug already exists
//   PATCH  ?id=<slug>  {title_*, summary_*, tags_*, sport, image_url,
//                       image_r2_key, image_caption, footer_note,
//                       image_prompt, published_at, source_name, source_url,
//                       status}
//   DELETE ?id=<slug>                       delete (the UI confirms first)
// Editable text is title_*/summary_* in en/zh_hant/zh_hans — articles have
// no full body column; the article page renders the summary as its content.
// Writes return 503 in seed mode (no database to write to).
"use strict";
const { requireAdmin } = require("../../lib/admin-auth");
const {
  SITE, dbConfigured, adminListArticles, getArticleAdmin, createArticle, updateArticle, deleteArticle,
} = require("../../lib/data");

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

const LANGS = ["en", "zh_hant", "zh_hans"];
const SPORTS = new Set([
  "football", "basketball", "badminton", "table_tennis", "tennis",
  "athletics", "swimming", "volleyball", "cycling", "rugby", "golf",
  "snooker", "boxing_mma", "esports", "racing", "cricket", "handball",
  "f1", "motorsport", "baseball", "bowling", "others",
]);

// Only real articles columns, with the right shape — nothing else reaches the DB.
function cleanPatch(body) {
  if (!body || typeof body !== "object") return null;
  const patch = {};
  for (const lang of LANGS) {
    if (body[`title_${lang}`] !== undefined) {
      if (typeof body[`title_${lang}`] !== "string") return { error: `title_${lang} must be a string` };
      patch[`title_${lang}`] = body[`title_${lang}`].slice(0, 500);
    }
    if (body[`summary_${lang}`] !== undefined) {
      if (typeof body[`summary_${lang}`] !== "string") return { error: `summary_${lang} must be a string` };
      patch[`summary_${lang}`] = body[`summary_${lang}`].slice(0, 5000);
    }
    if (body[`tags_${lang}`] !== undefined) {
      if (!Array.isArray(body[`tags_${lang}`]) || body[`tags_${lang}`].some((t) => typeof t !== "string")) {
        return { error: `tags_${lang} must be an array of strings` };
      }
      patch[`tags_${lang}`] = body[`tags_${lang}`].map((t) => t.trim()).filter(Boolean).slice(0, 30);
    }
  }
  if (body.sport !== undefined) {
    if (typeof body.sport !== "string" || !SPORTS.has(body.sport.trim())) return { error: "sport must be one of the 22 sport keys" };
    patch.sport = body.sport.trim().slice(0, 50);
  }
  if (body.image_url !== undefined) {
    if (body.image_url !== null && typeof body.image_url !== "string") return { error: "image_url must be a string or null" };
    patch.image_url = body.image_url ? body.image_url.trim().slice(0, 2000) : null;
  }
  if (body.image_r2_key !== undefined) {
    if (body.image_r2_key !== null && typeof body.image_r2_key !== "string") return { error: "image_r2_key must be a string or null" };
    patch.image_r2_key = body.image_r2_key ? body.image_r2_key.trim().slice(0, 500) : null;
  }
  if (body.image_caption !== undefined) {
    if (body.image_caption !== null && typeof body.image_caption !== "string") return { error: "image_caption must be a string or null" };
    patch.image_caption = body.image_caption ? body.image_caption.slice(0, 1000) : null;
  }
  if (body.footer_note !== undefined) {
    if (body.footer_note !== null && typeof body.footer_note !== "string") return { error: "footer_note must be a string or null" };
    patch.footer_note = body.footer_note ? body.footer_note.slice(0, 1000) : null;
  }
  if (body.image_prompt !== undefined) {
    if (body.image_prompt !== null && typeof body.image_prompt !== "string") return { error: "image_prompt must be a string or null" };
    patch.image_prompt = body.image_prompt ? body.image_prompt.slice(0, 5000) : null;
  }
  if (body.published_at !== undefined) {
    if (typeof body.published_at !== "string" || Number.isNaN(Date.parse(body.published_at))) return { error: "published_at must be a valid date/time" };
    patch.published_at = new Date(body.published_at).toISOString();
  }
  if (body.source_name !== undefined) {
    if (body.source_name !== null && typeof body.source_name !== "string") return { error: "source_name must be a string or null" };
    patch.source_name = body.source_name ? body.source_name.trim().slice(0, 500) : null;
  }
  if (body.source_url !== undefined) {
    if (body.source_url !== null && typeof body.source_url !== "string") return { error: "source_url must be a string or null" };
    patch.source_url = body.source_url ? body.source_url.trim().slice(0, 2000) : null;
  }
  if (body.status !== undefined) {
    if (body.status !== "published" && body.status !== "draft") return { error: "status must be published or draft" };
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) return { error: "nothing to update" };
  return { patch };
}

const SLUG_RE = /^[a-z0-9-]+$/;

function slugify(text) {
  return String(text || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

// Validate a create payload; returns { row } (a DB row) or { error }.
// Only a title (zh_hant or en) is required. Slug is optional — auto-derived
// from the English title (then zh_hant / zh_hans) when omitted. Dots are
// rejected: a dotted slug broke the old /a/<id>.html routing (see the
// 20260930-yuan-fixing rename, dot -> hyphen). image_prompt is only sent
// when supplied, because the column is added by migration 002 — sending it
// before 002 is applied would fail the insert (same rule as /api/ingest).
function cleanCreate(body) {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  let slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (slug) {
    if (slug.includes(".")) return { error: "slug must not contain dots — use hyphens instead" };
    if (!SLUG_RE.test(slug) || slug.startsWith("-") || slug.endsWith("-")) {
      return { error: "slug must be lowercase letters, digits and hyphens only" };
    }
    if (slug.length > 200) return { error: "slug is too long (max 200 characters)" };
  } else {
    slug = slugify(body.title_en) || slugify(body.title_zh_hant) || slugify(body.title_zh_hans);
    if (!slug) return { error: "cannot derive a slug from the title — please supply a slug" };
  }
  const title = {};
  const summary = {};
  const tags = {};
  for (const lang of LANGS) {
    if (body[`title_${lang}`] !== undefined && typeof body[`title_${lang}`] !== "string") return { error: `title_${lang} must be a string` };
    if (body[`summary_${lang}`] !== undefined && typeof body[`summary_${lang}`] !== "string") return { error: `summary_${lang} must be a string` };
    if (body[`tags_${lang}`] !== undefined) {
      if (!Array.isArray(body[`tags_${lang}`]) || body[`tags_${lang}`].some((t) => typeof t !== "string")) {
        return { error: `tags_${lang} must be an array of strings` };
      }
    }
    title[lang] = (body[`title_${lang}`] || "").trim().slice(0, 500);
    summary[lang] = (body[`summary_${lang}`] || "").trim().slice(0, 5000);
    tags[lang] = (body[`tags_${lang}`] || []).map((t) => t.trim()).filter(Boolean).slice(0, 30);
  }
  if (!title.zh_hant && !title.en) return { error: "at least one title (zh_hant or en) is required" };
  let publishedAt = new Date().toISOString();
  if (body.published_at !== undefined && body.published_at !== null && body.published_at !== "") {
    if (typeof body.published_at !== "string" || Number.isNaN(Date.parse(body.published_at))) return { error: "published_at must be a valid date/time" };
    publishedAt = new Date(body.published_at).toISOString();
  }
  const status = body.status === undefined || body.status === null || body.status === "" ? "published" : body.status;
  if (status !== "published" && status !== "draft") return { error: "status must be published or draft" };
  const sport = typeof body.sport === "string" && SPORTS.has(body.sport.trim()) ? body.sport.trim() : "others";
  const srcName = typeof body.source_name === "string" ? body.source_name.trim().slice(0, 500)
    : (body.source && typeof body.source === "object" && typeof body.source.name === "string" ? body.source.name.trim().slice(0, 500) : "");
  const srcUrl = typeof body.source_url === "string" ? body.source_url.trim().slice(0, 2000)
    : (body.source && typeof body.source === "object" && typeof body.source.url === "string" ? body.source.url.trim().slice(0, 2000) : "");
  const optStr = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const row = {
    site: SITE,
    slug,
    sport,
    published_at: publishedAt,
    source_name: srcName || null,
    source_url: srcUrl || null,
    image_url: optStr(body.image_url, 2000),
    image_r2_key: optStr(body.image_r2_key, 500),
    image_caption: optStr(body.image_caption, 1000),
    footer_note: optStr(body.footer_note, 1000),
    ...(typeof body.image_prompt === "string" && body.image_prompt.trim()
      ? { image_prompt: body.image_prompt.trim().slice(0, 5000) } : {}),
    title_en: title.en,
    title_zh_hant: title.zh_hant,
    title_zh_hans: title.zh_hans,
    summary_en: summary.en,
    summary_zh_hant: summary.zh_hant,
    summary_zh_hans: summary.zh_hans,
    tags_en: tags.en,
    tags_zh_hant: tags.zh_hant,
    tags_zh_hans: tags.zh_hans,
    status,
  };
  return { row };
}

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = req.query || {};
  const slug = String(q.id || "").trim();

  try {
    if (req.method === "GET") {
      if (slug) {
        const a = await getArticleAdmin(slug);
        if (!a) { res.status(404).json({ ok: false, error: "not found" }); return; }
        res.status(200).json({ ok: true, article: a });
        return;
      }
      const out = await adminListArticles({
        page: q.page, limit: q.limit,
        q: (q.q || "").trim(),
        status: (q.status || "").trim(),
      });
      res.status(200).json({ ok: true, ...out });
      return;
    }

    if (req.method === "POST") {
      if (!dbConfigured) { res.status(503).json({ ok: false, error: "database not configured" }); return; }
      let body;
      try { body = await readBody(req); }
      catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
      const cleaned = cleanCreate(body);
      if (cleaned.error) { res.status(400).json({ ok: false, error: cleaned.error }); return; }
      try {
        const created = await createArticle(cleaned.row);
        if (!created) { res.status(502).json({ ok: false, error: "database did not return the created article" }); return; }
        res.status(201).json({ ok: true, article: created, url: `/a/${created.slug}.html` });
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.startsWith("slug already exists") || /duplicate key|already exists/i.test(msg)) {
          res.status(409).json({ ok: false, error: `an article with slug "${cleaned.row.slug}" already exists — use PATCH to update it` });
          return;
        }
        res.status(502).json({ ok: false, error: `database error: ${msg.slice(0, 200)}` });
      }
      return;
    }

    if (req.method === "PATCH") {
      if (!slug) { res.status(400).json({ ok: false, error: "missing id" }); return; }
      if (!dbConfigured) { res.status(503).json({ ok: false, error: "database not configured" }); return; }
      let body;
      try { body = await readBody(req); }
      catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
      const cleaned = cleanPatch(body);
      if (cleaned.error) { res.status(400).json({ ok: false, error: cleaned.error }); return; }
      const updated = await updateArticle(slug, cleaned.patch);
      if (!updated) { res.status(404).json({ ok: false, error: "not found" }); return; }
      res.status(200).json({ ok: true, article: updated });
      return;
    }

    if (req.method === "DELETE") {
      if (!slug) { res.status(400).json({ ok: false, error: "missing id" }); return; }
      if (!dbConfigured) { res.status(503).json({ ok: false, error: "database not configured" }); return; }
      const existing = await getArticleAdmin(slug);
      if (!existing) { res.status(404).json({ ok: false, error: "not found" }); return; }
      await deleteArticle(slug);
      res.status(200).json({ ok: true, deleted: slug });
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    res.status(405).json({ ok: false, error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
