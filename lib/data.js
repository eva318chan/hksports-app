// Data layer for hksports-app — one seam, two backends.
//   * Supabase Postgres when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (server-side only).
//   * Bundled seed data (data/seed.json, snapshot of the live static repo) otherwise.
// Swapping seed -> real DB/R2 is env-only, no code change.
// Images: R2 public URL (R2_PUBLIC_BASE_URL) when configured, else the stored
// image_url (hotlink or old-site URL). No local design-image copies in this repo.
// Sports table is `sports_articles` — NEVER the news `articles` table.
// No secrets in this file. Nothing here runs in the browser.
"use strict";

const SITE = "hksports";
const TABLE = "sports_articles";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const R2_BASE = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

const dbConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
const r2Configured = Boolean(R2_BASE);

let seedCache = null;
function loadSeed() {
  if (!seedCache) {
    seedCache = require("../data/seed.json");
    seedCache.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
  }
  return seedCache;
}

let metaCache = null;
function loadSeedMeta() {
  if (!metaCache) metaCache = require("../data/seed-meta.json");
  return metaCache;
}

// Old-site design images live at /assets/design/<file> (hksports.hk or
// hkcn-sports-news.vercel.app). In this app they are served from
// <R2_BASE>/design/202611/<file> once R2 is configured; before that the
// stored image_url is returned as-is. The 9 self-hosted images live at
// /assets/... keys (see image_r2_key) and follow the same rule.
function resolveImage(a) {
  const url = a.image_url || "";
  const key = a.image_r2_key || "";
  if (key && r2Configured) return `${R2_BASE}/${key}`;
  if (key) return url;
  const m = url.match(/\/assets\/design\/([^/?#]+\.jpg)$/i);
  if (m) {
    if (r2Configured) return `${R2_BASE}/design/202611/${m[1]}`;
    return url;
  }
  return url;
}

// Public shape — identical to the old data/*.json shape, plus caption/footer
// extras that used to live only in the static HTML.
function toPublic(a) {
  const out = {
    id: a.id || a.slug,
    sport: a.sport,
    published_at: a.published_at,
    // Sports source is a plain string (institution name), not an object.
    source: typeof a.source === "string" ? a.source : (a.source_name || (a.source && a.source.name) || ""),
    source_url: a.source_url || (a.source && a.source.url) || "",
    image_url: resolveImage(a),
    title: a.title || { en: a.title_en || "", zh_hant: a.title_zh_hant || "", zh_hans: a.title_zh_hans || "" },
    summary: a.summary || { en: a.summary_en || "", zh_hant: a.summary_zh_hant || "", zh_hans: a.summary_zh_hans || "" },
    tags: a.tags || { en: a.tags_en || [], zh_hant: a.tags_zh_hant || [], zh_hans: a.tags_zh_hans || [] },
  };
  if (a.image_caption) out.image_caption = a.image_caption;
  if (a.footer_note) out.footer_note = a.footer_note;
  if (a.extra_images) out.extra_images = a.extra_images;
  return out;
}

function fromDbRow(r) {
  return {
    id: r.slug, slug: r.slug, sport: r.sport, published_at: r.published_at,
    status: r.status || "published",
    source_name: r.source_name, source_url: r.source_url,
    image_url: r.image_url, image_r2_key: r.image_r2_key,
    image_caption: r.image_caption, footer_note: r.footer_note,
    image_prompt: r.image_prompt || null,
    extra_images: r.extra_images || null,
    title_en: r.title_en, title_zh_hant: r.title_zh_hant, title_zh_hans: r.title_zh_hans,
    summary_en: r.summary_en, summary_zh_hant: r.summary_zh_hant, summary_zh_hans: r.summary_zh_hans,
    tags_en: r.tags_en, tags_zh_hant: r.tags_zh_hant, tags_zh_hans: r.tags_zh_hans,
  };
}

async function sbFetch(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// PostgREST caps a single response at 1000 rows (server max-rows), so a
// limit=2000 request silently returns only the newest 1000 rows. Fetch in
// pages of 1000 with limit/offset until a short page arrives, and take the
// true total from the Content-Range header (Prefer: count=exact) instead of
// trusting the number of rows returned.
async function sbFetchPaged(path, params) {
  const PAGE = 1000;
  const rows = [];
  let total = null;
  for (let offset = 0; ; offset += PAGE) {
    const p = new URLSearchParams(params);
    p.set("limit", String(PAGE));
    p.set("offset", String(offset));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${p.toString()}`, {
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "count=exact",
      },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const page = await r.json();
    const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/);
    if (m) total = parseInt(m[1], 10);
    rows.push(...page);
    if (page.length < PAGE) break;
    if (total !== null && rows.length >= total) break;
  }
  return { rows, total: total ?? rows.length };
}

// Single PostgREST page: limit + offset with Prefer: count=exact. The true
// total comes from the Content-Range header — listArticles never fetches rows
// beyond the requested page.
async function sbFetchPage(path, params, limit, offset) {
  const p = new URLSearchParams(params);
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${p.toString()}`, {
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "count=exact",
    },
  });
  if (r.status === 416) {
    // Offset past the end of the filtered set: PostgREST refuses the range
    // instead of returning an empty page. Return the empty page with the
    // true total from a limit=0 probe.
    const probe = await sbFetchPage(path, params, 0, 0);
    return { rows: [], total: probe.total };
  }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const rows = await r.json();
  const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/);
  return { rows, total: m ? parseInt(m[1], 10) : rows.length };
}

function nextDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return date;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)).toISOString().slice(0, 10);
}

// Build the PostgREST filter params for a list query. Server-side filters
// are the authority now; listArticles still re-applies `matches` to the
// fetched page as a safety net, so the two paths agree. Tag + search together
// used to overwrite each other (both used the `or` param) — they are combined
// into one `and` group now.
function listParams({ sport, date, tag, q }, imageFilter) {
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("site", `eq.${SITE}`);
  params.set("status", "eq.published");
  if (sport) params.set("sport", `eq.${sport}`);
  const ands = [];
  const ors = [];
  if (date) {
    // Day window in Hong Kong time — the same day the /api/meta date chips
    // count (sports_meta groups by Asia/Hong_Kong). Half-open, so the last
    // second of the day is included too. A malformed date matches nothing
    // instead of everything.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ands.push(`published_at.gte.${date}T00:00:00+08:00`);
      ands.push(`published_at.lt.${nextDay(date)}T00:00:00+08:00`);
    } else {
      ands.push("published_at.gte.9999-12-31T00:00:00+08:00");
      ands.push("published_at.lt.9999-12-31T00:00:01+08:00");
    }
  }
  if (tag) ors.push(`(tags_zh_hant.cs.{${tag}},tags_en.cs.{${tag}},tags_zh_hans.cs.{${tag}})`);
  if (q) {
    // Escape LIKE wildcards so the server pattern means the same substring
    // search as the JS `includes` check below.
    const like = `*${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}*`;
    ors.push(`(title_zh_hant.ilike.${like},title_en.ilike.${like},summary_zh_hant.ilike.${like},summary_en.ilike.${like},source_name.ilike.${like})`);
  }
  if (imageFilter === "with") ands.push("image_url.neq.");
  if (imageFilter === "without") ors.push("(image_url.is.null,image_url.eq.)");
  if (ors.length === 1 && ands.length === 0) params.set("or", ors[0]);
  else if (ands.length + ors.length > 0) {
    params.set("and", `(${[...ands, ...ors.map((o) => `or${o}`)].join(",")})`);
  }
  // Secondary key makes page boundaries deterministic when several rows
  // share the same published_at.
  params.set("order", "published_at.desc,slug.asc");
  return params;
}

// Fetch published rows for this site. Only the getMeta fallback (RPC missing)
// still needs the full set — listArticles pages through sbFetchPage now.
async function fetchRows({ sport, date, tag, q }) {
  if (!dbConfigured) {
    return loadSeed().filter((a) => (a.site === SITE || !a.site)
      && (a.status || "published") === "published");
  }
  const params = listParams({ sport, date, tag, q });
  const { rows } = await sbFetchPaged(TABLE, params);
  return rows.map(fromDbRow);
}

// sort=image_first: with-image articles first, then imageless, each newest
// first. PostgREST cannot order by "has image", so the page is assembled
// from two single-page queries (one per partition) — never more rows than
// the requested page, plus one limit=0 count probe when the page lies fully
// inside the first partition.
async function listImageFirst(opts, page, limit, offset) {
  const withParams = listParams(opts, "with");
  const first = await sbFetchPage(TABLE, withParams, limit, offset);
  let rows = first.rows;
  let total = first.total;
  if (offset + limit > first.total) {
    const withoutParams = listParams(opts, "without");
    const withoutOffset = Math.max(0, offset - first.total);
    const withoutLimit = limit - Math.max(0, first.total - offset);
    const second = await sbFetchPage(TABLE, withoutParams, withoutLimit, withoutOffset);
    total = first.total + second.total;
    rows = offset < first.total ? [...first.rows, ...second.rows] : second.rows;
  } else {
    const withoutParams = listParams(opts, "without");
    const { total: totalWithout } = await sbFetchPage(TABLE, withoutParams, 0, 0);
    total = first.total + totalWithout;
  }
  const articles = rows.map(fromDbRow).filter((a) => matches(a, opts)).map(toPublic);
  const pages = Math.max(1, Math.ceil(total / limit));
  return { total, page, limit, pages, articles };
}

function allTags(a) {
  if (Array.isArray(a.tags)) return a.tags;
  return [...(a.tags?.en || []), ...(a.tags?.zh_hant || []), ...(a.tags?.zh_hans || []),
    ...(a.tags_en || []), ...(a.tags_zh_hant || []), ...(a.tags_zh_hans || [])];
}

function matches(a, { sport, date, tag, q }) {
  if (sport && a.sport !== sport) return false;
  if (date && hktDate(a.published_at) !== date) return false;
  if (tag && !allTags(a).includes(tag)) return false;
  if (q) {
    const needle = q.toLowerCase();
    const hay = [
      a.title?.en, a.title?.zh_hant, a.title?.zh_hans,
      a.summary?.en, a.summary?.zh_hant, a.summary?.zh_hans,
      a.title_en, a.title_zh_hant, a.title_zh_hans,
      a.summary_en, a.summary_zh_hant, a.summary_zh_hans,
      typeof a.source === "string" ? a.source : a.source?.name, a.source_name,
      ...allTags(a),
    ].join(" ").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// Live homepage order is published_at DESC. Rule 5C image-first ordering
// lives in the daily JSON files, but the live homepage does NOT show it.
// Default sort therefore matches the live site; ?sort=image_first gives
// the 5C order explicitly.
function sortRows(rows, sort) {
  const byDate = (a, b) => (b.published_at || "").localeCompare(a.published_at || "");
  if (sort === "image_first") {
    const withImg = rows.filter((a) => (a.image_url || "").trim() !== "").sort(byDate);
    const without = rows.filter((a) => !(a.image_url || "").trim()).sort(byDate);
    return [...withImg, ...without];
  }
  return [...rows].sort(byDate);
}

// Date chips count Hong Kong days (sports_meta groups by Asia/Hong_Kong),
// and published_at is an instant — compare the Hong Kong date of the
// instant, not the UTC date the API renders.
function hktDate(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 10);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function listArticles(opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 30));
  const offset = (page - 1) * limit;
  if (!dbConfigured) {
    const rows = loadSeed().filter((a) => (a.site === SITE || !a.site)
      && (a.status || "published") === "published");
    const filtered = rows.filter((a) => matches(a, opts));
    const sorted = sortRows(filtered, opts.sort);
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    return { total, page, limit, pages, articles: sorted.slice(offset, offset + limit).map(toPublic) };
  }
  if (opts.sort === "image_first") return listImageFirst(opts, page, limit, offset);
  const params = listParams(opts);
  const { rows, total } = await sbFetchPage(TABLE, params, limit, offset);
  const articles = rows.map(fromDbRow).filter((a) => matches(a, opts)).map(toPublic);
  const pages = Math.max(1, Math.ceil(total / limit));
  return { total, page, limit, pages, articles };
}

async function getArticle(slug) {
  if (!slug) return null;
  if (!dbConfigured) {
    const a = loadSeed().find((x) => x.id === slug);
    if (!a || (a.status || "published") !== "published") return null;
    return toPublic(a);
  }
  const rows = await sbFetch(`${TABLE}?select=*&site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}&status=eq.published&limit=1`);
  return rows.length ? toPublic(fromDbRow(rows[0])) : null;
}

async function getMeta() {
  if (!dbConfigured) {
    const m = loadSeedMeta();
    return { updated_at: m.updated_at, dates: m.dates, total: m.total, source: "seed" };
  }
  try {
    const r = await sbFetch("rpc/sports_meta");
    return { updated_at: r.updated_at, dates: r.dates, total: r.total, source: "supabase" };
  } catch (e) {
    // RPC not installed yet — fall back to counting from a bounded fetch.
    const rows = await fetchRows({});
    const counts = {};
    for (const a of rows) counts[hktDate(a.published_at)] = (counts[hktDate(a.published_at)] || 0) + 1;
    const dates = Object.keys(counts).sort().reverse().map((d) => ({ date: d, count: counts[d] }));
    return { updated_at: rows[0]?.published_at || "", dates, total: rows.length, source: "supabase (no rpc)" };
  }
}

function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "";
  const proto = (req.headers && req.headers["x-forwarded-proto"]) || "https";
  return host ? `${proto}://${host}` : "https://hksports.hk";
}

function setCache(res, seconds) {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=300`);
}

// ---- Admin (api/admin/*) ----
// Full row shape for the admin UI: everything toPublic has, plus the fields
// only an admin may see or change (status, image_prompt, raw column names).
function toAdmin(a) {
  const pub = toPublic(a);
  return {
    ...pub,
    slug: a.slug || a.id,
    sport: a.sport,
    status: a.status || "published",
    image_r2_key: a.image_r2_key || null,
    image_prompt: a.image_prompt || null,
    source_name: a.source_name || (typeof a.source === "string" ? a.source : a.source?.name) || "",
    source_url: a.source_url || (typeof a.source === "string" ? "" : a.source?.url) || "",
    title_en: a.title_en ?? pub.title.en,
    title_zh_hant: a.title_zh_hant ?? pub.title.zh_hant,
    title_zh_hans: a.title_zh_hans ?? pub.title.zh_hans,
    summary_en: a.summary_en ?? pub.summary.en,
    summary_zh_hant: a.summary_zh_hant ?? pub.summary.zh_hant,
    summary_zh_hans: a.summary_zh_hans ?? pub.summary.zh_hans,
    tags_en: a.tags_en ?? pub.tags.en,
    tags_zh_hant: a.tags_zh_hant ?? pub.tags.zh_hant,
    tags_zh_hans: a.tags_zh_hans ?? pub.tags.zh_hans,
  };
}

function seedAdminRow(a) {
  return toAdmin({
    ...a, slug: a.id, status: a.status || "published",
    source_name: typeof a.source === "string" ? a.source : a.source?.name,
    source_url: typeof a.source === "string" ? "" : a.source?.url,
  });
}

// Admin list: ALL statuses (drafts included), newest first, optional search
// across slug + titles + summaries and optional status filter.
async function adminListArticles({ page = 1, limit = 30, q = "", status = "" } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (page - 1) * limit;
  if (!dbConfigured) {
    let rows = loadSeed().filter((a) => a.site === SITE || !a.site);
    if (status === "published" || status === "draft") {
      rows = rows.filter((a) => (a.status || "published") === status);
    }
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((a) => [
        a.id, a.title?.en, a.title?.zh_hant, a.title?.zh_hans,
        a.summary?.en, a.summary?.zh_hant, a.summary?.zh_hans,
      ].join(" ").toLowerCase().includes(needle));
    }
    rows.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
    const total = rows.length;
    return {
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      articles: rows.slice(offset, offset + limit).map(seedAdminRow),
    };
  }
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("site", `eq.${SITE}`);
  if (status === "published" || status === "draft") params.set("status", `eq.${status}`);
  if (q) {
    const like = `*${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}*`;
    params.set("or", `(slug.ilike.${like},title_zh_hant.ilike.${like},title_en.ilike.${like},summary_zh_hant.ilike.${like})`);
  }
  params.set("order", "published_at.desc,slug.asc");
  const { rows, total } = await sbFetchPage(TABLE, params, limit, offset);
  return {
    total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
    articles: rows.map((r) => toAdmin(fromDbRow(r))),
  };
}

// One article for the admin editor, any status. Null when missing.
async function getArticleAdmin(slug) {
  if (!slug) return null;
  if (!dbConfigured) {
    const a = loadSeed().find((x) => x.id === slug);
    return a ? seedAdminRow(a) : null;
  }
  const rows = await sbFetch(`${TABLE}?select=*&site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return rows.length ? toAdmin(fromDbRow(rows[0])) : null;
}

async function sbWrite(path, method, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Create one article (admin only). `row` is a full DB row (site, slug,
// sport, published_at, source_*, image_*, title_*, summary_*, tags_*,
// status); the caller validates. Throws "slug already exists: <slug>" when
// a row with that slug is already there — never silently overwrites.
// Returns the created admin row.
async function createArticle(row) {
  if (!dbConfigured) throw new Error("database not configured");
  const existing = await getArticleAdmin(row.slug);
  if (existing) throw new Error(`slug already exists: ${row.slug}`);
  const rows = await sbWrite(TABLE, "POST", row);
  return Array.isArray(rows) && rows.length ? toAdmin(fromDbRow(rows[0])) : null;
}

// Update one article (admin only). `patch` may only contain real columns;
// the caller validates. Returns the updated admin row, or null if the slug
// does not exist. Throws when the DB is not configured.
async function updateArticle(slug, patch) {
  if (!dbConfigured) throw new Error("database not configured");
  const rows = await sbWrite(
    `${TABLE}?site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}`, "PATCH", patch);
  return Array.isArray(rows) && rows.length ? toAdmin(fromDbRow(rows[0])) : null;
}

// Delete one article (admin only). Returns true when a row was removed.
async function deleteArticle(slug) {
  if (!dbConfigured) throw new Error("database not configured");
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE}?site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}`,
    { method: "DELETE", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return true;
}

module.exports = {
  SITE, dbConfigured, r2Configured, listArticles, getArticle, getMeta,
  toPublic, resolveImage, siteUrl, setCache,
  toAdmin, adminListArticles, getArticleAdmin, createArticle, updateArticle, deleteArticle,
};
