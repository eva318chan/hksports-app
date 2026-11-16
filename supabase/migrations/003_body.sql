-- Add body to sports_articles — run once in Supabase Dashboard → SQL Editor.
-- Stores the full article text as {en, zh_hant, zh_hans} strings, paragraphs
-- separated by a blank line, e.g. {"zh_hant": "第一段。\n\n第二段。"}.
-- The article page (api/article-page.js) renders it below the summary and
-- above the extra images; the language switcher re-renders it per language.
-- Null for summary-only articles (the common case) — those render exactly
-- as before, with no body div at all.
alter table public.sports_articles add column if not exists body jsonb;
