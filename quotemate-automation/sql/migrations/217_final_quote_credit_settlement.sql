-- Settle a deposit covered by the paid inspection only from an accepted
-- delivery's immutable reviewed snapshot. Apply199/205/207/215 first.
begin;
create table public.quote_credit_settlements (
  outbox_id uuid primary key references public.sms_outbox(id) on delete restrict,
  quote_id uuid not null references public.quotes(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  revision text,
  status text not null check(status in ('settled','not_required','pending','review_required')),
  reason text not null,
  updated_at timestamptz not null default now()
);
create index quote_credit_settlement_owner on public.quote_credit_settlements(tenant_id,quote_id,updated_at desc);
alter table public.quote_credit_settlements enable row level security;
revoke all on public.quote_credit_settlements from public,anon,authenticated;
grant select,insert,update on public.quote_credit_settlements to service_role;

create function public.settle_final_quote_credit(p_outbox_id uuid,p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.sms_outbox; f public.quotes; r public.quotes; i public.intakes;
  current_snapshot jsonb; snapshot jsonb; total_cents numeric; deposit_cents numeric;
  decision text := 'review_required'; why text := 'quote_credit_review_required';
begin
  -- Do not lock the outbox after the root: acceptance already owns its row
  -- and invokes this same function. Payload identity is immutable per intent.
  select * into o from public.sms_outbox where id=p_outbox_id and tenant_id=p_tenant_id;
  if not found then return jsonb_build_object('status','pending','reason','accepted_outbox_unconfirmed'); end if;
  if coalesce(o.payload->>'quoteReleaseId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    return jsonb_build_object('status','not_required','reason','not_generic_quote');
  end if;
  select * into f from public.quotes where id=(o.payload->>'quoteReleaseId')::uuid and tenant_id=p_tenant_id;
  if not found then return jsonb_build_object('status','review_required','reason','owned_quote_unavailable'); end if;
  if f.quote_kind is distinct from 'final' then
    return jsonb_build_object('status','not_required','reason','not_final_quote','quote_id',f.id);
  end if;
  -- Same root -> final -> intake order as213/214. The first final read only
  -- locates the root; repeat final ownership/lineage checks under the lock.
  select * into r from public.quotes where id=f.parent_quote_id and tenant_id=p_tenant_id for update;
  select * into f from public.quotes where id=(o.payload->>'quoteReleaseId')::uuid and tenant_id=p_tenant_id for update;
  if not found then return jsonb_build_object('status','review_required','reason','owned_quote_unavailable'); end if;
  select * into i from public.intakes where id=f.intake_id and tenant_id=p_tenant_id for update;
  loop
    if o.status not in ('accepted','delivered') or nullif(trim(o.provider_sid),'') is null then
      decision := 'pending'; why := 'provider_acceptance_unconfirmed'; exit;
    end if;
    if o.payload->>'tenantId' is distinct from p_tenant_id::text or o.audience is distinct from 'customer'
      or o.delivery_key not like 'quote-release:generic:'||f.id::text||':%' then
      why := 'delivery_identity_unconfirmed'; exit;
    end if;
    if r.id is null or coalesce(r.quote_kind,'initial') <> 'initial' or r.parent_quote_id is not null
      or r.paid_at is null or r.paid_tier is distinct from 'inspection'
      or f.quote_kind is distinct from 'final' or f.parent_quote_id is distinct from r.id or f.intake_id is distinct from r.intake_id
      or i.id is null or i.trade is null or lower(trim(i.trade)) not in ('electrical','plumbing') then
      why := 'owned_inspection_credit_unconfirmed'; exit;
    end if;
    if f.customer_released_at is null then why := 'owner_release_unconfirmed'; exit; end if;
    snapshot := o.payload->'quoteReleaseSnapshot';
    select jsonb_object_agg(field,to_jsonb(f)->field) into current_snapshot from unnest(array[
      'share_token','intake_id','good','better','best','total_inc_gst','selected_tier','scope_of_works','assumptions',
      'estimated_timeframe','needs_inspection','inspection_reason','deposit_pct','display_mode','applied_discount_pct',
      'quote_kind','parent_quote_id','pricing_book_version_id','report_doc','report_style']) field;
    if jsonb_typeof(snapshot) is distinct from 'object' or coalesce(o.payload->>'quoteReleaseRevision','') !~ '^[a-f0-9]{64}$' then
      why := 'legacy_delivery_snapshot_missing'; exit;
    end if;
    if snapshot is distinct from current_snapshot then why := 'accepted_quote_changed'; exit; end if;
    if f.total_inc_gst is null or f.total_inc_gst::text in ('NaN','Infinity','-Infinity') or f.total_inc_gst < 0
      or f.deposit_pct is null or f.deposit_pct::text in ('NaN','Infinity','-Infinity') or f.deposit_pct < 1 or f.deposit_pct > 90 then
      why := 'stored_quote_pricing_unconfirmed'; exit;
    end if;
    total_cents := f.total_inc_gst*100;
    if total_cents <> round(total_cents) or total_cents > 9007199254740991 or total_cents < 50 then
      why := 'stored_quote_pricing_unconfirmed'; exit;
    end if;
    -- Match finalDepositBaseCents, including the established rounded saved
    -- percentage and IEEE-754 positive Math.round behavior.
    deposit_cents := greatest(0,floor(total_cents::double precision *
      floor(f.deposit_pct::double precision+0.5::double precision)/100::double precision+0.5::double precision)::numeric-9900);
    if deposit_cents >= 50 then decision := 'not_required'; why := 'deposit_requires_payment'; exit; end if;
    if f.paid_at is not null then
      if f.paid_tier='credit' then decision := 'settled'; why := 'already_settled';
      else decision := 'not_required'; why := 'quote_already_paid'; end if;
      exit;
    end if;
    update public.quotes set paid_at=now(),paid_tier='credit',paid_amount_cents=0,
      paid_stripe_session_id=null,stripe_connect_destination=null
      where id=f.id and tenant_id=p_tenant_id and paid_at is null;
    decision := 'settled'; why := 'inspection_covers_deposit'; exit;
  end loop;
  insert into public.quote_credit_settlements(outbox_id,quote_id,tenant_id,revision,status,reason)
    values(o.id,f.id,p_tenant_id,o.payload->>'quoteReleaseRevision',decision,why)
    on conflict(outbox_id) do update set status=excluded.status,reason=excluded.reason,updated_at=now();
  return jsonb_build_object('status',decision,'reason',why,'quote_id',f.id,'outbox_id',o.id);
end $$;
revoke all on function public.settle_final_quote_credit(uuid,uuid) from public,anon,authenticated;
grant execute on function public.settle_final_quote_credit(uuid,uuid) to service_role;

create function public.reflect_final_quote_credit() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('accepted','delivered') and new.tenant_id is not null and new.payload ? 'quoteReleaseId' then
    begin
      perform public.settle_final_quote_credit(new.id,new.tenant_id);
    exception when others then
      -- An accounting dependency must never erase the carrier's accepted
      -- evidence. The explicit RPC/readback can reconcile after recovery.
      raise warning 'Final quote credit settlement needs recovery for outbox %',new.id;
    end;
  end if;
  return new;
end $$;
revoke all on function public.reflect_final_quote_credit() from public,anon,authenticated;
-- Alphabetical order is load-bearing: lock root/final before205's
-- generic_quote_delivery trigger takes the final-row lifecycle lock.
create trigger a_final_quote_credit after insert or update of status on public.sms_outbox
  for each row execute function public.reflect_final_quote_credit();
commit;
