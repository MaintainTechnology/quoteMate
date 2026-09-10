-- Review and edit must serialize on the same saved resource. Existing released
-- roofing quotes remain immutable: changed measurements create a held successor.
begin;

create or replace function public.sms_revise_roof_owned(
  p_tenant_id uuid, p_id uuid, p_expected jsonb, p_changes jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.roofing_measurements; revised public.roofing_measurements; linked_quote public.quotes;
  payload jsonb; cols text; request_key text;
begin
  select * into saved from public.roofing_measurements
    where id=p_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Measurement not found for tenant'; end if;
  if to_jsonb(saved)->>'paid_at' is not null then raise exception 'Paid quote is immutable'; end if;
  select * into linked_quote from public.quotes
    where tenant_id=p_tenant_id and share_token=to_jsonb(saved)->>'quote_share_token' for update;
  if found and (to_jsonb(linked_quote)->>'paid_at' is not null or linked_quote.status='paid')
    then raise exception 'Paid quote is immutable'; end if;
  if to_jsonb(saved) is distinct from p_expected then raise exception 'Measurement changed after review'; end if;
  if exists(select 1 from jsonb_object_keys(p_changes) k where k not in
    ('quote','included_indices','combined_area_m2','combined_better_inc_gst','structure_count','pdf_path'))
    then raise exception 'Unsupported measurement change'; end if;
  if saved.released_at is not null or to_jsonb(saved)->>'quote_share_token' is not null then
    request_key := 'revision:' || p_id::text || ':' || md5(p_expected::text || p_changes::text);
    select * into revised from public.roofing_measurements
      where tenant_id=p_tenant_id and source_request_key=request_key;
    if found then return to_jsonb(revised); end if;
    -- Copy only source measurements/contact. Approval, payment, PDF and derived
    -- image assets deliberately start empty on the new immutable-price revision.
    payload := jsonb_build_object('tenant_id',p_tenant_id,'address',saved.address,
      'postcode',saved.postcode,'state',saved.state,'provider',saved.provider,
      'customer_name',saved.customer_name,'customer_phone',saved.customer_phone,
      'routing',saved.routing,'quote',saved.quote,'included_indices',saved.included_indices,
      'structure_count',saved.structure_count,'combined_area_m2',saved.combined_area_m2,
      'combined_better_inc_gst',saved.combined_better_inc_gst,
      'public_token',replace(gen_random_uuid()::text,'-',''),
      'measure_token',replace(gen_random_uuid()::text,'-',''),
      'source_request_key',request_key,'released_at',null,'confirmed_at',null) || p_changes;
    payload := payload || jsonb_build_object('structures',coalesce(payload->'quote'->'structures','[]'::jsonb));
    select string_agg(quote_ident(k),',' order by k) into cols from jsonb_object_keys(payload) k;
    execute format('insert into public.roofing_measurements (%s) select %s from jsonb_populate_record(null::public.roofing_measurements,$1) returning *',cols,cols)
      into revised using payload;
  else
    payload := to_jsonb(saved) || p_changes;
    payload := payload || jsonb_build_object('structures',coalesce(payload->'quote'->'structures','[]'::jsonb));
    update public.roofing_measurements r set
      quote=n.quote, structures=n.structures, included_indices=n.included_indices,
      structure_count=n.structure_count, combined_area_m2=n.combined_area_m2,
      combined_better_inc_gst=n.combined_better_inc_gst,pdf_path=null
      from jsonb_populate_record(null::public.roofing_measurements,payload) n
      where r.id=p_id and r.tenant_id=p_tenant_id returning r.* into revised;
  end if;
  return to_jsonb(revised);
end $$;
revoke all on function public.sms_revise_roof_owned(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sms_revise_roof_owned(uuid,uuid,jsonb,jsonb) to service_role;

create or replace function public.sms_redraft_solar_owned(
  p_tenant_id uuid,p_id uuid,p_expected jsonb,p_changes jsonb,p_quote_changes jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.solar_estimates; quote_row public.quotes; cols text; payload jsonb;
begin
  select * into saved from public.solar_estimates where id=p_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Estimate not found for tenant'; end if;
  if saved.confirmed_at is not null or to_jsonb(saved)->>'paid_at' is not null then raise exception 'Released quote is immutable'; end if;
  if to_jsonb(saved) is distinct from p_expected then raise exception 'Estimate changed during redraft'; end if;
  if exists(select 1 from jsonb_object_keys(p_changes) k where k in
    ('id','tenant_id','intake_id','quote_id','public_token','source_request_key','confirmed_at','paid_at','customer_phone'))
    then raise exception 'Immutable estimate field'; end if;
  if exists(select 1 from jsonb_object_keys(p_quote_changes) k where k in
    ('id','tenant_id','intake_id','share_token','status','sent_at','paid_at','quote_kind','parent_quote_id'))
    then raise exception 'Immutable quote field'; end if;
  select * into quote_row from public.quotes where share_token=saved.public_token and tenant_id=p_tenant_id for update;
  if found then
    if quote_row.status not in ('draft','awaiting_tradie_approval') or to_jsonb(quote_row)->>'paid_at' is not null or to_jsonb(quote_row)->>'sent_at' is not null
      then raise exception 'Linked quote is already released'; end if;
    select string_agg(format('%I=n.%I',k,k),',' order by k) into cols from jsonb_object_keys(p_quote_changes) k;
    if cols is not null then
      payload := to_jsonb(quote_row) || p_quote_changes;
      execute format('update public.quotes q set %s from jsonb_populate_record(null::public.quotes,$1) n where q.id=$2 and q.tenant_id=$3',cols)
        using payload,quote_row.id,p_tenant_id;
    end if;
  end if;
  select string_agg(format('%I=n.%I',k,k),',' order by k) into cols from jsonb_object_keys(p_changes) k;
  if cols is null then raise exception 'No estimate changes'; end if;
  payload := to_jsonb(saved) || p_changes;
  execute format('update public.solar_estimates s set %s from jsonb_populate_record(null::public.solar_estimates,$1) n where s.id=$2 and s.tenant_id=$3 returning to_jsonb(s)',cols)
    into payload using payload,p_id,p_tenant_id;
  return payload;
end $$;
revoke all on function public.sms_redraft_solar_owned(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sms_redraft_solar_owned(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

-- A read-only readiness check confirms the mutation RPCs exist without creating
-- an enquiry, repricing a quote, or attempting a customer send.
create or replace function public.sms_owned_quote_revision_contract()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select to_regprocedure('public.sms_revise_roof_owned(uuid,uuid,jsonb,jsonb)') is not null
    and to_regprocedure('public.sms_redraft_solar_owned(uuid,uuid,jsonb,jsonb,jsonb)') is not null
$$;
revoke all on function public.sms_owned_quote_revision_contract() from public,anon,authenticated;
grant execute on function public.sms_owned_quote_revision_contract() to service_role;
notify pgrst,'reload schema';
commit;
