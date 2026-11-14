-- Add extra_images to sports_articles — run once in Supabase Dashboard → SQL Editor.
-- Mirror of the news app's migration 003 (articles.extra_images).
-- Stores additional real photos for an article as a JSON array of
-- {url, caption} objects, e.g. [{"url": "https://images.hksports.hk/design/202611/20261114-example-1.jpg", "caption": "開幕禮上，嘉賓致辭"}].
-- The hero image stays in image_url / image_caption; extra images render
-- below the summary on the article page (api/article-page.js).
-- Null/empty for articles with a single image (the common case).
alter table public.sports_articles add column if not exists extra_images jsonb;
