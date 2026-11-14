# hksports-app — 港體育 web app (parallel build)

New application for 港體育 / HK-China Sports Express, built **in parallel** with the
existing static site. The static site (`eva318chan/hkcn-sports-news` → hksports.hk)
keeps running and publishing untouched until this app passes parity and is
switched over. News site (`hkcnexpress.com`) is out of scope for this repo —
it has its own app (`hkcn-news-app`) and its own table (`articles`).

**Sports articles live in a separate table, `sports_articles` — never the news
`articles` table.** Same Supabase project, same R2 token, same INGEST_SECRET,
same Google OAuth client — but a separate app, a separate table, a separate
R2 bucket (`hksports-images`).

Plan: `~/workspace/goals/hkcn-news-sites-backfill-and-scheduled-updates/files/hksports-r2-db-migration-plan.md`

## Architecture

```
Reader → Vercel (hksports-app)
  ├── index.html + assets/*            static shell (same look as today)
  ├── assets/app.js                    homepage: calls /api/articles, not data/*.json
  ├── api/articles.js                  list / paginate / filter (sport) / search
  ├── api/article.js                   one article as JSON
  ├── api/article-page.js              /a/<id>.html — server-rendered, og tags in HTML
  ├── api/meta.js                      dates + counts (replaces data/manifest.json)
  ├── api/sitemap.xml.js / rss.xml.js  generated live from the store
  ├── api/ingest.js                    POST with x-ingest-secret — the pipeline write path
  ├── api/ingest-image.js              POST with x-ingest-secret — pipeline image upload to R2
  ├── lib/r2.js                        SigV4 S3 PUT helper (shared by ingest-image)
  ├── admin/index.html                 admin UI (Google SSO, see below)
  ├── admin/batch/index.html           batch images admin UI (manual testing for now, see below)
  ├── api/admin/batch.js               Gemini Batch API image generation (see below)
  └── api/admin/*                      admin API (all routes require the Google SSO session)
        ├── Supabase Postgres (sports_articles table) — DATABASE ONLY
        └── Cloudflare R2 (images.hksports.hk) — PRIMARY IMAGE STORE
```

**Images are R2, not Supabase Storage** (same decision as the news app):
R2 free tier is 10 GB storage with free egress; Supabase Storage free tier is
1 GB with $0.09/GB egress over that. A public sports site's cost is image
traffic, so images and the database stay separate — one side blowing up cannot
take the other down. Same split as Project 1943 (video in R2, DB stores the
reference). Supabase is database only in this app; no Supabase Storage bucket
is used or needed.

## Data seam (env-only switch, no code change)

`lib/data.js` is the single seam:

| | Seed mode (staging, now) | Live mode (after setup) |
|---|---|---|
| Articles | `data/seed.json` (empty until the seed phase runs `scripts/migrate.mjs`) | Supabase `sports_articles` table via REST (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) |
| Design images | stored `image_url` as-is (no local copies in this repo) | `https://images.hksports.hk/design/202611/<file>` (`R2_PUBLIC_BASE_URL`) |
| Other images | source `og:image` hotlink, unchanged | same |

When the env vars appear, the app switches automatically. Nothing else changes.

## Sports differences from the news app

- **Table**: `sports_articles` (with `sport`, not `category`; `source_name` /
  `source_url` from a plain-string `source`; `image_prompt` included from day
  one — the news app needed a second migration 002 for it).
- **`sport` filter**: 22 keys — the 6 the old `app.js` missed (cricket,
  handball, f1, motorsport, baseball, bowling) are included, so their 29
  articles filter and label correctly instead of falling back to "others".
- **No-image rule (2026-10-30, sports only)**: an article with no image gets
  **no hero block at all** on the article page and **no thumb** on the
  homepage card — never a noimg 🏅 placeholder (unlike the news site). A
  failed image load removes the whole homepage thumb; on the article page it
  replaces the `<img>` with a noimg div, exactly like the live static pages.
- **`image_url` is `null` when empty** (not `""`); the 3 old `""` rows are
  normalised to null at seed/ingest time.
- **No captions**: sports article HTML has no image captions, so the seed
  does not scrape them (the `image_caption` column is kept nullable for the
  future).
- **No backlink**: the live article pages have no "← 港體育" backlink (the old
  README/cron were wrong about this); this app does not add one.

## Env vars (Vercel → hksports-app → Settings → Environment Variables)

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | for live DB | same project as the news app: `https://xagpbfihzzkaarkznjax.supabase.co` |
| `SUPABASE_SERVICE_KEY` | for live DB + ingest | service_role key — **server-side only, never in the browser or repo** |
| `R2_PUBLIC_BASE_URL` | for live images | `https://images.hksports.hk` once the custom domain is connected; r2.dev URL before that |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` | for `/api/ingest-image` | same account-wide token as the news app (`hkcn-news-upload`, All buckets); `R2_BUCKET` is `hksports-images` |
| `INGEST_SECRET` | for publishing | **same value as the news app** (shared secret, type `plain` so the pipeline can read it back via the Vercel API) |
| `GEMINI_API_KEY` | for batch images | Gemini API key — server-side only, never in the browser or repo. The batch endpoint reads it from env; if it is missing, Generate fails with a clear message telling the admin to set it in Vercel. **Not set yet (2026-11-14) — add the same key as the news app.** |
| `GOOGLE_CLIENT_ID` | for admin sign-in | same OAuth client as the news app (`hkcn-news-admin`, public id, not a secret); the client must also allow the origins/redirects for `https://hksports-app-eva318chan.vercel.app` and `https://hksports.hk` |
| `ADMIN_EMAILS` | for admin sign-in | comma-separated allowlist of Google accounts allowed into `/admin/` (`eddiehlk@gmail.com,eva318.chan@gmail.com,bob318@gmail.com`) |
| `ADMIN_SESSION_SECRET` | for admin sign-in | **a new random value, different from the news app's**; HMAC key for the admin session cookie — server-side only, never in the browser or repo |
| `SITE_URL` | optional | defaults to the request host; set `https://hksports.hk` in production |

No secret, token or key is in this repo. See `.env.example`.

## Admin (`/admin/`)

The admin lives in this same project (no separate app). It manages the
articles in Supabase: create a new article, list/search (paginated, newest
first, all statuses), edit an article's titles, summaries, tags, **sport**,
image URL and status, unpublish (status `draft` — hidden from the public
site), and delete (the UI confirms first). Articles have no full body
column — the editable text is `title_*` / `summary_*` in en/zh_hant/zh_hans,
and the article page renders the summary as its content.

**Admin API — create / update without touching the DB.** `POST
/api/admin/articles` creates an article and `PATCH
/api/admin/articles?id=<slug>` updates one; both need the admin Google SSO
session (401 without it) and return 503 in seed mode (no database to write
to). Create payload:

```json
{ "slug": "20261113-example-sport",
  "title_zh_hant": "標題", "title_en": "Title",
  "summary_zh_hant": "摘要…", "tags_zh_hant": ["足球"],
  "sport": "football", "status": "published",
  "source_name": "香港電台", "source_url": "https://…",
  "image_url": "https://…", "image_prompt": "AI 設計圖 prompt…" }
```

Only a title (`zh_hant` or `en`) is required. `slug` is optional — when
omitted it is auto-derived from the English title (lowercase letters, digits
and hyphens only; dots are rejected with 400). `published_at` defaults to
now; `status` defaults to `published` (`draft` unpublishes); `sport` must be
one of the 22 sport keys and defaults to `others`. Creating with a slug that
already exists returns 409 and never overwrites — use PATCH to update. PATCH
accepts the same fields (plus `image_r2_key`, `image_caption`,
`footer_note`); omitted fields are left unchanged. `image_prompt` is stored
from day one (the column is in the initial migration). `extra_images` is an
optional array of up to 10 `{url, caption}` objects for additional real photos
(the hero image stays in `image_url` / `image_caption`); it needs migration
`supabase/migrations/002_extra_images.sql` applied in the Supabase SQL Editor
first, and renders below the summary on the article page.

**The automated pipeline keeps using `POST /api/ingest` with
`INGEST_SECRET`.** The cron cannot hold a Google SSO session, so the admin
API is for human / admin use only — pipeline publishing is unchanged (see
Publishing below).

**Batch images (2026-11-14, same as the news app).** The batch image
function lives on its own page, `/admin/batch/` (linked from the main admin
page's top navigation as "Batch images（批量生圖）", with a link back to
`/admin/`), and generates AI design images with the Gemini Batch API — the
only image-generation path. Manual flow: the admin selects articles, clicks
Generate, clicks Check, reviews the images and approves — the user controls
every step. **Auto flow is PAUSED (user decision 2026-11-14): no pipeline
step calls auto-submit and no cron calls auto-poll, so nothing generates or
approves itself until the user is satisfied with manual testing and says
the word.** When it is switched on, the wiring is the same as the news app
(pipeline step 5F auto-submit + a 5-minute auto-poll cron), with the same
3-attempt retry cap and the same auto-approve behaviour.

**Own tables, own batch.** The sports endpoint
(`POST /api/admin/batch`, the 12th and last Vercel function on this
project) reads and writes only its own tables — `sports_image_batches`,
`sports_image_batch_items`, `sports_batch_logs` (run
`sql/001-sports-batch-tables.sql` + `sql/002-sports-batch-logs.sql` once in
the Supabase SQL Editor) and `sports_articles`. It never touches the news
app's `image_batches` / `image_batch_items` / `batch_logs` / `articles`.
`gemini_model_prices` and `gemini_credit_topups` are shared with the news
app (same prices, same Gemini key, same HK$160 prepaid credit), so the
credit tracker on this page counts BOTH sites' batch spend. Images go to
this project's own R2 bucket (`hksports-images`) via `lib/r2.js`.

**Prerequisites before the first Generate works:** (1) the two SQL files
above have been run in the Supabase SQL Editor; (2) `GEMINI_API_KEY` is set
in Vercel → hksports-app → Environment Variables (same key as the news
app — not set yet as of 2026-11-14, so Generate currently fails with a
clear 503 telling the admin to set it).

**Auth is Google SSO only — no passwords.** The admin page shows a Google
Sign-In button (Google Identity Services); the ID token is sent to
`/api/admin/auth/callback`, which verifies it with Google, checks the email
against `ADMIN_EMAILS`, and sets a signed httpOnly session cookie (HMAC with
`ADMIN_SESSION_SECRET`, 7 days). Every `/api/admin/` route shares that one
auth check (`lib/admin-auth.js`); unauthenticated requests get 401 and
never see article data. If any of `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS` or
`ADMIN_SESSION_SECRET` is missing, sign-in fails closed. **Lesson from the
news app (2026-11-13): the OAuth client needs the JavaScript origins
registered as well as the redirect URIs — and the admin page redirects
apex → www, so BOTH `https://hksports.hk` and `https://www.hksports.hk`
must be registered, or sign-in fails with `origin_mismatch`.** Sign-in is
not testable without a real allowlisted Google account — staging verification
covers only the unauthenticated behaviour (`/admin/` shows the sign-in, not
data; `/api/admin/articles` returns 401).

**Public site only shows `published` rows.** `/api/articles`, `/api/article`,
`/a/<id>.html`, sitemap and RSS all filter `status=eq.published` (and seed
mode filters drafts too), so setting an article to `draft` unpublishes it
everywhere at once.

**Logout is server-side, not an endpoint of its own.** The session cookie is
HttpOnly, so JavaScript cannot clear it — the old `document.cookie` clear
never worked (the session stayed valid until expiry). The admin page POSTs
`{ action: "logout" }` to `/api/admin/auth/callback`, which expires
`hksports_admin_session` with `Max-Age=0`. No separate logout endpoint exists —
the existing callback handles it, deliberately, to stay under Vercel's
12-serverless-functions-per-deployment Hobby limit.

**Web Analytics.** Enabled on the Vercel dashboard (Hobby free: 50,000
events/month, 30 days history). No npm package is installed — this site has
no build step. Instead the pages carry exactly what `@vercel/analytics` v2
`inject()` does in production: the `window.va` stub plus `<script defer
src="/_vercel/insights/script.js">` (in `index.html`, `admin/index.html`,
and the article template in `api/article-page.js`).

## Still missing — dashboard steps for the user (Supabase + R2)

**Supabase (database only)** — the `sports_articles` table is created by the
user's browser (no DB password is available to agents):
1. Supabase Dashboard (project `hkcn-news`, Singapore `ap-southeast-1`) →
   SQL Editor → paste `supabase/migrations/001_sports_articles.sql` → Run.
   This creates the `sports_articles` table, indexes, RLS (public read of
   `published` rows only) and the `sports_meta()` function. It does **not**
   touch the news `articles` table.
2. Project Settings → API → copy the Project URL → `SUPABASE_URL`, and the
   `service_role` key → `SUPABASE_SERVICE_KEY` (never the `anon` key for writes).
3. Load the seed: `SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/migrate.mjs --to-supabase`
   (upserts by `(site, slug)`, safe to re-run). Verify row count = 1,077.
4. Paste the two values into the Vercel env vars above and redeploy.

**Cloudflare R2 (images)**:
1. Cloudflare Dashboard → R2 Object Storage → Create bucket `hksports-images`
   (Standard, Automatic — same as the news bucket). The existing account-wide
   token works; no new token is needed.
2. R2 → Custom Domains → Connect Domain → `images.hksports.hk` (hksports.hk
   DNS is already on Cloudflare, so no zone move is needed).
3. Set `R2_PUBLIC_BASE_URL=https://images.hksports.hk` in the Vercel env
   vars and redeploy. Before the custom domain is connected, use the bucket's
   r2.dev public URL.
4. R2 **write** credentials (S3-compatible API token) go to the Bella
   publishing pipeline, not to this web app. This app never uploads images
   directly — uploads go through `POST /api/ingest-image`.

## Publishing (after cutover — not active yet)

Each 2-hour pipeline run: search → rewrite → generate AI design image if needed
→ upload image to R2 (`design/YYYYMM/<file>`) → `POST /api/ingest` with
`x-ingest-secret` and the article JSON → verify the live `/a/<id>.html` URL.
No Git commit, no Vercel deployment. `POST`ing the same `id` again updates the
article (dedupe by `(site, slug)`). `DELETE /api/ingest?slug=<id>` (same secret)
removes one article.

**Image upload (`POST /api/ingest-image`, same `x-ingest-secret` auth as
`/api/ingest`).** The pipeline's route for design images into R2 — the cron
cannot hold a Google SSO session, so admin endpoints are unusable by it, and
the R2 credentials are only readable by serverless functions at runtime.
Body: `{ key, sourceUrl }` (the function fetches the image and PUTs it to R2)
or `{ key, contentBase64, contentType }` (direct upload). The key must match
`^design/YYYYMM/<name>.(jpg|jpeg|png|webp)$` **or** `^assets/<path>.(jpg|jpeg|png|webp)$`
(the second prefix is for the 9 self-hosted images, one-time backfill) —
anything else is rejected with 400. Response: `{ ok:true, key, url, bytes }`
where `url` is `R2_PUBLIC_BASE_URL + "/" + key`; the article is then ingested
with `image_url` = that URL and `image_r2_key` = the key. Uploads are
idempotent, so re-uploading the same key is safe. If the upload fails, the
pipeline keeps the old behaviour (image served from the old site's live URL,
logged as "待 R2 backfill") and never blocks publishing on it. Signing is
SigV4 (`lib/r2.js`, Node built-in crypto, no SDK).

## Migration

`node scripts/migrate.mjs` — fetches the live repo's manifest + every
`data/*.json`, and writes:

- `data/seed.json` — 1,077 rows (manifest total 1,077, 0 duplicates)
- `data/seed-meta.json` — dates/counts/`updated_at` (same numbers as manifest)

`node scripts/migrate.mjs --to-supabase` additionally uploads the seed to
Supabase (needs the env vars; run only after the SQL migration). The
`supabase/migrations/001_sports_articles.sql` schema file is committed in
this repo (the script does not regenerate it).

Seed normalisations: `image_url: ""` (3 rows) → `null`; the 9 self-hosted
images get `image_r2_key` under their original `assets/...` paths; design
images (from 2026-11-14) get `design/YYYYMM/<file>` keys. No slug renames
(all sports slugs are clean) and no caption scraping (sports pages have no
captions).

## Parity notes (checked against the live static site)

- **Homepage order is `published_at` DESC, not image-first.** The pipeline
  sorts each daily JSON image-first (rule 5C), but the live `app.js` re-sorts
  everything by `published_at` before rendering. The API defaults to the
  live order so the homepage matches; `?sort=image_first` returns the 5C
  order explicitly.
- **Search is better, not worse.** The live homepage only searches articles
  already loaded. The new API searches the whole corpus server-side. Same
  query box, wider results.
- **Meta count is the server total**, not the number of cards currently loaded.
- **Article pages** replicate the static template (same classes, same header,
  same language-switch script — now fetching `/api/article` instead of the
  daily JSON), with the sports no-hero rule for imageless articles.
- **Sitemap/RSS** use the request host (staging host on staging,
  `hksports.hk` in production via `SITE_URL`), so compare slugs, not hosts.
- **Ingest in seed mode returns 503** (after auth): there is no database to
  write to, and staging must not pretend an insert succeeded. The 401
  (wrong/missing secret) and 400 (bad body) paths are testable on staging; the
  insert→verify→delete test needs the Supabase project from the steps above.
- **Paging is server-side:** `/api/articles` fetches only the requested page
  from PostgREST (limit + offset, `Prefer: count=exact`, total from the
  Content-Range header). Tag + search are combined into one PostgREST `and`
  group, so both apply server-side. Date filters use the Hong Kong day window
  (the same day the `/api/meta` chips count). The homepage loads one page at
  a time: the Load More button fetches the next page, and scrolling it into
  view does the same automatically — the full 1,077 articles are never
  preloaded.

## Local test

```bash
node scripts/serve.mjs 3100   # http://localhost:3100 (seed mode, no env needed)
# With a test ingest secret (seed mode: auth works, insert returns 503):
INGEST_SECRET=test-secret node scripts/serve.mjs 3100
```

## Files

| Path | What it is |
|---|---|
| `index.html`, `assets/style.css`, `assets/logo-*.png`, `assets/favicon.png` | copied verbatim from the live repo |
| `assets/app.js` | live `app.js` with only the data loading changed (diff it: theme/i18n/render/share code is identical); SPORTS now has all 22 keys |
| `lib/data.js` | the data seam (seed ↔ Supabase, R2 ↔ stored image URLs) |
| `api/*.js` | Vercel serverless functions (no dependencies, no framework). 11 functions — shared code lives in root `lib/`, NOT under `api/`, or Vercel would count it as a function (Hobby limit is 12 per deployment) |
| `admin/index.html` | admin UI (Google SSO; calls `/api/admin/*`) |
| `lib/admin-auth.js` | shared Google SSO session check for all `/api/admin/` routes |
| `api/admin/config.js`, `api/admin/auth/callback.js` | admin sign-in: client-id config, ID-token exchange (logout is a branch of the callback — server-side cookie expiry) |
| `api/admin/articles.js` | admin article list / get / create / edit / delete |
| `data/seed.json`, `data/seed-meta.json` | migration snapshot (regenerate with `scripts/migrate.mjs`; empty until the seed phase) |
| `scripts/migrate.mjs`, `scripts/serve.mjs` | migration + local dev server |
| `supabase/migrations/001_sports_articles.sql` | DB schema + RLS + `sports_meta()` |
| `supabase/migrations/002_extra_images.sql` | adds `extra_images` jsonb to `sports_articles` (multi-photo articles) |
| `vercel.json` | rewrites `/a/:slug.html`, `/sitemap.xml`, `/rss.xml`; functions region `sin1` |
