-- down_0025_content_pages.sql — reverses migration 0025_content_pages.sql.
--
-- Removes the content pages, their version history and the two settings rows
-- 0025 added. audit_log rows it wrote stay (audit_log is append-only). Run in
-- the SQL editor only if the content pages are being withdrawn entirely;
-- turning the pages off is just content_pages_enabled = 'off'.

begin;
drop function if exists public.content_page_restore(bigint, uuid, text);
drop function if exists public.content_page_save(text, jsonb, uuid, text, timestamptz, text, jsonb);
drop table if exists public.content_page_versions;
drop table if exists public.content_pages;
delete from public.settings where key = 'content_pages_enabled';
-- site_domain is shared with other features once set; only drop it if unset.
delete from public.settings where key = 'site_domain' and btrim(value) = '';
commit;
