-- Prepare one balance from an owned, settled final quote. No carrier calls or
-- release stamps happen here; migration205 atomically releases/enqueues later.
create or replace function public.prepare_balance_quote(
  p_final_id uuid, p_tenant_id uuid, p_final_snapshot jsonb,
  p_root_snapshot jsonb, p_intake_snapshot jsonb,
  p_balance_cents bigint, p_share_token text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare f public.quotes; r public.quotes; i public.intakes; b public.quotes;
  total_cents numeric; deposit_cents numeric; balance_cents numeric; child_count integer;
begin
  -- All chain preparations lock root before final/children. The first read
  -- only locates that root; the final is re-read and checked under its lock.
  select * into f from quotes where id=p_final_id and tenant_id=p_tenant_id;
  if not found or f.quote_kind is distinct from 'final' or f.sent_at is null
    or f.paid_at is null or f.paid_tier is null or f.paid_tier not in ('deposit','credit') then
    raise exception 'Final quote is not settled';
  end if;
  select * into r from quotes where id=f.parent_quote_id and tenant_id=p_tenant_id for update;
  if not found or coalesce(r.quote_kind,'initial') <> 'initial' or r.parent_quote_id is not null
    or r.intake_id is distinct from f.intake_id or r.paid_at is null or r.paid_tier is distinct from 'inspection' then
    raise exception 'Owned paid inspection root required';
  end if;
  select * into f from quotes where id=p_final_id and tenant_id=p_tenant_id for update;
  if not found or f.parent_quote_id is distinct from r.id or f.intake_id is distinct from r.intake_id
    or f.quote_kind is distinct from 'final' or f.sent_at is null or f.paid_at is null
    or f.paid_tier is null or f.paid_tier not in ('deposit','credit') then raise exception 'Final quote changed'; end if;
  select * into i from intakes where id=f.intake_id and tenant_id=p_tenant_id for update;
  if not found or lower(trim(i.trade)) not in ('electrical','plumbing') or i.trade is null then
    raise exception 'Owned site visit intake required';
  end if;
  if p_final_snapshot is null or p_root_snapshot is null or p_intake_snapshot is null
    or to_jsonb(f) is distinct from p_final_snapshot or to_jsonb(r) is distinct from p_root_snapshot
    or to_jsonb(i) is distinct from p_intake_snapshot then raise exception 'Quote chain changed since review'; end if;
  if f.total_inc_gst is null or f.total_inc_gst::text in ('NaN','Infinity','-Infinity') or f.total_inc_gst < 0
    or f.deposit_pct is null or f.deposit_pct::text in ('NaN','Infinity','-Infinity')
    or f.deposit_pct < 1 or f.deposit_pct > 90 then raise exception 'Stored quote pricing required'; end if;
  total_cents := f.total_inc_gst * 100;
  if total_cents <> round(total_cents) or total_cents > 9007199254740991 then raise exception 'Exact stored cents required'; end if;
  -- Match the canonical JS money helper: it rounds the valid saved percentage
  -- for arithmetic; preserve the original stored percentage on the child.
  deposit_cents := greatest(0,round(total_cents * round(f.deposit_pct) / 100)-9900);
  if (f.paid_tier='credit' and deposit_cents>=50) or (f.paid_tier='deposit' and deposit_cents<50) then
    raise exception 'Final deposit settlement does not match its amount';
  end if;
  balance_cents := total_cents-9900-deposit_cents;
  if balance_cents < 50 or balance_cents is distinct from p_balance_cents::numeric then
    raise exception 'Balance amount changed or nothing to charge';
  end if;
  -- Lock every historical child, including paid ones. A partial unpaid unique
  -- index alone permits a second charge after the first child settles.
  perform 1 from quotes where parent_quote_id=f.id and quote_kind='balance' order by id for update;
  select count(*) into child_count from quotes where parent_quote_id=f.id and quote_kind='balance';
  if child_count > 1 then raise exception 'Balance history needs review'; end if;
  select * into b from quotes where parent_quote_id=f.id and quote_kind='balance';
  if found then
    if b.tenant_id is distinct from p_tenant_id or b.intake_id is distinct from f.intake_id
      or b.total_inc_gst is distinct from balance_cents/100 or b.deposit_pct is distinct from f.deposit_pct
      or b.pricing_book_version_id is distinct from f.pricing_book_version_id
      or nullif(b.share_token,'') is null then raise exception 'Stored balance differs from settled final'; end if;
    return jsonb_build_object('quote',to_jsonb(b),'already',true,'paid',b.paid_at is not null);
  end if;
  if nullif(p_share_token,'') is null then raise exception 'Balance link required'; end if;
  insert into quotes(intake_id,tenant_id,quote_kind,parent_quote_id,share_token,status,sent_at,
    total_inc_gst,deposit_pct,needs_inspection,good,better,best,scope_of_works,scope_short,
    assumptions,estimated_timeframe,gst_note,display_mode,stripe_links,price_hold_until,pricing_book_version_id)
  values(f.intake_id,p_tenant_id,'balance',f.id,p_share_token,'draft',null,
    balance_cents/100,f.deposit_pct,false,null,null,null,f.scope_of_works,f.scope_short,
    f.assumptions,f.estimated_timeframe,f.gst_note,f.display_mode,'{}',null,f.pricing_book_version_id)
  returning * into b;
  return jsonb_build_object('quote',to_jsonb(b),'already',false,'paid',false);
end $$;
revoke all on function public.prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text) from public,anon,authenticated;
grant execute on function public.prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text) to service_role;
