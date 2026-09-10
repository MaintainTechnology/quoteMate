-- Durable carrier intent and receipt ledger. Apply 198 before this migration.
-- Network outcomes are at-most-one automatic attempt after ambiguity, not fictional exactly-once delivery.
create table if not exists public.sms_outbox (
  id uuid primary key default gen_random_uuid(),
  delivery_key text not null unique,
  payload_hash text not null,
  payload jsonb not null,
  tenant_id uuid references public.tenants(id),
  turn_id uuid,
  conversation_id uuid references public.sms_conversations(id),
  body text not null,
  to_number text not null,
  audience text not null default 'customer' check (audience in ('customer','tradie')),
  status text not null default 'pending' check (status in ('pending','retry','sending','accepted','delivered','failed','undelivered','unknown')),
  provider_sid text unique,
  provider_status text,
  provider_error text,
  attempt_token uuid,
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  requires_attention boolean not null default false,
  result jsonb,
  sms_work_id uuid,
  sms_work_owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sms_outbox_due on public.sms_outbox(next_attempt_at) where status in ('pending','retry','sending');
create index if not exists sms_outbox_turn on public.sms_outbox(turn_id, created_at, id);
create index if not exists sms_outbox_attention on public.sms_outbox(tenant_id,updated_at) where requires_attention;
alter table public.sms_outbox enable row level security;
revoke all on public.sms_outbox from anon, authenticated;
grant all on public.sms_outbox to service_role;
drop trigger if exists sms_outbox_work_fence on public.sms_outbox;
create trigger sms_outbox_work_fence before insert or update on public.sms_outbox
  for each row execute function public.guard_sms_work_write();

alter table public.sms_messages add column if not exists outbox_id uuid references public.sms_outbox(id);
alter table public.sms_messages add column if not exists turn_id uuid;
alter table public.sms_messages add column if not exists delivery_status text;
create unique index if not exists sms_messages_outbox_once on public.sms_messages(outbox_id) where outbox_id is not null;
update sms_messages set delivery_status=case when nullif(twilio_message_sid,'') is not null then 'accepted' else 'unknown' end
  where direction='outbound' and delivery_status is null;

create or replace function public.classify_sms_outbound()
returns trigger language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox;
begin
  if new.direction<>'outbound' then return new; end if;
  select * into r from sms_outbox where id=new.outbox_id or
    (new.outbox_id is null and provider_sid=nullif(new.twilio_message_sid,'')) limit 1;
  if found then
    -- Compatibility writers must not duplicate an outbox-published reply.
    if new.outbox_id is null and exists(select 1 from sms_messages where outbox_id=r.id) then return null; end if;
    new.outbox_id=r.id; new.turn_id=r.turn_id; new.delivery_status=r.status;
  else
    new.delivery_status='unknown';
  end if;
  return new;
end $$;
drop trigger if exists sms_messages_delivery_evidence on public.sms_messages;
create trigger sms_messages_delivery_evidence before insert on public.sms_messages
  for each row execute function public.classify_sms_outbound();

create or replace function public.sms_outbox_enqueue(p_key text,p_payload jsonb,p_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox;
begin
  insert into sms_outbox(delivery_key,payload,payload_hash,tenant_id,turn_id,conversation_id,body,to_number,audience,sms_work_id,sms_work_owner)
  values(p_key,p_payload,p_hash,nullif(p_payload->>'tenantId','')::uuid,nullif(p_payload->>'turnId','')::uuid,
    nullif(p_payload->>'conversationId','')::uuid,p_payload->>'text',p_payload->>'to',coalesce(p_payload->>'audience','customer'),
    nullif(p_payload->>'workId','')::uuid,nullif(p_payload->>'workOwner','')::uuid)
  on conflict(delivery_key) do nothing;
  select * into r from sms_outbox where delivery_key=p_key;
  if r.payload_hash<>p_hash then raise exception 'SMS idempotency key payload mismatch'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.sms_outbox_claim(p_id uuid,p_attempt uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox;
begin
  -- Expired sending does not imply rejection: never automatically retry it.
  update sms_outbox set status='unknown',requires_attention=true,updated_at=now()
    where id=p_id and status='sending' and lease_until<now();
  update sms_outbox set status='sending',attempt_token=p_attempt,attempts=attempts+1,
    lease_until=now()+interval '2 minutes',updated_at=now()
    where id=p_id and status in ('pending','retry') and next_attempt_at<=now() and attempts<5
    returning * into r;
  if not found then return null; end if;
  return to_jsonb(r);
end $$;

create or replace function public.sms_outbox_publish(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox;
begin
  select * into r from sms_outbox where id=p_id;
  if r.status not in ('accepted','delivered') then
    update sms_messages set delivery_status=r.status where outbox_id=r.id;
    return;
  end if;
  if r.audience='customer' and r.conversation_id is null then return; end if;
  -- Owner alerts are not part of the customer's model transcript.
  insert into sms_messages(conversation_id,direction,body,twilio_message_sid,audience,to_number,tenant_id,outbox_id,turn_id,delivery_status)
  values(case when r.audience='tradie' then null else r.conversation_id end,'outbound',r.body,
    r.provider_sid,r.audience,r.to_number,r.tenant_id,r.id,r.turn_id,r.status)
  on conflict(outbox_id) where outbox_id is not null do update set
    delivery_status=excluded.delivery_status,twilio_message_sid=excluded.twilio_message_sid;
end $$;

create or replace function public.sms_outbox_finish(p_id uuid,p_attempt uuid,p_status text,p_result jsonb,p_sid text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox;
begin
  select * into r from sms_outbox where id=p_id and attempt_token=p_attempt for update;
  if not found then return null; end if;
  -- A signed receipt may win the race with the original POST response.
  if r.status in ('delivered','undelivered','failed') and r.provider_status is not null then
    return to_jsonb(r);
  end if;
  update sms_outbox set status=case when p_status='retry' and attempts>=5 then 'failed' else p_status end,
    provider_sid=coalesce(provider_sid,p_sid),result=p_result,
    requires_attention=p_status in ('failed','undelivered','unknown') or (p_status='retry' and attempts>=5),
    next_attempt_at=now()+make_interval(secs=>least(300,attempts*30)),lease_until=null,updated_at=now()
    where id=p_id;
  perform sms_outbox_publish(p_id);
  select * into r from sms_outbox where id=p_id;
  return to_jsonb(r);
end $$;

create or replace function public.sms_outbox_receipt(p_id uuid,p_attempt uuid,p_sid text,p_status text,p_error text)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.sms_outbox; next_status text; old_rank integer; new_rank integer;
begin
  select * into r from sms_outbox where id=p_id and attempt_token=p_attempt for update;
  if not found or (r.provider_sid is not null and r.provider_sid<>p_sid) then return false; end if;
  if p_status not in ('accepted','scheduled','queued','sending','sent','delivered','read','failed','undelivered','canceled') then return false; end if;
  old_rank=case r.provider_status when 'delivered' then 6 when 'read' then 7 when 'failed' then 5 when 'undelivered' then 5 when 'canceled' then 5 when 'sent' then 4 when 'sending' then 3 when 'queued' then 2 else 1 end;
  new_rank=case p_status when 'delivered' then 6 when 'read' then 7 when 'failed' then 5 when 'undelivered' then 5 when 'canceled' then 5 when 'sent' then 4 when 'sending' then 3 when 'queued' then 2 else 1 end;
  if new_rank<old_rank then return true; end if;
  next_status=case when p_status in ('delivered','read') then 'delivered' when p_status='undelivered' then 'undelivered' when p_status in ('failed','canceled') then 'failed' else 'accepted' end;
  update sms_outbox set provider_sid=p_sid,provider_status=p_status,provider_error=p_error,status=next_status,
    requires_attention=next_status in ('failed','undelivered'),lease_until=null,updated_at=now() where id=p_id;
  perform sms_outbox_publish(p_id);
  return true;
end $$;

-- Only trusted backend processes can create sends or mutate signed receipt state.
revoke all on function public.sms_outbox_enqueue(text,jsonb,text),public.sms_outbox_claim(uuid,uuid),public.sms_outbox_publish(uuid),public.sms_outbox_finish(uuid,uuid,text,jsonb,text),public.sms_outbox_receipt(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.sms_outbox_enqueue(text,jsonb,text),public.sms_outbox_claim(uuid,uuid),public.sms_outbox_publish(uuid),public.sms_outbox_finish(uuid,uuid,text,jsonb,text),public.sms_outbox_receipt(uuid,uuid,text,text,text) to service_role;

-- One live upload request per tenant/customer, even for overlapping inbound requests.
create or replace function public.sms_plan_request(p_tenant uuid,p_from text,p_to text,p_body text,p_sid text,p_work uuid default null,p_owner uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.plan_upload_requests; c uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':plan:'||p_from,0));
  select * into r from plan_upload_requests where tenant_id=p_tenant and customer_phone=p_from
    and status in ('awaiting_upload','analysing','failed') and expires_at>now()
    order by created_at desc limit 1 for update;
  c=r.sms_conversation_id;
  if c is null then
    insert into sms_conversations(from_number,to_number,status,conversation_type,tenant_id,sms_work_id,sms_work_owner)
      values(p_from,p_to,'done','plan_estimation',p_tenant,p_work,p_owner) returning id into c;
  end if;
  if r.id is null then
    insert into plan_upload_requests(token,tenant_id,sms_conversation_id,customer_phone,twilio_number,status)
      values(replace(gen_random_uuid()::text,'-',''),p_tenant,c,p_from,p_to,'awaiting_upload') returning * into r;
  elsif r.sms_conversation_id is null then
    update plan_upload_requests set sms_conversation_id=c,updated_at=now() where id=r.id returning * into r;
  end if;
  insert into sms_messages(conversation_id,direction,body,twilio_message_sid,sms_work_id,sms_work_owner)
    values(c,'inbound',p_body,p_sid,p_work,p_owner)
    on conflict(twilio_message_sid) where direction='inbound' and twilio_message_sid is not null do nothing;
  return to_jsonb(r);
end $$;
revoke all on function public.sms_plan_request(uuid,text,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sms_plan_request(uuid,text,text,text,text,uuid,uuid) to service_role;
notify pgrst,'reload schema';

create or replace function public.sms_outbox_retry(p_id uuid,p_tenant uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  -- Explicit authenticated owner recovery, only after definite non-delivery.
  -- Unknown/accepted outcomes and STOP recipients must never be blindly re-sent.
  update sms_outbox set status='retry',attempts=0,next_attempt_at=now(),requires_attention=false,
    provider_sid=null,provider_status=null,provider_error=null,result=null,updated_at=now()
    where id=p_id and tenant_id=p_tenant and status in ('failed','undelivered')
      and coalesce(provider_error,'')<>'21610'
      and coalesce(result->'smsAttempt'->>'code','')<>'21610';
  return found;
end $$;
revoke all on function public.sms_outbox_retry(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sms_outbox_retry(uuid,uuid) to service_role;
