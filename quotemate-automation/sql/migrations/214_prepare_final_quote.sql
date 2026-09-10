-- One final quote for the lifetime of a paid inspection, including paid
-- children. Existing duplicate histories need operator review, never deletion.
begin;
do $$
declare duplicate_parents text;
begin
  select string_agg(parent_quote_id::text, ', ' order by parent_quote_id::text)
    into duplicate_parents from (
      select parent_quote_id from public.quotes where quote_kind='final'
        and parent_quote_id is not null group by parent_quote_id having count(*) > 1
      order by parent_quote_id limit 20
    ) duplicates;
  if duplicate_parents is not null then
    raise exception 'Cannot install final-quote lifetime uniqueness: review duplicate final children for parent IDs %', duplicate_parents;
  end if;
end $$;
create unique index quotes_one_final_per_parent on public.quotes(parent_quote_id)
  where quote_kind='final' and parent_quote_id is not null;

create function public.prepare_final_quote(
  p_parent_id uuid, p_tenant_id uuid, p_parent_snapshot jsonb,
  p_intake_snapshot jsonb, p_child jsonb default null,
  p_deposit_version_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.quotes; i public.intakes; f public.quotes;
  price_version public.quote_pricing_versions; deposit_version public.quote_pricing_versions;
  child_count integer; source jsonb; source_lines jsonb; good jsonb; expected_child jsonb;
  source_label text; selected text; subtotal numeric := 0; total numeric; tax numeric;
  line jsonb; quantity numeric; unit_price numeric; line_cents numeric; line_sum numeric := 0;
  has_price boolean := false; raw_pct jsonb; numeric_pct numeric; deposit_pct numeric := 30;
begin
  -- Matches prepare_balance_quote's root-first lock order. Root locking
  -- serializes all callers before inspecting paid AND unpaid child history.
  select * into r from public.quotes where id=p_parent_id and tenant_id=p_tenant_id for update;
  if not found or coalesce(r.quote_kind,'initial') <> 'initial' or r.parent_quote_id is not null
    or r.paid_at is null or r.paid_tier is distinct from 'inspection' then
    raise exception 'Owned paid inspection root required';
  end if;
  perform 1 from public.quotes where parent_quote_id=r.id and quote_kind='final' order by id for update;
  select count(*) into child_count from public.quotes where parent_quote_id=r.id and quote_kind='final';
  if child_count > 1 then raise exception 'Final quote history needs review'; end if;
  select * into i from public.intakes where id=r.intake_id and tenant_id=p_tenant_id for update;
  if not found or i.trade is null or lower(trim(i.trade)) not in ('electrical','plumbing') then
    raise exception 'Owned site visit intake required';
  end if;
  if p_parent_snapshot is null or p_intake_snapshot is null or
    to_jsonb(r) is distinct from p_parent_snapshot or to_jsonb(i) is distinct from p_intake_snapshot then
    raise exception 'Quote chain changed since review';
  end if;
  select * into f from public.quotes where parent_quote_id=r.id and quote_kind='final';
  if found then
    if f.tenant_id is distinct from p_tenant_id or f.intake_id is distinct from r.intake_id
      or nullif(trim(f.share_token),'') is null then raise exception 'Final quote history needs review'; end if;
    if f.paid_at is not null then return jsonb_build_object('status','final_already_paid'); end if;
    return jsonb_build_object('status','ready','quote',to_jsonb(f),'already',true);
  end if;
  -- Read-only probe lets an existing draft reopen without today's book.
  -- Creation always repeats the complete locked proof after version capture.
  if p_child is null then return jsonb_build_object('status','needs_creation'); end if;
  if jsonb_typeof(p_child) is distinct from 'object' or nullif(trim(p_child->>'share_token'),'') is null then
    raise exception 'Final quote candidate required';
  end if;
  select * into price_version from public.quote_pricing_versions where id=(p_child->>'pricing_book_version_id')::uuid;
  select * into deposit_version from public.quote_pricing_versions where id=p_deposit_version_id;
  if price_version.id is null or deposit_version.id is null
    or price_version.tenant_id is distinct from p_tenant_id or deposit_version.tenant_id is distinct from p_tenant_id
    or price_version.trade is distinct from i.trade or deposit_version.trade is distinct from i.trade
    or jsonb_typeof(price_version.snapshot->'gst_registered') is distinct from 'boolean' then
    raise exception 'Owned captured pricing versions required';
  end if;

  selected := case when r.selected_tier in ('good','better','best') then r.selected_tier else null end;
  source := coalesce(nullif(to_jsonb(r)->selected,'null'),nullif(r.better,'null'),nullif(r.good,'null'),nullif(r.best,'null'));
  if source is not null then
    if jsonb_typeof(source) is distinct from 'object' or jsonb_typeof(source->'subtotal_ex_gst') not in ('number','string')
      or nullif(trim(source->>'subtotal_ex_gst'),'') is null then raise exception 'Stored quote pricing required'; end if;
    subtotal := (source->>'subtotal_ex_gst')::numeric;
    if subtotal::text in ('NaN','Infinity','-Infinity') or subtotal < 0 or subtotal*100 <> round(subtotal*100)
      or subtotal*100 > 9007199254740991 then raise exception 'Exact stored cents required'; end if;
    source_label := nullif(trim(source->>'label'),'');
    source_lines := nullif(source->'line_items','null');
    if source_lines is not null and jsonb_typeof(source_lines) is distinct from 'array' then
      raise exception 'Stored line items required';
    end if;
  end if;
  has_price := subtotal > 0;
  if source_lines is not null and jsonb_array_length(source_lines) > 0 then
    for line in select value from jsonb_array_elements(source_lines) loop
      if jsonb_typeof(line) is distinct from 'object' or nullif(trim(line->>'description'),'') is null
        or jsonb_typeof(line->'quantity') not in ('number','string') or nullif(trim(line->>'quantity'),'') is null
        or jsonb_typeof(line->'unit_price_ex_gst') not in ('number','string') or nullif(trim(line->>'unit_price_ex_gst'),'') is null then
        raise exception 'Stored line pricing required';
      end if;
      quantity := (line->>'quantity')::numeric; unit_price := (line->>'unit_price_ex_gst')::numeric;
      if quantity::text in ('NaN','Infinity','-Infinity') or unit_price::text in ('NaN','Infinity','-Infinity')
        or quantity < 0 or unit_price < 0 then raise exception 'Stored line pricing required'; end if;
      -- Match JS Math.round(quantity * price * 100), including its existing
      -- IEEE-754 boundary behavior. Decimal NUMERIC rounding is different.
      line_cents := floor(quantity::double precision * unit_price::double precision * 100::double precision + 0.5::double precision)::numeric;
      if line ? 'total_ex_gst' then
        if jsonb_typeof(line->'total_ex_gst') not in ('number','string') or nullif(trim(line->>'total_ex_gst'),'') is null
          or (line->>'total_ex_gst')::numeric is distinct from line_cents/100 then
          raise exception 'Stored line amount differs from its quantity and price';
        end if;
      end if;
      line_sum := line_sum + line_cents;
      has_price := has_price or unit_price > 0;
    end loop;
    if line_sum <> subtotal*100 then raise exception 'Stored line totals differ from subtotal'; end if;
  elsif subtotal > 0 then
    source_lines := jsonb_build_array(jsonb_build_object('description',coalesce(source_label || ' — as quoted','Job as quoted'),
      'quantity',1,'unit','job','unit_price_ex_gst',subtotal));
  else
    source_lines := '[{"description":"Job as quoted — confirmed on site","quantity":1,"unit":"job","unit_price_ex_gst":0,"total_ex_gst":0}]';
  end if;
  if (has_price and price_version.id is distinct from r.pricing_book_version_id)
    or (not has_price and price_version.id is distinct from deposit_version.id) then
    raise exception 'Copied prices require their original captured version';
  end if;
  -- Resolve the established job-type/default policy from the captured book.
  -- Match resolveDepositPct/asMoneyNumber: strings use a parseFloat numeric
  -- prefix, and missing, nonnumeric or out-of-range settings fall back to 30.
  raw_pct := deposit_version.snapshot #> array['overlays','deposit_pct_by_job_type',trim(coalesce(i.job_type,''))];
  if raw_pct is null or raw_pct='null' then raw_pct := deposit_version.snapshot #> '{overlays,deposit_pct_by_job_type,default}'; end if;
  if raw_pct is not null and raw_pct <> 'null' then
    if jsonb_typeof(raw_pct) in ('number','string') then
      begin
        numeric_pct := (regexp_match(ltrim(raw_pct #>> '{}'), '^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)'))[1]::double precision;
        exception when invalid_text_representation or numeric_value_out_of_range then numeric_pct := null;
      end;
    end if;
    if numeric_pct::text not in ('NaN','Infinity','-Infinity') and numeric_pct between 1 and 90 then
      deposit_pct := floor(numeric_pct::double precision + 0.5::double precision);
    end if;
  end if;
  -- Preserve totalIncGstCents's multiply order and positive Math.round.
  total := floor(subtotal::double precision * case when (price_version.snapshot->>'gst_registered')::boolean
    then 1.1::double precision else 1::double precision end * 100::double precision + 0.5::double precision)::numeric/100;
  tax := total-subtotal;
  good := jsonb_build_object('label',coalesce(source_label,'Final quote'),'subtotal_ex_gst',subtotal,'line_items',source_lines);
  expected_child := jsonb_build_object(
    'intake_id',r.intake_id,'tenant_id',r.tenant_id,'pricing_book_version_id',price_version.id,
    'scope_of_works',r.scope_of_works,'scope_short',r.scope_short,'assumptions',coalesce(r.assumptions,'[]'),
    'risk_flags',coalesce(r.risk_flags,'[]'),'estimated_timeframe',r.estimated_timeframe,'gst_note',r.gst_note,
    'display_mode',r.display_mode,'optional_upsells',coalesce(r.optional_upsells,'[]'),
    'quote_kind','final','parent_quote_id',r.id,'share_token',p_child->>'share_token','deposit_pct',deposit_pct,
    'status','draft','needs_inspection',false,'inspection_reason',null,'selected_tier','good',
    'good',good,'better',null,'best',null,'subtotal_ex_gst',subtotal,'gst',tax,'total_inc_gst',total,
    'stripe_links','{}'::jsonb,'price_hold_until',null);
  if p_child is distinct from expected_child then raise exception 'Final quote candidate differs from locked authority'; end if;
  -- Explicit projection prevents caller-injected payment/release/document state.
  insert into public.quotes(intake_id,tenant_id,pricing_book_version_id,scope_of_works,scope_short,assumptions,risk_flags,
    estimated_timeframe,gst_note,display_mode,optional_upsells,quote_kind,parent_quote_id,share_token,deposit_pct,
    status,needs_inspection,inspection_reason,selected_tier,good,better,best,subtotal_ex_gst,gst,total_inc_gst,stripe_links,price_hold_until)
  values(r.intake_id,r.tenant_id,price_version.id,r.scope_of_works,r.scope_short,coalesce(r.assumptions,'[]'),coalesce(r.risk_flags,'[]'),
    r.estimated_timeframe,r.gst_note,r.display_mode,coalesce(r.optional_upsells,'[]'),'final',r.id,p_child->>'share_token',deposit_pct,
    'draft',false,null,'good',good,null,null,subtotal,tax,total,'{}',null) returning * into f;
  return jsonb_build_object('status','ready','quote',to_jsonb(f),'already',false);
end $$;
revoke all on function public.prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid) to service_role;
commit;
