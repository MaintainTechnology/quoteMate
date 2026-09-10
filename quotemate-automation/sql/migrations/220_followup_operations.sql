-- Explicit, durable follow-up intents. Apply only through the approved migration
-- workflow. No expiry: an uncertain phone call/SMS must never become a new send
-- merely because a local working draft expired. Provider/outbox logic is unchanged.
create table if not exists public.followup_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  request_id uuid not null,
  action text not null check(action in ('text','call','note')),
  target_kind text not null check(target_kind in ('quote','conversation')),
  target_id uuid not null,
  payload_hash text not null,
  payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','unknown','accepted','failed','complete')),
  history text not null default 'pending' check(history in ('pending','complete','not_applicable')),
  provider_sid text,
  outbox_id uuid references public.sms_outbox(id),
  event_id uuid,
  conversation_id uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(tenant_id,request_id)
);
alter table public.followup_operations enable row level security;
revoke all on public.followup_operations from anon,authenticated;
grant all on public.followup_operations to service_role;
create unique index if not exists followup_operation_provider_idx on public.followup_operations(provider_sid) where provider_sid is not null;

create or replace function public.followup_outbox_matches(op public.followup_operations,box public.sms_outbox)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select coalesce(op.action='text' and op.tenant_id=box.tenant_id
    and box.delivery_key='followup:'||op.tenant_id::text||':'||op.request_id::text
    and box.to_number=op.payload->>'to' and box.body=op.payload->>'text'
    and box.payload->>'to'=op.payload->>'to' and box.payload->>'from'=op.payload->>'from'
    and box.payload->>'text'=op.payload->>'text' and box.payload->>'tenantId'=op.tenant_id::text
    and box.audience='customer' and box.payload->>'audience'='customer',false)
$$;
create or replace function public.followup_outbox_accepted(box public.sms_outbox)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  -- A mere SID on a failed/unknown row is insufficient. Either the durable
  -- transport result proves acceptance, or a verified attempt-bound callback
  -- proves Twilio created the message (even if its eventual delivery failed).
  select coalesce(box.provider_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$' and (
    (box.result->>'ok'='true' and box.result->>'sid'=box.provider_sid)
    or box.provider_status in ('accepted','scheduled','queued','sending','sent','delivered','read','failed','undelivered','canceled')
  ),false)
$$;

create or replace function public.followup_operation_claim(
  p_tenant uuid,p_request uuid,p_action text,p_target_kind text,p_target uuid,p_hash text,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare op followup_operations; claimed boolean := false;
begin
  if p_target_kind='quote' then
    perform 1 from quotes where id=p_target and tenant_id=p_tenant for key share;
  elsif p_target_kind='conversation' and p_action in ('text','call') then
    perform 1 from sms_conversations where id=p_target and tenant_id=p_tenant for key share;
  else raise exception 'invalid_target' using errcode='22023'; end if;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  insert into followup_operations(tenant_id,request_id,action,target_kind,target_id,payload_hash,payload)
    values(p_tenant,p_request,p_action,p_target_kind,p_target,p_hash,p_payload)
    on conflict(tenant_id,request_id) do nothing returning * into op;
  claimed := found;
  if not claimed then
    select * into op from followup_operations where tenant_id=p_tenant and request_id=p_request for update;
    if op.action<>p_action or op.target_kind<>p_target_kind or op.target_id<>p_target or op.payload_hash<>p_hash then
      raise exception 'operation_conflict' using errcode='23505';
    end if;
  end if;
  return jsonb_build_object('claimed',claimed,'operation',to_jsonb(op));
end $$;

-- Called only after accepted evidence. All transcript/pin/event changes are one
-- transaction; a failed repair leaves history pending and can be repeated safely.
create or replace function public.followup_operation_repair(p_tenant uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare op followup_operations; convo uuid; box sms_outbox; event uuid; pin jsonb; preserve_context boolean;
begin
  select * into op from followup_operations where tenant_id=p_tenant and request_id=p_request for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if op.status not in ('accepted','complete') or op.history='complete' then return to_jsonb(op); end if;
  if op.target_kind='quote' then
    perform 1 from quotes where id=op.target_id and tenant_id=p_tenant for key share;
  else
    perform 1 from sms_conversations where id=op.target_id and tenant_id=p_tenant for key share;
  end if;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if op.action='text' then
    select * into box from sms_outbox where id=op.outbox_id and tenant_id=p_tenant;
    if not found or not followup_outbox_matches(op,box) or not followup_outbox_accepted(box) or box.provider_sid<>op.provider_sid then
      raise exception 'acceptance_unconfirmed' using errcode='22023';
    end if;
    if op.target_kind='conversation' then convo:=op.target_id;
    else
      -- Serialize only this tenant/customer thread selection; concurrent different
      -- follow-up intents must not create two new threads for the same customer.
      perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||(op.payload->>'to'),0));
      select id into convo from sms_conversations where tenant_id=p_tenant and from_number=op.payload->>'to'
        and conversation_type='customer_quote'
        order by last_message_at desc nulls last,id desc limit 1 for update;
    end if;
    pin:=op.payload->'pin';
    if pin is not null and pin<>'null'::jsonb then
      pin:=pin||jsonb_build_object('sent_at',op.accepted_at,'expires_at',op.accepted_at+interval '14 days');
    end if;
    if convo is null then
      insert into sms_conversations(tenant_id,from_number,to_number,conversation_type,status,last_message_at,followup_quote)
        values(p_tenant,op.payload->>'to',op.payload->>'from','customer_quote','open',op.accepted_at,pin) returning id into convo;
    else
      -- Repair appends historical evidence, never resumes an old receptionist
      -- flow over newer inbound activity. Equal pin times preserve the pin that
      -- already won, so a repair cannot flip between two same-time operations.
      select coalesce((followup_quote->>'sent_at')::timestamptz>=op.accepted_at,false)
        or coalesce(last_message_at>op.accepted_at,false) into preserve_context
        from sms_conversations where id=convo and tenant_id=p_tenant for update;
      update sms_conversations set status=case when not preserve_context and (last_message_at is null or last_message_at<=op.accepted_at) then 'open' else status end,
        last_message_at=greatest(last_message_at,op.accepted_at),updated_at=now(),
        followup_quote=case when op.target_kind='quote' and not preserve_context then pin else followup_quote end,
        roofing_state=case when op.target_kind='quote' and not preserve_context then null else roofing_state end,
        painting_state=case when op.target_kind='quote' and not preserve_context then null else painting_state end
        where id=convo and tenant_id=p_tenant;
    end if;
    insert into sms_messages(conversation_id,direction,body,twilio_message_sid,audience,to_number,tenant_id,outbox_id,delivery_status,created_at)
      values(convo,'outbound',box.body,box.provider_sid,'customer',box.to_number,p_tenant,box.id,box.status,op.accepted_at)
      on conflict(outbox_id) where outbox_id is not null do update set delivery_status=excluded.delivery_status;
  end if;
  if op.target_kind='quote' then
    event:=coalesce(op.event_id,gen_random_uuid());
    insert into quote_followup_events(id,tenant_id,quote_id,kind,outcome,summary,created_at)
      values(event,p_tenant,op.target_id,case when op.action='text' then 'sms' else 'call' end,
        case when op.action='text' then 'text_sent' else 'call_dialed' end,
        case when op.action='text' then 'SMS: '||left(op.payload->>'text',120)||case when length(op.payload->>'text')>120 then '…' else '' end else 'Outbound call placed' end,op.accepted_at)
      on conflict(id) do nothing;
  end if;
  update followup_operations set history='complete',status='complete',event_id=event,conversation_id=convo,updated_at=now()
    where id=op.id returning * into op;
  return to_jsonb(op);
end $$;

-- A provider acceptance transaction must survive an unavailable history table.
-- Repair runs in a nested subtransaction; its failure is visible as pending.
create or replace function public.followup_operation_try_repair(p_tenant uuid,p_request uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  begin perform followup_operation_repair(p_tenant,p_request);
  exception when others then null; end;
end $$;

create or replace function public.followup_outbox_evidence()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare op followup_operations; accepted boolean;
begin
  if new.delivery_key not like 'followup:%' then return new; end if;
  select * into op from followup_operations where tenant_id=new.tenant_id and action='text'
    and new.delivery_key='followup:'||tenant_id::text||':'||request_id::text for update;
  if not found or not followup_outbox_matches(op,new) then return new; end if;
  accepted:=followup_outbox_accepted(new);
  update followup_operations set outbox_id=new.id,provider_sid=case when accepted then coalesce(provider_sid,new.provider_sid) else provider_sid end,
    accepted_at=case when accepted then coalesce(accepted_at,now()) else accepted_at end,
    status=case when history='complete' then 'complete' when accepted or provider_sid is not null then 'accepted'
      when new.status in ('unknown','sending') then 'unknown' when new.status in ('failed','undelivered') then 'failed' else 'pending' end,
    updated_at=now()
    where id=op.id
    returning * into op;
  if found and op.provider_sid is not null then perform followup_operation_try_repair(op.tenant_id,op.request_id); end if;
  return new;
end $$;
drop trigger if exists followup_outbox_evidence on public.sms_outbox;
create trigger followup_outbox_evidence after insert or update on public.sms_outbox
for each row execute function public.followup_outbox_evidence();

create or replace function public.followup_call_finish(p_tenant uuid,p_request uuid,p_status text,p_sid text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare op followup_operations;
begin
  if p_status not in ('accepted','failed','unknown') or (p_status='accepted' and coalesce(p_sid,'') !~ '^CA[0-9a-fA-F]{32}$') then
    raise exception 'invalid_call_evidence' using errcode='22023';
  end if;
  update followup_operations set status=p_status,provider_sid=p_sid,
    accepted_at=case when p_status='accepted' then now() else null end,updated_at=now()
    where tenant_id=p_tenant and request_id=p_request and action='call' and status in ('pending','unknown') returning * into op;
  if not found then select * into op from followup_operations where tenant_id=p_tenant and request_id=p_request and action='call'; end if;
  if op.id is null then raise exception 'not_found' using errcode='P0002'; end if;
  perform followup_operation_try_repair(p_tenant,p_request);
  select * into op from followup_operations where id=op.id;
  return to_jsonb(op);
end $$;

create or replace function public.followup_note_commit(p_tenant uuid,p_request uuid,p_quote uuid,p_hash text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; op followup_operations; event uuid; note_text text;
begin
  if p_payload->>'outcome' not in ('left_voicemail','spoke','no_answer','wants_callback','not_interested','other')
    or length(coalesce(p_payload->>'note',''))>500 then raise exception 'invalid_note' using errcode='22023'; end if;
  result:=followup_operation_claim(p_tenant,p_request,'note','quote',p_quote,p_hash,p_payload);
  select * into op from followup_operations where tenant_id=p_tenant and request_id=p_request for update;
  if op.status='complete' then return to_jsonb(op); end if;
  event:=gen_random_uuid(); note_text:=nullif(btrim(p_payload->>'note'),'');
  insert into quote_followup_events(id,tenant_id,quote_id,actor_user_id,kind,outcome,summary,note)
    values(event,p_tenant,p_quote,(p_payload->>'actor')::uuid,'note',p_payload->>'outcome',p_payload->>'summary',note_text);
  if not coalesce((p_payload->>'preserveChase')::boolean,false) then
    update quotes set followed_up_at=now(),followup_note=coalesce(note_text,followup_note) where id=p_quote and tenant_id=p_tenant;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
  end if;
  update followup_operations set status='complete',history='complete',event_id=event,updated_at=now() where id=op.id returning * into op;
  return to_jsonb(op);
end $$;

revoke all on function public.followup_operation_claim(uuid,uuid,text,text,uuid,text,jsonb),public.followup_operation_repair(uuid,uuid),public.followup_operation_try_repair(uuid,uuid),public.followup_outbox_evidence(),public.followup_call_finish(uuid,uuid,text,text),public.followup_note_commit(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.followup_outbox_matches(public.followup_operations,public.sms_outbox),public.followup_outbox_accepted(public.sms_outbox) from public,anon,authenticated;
grant execute on function public.followup_operation_claim(uuid,uuid,text,text,uuid,text,jsonb),public.followup_operation_repair(uuid,uuid),public.followup_operation_try_repair(uuid,uuid),public.followup_call_finish(uuid,uuid,text,text),public.followup_note_commit(uuid,uuid,uuid,text,jsonb) to service_role;
