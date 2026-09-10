-- BE01: preserve the exact owned book read for a newly priced quote.
-- Existing quotes are intentionally not backfilled from today's settings.
begin;

create table public.quote_pricing_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  trade text not null check (length(trim(trade)) > 0),
  -- No FK to the mutable/deletable pricing_book: removing a trade must not
  -- erase the pricing basis of an existing quote.
  pricing_book_id uuid not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (tenant_id, trade, pricing_book_id, content_hash)
);
alter table public.quote_pricing_versions enable row level security;
revoke all on public.quote_pricing_versions from public, anon, authenticated;
grant select on public.quote_pricing_versions to service_role;

create function public.guard_quote_pricing_version() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'quote pricing version is immutable';
end $$;
create trigger quote_pricing_version_immutable before update on public.quote_pricing_versions
for each row execute function public.guard_quote_pricing_version();

alter table public.quotes add column pricing_book_version_id uuid
  references public.quote_pricing_versions(id) on delete restrict;

create function public.guard_quote_pricing_version_owner() returns trigger
language plpgsql set search_path = public as $$
declare version_row public.quote_pricing_versions; intake_trade text; intake_tenant uuid;
begin
  if tg_op = 'UPDATE' and old.pricing_book_version_id is not null and
     new.pricing_book_version_id is distinct from old.pricing_book_version_id then
    raise exception 'attached quote pricing version is immutable';
  end if;
  if new.pricing_book_version_id is null then return new; end if;
  select * into strict version_row from public.quote_pricing_versions where id = new.pricing_book_version_id;
  select trade, tenant_id into intake_trade, intake_tenant from public.intakes where id = new.intake_id;
  if new.tenant_id is distinct from version_row.tenant_id or
     intake_tenant is distinct from version_row.tenant_id or
     intake_trade is distinct from version_row.trade then
    raise exception 'quote pricing version ownership mismatch';
  end if;
  return new;
end $$;
create trigger quote_pricing_version_owner before insert or update on public.quotes
for each row execute function public.guard_quote_pricing_version_owner();

create function public.capture_quote_pricing_version(
  p_tenant_id uuid, p_trade text, p_book_id uuid, p_expected_book jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare book jsonb; fingerprint text; version_row public.quote_pricing_versions;
begin
  -- The caller must carry the exact SELECT * result used by its estimator.
  -- Capture fails if settings changed since that read; it never assigns a
  -- newer book to prices already computed against an older one.
  select to_jsonb(pb) into book from public.pricing_book pb
    where pb.id = p_book_id and pb.tenant_id = p_tenant_id and pb.trade = p_trade for share;
  if book is null or jsonb_typeof(book->'gst_registered') is distinct from 'boolean' then
    raise exception 'owned pricing book required';
  end if;
  if book is distinct from p_expected_book then raise exception 'pricing revision changed'; end if;
  fingerprint := encode(sha256(convert_to(book::text, 'UTF8')), 'hex');
  insert into public.quote_pricing_versions(tenant_id, trade, pricing_book_id, snapshot, content_hash)
  values (p_tenant_id, p_trade, p_book_id, book, fingerprint)
  on conflict (tenant_id, trade, pricing_book_id, content_hash) do nothing returning * into version_row;
  if not found then
    select * into strict version_row from public.quote_pricing_versions
      where tenant_id = p_tenant_id and trade = p_trade and pricing_book_id = p_book_id and content_hash = fingerprint;
  end if;
  return to_jsonb(version_row);
end $$;
revoke all on function public.capture_quote_pricing_version(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.capture_quote_pricing_version(uuid, text, uuid, jsonb) to service_role;
revoke all on function public.guard_quote_pricing_version() from public, anon, authenticated;
revoke all on function public.guard_quote_pricing_version_owner() from public, anon, authenticated;
commit;
