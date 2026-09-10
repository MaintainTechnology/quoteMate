-- Safe operational rollback: stop NEW corrections, retain committed-operation
-- recovery and all pricing/released-history guards. Never restore201's unbound
-- commercial-paint approval or drop recovery records to roll back a UI release.
begin;
create or replace function public.apply_commercial_paint_correction(p_tenant_id uuid,p_run_id uuid,p_operation_id uuid,
  p_expected_revision text,p_extraction_id uuid,p_request_hash text,p_changes jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare prior public.commercial_paint_correction_operations%rowtype;
begin
  if not exists(select 1 from public.paint_runs where id=p_run_id and tenant_id=p_tenant_id) then
    raise exception using errcode='PC004',message='not_found'; end if;
  select * into prior from public.commercial_paint_correction_operations
    where tenant_id=p_tenant_id and run_id=p_run_id and operation_id=p_operation_id;
  if found then
    if prior.request_hash is distinct from p_request_hash or prior.expected_revision is distinct from p_expected_revision or
      prior.extraction_id is distinct from p_extraction_id or prior.changes is distinct from p_changes then
      raise exception using errcode='PC002',message='correction_operation_reused'; end if;
    return prior.outcome;
  end if;
  raise exception using errcode='PC005',message='new_corrections_paused';
end $$;
revoke all on function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
