-- T09/X04: atomic owned corrections and exact rich-run pricing review.
-- Apply after201/211/219. Does not reprice, release or send historical work.
begin;

create table if not exists public.commercial_paint_correction_operations (
  tenant_id uuid not null, run_id uuid not null references public.paint_runs(id) on delete cascade,
  operation_id uuid not null, request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  expected_revision text not null check(expected_revision ~ '^[a-f0-9]{64}$'), extraction_id uuid,
  changes jsonb not null, outcome jsonb not null, created_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id,run_id,operation_id)
);
alter table public.commercial_paint_correction_operations enable row level security;
revoke all on public.commercial_paint_correction_operations from public,anon,authenticated;
grant select,insert on public.commercial_paint_correction_operations to service_role;

create or replace function public.commercial_paint_edit_snapshot(p_tenant_id uuid,p_run_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  with source as (
    select jsonb_build_object('runId',r.id,'extractionId',e.id,'job_name',r.job_name,'site_address',r.site_address,
      'items',coalesce(e.items,'[]'::jsonb),'corrected_items',e.corrected_items,'released',r.released_at is not null) as body
    from public.paint_runs r left join lateral (
      select x.* from public.plan_extractions x where x.paint_run_id=r.id and x.tenant_id=r.tenant_id
      order by x.created_at desc,x.id desc limit 1
    ) e on true
    where r.id=p_run_id and r.tenant_id=p_tenant_id and (e.id is null or e.trade='commercial_painting')
  ) select body||jsonb_build_object('revision',encode(sha256(convert_to(body::text,'UTF8')),'hex')) from source;
$$;

create or replace function public.commercial_paint_valid_correction(p_changes jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare item jsonb; field text;
begin
  if p_changes is null or jsonb_typeof(p_changes)<>'object' or p_changes='{}'::jsonb or
    exists(select 1 from jsonb_object_keys(p_changes) key where key not in ('job_name','site_address','corrected_items')) then return false; end if;
  foreach field in array array['job_name','site_address'] loop
    if p_changes ? field and (jsonb_typeof(p_changes->field) not in ('null','string') or
      length(p_changes->>field)>case when field='job_name' then 200 else 300 end) then return false; end if;
  end loop;
  if not(p_changes ? 'corrected_items') then return true; end if;
  if jsonb_typeof(p_changes->'corrected_items')<>'array' or jsonb_array_length(p_changes->'corrected_items') not between 1 and 5000 then return false; end if;
  for item in select value from jsonb_array_elements(p_changes->'corrected_items') loop
    if jsonb_typeof(item)<>'object' or not(item ?& array['surface','room','substrate','system','unit','quantity','coats','confidence','source']) or
      exists(select 1 from jsonb_object_keys(item) key where key not in ('surface','room','substrate','system','unit','quantity','coats','height_m','confidence','source','delta_pct','separate_price','excluded','note')) then return false; end if;
    if jsonb_typeof(item->'surface')<>'string' or length(btrim(item->>'surface')) not between 1 and 200 or
      jsonb_typeof(item->'room')<>'string' or length(item->>'room')>120 or
      jsonb_typeof(item->'substrate')<>'string' or length(item->>'substrate')>120 or
      jsonb_typeof(item->'system')<>'string' or item->>'system' not in ('spray_matt','flat','low_sheen','semi_gloss') or
      jsonb_typeof(item->'unit')<>'string' or item->>'unit' not in ('m2','item') or
      jsonb_typeof(item->'confidence')<>'string' or item->>'confidence' not in ('high','medium','low') or
      jsonb_typeof(item->'source')<>'string' or item->>'source' not in ('plan','measurements','both','manual') or
      jsonb_typeof(item->'quantity')<>'number' or (item->>'quantity')::numeric not between 0 and 1.7976931348623157e308 or
      jsonb_typeof(item->'coats')<>'number' or (item->>'coats')::numeric not in (1,2,3,4) then return false; end if;
    if item ? 'height_m' and (jsonb_typeof(item->'height_m')<>'number' or (item->>'height_m')::numeric<=0 or (item->>'height_m')::numeric>=30) then return false; end if;
    if item ? 'delta_pct' and (jsonb_typeof(item->'delta_pct')<>'number' or abs((item->>'delta_pct')::numeric)>1.7976931348623157e308) then return false; end if;
    if item ? 'note' and (jsonb_typeof(item->'note')<>'string' or length(item->>'note')>400) then return false; end if;
    foreach field in array array['separate_price','excluded'] loop
      if item ? field and jsonb_typeof(item->field)<>'boolean' then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then return false;
end $$;

create or replace function public.commercial_paint_correction_status(p_tenant_id uuid,p_run_id uuid,p_operation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  if not exists(select 1 from public.paint_runs where id=p_run_id and tenant_id=p_tenant_id) then
    raise exception using errcode='PC004',message='not_found'; end if;
  select outcome into result from public.commercial_paint_correction_operations
    where tenant_id=p_tenant_id and run_id=p_run_id and operation_id=p_operation_id;
  return coalesce(result,jsonb_build_object('ok',true,'status','not_found','runId',p_run_id,'operationId',p_operation_id));
end $$;

create or replace function public.apply_commercial_paint_correction(p_tenant_id uuid,p_run_id uuid,p_operation_id uuid,
  p_expected_revision text,p_extraction_id uuid,p_request_hash text,p_changes jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.paint_runs%rowtype; e public.plan_extractions%rowtype;
  prior public.commercial_paint_correction_operations%rowtype; snapshot jsonb; result jsonb;
begin
  -- Reject the entire command before changing metadata, items or pricing.
  if p_operation_id is null or coalesce(p_expected_revision,'') !~ '^[a-f0-9]{64}$' or
    coalesce(p_request_hash,'') !~ '^[a-f0-9]{64}$' or not public.commercial_paint_valid_correction(p_changes) or
    (p_changes ? 'corrected_items' and p_extraction_id is null) then
    raise exception using errcode='PC003',message='invalid_correction'; end if;
  select * into r from public.paint_runs where id=p_run_id and tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='PC004',message='not_found'; end if;
  select * into prior from public.commercial_paint_correction_operations
    where tenant_id=p_tenant_id and run_id=p_run_id and operation_id=p_operation_id;
  if found then
    if prior.request_hash is distinct from p_request_hash or prior.expected_revision is distinct from p_expected_revision or
      prior.extraction_id is distinct from p_extraction_id or prior.changes is distinct from p_changes then
      raise exception using errcode='PC002',message='correction_operation_reused'; end if;
    return prior.outcome;
  end if;
  if r.released_at is not null then raise exception using errcode='QM001',message='released_quote_immutable'; end if;
  if r.status='extracting' then raise exception using errcode='PC001',message='correction_conflict'; end if;
  select * into e from public.plan_extractions where paint_run_id=r.id and tenant_id=r.tenant_id
    order by created_at desc,id desc limit 1 for update;
  snapshot:=public.commercial_paint_edit_snapshot(p_tenant_id,p_run_id);
  if snapshot is null or snapshot->>'revision' is distinct from p_expected_revision or e.id is distinct from p_extraction_id or
    (e.id is not null and e.trade is distinct from 'commercial_painting') then
    raise exception using errcode='PC001',message='correction_conflict'; end if;
  update public.paint_runs set
    job_name=case when p_changes ? 'job_name' then nullif(p_changes->>'job_name','') else job_name end,
    site_address=case when p_changes ? 'site_address' then nullif(p_changes->>'site_address','') else site_address end,
    status=case when e.id is null then status else 'ready' end,updated_at=clock_timestamp()
    where id=r.id and tenant_id=r.tenant_id;
  if e.id is not null then
    update public.plan_extractions set corrected_items=case when p_changes ? 'corrected_items' then p_changes->'corrected_items' else corrected_items end,
      priced_bom=null,priced_at=null,paint_pricing_proof=null,updated_at=clock_timestamp()
      where id=e.id and paint_run_id=r.id and tenant_id=r.tenant_id;
  end if;
  snapshot:=public.commercial_paint_edit_snapshot(p_tenant_id,p_run_id);
  result:=jsonb_build_object('ok',true,'status','applied','runId',r.id,'operationId',p_operation_id,
    'extractionId',e.id,'expectedRevision',p_expected_revision,'requestHash',p_request_hash,'revision',snapshot->>'revision');
  insert into public.commercial_paint_correction_operations(tenant_id,run_id,operation_id,request_hash,expected_revision,extraction_id,changes,outcome)
    values(r.tenant_id,r.id,p_operation_id,p_request_hash,p_expected_revision,e.id,p_changes,result);
  return result;
end $$;

revoke all on function public.commercial_paint_edit_snapshot(uuid,uuid) from public,anon,authenticated;
revoke all on function public.commercial_paint_valid_correction(jsonb) from public,anon,authenticated;
revoke all on function public.commercial_paint_correction_status(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.commercial_paint_edit_snapshot(uuid,uuid) to service_role;
grant execute on function public.commercial_paint_valid_correction(jsonb) to service_role;
grant execute on function public.commercial_paint_correction_status(uuid,uuid,uuid) to service_role;
grant execute on function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb) to service_role;

-- Existing release signature and non-paint families remain compatible.
create or replace function public.sms_release_quote_resource(p_tenant_id uuid,p_family text,p_resource_id uuid,p_customer_phone text default null,
  p_outbound jsonb default null,p_outbound_hash text default null,p_expected_snapshot jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare tab text; stamp_col text; saved jsonb; old_phone text; recipient text; tok text; reviewed_bom jsonb; e public.plan_extractions%rowtype; binding jsonb; source jsonb;
begin
  if p_family='commercial-paint' then lock table public.paint_rates,public.pricing_book in share mode; end if;
  tab := case p_family when 'roof' then 'roofing_measurements' when 'paint' then 'painting_measurements'
    when 'solar' then 'solar_estimates' when 'plan' then 'plan_extractions'
    when 'aircon' then 'aircon_recommendations' when 'commercial-paint' then 'paint_runs' end;
  if tab is null then raise exception 'Unsupported quote family'; end if;
  execute format('select to_jsonb(r) from public.%I r where id=$1 and tenant_id=$2 for update',tab)
    into saved using p_resource_id,p_tenant_id;
  if saved is null then raise exception 'Quote not found for tenant'; end if;
  if p_expected_snapshot is not null and saved is distinct from (p_expected_snapshot-'_review_priced_bom'-'_review_paint_pricing') then raise exception 'Quote changed after review'; end if;
  if p_family='commercial-paint' then
    binding:=p_expected_snapshot->'_review_paint_pricing';
    if binding is null or jsonb_typeof(binding)<>'object' then
      raise exception using errcode='QP002',message='pricing_review_required'; end if;
    if saved->>'released_at' is null then
      select * into e from public.plan_extractions where tenant_id=p_tenant_id and paint_run_id=p_resource_id
        order by created_at desc,id desc limit 1 for update;
      source:=public.commercial_paint_pricing_source(p_tenant_id,p_resource_id,e.id);
    else
      -- Released pricing is historical; later rate edits must not rewrite it.
      select * into e from public.plan_extractions where tenant_id=p_tenant_id and paint_run_id=p_resource_id
        and priced_bom is not null order by priced_at desc,id desc limit 1 for update;
      source:=e.paint_pricing_proof->'source';
    end if;
    reviewed_bom:=e.priced_bom;
    if e.id is null or e.trade is distinct from 'commercial_painting' or reviewed_bom is null or e.priced_at is null or source is null or
      e.id::text is distinct from binding->>'extractionId' or e.priced_at is distinct from (binding->>'pricedAt')::timestamptz or
      reviewed_bom is distinct from p_expected_snapshot->'_review_priced_bom' or e.paint_pricing_proof is distinct from binding->'proof' or
      e.paint_pricing_proof->'source' is distinct from source or e.paint_pricing_proof->>'version' is distinct from '1' or
      e.paint_pricing_proof->>'algorithm' is distinct from 'commercial-paint-v1' or coalesce(e.paint_pricing_proof->>'digest','') !~ '^[a-f0-9]{64}$' or
      source#>>'{run,id}' is distinct from p_resource_id::text or source#>>'{run,tenant_id}' is distinct from p_tenant_id::text or
      source#>'{run,job_name}' is distinct from saved->'job_name' or source#>'{run,site_address}' is distinct from saved->'site_address' or
      source#>>'{extraction,id}' is distinct from e.id::text or source#>>'{extraction,paint_run_id}' is distinct from p_resource_id::text or
      source#>>'{extraction,tenant_id}' is distinct from p_tenant_id::text or source#>'{extraction,items}' is distinct from e.items or
      source#>'{extraction,corrected_items}' is distinct from coalesce(e.corrected_items,'null'::jsonb) then
      raise exception using errcode='QP001',message='pricing_changed';
    end if;
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

-- Keep the precise priced source immutable while allowing PDF/cache projections.
create or replace function public.guard_commercial_quote_extraction()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public set row_security=off as $$
declare
  old_run uuid;
  new_run uuid;
  old_priced boolean := false;
  new_priced boolean := false;
  parent record;
  new_parent_owned boolean := false;
  old_parent_visible boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_run := old.paint_run_id;
    old_priced := old.priced_bom is not null;
  end if;
  if tg_op <> 'DELETE' then
    new_run := new.paint_run_id;
    new_priced := new.priced_bom is not null;
  end if;

  if tg_op = 'UPDATE' and
     new.id is not distinct from old.id and
     new.items is not distinct from old.items and new.corrected_items is not distinct from old.corrected_items and
     new.paint_pricing_proof is not distinct from old.paint_pricing_proof and new.created_at is not distinct from old.created_at and
     new.trade is not distinct from old.trade and
     new.priced_bom is not distinct from old.priced_bom and
     new.priced_at is not distinct from old.priced_at and
     new.tenant_id is not distinct from old.tenant_id and
     new.paint_run_id is not distinct from old.paint_run_id then
    return new;
  end if;

  -- Ordinary plan extractions have no paint_run_id and retain their own
  -- release contract. A commercial result must belong to its actual run.
  for parent in
    select r.id,r.tenant_id,r.released_at from public.paint_runs r
    where r.id = any(array[old_run,new_run]) order by r.id for update
  loop
    if parent.id = old_run then old_parent_visible := true; end if;
    if old_priced and parent.id = old_run and parent.released_at is not null then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
    if new_priced and parent.id = new_run then
      new_parent_owned := parent.tenant_id = new.tenant_id;
      if parent.released_at is not null then
        raise exception using errcode='QM001',message='released_quote_immutable';
      end if;
    end if;
  end loop;

  -- ON DELETE CASCADE removes an unreleased parent before its children.
  -- The parent row guard already rejects deletion of a released run.
  if tg_op <> 'DELETE' and old_priced and old_run is not null and not old_parent_visible then
    raise exception using errcode='QM001',message='commercial_priced_parent_unavailable';
  end if;
  if new_priced and new_run is not null and not coalesce(new_parent_owned,false) then
    raise exception using errcode='QM001',message='commercial_priced_result_requires_owned_run';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.guard_commercial_quote_run()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if old.released_at is not null then
    if tg_op = 'DELETE' then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
    if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or
       new.public_token is distinct from old.public_token or new.released_at is distinct from old.released_at or
       new.job_name is distinct from old.job_name or new.site_address is distinct from old.site_address or
       new.status is distinct from old.status or new.customer_phone is distinct from old.customer_phone then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;


revoke all on function public.guard_commercial_quote_extraction() from public,anon,authenticated,service_role;
revoke all on function public.guard_commercial_quote_run() from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
commit;
