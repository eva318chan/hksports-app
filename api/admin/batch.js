// POST /api/admin/batch — Gemini Batch API image generation (admin only).
//   SPORTS version of the hkcn-news-app batch endpoint: same actions, same
//   flow, but its OWN tables (sports_image_batches / sports_image_batch_items /
//   sports_batch_logs) and its OWN articles table (sports_articles) — a sports
//   batch can never touch a news batch, and vice versa. R2 goes to the sports
//   bucket (R2_BUCKET env on hksports-app) via lib/r2, same as hkcn.
//   Shared with hkcn (same Supabase project, same Gemini key, same prepaid
//   credit): gemini_model_prices and gemini_credit_topups — prices and the
//   credit ledger are one shared pot, so credit-summary counts BOTH sites'
//   batch spend (see hkcnBatchSpendUSD), while stats() is sports-only.
//   One endpoint for the whole batch flow. Vercel Hobby allows 12 serverless
//   functions per deployment and this is #12, so every batch action lives
//   here behind an `action` field in the POST body.
//   Actions (POST body { action, ... }): list-articles, create, check,
//   approve, reject, list-batches, list-items, list-logs, stats,
//   credit-summary, credit-topup-add, auto-submit, auto-poll — identical to
//   hkcn. See the hkcn file for the full per-action notes; the Gemini Batch
//   API shape, double-nested inlinedResponses, key-based matching and the
//   3-attempt retry cap are all copied verbatim.
//   PAUSED (user decision 2026-11-14): the auto flow is built but NOT
//   wired up — no pipeline step calls auto-submit and no cron calls
//   auto-poll. Manual testing only (admin page: Generate -> Check ->
//   Approve) until the user is satisfied, then the user says the word and
//   the two wires are added (pipeline 5F + a 5-minute auto-poll cron).
//   DB tables (sql/001-sports-batch-tables.sql + sql/002-sports-batch-logs.sql
//   — run once in the Supabase SQL Editor): sports_image_batches,
//   sports_image_batch_items, sports_batch_logs. gemini_model_prices and
//   gemini_credit_topups already exist (shared with hkcn).
//   Auth: Google SSO admin session for manual actions; INGEST_SECRET
//   (x-ingest-secret) for auto-submit/auto-poll only, exactly as hkcn.
"use strict";
const crypto = require("crypto");
const { requireAdmin } = require("../../lib/admin-auth");
const { r2Configured, r2PublicBase, putObject, copyObject, deleteObject } = require("../../lib/r2");

const SITE = "hksports";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const STAGING_PREFIX = "staging/design";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TABLES_MISSING = "sports batch tables are not created yet — run sql/001-sports-batch-tables.sql in the Supabase SQL Editor, then try again";

// Fully automatic flow (user decision 2026-11-13: "全自動，連批准都自動").
// The 2-hour pipeline (step 5F) calls auto-submit; a 5-minute cron calls
// auto-poll. A cron cannot use Google SSO, so the two auto actions
// authenticate with INGEST_SECRET (x-ingest-secret, the same shared secret
// as /api/ingest) instead — see isAutoAuth(). Auto auth grants ONLY the
// two auto actions; every manual action still needs the Google SSO session.
// Auto actions only ever touch batches the auto flow created itself
// (created_by "auto"): manual batches stay fully manual — the user still
// checks and approves those in the admin.
const AUTO_MODEL = "gemini-3.1-flash-lite-image";
const AUTO_ACTOR = "auto";

// Automatic retries are capped (user decision 2026-11-13: "重試 3 times
// only", clarified: first submission fails, then at most 2 more automatic
// submissions). So one article gets at most 3 total attempts in the auto
// flow: failed 0 -> attempt 1, failed 1 -> retry 1, failed 2 -> retry 2,
// failed 3 -> parked, never auto-submitted again. A failed item counts
// toward the article's failed total whether it came from an auto batch or
// a manual Generate (a manual attempt that fails still counts). Manual
// Generate (create) is deliberately NOT capped — it is the escape hatch
// for a parked article.
const MAX_AUTO_ATTEMPTS = 3;

// Split candidate slugs into those the auto flow may submit and those
// parked by the retry cap. `failedCounts` is a Map slug -> number of
// failed items for that article. Pure (no DB access) so it can be
// unit-tested with fixtures — see the throwaway test, not committed.
function applyRetryCap(slugs, failedCounts) {
  const submit = [];
  const capped = [];
  for (const slug of slugs) {
    const n = failedCounts.get(slug) || 0;
    if (n >= MAX_AUTO_ATTEMPTS) capped.push({ slug, failed: n });
    else submit.push(slug);
  }
  return { submit, capped };
}

// ---- Gemini credit tracker (user request 2026-11-13) ----
// The user prepaid HK$160.00 on 2026-11-12 to open the Gemini API for
// image generation, and wants the batch page to show the estimated
// remaining credit (in USD) and how many Lite images it can still buy,
// so they know when to top up. Anchor numbers are from the user's own
// Cloud billing screenshots (2026-11-13) — do not guess them:
//   prepaid HK$160.00 (2026-11-12, Visa ••••9616)
//   Google-verified usage HK$16.79 as of 2026-11-13 -> remaining HK$143.21
//   batch page total spend at that same moment: US$1.6000 (85 images).
// The US$1.60 is already inside the HK$16.79, so only batch spend AFTER
// the anchor is added on top (converted at today's rate). The page
// fetches today's USD->HKD rate itself (Frankfurter, no key) and does
// the arithmetic there; this server-side pure function mirrors it
// exactly and is unit-tested with fixtures.
const CREDIT_ANCHOR = {
  date: "2026-11-13",
  usageHKD: 16.79,        // Google-verified total Gemini usage up to the anchor date
  batchSpendUSD: 1.6,     // batch page total spend (USD) at the anchor moment
  topupsHKD: 160.0,       // fallback prepaid total when the top-ups table is not created yet
  liteBatchPriceUSD: 0.0168,
};
const CREDIT_FALLBACK_RATE = 7.85; // only used by the page when the FX fetch fails

function creditEstimate({ topupsTotalHKD, anchorUsageHKD, anchorBatchSpendUSD, batchTotalSpendUSD, rate, liteBatchPriceUSD }) {
  const r = Number(rate) > 0 ? Number(rate) : CREDIT_FALLBACK_RATE;
  const price = Number(liteBatchPriceUSD) > 0 ? Number(liteBatchPriceUSD) : 0.0168;
  // Only batch spend after the anchor counts — the anchor batch spend is
  // already inside the anchor usage, so a negative delta is clamped to 0
  // (it can only happen if the stats table is missing and reports 0).
  const extraSpendUSD = Math.max(0, Number(batchTotalSpendUSD || 0) - Number(anchorBatchSpendUSD || 0));
  const totalUsedHKD = Number(anchorUsageHKD || 0) + extraSpendUSD * r;
  const remainingHKD = Number(topupsTotalHKD || 0) - totalUsedHKD;
  const remainingUSD = remainingHKD / r;
  return {
    totalUsedHKD: round2(totalUsedHKD),
    remainingHKD: round2(remainingHKD),
    remainingUSD: round2(remainingUSD),
    imagesRemaining: Math.max(0, Math.floor(remainingUSD / price)),
    extraSpendUSD: round2(extraSpendUSD),
  };
}

function isAutoAuth(req) {
  const secret = process.env.INGEST_SECRET || "";
  if (!secret) return false;
  const given = req.headers["x-ingest-secret"] || "";
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verified 2026-11-13 (Google pricing page): batch price is half of standard.
// Used when the gemini_model_prices table is empty or not yet created, so the
// model picker still works before the SQL is run. Do NOT offer
// gemini-2.5-flash-image — it retires 2027-03-15.
const FALLBACK_MODELS = [
  { model: "gemini-3.1-flash-lite-image", display_name: "Lite (Nano Banana 2 Lite)", standard_price_usd: 0.0336, batch_price_usd: 0.0168 },
  { model: "gemini-3.1-flash-image", display_name: "Flash Image (Nano Banana 2) — 1K", standard_price_usd: 0.067, batch_price_usd: 0.034 },
  { model: "gemini-3-pro-image", display_name: "Pro Image (Nano Banana Pro) — 1K/2K", standard_price_usd: 0.134, batch_price_usd: 0.067 },
];

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

function hktToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nextDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return date;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)).toISOString().slice(0, 10);
}

// Hong Kong year-month (YYYYMM) of a published_at instant — the design/
// folder convention is monthly by article date.
function hktYearMonth(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return hktToday().slice(0, 7).replace("-", "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7).replace("-", "");
}

function round2(n) { return Math.round(n * 100) / 100; }

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- Supabase (service key, server-side only) ----

function sbEnv() {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_KEY || "";
  if (!url || !key) throw err(503, "database not configured: SUPABASE_URL / SUPABASE_SERVICE_KEY are not set");
  return { url, key };
}

function isMissingTable(e) {
  return Boolean(e && (e.code === "PGRST205" || /Could not find the table/i.test(String(e.message || ""))));
}

async function sbFetch(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = sbEnv();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain-text error */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${r.status}`;
    const e = new Error(String(msg).slice(0, 300));
    e.status = r.status;
    e.code = json && json.code;
    throw e;
  }
  return { json, headers: r.headers };
}

async function sbRows(path, opts) {
  const { json } = await sbFetch(path, opts);
  return Array.isArray(json) ? json : [];
}

function totalFromHeaders(headers) {
  const m = (headers.get("content-range") || "").match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- Gemini Batch API (key from env, never in the repo or a response) ----

function geminiKey() {
  const k = process.env.GEMINI_API_KEY || "";
  if (!k) throw err(503, "GEMINI_API_KEY is not set — set it in Vercel → hksports-app → Environment Variables, then redeploy");
  return k;
}

async function geminiJson(url, { method = "GET", body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { "x-goog-api-key": geminiKey(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain-text error */ }
  if (!r.ok) {
    const msg = (json && json.error && (json.error.message || JSON.stringify(json.error))) || text || `HTTP ${r.status}`;
    throw err(502, `Gemini ${r.status}: ${String(msg).slice(0, 300)}`);
  }
  return json || {};
}

// Create a batch job. `requests` is [{ key (slug), prompt }]. The request
// shape mirrors the verified single-image call (bin/gemini.py): text prompt
// + responseModalities TEXT+IMAGE + 16:9 aspect ratio.
async function geminiCreateBatch({ model, displayName, requests }) {
  return geminiJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:batchGenerateContent`, {
    method: "POST",
    body: {
      batch: {
        display_name: displayName,
        input_config: {
          requests: {
            requests: requests.map((req) => ({
              request: {
                contents: [{ role: "user", parts: [{ text: req.prompt }] }],
                generationConfig: {
                  responseModalities: ["TEXT", "IMAGE"],
                  imageConfig: { aspectRatio: "16:9" },
                },
              },
              metadata: { key: req.key },
            })),
          },
        },
      },
    },
  });
}

async function geminiGetBatch(name) {
  if (!/^batches\/[A-Za-z0-9_-]+$/.test(name)) throw err(400, `invalid batch name: ${name}`);
  return geminiJson(`${GEMINI_BASE}/${name}`);
}

const GEMINI_STATE = {
  JOB_STATE_PENDING: "pending",
  JOB_STATE_RUNNING: "running",
  JOB_STATE_SUCCEEDED: "succeeded",
  JOB_STATE_FAILED: "failed",
  JOB_STATE_CANCELLED: "cancelled",
  JOB_STATE_EXPIRED: "expired",
  // The Batch API actually returns BATCH_STATE_* in metadata.state
  // (verified 2026-11-13 against a real operation) — the JOB_STATE_*
  // keys above are kept only as a harmless fallback.
  BATCH_STATE_PENDING: "pending",
  BATCH_STATE_RUNNING: "running",
  BATCH_STATE_SUCCEEDED: "succeeded",
  BATCH_STATE_FAILED: "failed",
  BATCH_STATE_CANCELLED: "cancelled",
  BATCH_STATE_EXPIRED: "expired",
};

function geminiState(job) {
  const raw = (job && job.metadata && job.metadata.state) || (job && job.state) || "";
  if (GEMINI_STATE[raw]) return GEMINI_STATE[raw];
  return raw ? String(raw).replace(/^(JOB_STATE_|BATCH_STATE_)/, "").toLowerCase() : "pending";
}

// ---- Model prices (DB table, with the verified fallback) ----

async function loadModels() {
  try {
    const rows = await sbRows("gemini_model_prices?select=*&order=model.asc");
    if (rows.length) {
      return {
        models: rows.map((r) => ({
          model: r.model, display_name: r.display_name,
          standard_price_usd: Number(r.standard_price_usd), batch_price_usd: Number(r.batch_price_usd),
        })),
        source: "db", tablesMissing: false,
      };
    }
    return { models: FALLBACK_MODELS.map((m) => ({ ...m })), source: "fallback", tablesMissing: false };
  } catch (e) {
    // Prices are a read-only summary: fall back instead of failing the page.
    return { models: FALLBACK_MODELS.map((m) => ({ ...m })), source: "fallback", tablesMissing: isMissingTable(e) };
  }
}

// ---- Public shapes ----

function stagingUrl(key) {
  const base = r2PublicBase();
  return key && base ? `${base}/${key}` : null;
}

function publicBatch(b, items) {
  const counts = { submitted: 0, generated: 0, approved: 0, rejected: 0, failed: 0 };
  for (const it of items || []) if (counts[it.status] !== undefined) counts[it.status]++;
  return {
    id: b.id, gemini_batch_name: b.gemini_batch_name, model: b.model, status: b.status,
    created_at: b.created_at, created_by: b.created_by, article_count: b.article_count, counts,
  };
}

function publicItem(it, extra) {
  return {
    id: it.id, batch_id: it.batch_id, article_slug: it.article_slug, status: it.status,
    staging_r2_key: it.staging_r2_key || null, staging_url: stagingUrl(it.staging_r2_key),
    error: it.error || null, ...(extra || {}),
  };
}

// ---- Actions ----

// Articles in a date range (Hong Kong days). Default: today, without-image
// only. Published articles only — drafts do not get batch images.
async function listArticles(body) {
  const today = hktToday();
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(body.dateFrom || "") ? body.dateFrom : today;
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(body.dateTo || "") ? body.dateTo : today;
  const image = body.image === "all" ? "all" : "without";
  const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 100));
  const params = new URLSearchParams();
  params.set("select", "slug,sport,published_at,image_url,image_prompt,title_zh_hant,title_en");
  params.set("site", `eq.${SITE}`);
  params.set("status", "eq.published");
  params.set("published_at", `gte.${dateFrom}T00:00:00+08:00`);
  params.append("published_at", `lt.${nextDay(dateTo)}T00:00:00+08:00`);
  if (image === "without") params.set("or", "(image_url.is.null,image_url.eq.)");
  params.set("order", "published_at.desc,slug.asc");
  params.set("limit", String(limit));
  const { json } = await sbFetch(`sports_articles?${params.toString()}`, { prefer: "count=exact" });
  const rows = Array.isArray(json) ? json : [];
  // Eligibility (user decision 2026-11-13): the article list only ever
  // shows articles that can actually be generated — imageless AND with no
  // pending batch item (status submitted/generated). An article that
  // already has an image is never shown (whatever the `image` filter
  // says), and neither is one already in a pending batch, so it can never
  // be submitted twice. An imageless article whose batch was rejected (or
  // failed — nothing usable was produced) shows again so it can be
  // re-submitted. `total` is the eligible count, so the page's
  // "共 N 篇（總數 M）" stays consistent.
  let eligible = rows.filter((a) => !(a.image_url || "").trim());
  const slugs = eligible.map((a) => a.slug);
  if (slugs.length) {
    const items = await sbRows(`sports_image_batch_items?select=article_slug,status&article_slug=in.(${slugs.map(encodeURIComponent).join(",")})&limit=1000`);
    const pending = new Set();
    for (const it of items) {
      if (it.status === "submitted" || it.status === "generated") pending.add(it.article_slug);
    }
    eligible = eligible.filter((a) => !pending.has(a.slug));
  }
  return {
    ok: true, dateFrom, dateTo, image, total: eligible.length,
    articles: eligible.map((a) => ({
      slug: a.slug, sport: a.sport, published_at: a.published_at,
      image_url: a.image_url || null, image_prompt: a.image_prompt || null,
      title_zh_hant: a.title_zh_hant || "", title_en: a.title_en || "",
    })),
  };
}

async function createBatch(body, email) {
  const slugs = Array.isArray(body.slugs)
    ? [...new Set(body.slugs.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!slugs.length) throw err(400, "select at least one article");
  // No hard size limit (user decision 2026-11-13: "endpoint 放寬，warning
  // 照去"). The page suggests ~10 per batch and warns above that, but the
  // endpoint accepts whatever the user confirms.
  const { models } = await loadModels();
  const model = String(body.model || "").trim();
  if (!models.some((m) => m.model === model)) {
    throw err(400, `unknown model: ${model || "(none)"} — pick one from the model list`);
  }
  // Validate the articles BEFORE calling Gemini, so a bad selection costs nothing.
  const rows = await sbRows(`sports_articles?select=slug,image_url,image_prompt&site=eq.${SITE}&slug=in.(${slugs.map(encodeURIComponent).join(",")})`);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const bad = [];
  for (const slug of slugs) {
    const a = bySlug.get(slug);
    if (!a) bad.push(`${slug}：搵唔到呢篇文章`);
    else if (!(a.image_prompt || "").trim()) bad.push(`${slug}：未有 image_prompt，請先準備 prompt`);
    else if ((a.image_url || "").trim()) bad.push(`${slug}：已經有圖，唔使再生`);
  }
  if (bad.length) throw err(400, `以下文章唔可以直接入 batch：\n${bad.join("\n")}`);
  const displayName = `sports-batch-${hktToday().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const job = await geminiCreateBatch({
    model, displayName,
    requests: slugs.map((slug) => ({ key: slug, prompt: bySlug.get(slug).image_prompt.trim() })),
  });
  const geminiName = job && job.name;
  if (!geminiName || !/^batches\/[A-Za-z0-9_-]+$/.test(geminiName)) {
    throw err(502, `Gemini did not return a batch name: ${JSON.stringify(job).slice(0, 200)}`);
  }
  const state = geminiState(job);
  let batchRow = null;
  try {
    const created = await sbFetch("sports_image_batches", {
      method: "POST", prefer: "return=representation",
      body: { gemini_batch_name: geminiName, model, status: state, created_by: email || null, article_count: slugs.length },
    });
    batchRow = Array.isArray(created.json) && created.json.length ? created.json[0] : null;
    if (!batchRow || !batchRow.id) throw new Error("database did not return the created batch");
    const items = await sbFetch("sports_image_batch_items", {
      method: "POST", prefer: "return=representation",
      body: slugs.map((slug) => ({ batch_id: batchRow.id, article_slug: slug, status: "submitted" })),
    });
    const itemRows = Array.isArray(items.json) ? items.json : [];
    return { ok: true, batch: publicBatch(batchRow, itemRows), items: itemRows.map((it) => publicItem(it)), gemini_batch_name: geminiName };
  } catch (e) {
    // The Gemini batch already exists — remove the half-saved DB rows so a
    // retry does not leave an orphan, and surface the Gemini batch name so
    // it can still be recovered by hand.
    if (batchRow && batchRow.id) {
      try { await sbFetch(`sports_image_batches?id=eq.${batchRow.id}`, { method: "DELETE" }); } catch (e2) { /* keep the original error */ }
    }
    if (isMissingTable(e)) throw e;
    throw err(502, `batch created on Gemini (${geminiName}) but could not be saved: ${String(e.message || e).slice(0, 200)}`);
  }
}

// Unwrap Gemini batch inlined responses. The Batch API returns them
// double-nested (verified 2026-11-13 against the real operation
// batches/sxp329nhpsu7to6vk65dtaeyir9qxz9l88nx): response.inlinedResponses
// is an OBJECT {"inlinedResponses": [...]}, not a flat array, and
// metadata.output.inlinedResponses has the identical shape. Accept both
// locations and both shapes (flat array, or object with an inlinedResponses
// key). When the two locations disagree in length, use the fuller one —
// the real operation carries the same items in both, but a partial
// response may truncate one of them.
// Returns the flat array of per-request results, in request order.
function unwrapInlinedResponses(job) {
  const candidates = [];
  const push = (v) => {
    if (Array.isArray(v)) candidates.push(v);
    else if (v && Array.isArray(v.inlinedResponses)) candidates.push(v.inlinedResponses);
  };
  if (job) {
    push(job.response && job.response.inlinedResponses);
    push(job.metadata && job.metadata.output && job.metadata.output.inlinedResponses);
    push(job.dest && job.dest.inlinedResponses);
  }
  let best = [];
  for (const c of candidates) if (c.length > best.length) best = c;
  return best;
}

// Extract the image (if any) from one inlined batch response.
// Returns { image } on success, or { failReason } when this request did
// not produce a usable image. A per-item Gemini `error` is reported with
// its own message; a text-only reply is reported as such (it is a model
// failure, not a missing result).
function extractInlineImage(inline) {
  const errObj = inline && inline.error;
  if (errObj) return { failReason: String(errObj.message || JSON.stringify(errObj)).slice(0, 300) };
  const resp = inline && inline.response;
  if (!resp) return { failReason: "no result in batch response" };
  const parts = ((resp.candidates || [])[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || [];
  for (const p of parts) {
    if (p.inlineData && p.inlineData.data) return { image: p.inlineData };
  }
  const textPart = parts.find((p) => typeof p.text === "string" && p.text.trim());
  return { failReason: textPart
    ? `model returned text instead of an image: ${textPart.text.slice(0, 200)}`
    : "model returned no image" };
}

// The key (article slug) for one inlined batch result. Gemini keys every
// result by metadata.key — the key submitted with its request (see
// geminiCreateBatch). Returns null when the result carries no key; such a
// result cannot be attributed to any article and must never be used to
// write a file.
function resultKey(inline) {
  if (!inline || typeof inline !== "object") return null;
  const m = inline.metadata;
  if (m && typeof m.key === "string" && m.key) return m.key;
  if (typeof inline.key === "string" && inline.key) return inline.key;
  return null;
}

// Index unwrapped results by their metadata.key (slug). The two locations
// (response / metadata.output) carry the same list, so a key seen twice is
// the same result — first occurrence wins. A result without a key is left
// out: it cannot be matched to an article, so it is never written anywhere.
function indexResultsByKey(responses) {
  const byKey = new Map();
  for (const r of responses || []) {
    const k = resultKey(r);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  return byKey;
}

async function checkBatch(body) {
  const batchId = String(body.batchId || "").trim();
  if (!batchId) throw err(400, "missing batchId");
  const brows = await sbRows(`sports_image_batches?select=*&id=eq.${encodeURIComponent(batchId)}&limit=1`);
  const batch = brows[0];
  if (!batch) throw err(404, "batch not found");
  const items = await sbRows(`sports_image_batch_items?select=*&batch_id=eq.${encodeURIComponent(batchId)}&order=created_at.asc`);
  const now = new Date().toISOString();
  // Sweep stale errors first: an item that already generated/approved must
  // not keep an error from an earlier failed Check (user report 2026-11-13:
  // generated items still showed "batch batch_state_succeeded" in red).
  // Runs on every Check, so a re-Check on a finished batch still heals
  // its rows.
  for (const it of items) {
    if ((it.status === "generated" || it.status === "approved") && it.error) {
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { error: null, updated_at: now } });
      it.error = null;
    }
  }
  // "failed" is deliberately NOT terminal here: a failed item is retried
  // on the next Check (it re-reads the same inlined response, so a
  // genuinely-failed item just fails again with its real reason).
  // There is deliberately NO "already complete" early return here. A
  // re-Check on a succeeded batch must re-download every generated item's
  // image BY KEY and overwrite its staging file (idempotent): that is how
  // a wrong staging file gets repaired without regenerating, and it is
  // what makes two overlapping Checks safe — both write the same correct
  // bytes to each key instead of racing a position zip.
  const job = await geminiGetBatch(batch.gemini_batch_name);
  const state = geminiState(job);
  const done = job.done === true || ["succeeded", "failed", "cancelled", "expired"].includes(state);
  if (!done) {
    // sports_image_batches has no updated_at column (see sql/001-sports-batch-tables.sql) — PATCH status only.
    await sbFetch(`sports_image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: state } });
    return { ok: true, batch: publicBatch({ ...batch, status: state }, items), items: items.map((it) => publicItem(it)), note: "batch still processing — check again later" };
  }
  if (state !== "succeeded") {
    const errMsg = (`batch ${state}` + (job.error && job.error.message ? `: ${String(job.error.message).slice(0, 200)}` : "")).slice(0, 500);
    for (const it of items) {
      if (it.status === "submitted") {
        await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: errMsg, updated_at: now } });
        it.status = "failed"; it.error = errMsg;
      }
    }
    await sbFetch(`sports_image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: state } });
    return { ok: true, batch: publicBatch({ ...batch, status: state }, items), items: items.map((it) => publicItem(it)), note: `batch ${state}` };
  }
  // Succeeded — download the results, matched BY KEY (metadata.key is the
  // article slug). Gemini does NOT return results in request order, so a
  // position zip (responses[i] for items[i]) writes the wrong image into a
  // file — verified 2026-11-13 on batch 33e28bac, where 2 of 10 staging
  // files got another article's bytes. A result with no key, or no result
  // for an item's slug, marks that item failed with a clear error — never
  // silently write another item's bytes to its file.
  // Re-downloads are idempotent: "generated" items are re-downloaded by key
  // and their staging file overwritten, so a re-Check repairs a wrong file
  // instead of leaving it in place. Skip only "approved" (already published,
  // staging deleted) and "rejected" (user decision).
  if (!r2Configured()) throw err(503, "R2 credentials not configured — cannot download batch results");
  const byKey = indexResultsByKey(unwrapInlinedResponses(job));
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!["submitted", "failed", "generated"].includes(it.status)) { results.push(publicItem(it)); continue; }
    const inline = byKey.get(it.article_slug);
    if (!inline) {
      const reason = `no image result for this article in the batch response (key ${it.article_slug} not found)`;
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: reason.slice(0, 500), updated_at: now } });
      results.push(publicItem({ ...it, status: "failed", error: reason.slice(0, 500) }));
      continue;
    }
    const { image, failReason } = extractInlineImage(inline);
    if (!image) {
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: failReason.slice(0, 500), updated_at: now } });
      results.push(publicItem({ ...it, status: "failed", error: failReason.slice(0, 500) }));
      continue;
    }
    const buf = Buffer.from(image.data, "base64");
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
      const reason = !buf.length ? "empty image data" : "image too large (max 10 MB)";
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: reason, updated_at: now } });
      results.push(publicItem({ ...it, status: "failed", error: reason }));
      continue;
    }
    // Gemini output is saved as .jpg, same as the existing design/ files
    // (the bytes keep their real mime type in the R2 Content-Type).
    const key = `${STAGING_PREFIX}/${batchId}/${it.article_slug}.jpg`;
    const contentType = typeof image.mimeType === "string" && image.mimeType.startsWith("image/")
      ? image.mimeType : "image/jpeg";
    const out = await putObject({ key, body: buf, contentType });
    // Clear any error from an earlier failed Check — a generated item must
    // not keep showing the old failure in red.
    await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "generated", staging_r2_key: out.key, error: null, updated_at: now } });
    results.push(publicItem({ ...it, status: "generated", staging_r2_key: out.key, error: null }));
  }
  await sbFetch(`sports_image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: "succeeded" } });
  const generated = results.filter((r) => r.status === "generated").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return {
    ok: true,
    batch: publicBatch({ ...batch, status: "succeeded" }, results.map((r) => ({ status: r.status }))),
    items: results,
    note: `downloaded ${generated} image(s), ${failed} failed — review them below before approving`,
  };
}

async function approveItems(body) {
  const ids = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!ids.length) throw err(400, "select at least one image to approve");
  if (!r2Configured()) throw err(503, "R2 credentials not configured");
  const results = [];
  for (const id of ids) {
    try {
      const rows = await sbRows(`sports_image_batch_items?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const it = rows[0];
      if (!it) throw new Error("item not found");
      if (it.status !== "generated") throw new Error(`item is ${it.status}, not generated — nothing to approve`);
      if (!it.staging_r2_key) throw new Error("item has no staging image");
      const arows = await sbRows(`sports_articles?select=slug,published_at&site=eq.${SITE}&slug=eq.${encodeURIComponent(it.article_slug)}&limit=1`);
      const article = arows[0];
      if (!article) throw new Error(`article ${it.article_slug} not found`);
      const destKey = `design/${hktYearMonth(article.published_at)}/${it.article_slug}.jpg`;
      const copied = await copyObject({ sourceKey: it.staging_r2_key, destKey });
      if (!copied.url) throw new Error("R2_PUBLIC_BASE_URL is not set — cannot build the public image URL");
      const now = new Date().toISOString();
      await sbFetch(`sports_articles?site=eq.${SITE}&slug=eq.${encodeURIComponent(it.article_slug)}`, {
        method: "PATCH", body: { image_url: copied.url, image_r2_key: copied.key, updated_at: now },
      });
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "approved", error: null, updated_at: now } });
      try { await deleteObject(it.staging_r2_key); } catch (e) { /* staging cleanup is best-effort */ }
      results.push({ id: it.id, article_slug: it.article_slug, status: "approved", image_url: copied.url, image_r2_key: copied.key });
    } catch (e) {
      results.push({ id, article_slug: null, status: "error", error: String(e.message || e).slice(0, 200) });
    }
  }
  return { ok: true, results };
}

// ---- Fully automatic flow (step 5F + 5-minute poll) ----

// Auto-submit (step 5F, called by the 2-hour pipeline after the prompts
// are ingested): ONE Lite batch for every published article that has an
// image_prompt, no image_url, and no item already submitted/generated in
// any batch. RETRY CAP: an article with 3 failed items is skipped (1
// initial attempt + at most 2 automatic retries — user decision
// 2026-11-13); skipped slugs are listed in the response and the batch
// log. Manual Generate is NOT capped. Reuses createBatch (same validation,
// same Gemini call, same DB rows) with created_by "auto", so the admin
// batch page shows the batch and its cost exactly like a manual one.
// Returns ok with submitted 0 when there is nothing to do — no Gemini
// call, no batch row.
// A concurrent state change (an article gaining an image between the
// filter and the create) makes createBatch reject the whole selection;
// in that case the bad slugs are dropped and the rest is retried once.
async function autoSubmit() {
  const params = new URLSearchParams();
  params.set("select", "slug,image_url,image_prompt");
  params.set("site", `eq.${SITE}`);
  params.set("status", "eq.published");
  params.set("image_prompt", "neq.");
  params.set("or", "(image_url.is.null,image_url.eq.)");
  params.set("order", "published_at.desc");
  params.set("limit", "1000");
  const rows = await sbRows(`sports_articles?${params.toString()}`);
  const candidates = rows
    .filter((a) => (a.image_prompt || "").trim() && !(a.image_url || "").trim())
    .map((a) => a.slug);
  if (!candidates.length) return { ok: true, submitted: 0, batch: null, cost_usd: 0, note: "no articles need images" };
  const pending = await sbRows("sports_image_batch_items?select=article_slug&status=in.(submitted,generated)&limit=1000");
  const pendingSlugs = new Set(pending.map((p) => p.article_slug));
  let slugs = candidates.filter((s) => !pendingSlugs.has(s));
  // Retry cap (see MAX_AUTO_ATTEMPTS): skip any article that already has
  // 3 failed items — it has had its 1 attempt + 2 automatic retries and is
  // parked. Failed items are counted whether they came from auto batches
  // or manual Generates. One query for all failed slugs (no per-article
  // IN list, so a long candidate list cannot blow up the URL); the
  // failed-items table is small (the auto flow started 2026-11-13) and
  // 1000 rows is far above its size — page this if it ever grows.
  let capped = [];
  if (slugs.length) {
    const failed = await sbRows("sports_image_batch_items?select=article_slug&status=eq.failed&limit=1000");
    const counts = new Map();
    for (const it of failed) counts.set(it.article_slug, (counts.get(it.article_slug) || 0) + 1);
    const split = applyRetryCap(slugs, counts);
    slugs = split.submit;
    capped = split.capped;
  }
  const cappedSlugs = capped.map((c) => c.slug);
  if (!slugs.length) {
    return {
      ok: true, submitted: 0, batch: null, cost_usd: 0,
      retry_capped: cappedSlugs, retry_capped_count: capped.length,
      note: capped.length
        ? `nothing to submit — ${capped.length} article(s) parked by the 3-attempt retry cap: ${cappedSlugs.join(", ")}`
        : "all prompted articles are already in a pending batch",
    };
  }
  let out;
  try {
    out = await createBatch({ slugs, model: AUTO_MODEL }, AUTO_ACTOR);
  } catch (e) {
    // Drop the slugs createBatch rejected and retry once with the rest.
    const msg = String((e && e.message) || "");
    const bad = new Set();
    if (e && e.status === 400 && msg.includes("唔可以直接入 batch")) {
      for (const line of msg.split("\n").slice(1)) {
        const slug = line.split("：")[0].trim();
        if (slug) bad.add(slug);
      }
    }
    const rest = slugs.filter((s) => !bad.has(s));
    if (!bad.size || !rest.length) throw e;
    slugs = rest;
    out = await createBatch({ slugs, model: AUTO_MODEL }, AUTO_ACTOR);
  }
  const { models } = await loadModels();
  const m = models.find((x) => x.model === AUTO_MODEL);
  const price = m ? Number(m.batch_price_usd) || 0 : 0.0168;
  return {
    ok: true, submitted: slugs.length, batch: out.batch,
    gemini_batch_name: out.gemini_batch_name, model: AUTO_MODEL,
    cost_usd: round2(slugs.length * price),
    retry_capped: cappedSlugs, retry_capped_count: capped.length,
    note: `submitted ${slugs.length} article(s) to Gemini (${AUTO_MODEL})`
      + (capped.length ? `; ${capped.length} parked by the 3-attempt retry cap: ${cappedSlugs.join(", ")}` : ""),
  };
}

// Auto-poll (5-minute cron): poll every pending AUTO batch (created_by
// "auto" — manual batches are never touched here), download finished
// images to R2 staging via checkBatch (key-based matching, idempotent),
// then auto-approve each generated item with approveItems (same copy to
// design/ + article link as the manual Approve button). Failures stay
// failed and are never approved. Also picks up auto batches that finished
// but still have generated items (a previous poll downloaded them but the
// approve step failed) — checkBatch re-downloads those by key and they
// get approved here. An item whose approve errors (e.g. an overlapping
// poll already approved it — approveItems re-checks status per item) is
// counted as skipped, not as a failure of the run.
// Two overlapping polls are safe: checkBatch writes the same correct bytes
// per key, and approveItems refuses any item that is no longer "generated".
async function autoPoll() {
  const pending = await sbRows(`sports_image_batches?select=id&created_by=eq.${AUTO_ACTOR}&status=in.(pending,running,submitted)&order=created_at.asc&limit=50`);
  const genItems = await sbRows("sports_image_batch_items?select=batch_id,sports_image_batches(created_by)&status=eq.generated&limit=1000");
  const ids = new Set(pending.map((b) => b.id));
  for (const it of genItems) {
    if (it.sports_image_batches && it.sports_image_batches.created_by === AUTO_ACTOR && it.batch_id) ids.add(it.batch_id);
  }
  if (!ids.size) return { ok: true, checked: 0, approved: 0, failed: 0, skipped: 0, batches: [], note: "no pending auto batches" };
  const batchResults = [];
  let approvedTotal = 0, failedTotal = 0, skippedTotal = 0;
  for (const batchId of ids) {
    try {
      const checked = await checkBatch({ batchId });
      const items = Array.isArray(checked.items) ? checked.items : [];
      const gen = items.filter((i) => i.status === "generated");
      const failed = items.filter((i) => i.status === "failed").length;
      let approved = 0, skipped = 0;
      if (gen.length) {
        const appr = await approveItems({ itemIds: gen.map((i) => i.id) });
        for (const r of appr.results || []) {
          if (r.status === "approved") approved++;
          else skipped++;
        }
      }
      approvedTotal += approved; failedTotal += failed; skippedTotal += skipped;
      batchResults.push({
        batch_id: batchId,
        gemini_batch_name: (checked.batch && checked.batch.gemini_batch_name) || null,
        model: (checked.batch && checked.batch.model) || null,
        state: (checked.batch && checked.batch.status) || null,
        generated: gen.length, approved, failed, skipped,
      });
    } catch (e) {
      batchResults.push({
        batch_id: batchId, gemini_batch_name: null, model: null, state: "error",
        generated: 0, approved: 0, failed: 0, skipped: 0,
        error: String(e.message || e).slice(0, 200),
      });
    }
  }
  return {
    ok: true, checked: ids.size, approved: approvedTotal,
    failed: failedTotal, skipped: skippedTotal, batches: batchResults,
    note: `checked ${ids.size} auto batch(es), approved ${approvedTotal} image(s), ${failedTotal} failed`,
  };
}

async function rejectItems(body) {
  const ids = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!ids.length) throw err(400, "select at least one image to reject");
  const results = [];
  for (const id of ids) {
    try {
      const rows = await sbRows(`sports_image_batch_items?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const it = rows[0];
      if (!it) throw new Error("item not found");
      if (it.status !== "generated") throw new Error(`item is ${it.status}, not generated — nothing to reject`);
      // Rejected images are NOT deleted (user decision 2026-11-13): the
      // staging object stays in R2 and staging_r2_key is kept, so the image
      // stays viewable in the batch 詳情 view and the 已拒絕 section.
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "rejected", updated_at: new Date().toISOString() } });
      results.push({ id: it.id, article_slug: it.article_slug, status: "rejected" });
    } catch (e) {
      results.push({ id, article_slug: null, status: "error", error: String(e.message || e).slice(0, 200) });
    }
  }
  return { ok: true, results };
}

async function listBatches(body) {
  const limit = Math.min(50, Math.max(1, parseInt(body.limit, 10) || 20));
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const offset = (page - 1) * limit;
  const { json, headers } = await sbFetch(
    `sports_image_batches?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
    { prefer: "count=exact" },
  );
  const batches = Array.isArray(json) ? json : [];
  const ids = batches.map((b) => b.id);
  const itemsByBatch = {};
  if (ids.length) {
    const items = await sbRows(`sports_image_batch_items?select=batch_id,status&batch_id=in.(${ids.join(",")})&limit=500`);
    for (const it of items) (itemsByBatch[it.batch_id] = itemsByBatch[it.batch_id] || []).push(it);
  }
  return {
    ok: true, total: totalFromHeaders(headers) ?? batches.length, page, limit,
    batches: batches.map((b) => publicBatch(b, itemsByBatch[b.id] || [])),
  };
}

async function listItems(body) {
  const status = String(body.status || "").trim();
  const batchId = String(body.batchId || "").trim();
  const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 50));
  const params = new URLSearchParams();
  params.set("select", "*,sports_image_batches(model,gemini_batch_name,status)");
  if (status) params.set("status", `eq.${status}`);
  if (batchId) params.set("batch_id", `eq.${batchId}`);
  params.set("order", "created_at.desc");
  params.set("limit", String(limit));
  const items = await sbRows(`sports_image_batch_items?${params.toString()}`);
  // Heal stale errors on read too (same rule as the Check sweep): a
  // generated/approved item must not keep an error from an earlier failed
  // Check, so the batch 詳情 view never shows it in red. This also clears
  // the two rows left over from the 2026-11-13 batch the next time the
  // detail view is opened — no separate one-off SQL needed.
  for (const it of items) {
    if ((it.status === "generated" || it.status === "approved") && it.error) {
      await sbFetch(`sports_image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { error: null, updated_at: new Date().toISOString() } });
      it.error = null;
    }
  }
  const slugs = [...new Set(items.map((it) => it.article_slug))];
  const titles = {};
  if (slugs.length) {
    const arows = await sbRows(`sports_articles?select=slug,title_zh_hant,title_en&site=eq.${SITE}&slug=in.(${slugs.map(encodeURIComponent).join(",")})&limit=100`);
    for (const a of arows) titles[a.slug] = a.title_zh_hant || a.title_en || a.slug;
  }
  return {
    ok: true,
    items: items.map((it) => ({
      ...publicItem(it),
      title: titles[it.article_slug] || it.article_slug,
      model: (it.sports_image_batches && it.sports_image_batches.model) || null,
      gemini_batch_name: (it.sports_image_batches && it.sports_image_batches.gemini_batch_name) || null,
    })),
  };
}

// Usage stats. "Generated" counts every successful Gemini output (generated
// + approved + rejected) because each one was billed; cost is generated x
// the model's batch price. Never throws for a missing/empty price table —
// the model picker needs the fallback prices to work before the SQL is run.
async function stats() {
  const { models, source, tablesMissing } = await loadModels();
  const perModel = new Map();
  let itemsMissing = tablesMissing;
  if (!tablesMissing) {
    try {
      // Single page of 1000 — the same PostgREST cap lib/data.js pages
      // around. Fine for a POC summary; page it if the table ever grows.
      const items = await sbRows("sports_image_batch_items?select=status,sports_image_batches(model)&limit=1000");
      for (const it of items) {
        const model = (it.sports_image_batches && it.sports_image_batches.model) || "unknown";
        const row = perModel.get(model) || { generated: 0, approved: 0 };
        if (["generated", "approved", "rejected"].includes(it.status)) row.generated++;
        if (it.status === "approved") row.approved++;
        perModel.set(model, row);
      }
    } catch (e) {
      if (isMissingTable(e)) itemsMissing = true;
      else throw e;
    }
  }
  const statsRows = models.map((m) => {
    const row = perModel.get(m.model) || { generated: 0, approved: 0 };
    return {
      model: m.model, display_name: m.display_name, batch_price_usd: m.batch_price_usd,
      generated: row.generated, approved: row.approved,
      cost_usd: round2(row.generated * (Number(m.batch_price_usd) || 0)),
    };
  });
  for (const [model, row] of perModel) {
    if (!models.some((m) => m.model === model)) {
      statsRows.push({ model, display_name: model, batch_price_usd: null, generated: row.generated, approved: row.approved, cost_usd: null });
    }
  }
  return {
    ok: true, tablesMissing: itemsMissing, price_source: source, models,
    stats: statsRows,
    total: {
      generated: statsRows.reduce((s, x) => s + x.generated, 0),
      approved: statsRows.reduce((s, x) => s + x.approved, 0),
      cost_usd: round2(statsRows.reduce((s, x) => s + (x.cost_usd || 0), 0)),
    },
  };
}

// ---- Gemini credit tracker: read + record top-ups ----

// Read the credit ledger for the batch page: top-ups (from the
// gemini_credit_topups table when it exists — sql/003-credit-topups.sql (already run for hkcn — shared table, do not re-run)),
// the anchor constants, and the current batch total spend (USD) from
// stats(). The page fetches today's FX rate itself and computes the
// remaining credit with the same formula as creditEstimate(). Read-only:
// console-logged only, never written to sports_batch_logs. If the top-ups table
// is not created yet, the anchor prepayment (HK$160.00) is used as the
// fallback total and ledgerLive is false, so the page still shows the
// right estimate and says the ledger is not connected yet.
// hkcn site batch spend (USD), for the shared credit ledger: the Gemini
// key and the HK$160 prepaid credit are one pot for both sites, so the
// remaining-credit figure must subtract BOTH sites' spend. Reads the hkcn
// image_batch_items table (same Supabase project, service key). Returns 0
// when the hkcn tables cannot be read — the sports-only figure is then
// used and the page still works.
async function hkcnBatchSpendUSD(models) {
  try {
    const items = await sbRows("image_batch_items?select=status,image_batches(model)&limit=1000");
    let total = 0;
    for (const it of items) {
      if (!["generated", "approved", "rejected"].includes(it.status)) continue;
      const m = models.find((x) => x.model === (it.image_batches && it.image_batches.model));
      if (m) total += Number(m.batch_price_usd) || 0;
    }
    return round2(total);
  } catch (e) { return 0; }
}

async function creditSummary() {
  const st = await stats();
  const hkcnSpend = await hkcnBatchSpendUSD((await loadModels()).models);
  const combinedSpendUSD = round2(st.total.cost_usd + hkcnSpend);
  const { models } = await loadModels();
  const lite = models.find((m) => m.model === AUTO_MODEL);
  const litePrice = lite ? Number(lite.batch_price_usd) || 0.0168 : 0.0168;
  const anchor = { date: CREDIT_ANCHOR.date, usageHKD: CREDIT_ANCHOR.usageHKD, batchSpendUSD: CREDIT_ANCHOR.batchSpendUSD };
  let topups = null;
  let ledgerLive = true;
  try {
    topups = await sbRows("gemini_credit_topups?select=id,amount_hkd,topped_up_at,note,created_by,created_at&order=topped_up_at.desc,created_at.desc&limit=100");
  } catch (e) {
    if (isMissingTable(e)) ledgerLive = false;
    else throw e;
  }
  if (!ledgerLive || !topups) {
    return {
      ok: true, ledgerLive: false,
      topups: [{ amount_hkd: CREDIT_ANCHOR.topupsHKD, topped_up_at: "2026-11-12", note: "Prepaid to open the Gemini API for image generation (Visa ••••9616)", created_by: "seed", fallback: true }],
      topupsTotalHKD: CREDIT_ANCHOR.topupsHKD,
      anchor, batchTotalSpendUSD: combinedSpendUSD,
      liteBatchPriceUSD: litePrice, fallbackRate: CREDIT_FALLBACK_RATE,
    };
  }
  const total = topups.reduce((s, t) => s + Number(t.amount_hkd || 0), 0);
  return {
    ok: true, ledgerLive: true,
    topups: topups.map((t) => ({ id: t.id, amount_hkd: Number(t.amount_hkd), topped_up_at: t.topped_up_at, note: t.note || "", created_by: t.created_by || "" })),
    topupsTotalHKD: round2(total),
    anchor, batchTotalSpendUSD: combinedSpendUSD,
    liteBatchPriceUSD: litePrice, fallbackRate: CREDIT_FALLBACK_RATE,
  };
}

// Record a Gemini prepayment (top-up). Google SSO admin session only —
// the dispatcher already refuses INGEST_SECRET for every action except
// auto-submit/auto-poll, so a cron secret can never write the ledger.
// Validates the amount (positive, at most HK$100,000 — above that is
// almost certainly a typo) and the date. Also written to sports_batch_logs, so
// a top-up has an audit trail on the batch page. Returns the created row
// plus a fresh credit summary so the page can refresh its numbers.
// Requires sql/003-credit-topups.sql (already run for hkcn — shared table, do not re-run) to be run — a missing table is a
// 503 with a clear instruction, never a silent fallback (a write must
// not pretend it succeeded).
async function creditTopupAdd(body, email) {
  const amount = Number(body.amount_hkd);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw err(400, "amount_hkd must be a positive number no larger than HK$100,000");
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.topped_up_at || "") ? body.topped_up_at : hktToday();
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw err(400, `invalid topped_up_at date: ${date} (use YYYY-MM-DD)`);
  }
  const note = String(body.note || "").slice(0, 200);
  let created;
  try {
    created = await sbFetch("gemini_credit_topups", {
      method: "POST", prefer: "return=representation",
      body: { amount_hkd: round2(amount), topped_up_at: date, note: note || null, created_by: email || null },
    });
  } catch (e) {
    if (isMissingTable(e)) throw err(503, "credit top-ups table is not created yet — run sql/003-credit-topups.sql (already run for hkcn — shared table, do not re-run) in the Supabase SQL Editor, then try again");
    throw e;
  }
  const row = Array.isArray(created.json) && created.json.length ? created.json[0] : null;
  if (!row || !row.id) throw err(502, "top-up could not be saved");
  const summary = await creditSummary();
  return {
    ok: true,
    topup: { id: row.id, amount_hkd: Number(row.amount_hkd), topped_up_at: row.topped_up_at, note: row.note || "", created_by: row.created_by || "" },
    credit: summary,
  };
}

// ---- Logging (user request 2026-11-13: "add log") ----
// Every action is logged to console as one JSON line (Vercel Runtime Logs),
// and create/check/approve/reject are also written to the sports_batch_logs table
// (sql/002-sports-batch-logs.sql) so the admin batch page can show a persistent
// log. Reads (list-articles / list-batches / list-items / stats /
// list-logs) are console-only — logging every page load to the DB would
// flood the table. Logging never fails the action: a missing sports_batch_logs
// table (SQL not run yet) or any insert error is swallowed after the
// console line is written.

function logLine({ actor, action, batchId, detail, ok, error }) {
  try {
    console.log("[batch] " + JSON.stringify({
      ts: new Date().toISOString(), actor: actor || null, action,
      batch_id: batchId || null, detail: detail || null, ok: !!ok,
      error: error ? String(error).slice(0, 300) : null,
    }));
  } catch (e) { /* logging must never break the action */ }
}

const DB_LOGGED_ACTIONS = new Set(["create", "check", "approve", "reject", "auto-submit", "auto-poll", "credit-topup-add"]);

async function logDb(entry) {
  if (!DB_LOGGED_ACTIONS.has(entry.action)) return;
  try {
    await sbFetch("sports_batch_logs", {
      method: "POST",
      body: {
        actor: entry.actor || null, action: entry.action,
        batch_id: entry.batchId || null, detail: entry.detail || null,
        ok: !!entry.ok, error: entry.error ? String(entry.error).slice(0, 500) : null,
      },
    });
  } catch (e) { /* table missing (002 not run) or any insert error: ignore */ }
}

async function logAction(entry) {
  logLine(entry);
  await logDb(entry);
}

// One-line summary of an action result, for the log. Returns
// { batchId, detail }.
function summarize(action, body, out) {
  try {
    if (action === "create" && out && out.batch) {
      return { batchId: out.gemini_batch_name || out.batch.id, detail: `model=${out.batch.model}, articles=${out.batch.article_count}` };
    }
    if (action === "auto-submit" && out) {
      // The retry cap must be visible in the log, not silent: a parked
      // article stops being retried, and the log is where the user sees why.
      // The slugs are already in out.note; only the count is appended here
      // so the detail does not list them twice.
      const capped = out.retry_capped_count ? `, retry-capped=${out.retry_capped_count}` : "";
      if (out.batch) return { batchId: out.gemini_batch_name || out.batch.id, detail: `model=${out.model || AUTO_MODEL}, articles=${out.submitted || 0}, cost=$${Number(out.cost_usd || 0).toFixed(2)} USD${capped}`.slice(0, 500) };
      return { batchId: null, detail: `${out.note || "nothing to submit"}${capped}`.slice(0, 500) };
    }
    if (action === "auto-poll" && out) {
      let detail = `checked=${out.checked || 0}, approved=${out.approved || 0}, failed=${out.failed || 0}, skipped=${out.skipped || 0}`;
      const errs = (out.batches || []).filter((b) => b.error).map((b) => `${b.gemini_batch_name || b.batch_id}: ${b.error}`);
      if (errs.length) detail += `; errors: ${errs.join("; ")}`;
      return { batchId: null, detail: detail.slice(0, 500) };
    }
    if (action === "check" && out && out.batch) {
      const c = out.batch.counts || {};
      const items = Array.isArray(out.items) ? out.items : [];
      const gen = items.filter((i) => i.status === "generated").map((i) => i.article_slug);
      const fail = items.filter((i) => i.status === "failed")
        .map((i) => `${i.article_slug} (${String(i.error || "failed").slice(0, 100)})`);
      let detail = `state=${out.batch.status}, generated=${c.generated || 0}, failed=${c.failed || 0}`;
      if (gen.length) detail += `; generated: ${gen.join(", ")}`;
      if (fail.length) detail += `; failed: ${fail.join("; ")}`;
      return { batchId: String(body.batchId || ""), detail: detail.slice(0, 500) };
    }
    if ((action === "approve" || action === "reject") && out && Array.isArray(out.results)) {
      const done = out.results.filter((r) => r.status === "approved" || r.status === "rejected").length;
      const errs = out.results.filter((r) => r.status === "error").length;
      return { batchId: null, detail: `items=${out.results.length}, done=${done}, errors=${errs}` };
    }
    if (action === "credit-topup-add" && out && out.topup) {
      return { batchId: null, detail: `top-up HK$${Number(out.topup.amount_hkd).toFixed(2)}, date=${out.topup.topped_up_at}${out.topup.note ? ", note=" + out.topup.note : ""}`.slice(0, 500) };
    }
  } catch (e) { /* fall through */ }
  return { batchId: String(body.batchId || body.batch_id || "") || null, detail: null };
}

// Latest 50 log rows, newest first. If the sports_batch_logs table does not exist
// yet (sql/002-sports-batch-logs.sql not run), return logsMissing instead of
// failing — the page shows a clear message in that case.
async function listLogs() {
  try {
    const rows = await sbRows("sports_batch_logs?select=*&order=created_at.desc&limit=50");
    return {
      ok: true, logsMissing: false,
      logs: rows.map((r) => ({
        id: r.id, created_at: r.created_at, actor: r.actor, action: r.action,
        batch_id: r.batch_id, detail: r.detail, ok: r.ok, error: r.error,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return { ok: true, logsMissing: true, logs: [] };
    throw e;
  }
}

module.exports = async (req, res) => {
  // Auth: Google SSO for the manual actions; INGEST_SECRET (x-ingest-secret)
  // for the two auto actions only (a cron has no browser session). A request
  // with a wrong secret and no session fails closed with 401 here; a request
  // with a correct secret asking for a manual action is refused in the
  // switch below — auto auth never grants manual actions.
  const auto = isAutoAuth(req);
  let email;
  if (auto) email = AUTO_ACTOR;
  else {
    email = requireAdmin(req, res);
    if (!email) return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed — POST { action } only" });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
  const action = String((body && body.action) || "").trim();
  // Auto auth (INGEST_SECRET) grants ONLY the two auto actions — a cron
  // secret must never be able to run a manual action (approve / reject /
  // create / check on an arbitrary batch). Manual actions need the Google
  // SSO session, exactly as before.
  if (auto && action !== "auto-submit" && action !== "auto-poll") {
    res.status(401).json({ ok: false, error: "unauthorized: this action needs a Google admin session" });
    return;
  }
  try {
    let out;
    switch (action) {
      case "list-articles": out = await listArticles(body); break;
      case "create": out = await createBatch(body, email); break;
      case "check": out = await checkBatch(body); break;
      case "approve": out = await approveItems(body); break;
      case "reject": out = await rejectItems(body); break;
      case "list-batches": out = await listBatches(body); break;
      case "list-items": out = await listItems(body); break;
      case "list-logs": out = await listLogs(); break;
      case "stats": out = await stats(); break;
      case "credit-summary": out = await creditSummary(); break;
      case "credit-topup-add": out = await creditTopupAdd(body, email); break;
      case "auto-submit":
        if (!auto) { res.status(401).json({ ok: false, error: "unauthorized: auto-submit needs x-ingest-secret" }); return; }
        out = await autoSubmit(); break;
      case "auto-poll":
        if (!auto) { res.status(401).json({ ok: false, error: "unauthorized: auto-poll needs x-ingest-secret" }); return; }
        out = await autoPoll(); break;
      default:
        await logAction({ actor: email, action: action || "(none)", ok: false, error: "unknown action" });
        res.status(400).json({ ok: false, error: `unknown action: ${action || "(none)"} — use list-articles, create, check, approve, reject, list-batches, list-items, list-logs, stats, credit-summary, credit-topup-add, auto-submit or auto-poll` });
        return;
    }
    const s = summarize(action, body, out);
    await logAction({ actor: email, action, batchId: s.batchId, detail: s.detail, ok: true });
    res.status(200).json(out);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    await logAction({ actor: email, action, batchId: String(body.batchId || "") || null, detail: null, ok: false, error: msg });
    if (isMissingTable(e)) {
      res.status(503).json({ ok: false, error: TABLES_MISSING });
      return;
    }
    const status = (e && e.status) || 500;
    res.status(status).json({ ok: false, error: msg });
  }
};

// Test hooks: the parser test (throwaway, not committed) requires this
// module and calls these directly against a real operation fixture.
module.exports.unwrapInlinedResponses = unwrapInlinedResponses;
module.exports.extractInlineImage = extractInlineImage;
module.exports.geminiState = geminiState;
module.exports.resultKey = resultKey;
module.exports.indexResultsByKey = indexResultsByKey;
module.exports.applyRetryCap = applyRetryCap;
module.exports.MAX_AUTO_ATTEMPTS = MAX_AUTO_ATTEMPTS;
module.exports.creditEstimate = creditEstimate;
module.exports.CREDIT_ANCHOR = CREDIT_ANCHOR;
module.exports.CREDIT_FALLBACK_RATE = CREDIT_FALLBACK_RATE;
