-- BE04: reviewed takeoff/rate/GST/labour provenance and quiet atomic save.
-- Apply after107/201/211. No historical quote or price is rewritten.
begin;
alter table public.plan_extractions add column if not exists paint_pricing_proof jsonb;

-- One SQL snapshot; no fallback to another trade's tax configuration.
create or replace function public.commercial_paint_pricing_source(p_tenant_id uuid,p_run_id uuid,p_extraction_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select jsonb_build_object('version',1,
    'run',jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'job_name',r.job_name,'site_address',r.site_address),
    'extraction',jsonb_build_object('id',e.id,'tenant_id',e.tenant_id,'paint_run_id',e.paint_run_id,'items',e.items,'corrected_items',e.corrected_items),
    'rates',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',v.kind,'code',v.code,'label',v.label,'tenant_id',v.tenant_id,'system',v.system,'method',v.method,
      'product',v.product,'coverage_m2_per_hr',v.coverage_m2_per_hr,'spread_m2_per_l',v.spread_m2_per_l,
      'price_per_l_ex_gst',v.price_per_l_ex_gst,'unit_hours',v.unit_hours,'value',v.value,'unit',v.unit,'is_default',v.is_default)
      order by v.code,v.tenant_id nulls first) from public.paint_rates v
      where v.trade='commercial_painting' and (v.tenant_id is null or v.tenant_id=p_tenant_id)),'[]'::jsonb),
    'pricing_book',(select case when count(*)=1 then (jsonb_agg(jsonb_build_object(
      'id',b.id,'tenant_id',b.tenant_id,'trade',b.trade,'gst_registered',b.gst_registered))->0) else null end
      from public.pricing_book b where b.tenant_id=p_tenant_id and b.trade='commercial_painting'))
  from public.paint_runs r join public.plan_extractions e on e.paint_run_id=r.id and e.tenant_id=r.tenant_id
  where r.id=p_run_id and r.tenant_id=p_tenant_id and e.id=p_extraction_id and e.trade='commercial_painting'
    and not exists(select 1 from public.plan_extractions newer where newer.paint_run_id=r.id and newer.tenant_id=r.tenant_id
      and (newer.created_at,newer.id)>(e.created_at,e.id));
$$;

create or replace function public.persist_commercial_paint_pricing(p_tenant_id uuid,p_run_id uuid,p_extraction_id uuid,
  p_source jsonb,p_proof jsonb,p_bom jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.paint_runs%rowtype; e public.plan_extractions%rowtype; stamp timestamptz;
begin
  -- Includes insertion/deletion phantoms in the selected rate/book set.
  -- These short transaction locks never cover rendering or provider I/O.
  lock table public.paint_rates,public.pricing_book in share mode;
  select * into r from public.paint_runs where id=p_run_id and tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='QP001',message='pricing_changed'; end if;
  if r.released_at is not null then raise exception using errcode='QM001',message='released_quote_immutable'; end if;
  select * into e from public.plan_extractions where id=p_extraction_id and paint_run_id=r.id and tenant_id=r.tenant_id for update;
  if not found or p_source is null or public.commercial_paint_pricing_source(p_tenant_id,p_run_id,p_extraction_id) is distinct from p_source then
    raise exception using errcode='QP001',message='pricing_changed';
  end if;
  if p_bom is null then
    update public.plan_extractions set priced_bom=null,priced_at=null,paint_pricing_proof=null,updated_at=clock_timestamp() where id=e.id;
    update public.paint_runs set status='ready',updated_at=clock_timestamp() where id=r.id;
    return jsonb_build_object('ok',true,'cleared',true);
  end if;
  if p_proof->>'version' is distinct from '1' or p_proof->>'algorithm' is distinct from 'commercial-paint-v1' or
     p_proof->'source' is distinct from p_source or coalesce(p_proof->>'digest','') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='QP002',message='pricing_review_required';
  end if;
  stamp:=greatest(clock_timestamp(),coalesce(e.priced_at+interval '1 microsecond','-infinity'::timestamptz));
  update public.plan_extractions set priced_bom=p_bom,priced_at=stamp,paint_pricing_proof=p_proof,updated_at=stamp where id=e.id;
  update public.paint_runs set status='priced',updated_at=stamp where id=r.id;
  return jsonb_build_object('ok',true,'priced_at',stamp,'pricingProof',p_proof->>'digest');
end $$;

create or replace function public.save_commercial_paint_quote(p_tenant_id uuid,p_run_id uuid,p_extraction_id uuid,
  p_source jsonb,p_proof jsonb,p_bom jsonb,p_priced_at timestamptz,p_intake jsonb,p_quote jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.paint_runs%rowtype; e public.plan_extractions%rowtype; q public.quotes%rowtype;
  i public.intakes%rowtype; intake_id uuid; quote_id uuid;
begin
  lock table public.paint_rates,public.pricing_book in share mode;
  select * into r from public.paint_runs where id=p_run_id and tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='QP001',message='pricing_changed'; end if;
  select * into e from public.plan_extractions where id=p_extraction_id and paint_run_id=r.id and tenant_id=r.tenant_id for update;
  if not found then raise exception using errcode='QP001',message='pricing_changed'; end if;
  intake_id:=(p_intake->>'id')::uuid; quote_id:=(p_quote->>'id')::uuid;
  -- First reconcile a previously committed draft; historical saved work remains
  -- recoverable after a new rate edit or customer release.
  select * into q from public.quotes where id=quote_id for update;
  if found then
    select * into i from public.intakes where id=q.intake_id and tenant_id=p_tenant_id;
    if q.tenant_id is distinct from p_tenant_id or q.intake_id is distinct from intake_id or i.id is null or
       i.scope->>'paint_run_id' is distinct from p_run_id::text or i.scope->>'extraction_id' is distinct from p_extraction_id::text or
       (i.scope->>'priced_at')::timestamptz is distinct from p_priced_at or
       i.scope->'paint_pricing_proof'->>'digest' is distinct from p_proof->>'digest' or
       i.caller is distinct from p_intake->'caller' then
      raise exception using errcode='QP003',message='saved_quote_unverifiable';
    end if;
    return jsonb_build_object('ok',true,'already',true,'quote',to_jsonb(q));
  end if;
  if r.released_at is not null then raise exception using errcode='QM001',message='released_quote_immutable'; end if;
  if p_source is null or public.commercial_paint_pricing_source(p_tenant_id,p_run_id,p_extraction_id) is distinct from p_source or
     e.priced_at is distinct from p_priced_at or e.priced_bom is distinct from p_bom or e.paint_pricing_proof is distinct from p_proof then
    raise exception using errcode='QP001',message='pricing_changed';
  end if;
  if p_proof->'source' is distinct from p_source or coalesce(p_proof->>'digest','') !~ '^[a-f0-9]{64}$' or
     p_intake->>'tenant_id' is distinct from p_tenant_id::text or p_quote->>'tenant_id' is distinct from p_tenant_id::text or
     p_intake->>'trade' is distinct from 'commercial_painting' or p_quote->>'intake_id' is distinct from intake_id::text or
     p_intake->'scope'->'paint_pricing_proof' is distinct from p_proof or
     p_intake->'scope'->>'paint_run_id' is distinct from p_run_id::text or p_intake->'scope'->>'extraction_id' is distinct from p_extraction_id::text or
     (p_intake->'scope'->>'priced_at')::timestamptz is distinct from p_priced_at or
     (p_quote->>'total_inc_gst')::numeric is distinct from (p_bom->>'totalIncGst')::numeric or
     (p_quote->>'subtotal_ex_gst')::numeric is distinct from (p_bom->>'subtotalExGst')::numeric or
     (p_quote->>'gst')::numeric is distinct from (p_bom->>'gst')::numeric then
    raise exception using errcode='QP002',message='pricing_review_required';
  end if;
  -- Explicit columns keep payment/release state out of this quiet draft path.
  insert into public.intakes(id,tenant_id,trade,job_type,address,suburb,scope,access,property,risks,inspection_required,caller,timing,confidence,confidence_reason)
  values(intake_id,p_tenant_id,'commercial_painting','commercial_painting',r.site_address,null,
    p_intake->'scope',p_intake->'access',p_intake->'property',p_intake->'risks',false,p_intake->'caller',p_intake->'timing',
    p_intake->>'confidence',p_intake->>'confidence_reason');
  insert into public.quotes(id,tenant_id,intake_id,status,share_token,scope_of_works,assumptions,risk_flags,needs_inspection,inspection_reason,
    good,better,best,selected_tier,subtotal_ex_gst,gst,total_inc_gst,routing_decision)
  values(quote_id,p_tenant_id,intake_id,'draft',p_quote->>'share_token',p_quote->>'scope_of_works',p_quote->'assumptions',p_quote->'risk_flags',false,null,
    p_quote->'good',p_quote->'better',p_quote->'best','better',(p_bom->>'subtotalExGst')::numeric,(p_bom->>'gst')::numeric,(p_bom->>'totalIncGst')::numeric,'tradie_review')
  returning * into q;
  update public.plan_extractions set sheets_used=coalesce(sheets_used,'{}'::jsonb)||jsonb_build_object('saved_quote',jsonb_build_object(
    'quote_id',q.id,'share_token',q.share_token,'priced_at',e.priced_at,'pdf_ready',false,'pricing_proof',p_proof->>'digest')) where id=e.id;
  return jsonb_build_object('ok',true,'already',false,'quote',to_jsonb(q));
end $$;

revoke all on function public.commercial_paint_pricing_source(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commercial_paint_pricing_source(uuid,uuid,uuid) to service_role;
grant execute on function public.persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
