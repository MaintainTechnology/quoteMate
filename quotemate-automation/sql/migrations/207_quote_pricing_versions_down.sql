begin;
drop trigger if exists quote_pricing_version_owner on public.quotes;
alter table public.quotes drop column if exists pricing_book_version_id;
drop function if exists public.guard_quote_pricing_version_owner();
drop function if exists public.capture_quote_pricing_version(uuid, text, uuid, jsonb);
drop table if exists public.quote_pricing_versions;
drop function if exists public.guard_quote_pricing_version();
commit;
