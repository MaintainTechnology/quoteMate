-- Apply after205 and207, before deploying callers of the expanded release snapshot.
-- Older callers missing the new fields fail closed until their backend is upgraded.
-- Existing outbox payloads/receipts are deliberately unchanged and remain recoverable.
-- A pre215 intent cannot be silently recomposed with a new revision on the same key.
create or replace function public.approve_generic_quote_release(
  p_quote_id uuid,p_tenant_id uuid,p_owner_id text,p_snapshot jsonb,p_hold_until timestamptz,
  p_outbound jsonb default null,p_hash text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare q public.quotes; saved jsonb; existing public.sms_outbox; current_snapshot jsonb;
begin
  select * into q from quotes where id=p_quote_id and tenant_id=p_tenant_id for update;
  if not found or nullif(p_owner_id,'') is null then raise exception 'Owned quote approval required'; end if;
  if q.paid_at is not null or q.status in ('paid','accepted') then raise exception 'Quote already transacted'; end if;
  select jsonb_object_agg(field, to_jsonb(q)->field) into current_snapshot
    from unnest(array['share_token','intake_id','good','better','best','total_inc_gst','selected_tier',
      'scope_of_works','assumptions','estimated_timeframe','needs_inspection','inspection_reason','deposit_pct',
      'display_mode','applied_discount_pct','quote_kind','parent_quote_id','pricing_book_version_id','report_doc','report_style']) field;
  -- Exact equality also rejects partial objects and added/reordered array content;
  -- containment would accept unreviewed narrative, style or line-item additions.
  if p_snapshot is distinct from current_snapshot then raise exception 'Quote changed since owner review'; end if;
  if p_outbound is not null then
    if p_outbound->'quoteReleaseSnapshot' is distinct from p_snapshot then raise exception 'Quote delivery snapshot required'; end if;
    if p_outbound->>'tenantId' is distinct from p_tenant_id::text or p_outbound->>'quoteReleaseId' is distinct from p_quote_id::text
      or nullif(p_outbound->>'to','') is null or nullif(p_outbound->>'text','') is null
      or not (p_outbound->>'deliveryKey' like 'quote-release:generic:'||p_quote_id::text||':%') then
      raise exception 'Quote delivery ownership required';
    end if;
    select * into existing from sms_outbox where delivery_key=p_outbound->>'deliveryKey';
    if found then
      if existing.tenant_id is distinct from p_tenant_id or existing.payload->>'quoteReleaseId' is distinct from p_quote_id::text
        or existing.to_number is distinct from p_outbound->>'to'
        or existing.payload->>'quoteReleaseRevision' is distinct from p_outbound->>'quoteReleaseRevision' then raise exception 'Quote delivery intent mismatch'; end if;
      return jsonb_build_object('approved',true,'outbound',existing.payload,'outbox_id',existing.id);
    end if;
  end if;
  if q.status is null or q.status not in ('draft','awaiting_tradie_approval','inspection','sent','viewed') then raise exception 'Quote is not sendable'; end if;
  if p_outbound is not null then
    saved := sms_outbox_enqueue(p_outbound->>'deliveryKey',p_outbound,p_hash);
  end if;
  update quotes set customer_released_at=coalesce(customer_released_at,now()),customer_released_by=coalesce(customer_released_by,p_owner_id),
    price_hold_until=p_hold_until where id=q.id;
  return jsonb_build_object('approved',true,'outbound',p_outbound,'outbox_id',saved->>'id');
end $$;
revoke all on function public.approve_generic_quote_release(uuid,uuid,text,jsonb,timestamptz,jsonb,text) from public,anon,authenticated;
grant execute on function public.approve_generic_quote_release(uuid,uuid,text,jsonb,timestamptz,jsonb,text) to service_role;
