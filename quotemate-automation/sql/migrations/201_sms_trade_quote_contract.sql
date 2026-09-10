-- Apply after 198-200, before promoting any matching receptionist artefact.
-- New drafts need explicit approval; existing release evidence is preserved.
begin;
alter table public.roofing_measurements add column if not exists source_request_key text,
  add column if not exists released_at timestamptz,
  add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid;
alter table public.painting_measurements add column if not exists source_request_key text,
  add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid;
alter table public.solar_estimates add column if not exists source_request_key text,
  add column if not exists customer_phone text,
  add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid;
alter table public.paint_runs add column if not exists customer_phone text,
  add column if not exists released_at timestamptz;
alter table public.aircon_recommendations add column if not exists released_at timestamptz;
alter table public.plan_extractions add column if not exists released_at timestamptz;

create unique index if not exists roofing_sms_request_key on public.roofing_measurements(tenant_id, source_request_key);
create unique index if not exists painting_sms_request_key on public.painting_measurements(tenant_id, source_request_key);
create unique index if not exists solar_sms_request_key on public.solar_estimates(tenant_id, source_request_key);

create or replace trigger sms_work_guard before insert or update on public.roofing_measurements
  for each row execute function public.guard_sms_work_write();
create or replace trigger sms_work_guard before insert or update on public.painting_measurements
  for each row execute function public.guard_sms_work_write();
create or replace trigger sms_work_guard before insert or update on public.solar_estimates
  for each row execute function public.guard_sms_work_write();

create table if not exists public.sms_human_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_phone text not null,
  conversation_id uuid references public.sms_conversations(id) on delete set null,
  request_key text not null,
  trade text not null,
  reason text not null,
  resource_type text,
  resource_id uuid,
  status text not null default 'open' check(status in ('open','notified','resolved')),
  notification_error text,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sms_work_id uuid, sms_work_owner uuid,
  unique(tenant_id, request_key)
);
alter table public.sms_human_tasks enable row level security;
grant select,insert,update on public.sms_human_tasks to service_role;
create or replace trigger sms_work_guard before insert or update on public.sms_human_tasks
  for each row execute function public.guard_sms_work_write();

-- Phone equivalence is AU mobile formatting only, never a suffix comparison.
create or replace function public.sms_normalise_customer_phone(p_phone text)
returns text language sql immutable strict set search_path=public,pg_temp as $$
  select case when regexp_replace(p_phone,'[^0-9]','','g') ~ '^0[0-9]{9}$'
    then '61' || substring(regexp_replace(p_phone,'[^0-9]','','g') from 2)
    else regexp_replace(p_phone,'[^0-9]','','g') end
$$;

create or replace function public.sms_customer_quote_references(p_tenant_id uuid, p_customer_phone text)
returns table(family text, resource_id uuid, token text, label text, stage text, created_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
  with candidates as (
    select 'generic'::text family, q.id resource_id, q.share_token token,
      coalesce(nullif(i.address,''), nullif(replace(i.job_type,'_',' '),''),'job') label,
      case when to_jsonb(q)->>'customer_released_at' is not null or to_jsonb(q)->>'sent_at' is not null or q.status in ('sent','accepted','paid') then 'ready' else 'awaiting_review' end stage,
      q.created_at
    from public.quotes q join public.intakes i on i.id=q.intake_id and i.tenant_id=q.tenant_id
    where q.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(i.caller->>'phone')=public.sms_normalise_customer_phone(p_customer_phone)
      and not exists(select 1 from public.solar_estimates s where s.tenant_id=q.tenant_id and (s.quote_id=q.id or s.public_token=q.share_token))
      and not exists(select 1 from public.roofing_measurements r where r.tenant_id=q.tenant_id and (r.public_token=q.share_token or to_jsonb(r)->>'quote_id'=q.id::text))
      and not exists(select 1 from public.quotes child where child.tenant_id=q.tenant_id and to_jsonb(child)->>'parent_quote_id'=q.id::text and to_jsonb(child)->>'sent_at' is not null)
    union all
    select 'roof', r.id,r.public_token,coalesce(r.address,'roofing'),
      case when r.released_at is not null then 'ready' else 'awaiting_review' end,r.created_at
    from public.roofing_measurements r where r.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(r.customer_phone)=public.sms_normalise_customer_phone(p_customer_phone)
    union all
    select 'paint',r.id,r.public_token,coalesce(r.address,'painting'),
      case when r.released_at is not null then 'ready' else 'awaiting_review' end,r.created_at
    from public.painting_measurements r where r.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(r.customer_phone)=public.sms_normalise_customer_phone(p_customer_phone)
    union all
    select 'solar',s.id,s.public_token,s.address,
      case when s.confirmed_at is not null and s.guardrail_flags='[]'::jsonb then 'ready' else 'awaiting_review' end,s.created_at
    from public.solar_estimates s left join public.intakes i on i.id=s.intake_id and i.tenant_id=s.tenant_id
    where s.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(coalesce(s.customer_phone,i.caller->>'phone'))=public.sms_normalise_customer_phone(p_customer_phone)
    union all
    select 'plan',e.id,e.share_token,coalesce(u.filename,'plan take-off'),
      case when e.released_at is not null then 'ready' else 'awaiting_review' end,e.created_at
    from public.plan_extractions e join public.plan_uploads u on u.id=e.plan_upload_id and u.tenant_id=e.tenant_id
    where e.tenant_id=p_tenant_id and exists(select 1 from public.plan_upload_requests r where r.tenant_id=e.tenant_id and r.plan_extraction_id=e.id and public.sms_normalise_customer_phone(r.customer_phone)=public.sms_normalise_customer_phone(p_customer_phone))
    union all
    select 'aircon',r.id,r.public_token,coalesce(r.address,'air conditioning'),
      case when r.released_at is not null then 'ready' else 'awaiting_review' end,r.created_at
    from public.aircon_recommendations r where r.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(r.customer_phone)=public.sms_normalise_customer_phone(p_customer_phone)
    union all
    select 'commercial-paint',r.id,r.public_token,coalesce(r.job_name,r.site_address,'commercial painting'),
      case when r.released_at is not null then 'ready' else 'awaiting_review' end,r.created_at
    from public.paint_runs r where r.tenant_id=p_tenant_id and public.sms_normalise_customer_phone(r.customer_phone)=public.sms_normalise_customer_phone(p_customer_phone)
  ) select * from candidates where token is not null order by created_at desc, resource_id limit 30
$$;
revoke all on function public.sms_customer_quote_references(uuid,text) from public,anon,authenticated;
grant execute on function public.sms_customer_quote_references(uuid,text) to service_role;

-- Intake + deterministic estimate + generic payment quote are one transaction.
-- A response lost after commit is replayed using the same request key/token.
create or replace function public.sms_save_solar_estimate(
  p_tenant_id uuid,p_request_key text,p_customer_phone text,
  p_intake jsonb,p_solar jsonb,p_quote jsonb,p_work_id uuid default null,p_work_owner uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  saved public.solar_estimates;
  intake_id uuid;
  quote_id uuid;
  payload jsonb;
  cols text;
begin
  if p_tenant_id is null or nullif(p_request_key,'') is null or nullif(p_customer_phone,'') is null then
    raise exception 'Solar owner and request identity required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_request_key,0));
  select * into saved from public.solar_estimates where tenant_id=p_tenant_id and source_request_key=p_request_key;
  if found then return to_jsonb(saved); end if;
  payload := p_intake || jsonb_build_object('tenant_id',p_tenant_id,'caller',coalesce(p_intake->'caller','{}') || jsonb_build_object('phone',p_customer_phone),
    'sms_work_id',p_work_id,'sms_work_owner',p_work_owner);
  select string_agg(quote_ident(k),',' order by k) into cols from jsonb_object_keys(payload) k;
  execute format('insert into public.intakes (%s) select %s from jsonb_populate_record(null::public.intakes,$1) returning id',cols,cols) into intake_id using payload;
  payload := p_quote || jsonb_build_object('tenant_id',p_tenant_id,'intake_id',intake_id,'status','draft',
    'sms_work_id',p_work_id,'sms_work_owner',p_work_owner);
  select string_agg(quote_ident(k),',' order by k) into cols from jsonb_object_keys(payload) k;
  execute format('insert into public.quotes (%s) select %s from jsonb_populate_record(null::public.quotes,$1) returning id',cols,cols) into quote_id using payload;
  payload := p_solar || jsonb_build_object('tenant_id',p_tenant_id,'intake_id',intake_id,'quote_id',quote_id,
    'customer_phone',p_customer_phone,'source_request_key',p_request_key,'confirmed_at',null,
    'sms_work_id',p_work_id,'sms_work_owner',p_work_owner);
  select string_agg(quote_ident(k),',' order by k) into cols from jsonb_object_keys(payload) k;
  execute format('insert into public.solar_estimates (%s) select %s from jsonb_populate_record(null::public.solar_estimates,$1) returning *',cols,cols) into saved using payload;
  return to_jsonb(saved);
end $$;
revoke all on function public.sms_save_solar_estimate(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sms_save_solar_estimate(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid) to service_role;

-- Called only by an authenticated owner action in /api/sms/quote-release.
-- Resource lock makes recipient binding and approval one atomic operation.
create or replace function public.sms_release_quote_resource(p_tenant_id uuid,p_family text,p_resource_id uuid,p_customer_phone text default null,
  p_outbound jsonb default null,p_outbound_hash text default null,p_expected_snapshot jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare tab text; stamp_col text; saved jsonb; old_phone text; recipient text; tok text; reviewed_bom jsonb;
begin
  tab := case p_family when 'roof' then 'roofing_measurements' when 'paint' then 'painting_measurements'
    when 'solar' then 'solar_estimates' when 'plan' then 'plan_extractions'
    when 'aircon' then 'aircon_recommendations' when 'commercial-paint' then 'paint_runs' end;
  if tab is null then raise exception 'Unsupported quote family'; end if;
  execute format('select to_jsonb(r) from public.%I r where id=$1 and tenant_id=$2 for update',tab)
    into saved using p_resource_id,p_tenant_id;
  if saved is null then raise exception 'Quote not found for tenant'; end if;
  if p_expected_snapshot is not null and saved is distinct from (p_expected_snapshot-'_review_priced_bom') then raise exception 'Quote changed after review'; end if;
  if p_family='commercial-paint' then
    select priced_bom into reviewed_bom from public.plan_extractions where tenant_id=p_tenant_id and paint_run_id=p_resource_id
      and priced_bom is not null order by priced_at desc limit 1 for update;
    if reviewed_bom is null or reviewed_bom is distinct from p_expected_snapshot->'_review_priced_bom' then raise exception 'Tender pricing changed after review'; end if;
  end if;
  if p_family='solar' and coalesce(saved->'guardrail_flags','["missing"]'::jsonb)<>'[]'::jsonb then raise exception 'Solar checks need resolution'; end if;
  if p_family='plan' and (saved->'corrected_items' is null or saved->'corrected_items'='null'::jsonb) then raise exception 'Review plan quantities before approval'; end if;
  if p_family='commercial-paint' and saved->>'status' is distinct from 'priced' then raise exception 'Commercial painting result must be priced'; end if;
  if p_family='roof' and (saved->'quote'->'pricing_authority'->>'tenant_id') is distinct from p_tenant_id::text then raise exception 'Tenant roofing pricing review required'; end if;
  tok := coalesce(saved->>'public_token',saved->>'share_token');
  if tok is null or tok !~ '^[A-Za-z0-9_-]{12,160}$' then raise exception 'Saved result token missing'; end if;
  old_phone := saved->>'customer_phone';
  if p_family='solar' and nullif(old_phone,'') is null then
    select caller->>'phone' into old_phone from public.intakes where id=(saved->>'intake_id')::uuid and tenant_id=p_tenant_id;
  elsif p_family='plan' then
    select customer_phone into old_phone from public.plan_upload_requests where tenant_id=p_tenant_id and plan_extraction_id=p_resource_id order by created_at desc limit 1;
  end if;
  if nullif(old_phone,'') is not null and nullif(p_customer_phone,'') is not null and
     public.sms_normalise_customer_phone(old_phone)<>public.sms_normalise_customer_phone(p_customer_phone) then raise exception 'Customer does not own this result'; end if;
  recipient := coalesce(nullif(old_phone,''),nullif(p_customer_phone,''));
  if recipient is null or public.sms_normalise_customer_phone(recipient) !~ '^[0-9]{8,15}$' then raise exception 'Customer mobile required'; end if;
  if p_outbound is null or p_outbound_hash is null or
     p_outbound->>'tenantId' is distinct from p_tenant_id::text or
     p_outbound->>'resourceToken' is distinct from tok or
     public.sms_normalise_customer_phone(p_outbound->>'to') is distinct from public.sms_normalise_customer_phone(recipient)
  then raise exception 'A durable customer delivery intent is required'; end if;
  perform public.sms_outbox_enqueue('quote-release:' || p_family || ':' || p_resource_id::text,p_outbound,p_outbound_hash);
  stamp_col := case when p_family='solar' then 'confirmed_at' else 'released_at' end;
  if p_family='plan' then
    -- A plan's customer binding lives on its upload request. It must already
    -- exist, so a random new recipient cannot take ownership of a plan.
    if nullif(old_phone,'') is null then raise exception 'Link this plan to a customer upload request first'; end if;
    execute format('update public.%I set %I=coalesce(%I,now()) where id=$1 and tenant_id=$2',tab,stamp_col,stamp_col) using p_resource_id,p_tenant_id;
  else
    execute format('update public.%I set %I=coalesce(%I,now()),customer_phone=$3 where id=$1 and tenant_id=$2',tab,stamp_col,stamp_col) using p_resource_id,p_tenant_id,recipient;
  end if;
  return jsonb_build_object('token',tok,'customer_phone',recipient,'label',coalesce(saved->>'address',saved->>'job_name',p_family),'created_at',saved->>'created_at');
end $$;
revoke all on function public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
