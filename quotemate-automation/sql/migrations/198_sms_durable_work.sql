-- Receipt, work ownership and durable stage checkpoints. Apply before code rollout.
create table if not exists public.sms_work_jobs (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  work_key text not null unique,
  kind text not null check (kind in ('inbound','intake','estimate','plan')),
  serial_key text not null,
  service_key text not null default 'platform',
  turn_id uuid not null,
  tenant_id uuid,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','running','retry','completed','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  owner_token uuid,
  lease_until timestamptz,
  checkpoint jsonb not null default '{}',
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists sms_work_ready on public.sms_work_jobs(status,available_at,sequence);
create index if not exists sms_work_serial on public.sms_work_jobs(serial_key,sequence) where status not in ('completed','failed');
alter table public.sms_work_jobs enable row level security;
revoke all on public.sms_work_jobs from anon, authenticated;
grant all on public.sms_work_jobs to service_role;
grant usage, select on sequence public.sms_work_jobs_sequence_seq to service_role;

create or replace function public.enqueue_sms_work(p_key text,p_kind text,p_serial_key text,p_turn_id uuid,p_payload jsonb,p_tenant_id uuid default null,p_service text default 'platform')
returns public.sms_work_jobs language plpgsql security definer set search_path=public as $$
declare j public.sms_work_jobs;
begin
  insert into sms_work_jobs(work_key,kind,serial_key,turn_id,payload,tenant_id,service_key,status,last_error)
  values(p_key,p_kind,p_serial_key,p_turn_id,p_payload,p_tenant_id,p_service,
    case when p_service='retired-platform' then 'failed' else 'pending' end,
    case when p_service='retired-platform' then 'Signed message reached retired webhook; route migration and message recovery required' else null end)
  on conflict(work_key) do nothing;
  select * into strict j from sms_work_jobs where work_key=p_key;
  if j.kind<>p_kind then raise exception 'work key contract mismatch'; end if;
  return j;
end $$;

create or replace function public.claim_sms_work(p_kinds text[],p_id uuid default null,p_lease_seconds integer default 90,p_service text default 'platform')
returns setof public.sms_work_jobs language plpgsql security definer set search_path=public as $$
declare j public.sms_work_jobs;
begin
  for j in select * from sms_work_jobs w
    where service_key=p_service and kind=any(p_kinds) and (p_id is null or id=p_id)
      and ((status in ('pending','retry') and available_at<=clock_timestamp()) or (status='running' and lease_until<clock_timestamp()))
    order by sequence for update skip locked
  loop
    -- The lock spans selection + claim, including two previously unseen messages.
    if not pg_try_advisory_xact_lock(hashtextextended(j.serial_key,0)) then continue; end if;
    if exists(select 1 from sms_work_jobs w where w.serial_key=j.serial_key and w.id<>j.id
      and w.status not in ('completed','failed') and (w.sequence<j.sequence or (w.status='running' and w.lease_until>clock_timestamp()))) then continue; end if;
    return query update sms_work_jobs set status='running',owner_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,300))),
      attempts=attempts+1,updated_at=clock_timestamp()
      where id=j.id returning *;
    return;
  end loop;
end $$;

create or replace function public.renew_sms_work(p_id uuid,p_owner uuid,p_lease_seconds integer default 90)
returns boolean language sql security definer set search_path=public as $$
  with changed as (update sms_work_jobs set lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,300))),updated_at=clock_timestamp()
  where id=p_id and owner_token=p_owner and status='running' and lease_until>clock_timestamp() returning id)
  select exists(select 1 from changed);
$$;
create or replace function public.assert_sms_work_owner(p_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.sms_work_jobs;
begin
  select * into j from sms_work_jobs where id=p_id for share;
  if not found or j.owner_token is distinct from p_owner or j.status<>'running' or j.lease_until<=clock_timestamp() then
    raise exception 'SMS work lease lost' using errcode='40001';
  end if;
  return true;
end $$;
create or replace function public.checkpoint_sms_work(p_id uuid,p_owner uuid,p_name text,p_value jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform assert_sms_work_owner(p_id,p_owner);
  update sms_work_jobs set checkpoint=jsonb_set(checkpoint,array[p_name],coalesce(p_value,'null'::jsonb),true),updated_at=clock_timestamp() where id=p_id and owner_token=p_owner;
  return true;
end $$;
create or replace function public.finish_sms_work(p_id uuid,p_owner uuid,p_result jsonb default null,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform assert_sms_work_owner(p_id,p_owner);
  update sms_work_jobs set status=case when p_error is null then 'completed' when attempts>=8 then 'failed' else 'retry' end,
    result=case when p_error is null then p_result else result end,last_error=left(p_error,1000),
    available_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(attempts,6))::integer)),
    completed_at=case when p_error is null then clock_timestamp() else null end,
    lease_until=null,owner_token=null,updated_at=clock_timestamp()
  where id=p_id and owner_token=p_owner;
  return true;
end $$;

-- Every worker mutation carries its attempt, verified in the SAME transaction
-- as the write. Holding SHARE prevents a successor claim racing this mutation.
create or replace function public.guard_sms_work_write() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.sms_work_id is not null then perform assert_sms_work_owner(new.sms_work_id,new.sms_work_owner); end if;
  -- Do not leave an expired attempt on a row later edited by an authenticated tradie.
  new.sms_work_id=null; new.sms_work_owner=null;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['sms_conversations','sms_messages','intakes','quotes'] loop
    execute format('alter table public.%I add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid',t);
    execute format('drop trigger if exists guard_sms_work_write on public.%I',t);
    execute format('create trigger guard_sms_work_write before insert or update on public.%I for each row execute function public.guard_sms_work_write()',t);
  end loop;
end $$;
alter table public.sms_conversations add column if not exists processing_owner uuid,
  add column if not exists quote_stage text,
  add column if not exists quote_id uuid,
  add column if not exists last_processed_work_sequence bigint;
alter table public.intakes add column if not exists sms_source_key text;
create unique index if not exists intakes_sms_source_key on public.intakes(sms_source_key);
alter table public.quotes add column if not exists estimate_request_key text;
create unique index if not exists quotes_estimate_request_key on public.quotes(estimate_request_key) where estimate_request_key is not null;

revoke all on function public.enqueue_sms_work(text,text,text,uuid,jsonb,uuid,text),public.claim_sms_work(text[],uuid,integer,text),public.renew_sms_work(uuid,uuid,integer),public.assert_sms_work_owner(uuid,uuid),public.checkpoint_sms_work(uuid,uuid,text,jsonb),public.finish_sms_work(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.enqueue_sms_work(text,text,text,uuid,jsonb,uuid,text),public.claim_sms_work(text[],uuid,integer,text),public.renew_sms_work(uuid,uuid,integer),public.assert_sms_work_owner(uuid,uuid),public.checkpoint_sms_work(uuid,uuid,text,jsonb),public.finish_sms_work(uuid,uuid,jsonb,text) to service_role;
