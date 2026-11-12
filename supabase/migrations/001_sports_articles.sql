-- hksports articles table — run once in Supabase Dashboard → SQL Editor.
-- Same Supabase project as hkcn-news (hkcn-news), separate table from `articles`.
-- NEVER touch the news `articles` table. Seed data is loaded afterwards with:
--   node scripts/migrate.mjs --to-supabase
-- (SUPABASE_URL + SUPABASE_SERVICE_KEY in env, never in the repo).
-- image_prompt is included from day one (the news app needed a second
-- migration 002 for it — do not repeat that).
create table if not exists public.sports_articles (
  id uuid primary key default gen_random_uuid(),
  site text not null,                      -- always 'hksports' (kept for symmetry
                                            -- with the news schema + ingest upsert;
                                            -- the table itself is sports-only)
  slug text not null,                      -- article id, e.g. 20261112-man-utd-carrick-leaves
  sport text not null,                     -- NOT `category`: football, basketball, ...
  published_at timestamptz not null,
  source_name text not null default '',    -- sports JSON `source` is a plain string
  source_url text not null default '',
  image_url text,                          -- final display URL (R2 URL or source og:image hotlink)
  image_r2_key text,                       -- e.g. design/202611/<file>.jpg, or assets/img/<file>.jpg
  image_caption text,                      -- nullable; sports HTML has no captions today,
                                            -- kept for future parity with news 5B
  footer_note text,                        -- nullable; e.g. AI design image note
  image_prompt text,                       -- Gemini prompt for the AI design image
  title_en text not null default '',
  title_zh_hant text not null default '',
  title_zh_hans text not null default '',
  summary_en text not null default '',
  summary_zh_hant text not null default '',
  summary_zh_hans text not null default '',
  tags_en text[] not null default '{}',
  tags_zh_hant text[] not null default '{}',
  tags_zh_hans text[] not null default '{}',
  status text not null default 'published', -- 'published' | 'draft'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site, slug)
);
create index if not exists sports_articles_site_published_idx on public.sports_articles (site, published_at desc);
create index if not exists sports_articles_site_sport_idx on public.sports_articles (site, sport, published_at desc);
create index if not exists sports_articles_tags_hant_idx on public.sports_articles using gin (tags_zh_hant);
create index if not exists sports_articles_search_idx on public.sports_articles
  using gin (to_tsvector('simple', coalesce(title_zh_hant,'') || ' ' || coalesce(summary_zh_hant,'') || ' ' || coalesce(title_en,'') || ' ' || coalesce(summary_en,'')));

alter table public.sports_articles enable row level security;
drop policy if exists "public read published" on public.sports_articles;
create policy "public read published" on public.sports_articles
  for select to anon, authenticated using (status = 'published');

-- Homepage meta (date chips + counts) for /api/meta. Same numbers as data/manifest.json.
create or replace function public.sports_meta()
returns jsonb
language sql security definer
as $$
  select jsonb_build_object(
    'updated_at', (select max(published_at) from public.sports_articles where status = 'published'),
    'total', (select count(*) from public.sports_articles where status = 'published'),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day desc)
      from (select to_char(published_at at time zone 'Asia/Hong_Kong', 'YYYY-MM-DD') as day,
                   count(*) as cnt
            from public.sports_articles where status = 'published' group by day) s
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.sports_meta() to anon, authenticated;
