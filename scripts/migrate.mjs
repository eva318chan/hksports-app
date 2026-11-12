// Migration: live static repo eva318chan/hkcn-sports-news → seed dataset + Supabase.
//   node scripts/migrate.mjs            fetch manifest + every data/*.json,
//                                       write data/seed.json, data/seed-meta.json
//   node scripts/migrate.mjs --to-supabase
//                                       same as above, then upload seed rows to Supabase
//                                       (needs SUPABASE_URL + SUPABASE_SERVICE_KEY in env,
//                                       run only after supabase/migrations/
//                                       001_sports_articles.sql has been applied in the
//                                       Supabase SQL Editor).
// Reads only from the PUBLIC live repo. Writes nothing to it. No secrets in this file.
// Sports differences from the news version: no slug renames (sports slugs are
// clean), no HTML caption/footer scraping (sports pages have no captions and
// a standard footer), image_url "" normalises to null, and the 9 self-hosted
// images keep their assets/... R2 keys.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = "https://raw.githubusercontent.com/eva318chan/hkcn-sports-news/main";
const SITE = "hksports";
const TABLE = "sports_articles";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "hksports-app-migrate" } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

// Design images live at /assets/design/<file> on the old site; the 9
// self-hosted images live at /assets/<path>. Both keep their path as the
// R2 key (design images under design/YYYYMM/, self-hosted under assets/).
function r2KeyFor(imageUrl) {
  if (!imageUrl) return null;
  const m = imageUrl.match(/\/assets\/design\/([^/?#]+\.jpg)$/i);
  if (m) return `design/202611/${m[1]}`;
  const a = imageUrl.match(/\/assets\/([^?#]+)$/i);
  if (a && /^(img\/|202\d{5}-)/.test(a[1])) return `assets/${a[1]}`;
  return null;
}

async function main() {
  const toSupabase = process.argv.includes("--to-supabase");

  const manifest = JSON.parse(await fetchText(`${LIVE}/data/manifest.json`));
  const dates = manifest.dates || [];
  const manifestTotal = dates.reduce((n, d) => n + (d.count || 0), 0);
  console.log(`manifest: ${dates.length} dates, total ${manifestTotal}, updated_at ${manifest.updated_at}`);

  // 1. Fetch every daily JSON.
  let rows = [];
  for (const d of dates) {
    const arr = JSON.parse(await fetchText(`${LIVE}/data/${d.date}.json`));
    if (arr.length !== d.count) console.warn(`count mismatch ${d.date}: manifest ${d.count}, file ${arr.length}`);
    rows.push(...arr);
  }
  console.log(`articles from JSON: ${rows.length}`);

  // 2. Normalise to the seed shape (original JSON shape + extras).
  const stats = { emptyImage: 0, designImages: 0, selfHosted: 0 };
  const seed = rows.map((a) => {
    const out = {
      site: SITE,
      id: a.id,
      sport: a.sport,
      published_at: a.published_at,
      source: a.source || "",
      source_url: a.source_url || "",
      image_url: (a.image_url || "").trim() ? a.image_url : null,
      title: a.title,
      summary: a.summary,
      tags: a.tags,
      status: "published",
    };
    if (a.image_url === "") stats.emptyImage++;
    const key = r2KeyFor(a.image_url || "");
    if (key) {
      out.image_r2_key = key;
      if (key.startsWith("design/")) stats.designImages++;
      else stats.selfHosted++;
    }
    if (a.image_prompt) out.image_prompt = a.image_prompt;
    return out;
  });

  if (seed.length !== manifestTotal) {
    console.error(`MISMATCH: seed rows ${seed.length} != manifest total ${manifestTotal}`);
    process.exitCode = 1;
  }
  const dupes = seed.length - new Set(seed.map((r) => r.id)).size;
  if (dupes) { console.error(`MISMATCH: ${dupes} duplicate ids`); process.exitCode = 1; }

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", "seed.json"), JSON.stringify(seed));
  writeFileSync(join(ROOT, "data", "seed-meta.json"), JSON.stringify({
    updated_at: manifest.updated_at, dates, total: seed.length,
    generated_at: new Date().toISOString(),
    stats,
  }, null, 2));
  console.log(`wrote data/seed.json (${seed.length} rows), data/seed-meta.json`);
  console.log(`stats: empty image_url normalised ${stats.emptyImage}, design images ${stats.designImages}, self-hosted assets ${stats.selfHosted}`);

  if (toSupabase) await uploadToSupabase(seed);
  if (process.exitCode) console.error("DONE WITH MISMATCHES — do not cut over.");
  else console.log(`DONE: ${seed.length} rows, manifest total ${manifestTotal} — match.`);
}

async function uploadToSupabase(seed) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in env (never in this file).");
  const BATCH = 200;
  for (let i = 0; i < seed.length; i += BATCH) {
    const batch = seed.slice(i, i + BATCH).map(toDbRow);
    const r = await fetch(`${url}/rest/v1/${TABLE}?on_conflict=site,slug`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`Supabase insert batch ${i} failed: ${r.status} ${await r.text()}`);
    console.log(`uploaded ${Math.min(i + BATCH, seed.length)}/${seed.length}`);
  }
}

function toDbRow(a) {
  // Sports schema: source is a plain string (institution name).
  const srcName = typeof a.source === "string" ? a.source : (a.source?.name || "");
  const srcUrl = typeof a.source === "string" ? (a.source_url || "") : (a.source?.url || a.source_url || "");
  return {
    site: a.site, slug: a.id, sport: a.sport, published_at: a.published_at,
    source_name: srcName, source_url: srcUrl,
    image_url: a.image_url || null, image_r2_key: a.image_r2_key || null,
    image_caption: a.image_caption || null, footer_note: a.footer_note || null,
    image_prompt: a.image_prompt || null,
    title_en: a.title?.en || "", title_zh_hant: a.title?.zh_hant || "", title_zh_hans: a.title?.zh_hans || "",
    summary_en: a.summary?.en || "", summary_zh_hant: a.summary?.zh_hant || "", summary_zh_hans: a.summary?.zh_hans || "",
    tags_en: a.tags?.en || [], tags_zh_hant: a.tags?.zh_hant || [], tags_zh_hans: a.tags?.zh_hans || [],
    status: "published",
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
