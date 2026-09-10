-- C05: private, unpaid, standalone draft deletion. Shared/payment/worker
-- lifecycle deletion remains protected until those writers share a fence.
begin;

create function public.quote_deletion_permission(p_tenant_id uuid, p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; reason text;
begin
  select * into q from public.quotes where id=p_quote_id and tenant_id=p_tenant_id;
  if not found then reason := 'not_found';
  elsif q.paid_at is not null then reason := 'quote_already_paid';
  elsif q.parent_quote_id is not null or coalesce(q.quote_kind,'initial') <> 'initial'
    or exists(select 1 from public.quotes where parent_quote_id=q.id) then reason := 'quote_has_chain';
  elsif exists(select 1 from public.job_quote_operations where quote_id=q.id or intake_id=q.intake_id)
    then reason := 'quote_has_operation_history';
  elsif q.sent_at is not null or q.status is distinct from 'draft'
    or nullif(to_jsonb(q)->>'customer_released_at','') is not null
    or nullif(to_jsonb(q)->>'accepted_at','') is not null
    or nullif(to_jsonb(q)->>'scheduled_at','') is not null then reason := 'quote_not_private_draft';
  elsif nullif(q.share_token,'') is not null then reason := 'quote_has_public_link';
  elsif q.stripe_links is not null and q.stripe_links <> '{}'::jsonb then reason := 'quote_has_checkout';
  elsif exists(select 1 from public.roofing_measurements where quote_id=q.id)
    or exists(select 1 from public.roofing_quote_revisions where base_quote_id=q.id)
    or exists(select 1 from public.solar_estimates where quote_id=q.id) then reason := 'quote_has_saved_job';
  elsif nullif(to_jsonb(q)->>'sms_work_id','') is not null
    or exists(select 1 from public.sms_work_jobs where work_key='estimate:initial:'||q.intake_id::text)
    or exists(select 1 from public.sms_conversations where quote_id=q.id or intake_id=q.intake_id)
    then reason := 'quote_has_workflow_history';
  elsif exists(select 1 from public.payments where quote_id=q.id) then reason := 'quote_has_payment_history';
  end if;
  return jsonb_build_object('allowed',reason is null,'reason',reason);
end $$;

create function public.delete_supported_quote(p_tenant_id uuid, p_quote_id uuid, p_expected_quote jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; permission jsonb; deleted_id uuid;
begin
  -- The row lock also conflicts with FK key-share locks for chain creation.
  -- Check every mutable field again after obtaining ownership of this row.
  select * into q from public.quotes where id=p_quote_id and tenant_id=p_tenant_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  permission := public.quote_deletion_permission(p_tenant_id,p_quote_id);
  if not (permission->>'allowed')::boolean then
    return jsonb_build_object('ok',false,'error',permission->>'reason');
  end if;
  if p_expected_quote is null or to_jsonb(q) is distinct from p_expected_quote then
    return jsonb_build_object('ok',false,'error','quote_changed');
  end if;
  delete from public.quotes where id=q.id and tenant_id=p_tenant_id and paid_at is null
    returning id into deleted_id;
  if deleted_id is null then return jsonb_build_object('ok',false,'error','quote_changed'); end if;
  return jsonb_build_object('ok',true,'deleted',true,'quote_id',deleted_id);
end $$;

revoke all on function public.quote_deletion_permission(uuid,uuid), public.delete_supported_quote(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.quote_deletion_permission(uuid,uuid), public.delete_supported_quote(uuid,uuid,jsonb)
  to service_role;
commit;
