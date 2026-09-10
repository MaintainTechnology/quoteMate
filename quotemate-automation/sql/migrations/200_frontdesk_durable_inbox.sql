-- Durable provider receipt and routing jobs. Apply before front-desk v2 code.
create table if not exists public.sms_frontdesk_jobs (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  receipt_key text not null unique,
  from_number text not null,
  to_number text not null,
  payload jsonb not null,
  tenant_id uuid references public.tenants(id),
  trade text,
  decision jsonb,
  state text not null default 'pending' check (state in ('pending','processing','forwarded','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_owner uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sms_frontdesk_jobs_ready on public.sms_frontdesk_jobs(state,available_at,sequence);
create index if not exists sms_frontdesk_jobs_pair on public.sms_frontdesk_jobs(to_number,from_number,sequence);
alter table public.sms_frontdesk_jobs enable row level security;
revoke all on public.sms_frontdesk_jobs from anon, authenticated;
grant all on public.sms_frontdesk_jobs to service_role;
grant usage, select on sequence public.sms_frontdesk_jobs_sequence_seq to service_role;

-- Claim only the oldest unfinished turn for a customer/number pair. A failed
-- job is visible to operations and does not permanently block later enquiries.
create or replace function public.claim_sms_frontdesk_job(p_owner uuid)
returns setof public.sms_frontdesk_jobs language sql security definer set search_path=public as $$
  update sms_frontdesk_jobs j set state='processing', lease_owner=p_owner,
    lease_until=now()+interval '90 seconds', attempts=j.attempts+1, updated_at=now()
  where j.id=(
    select candidate.id from sms_frontdesk_jobs candidate
    where ((candidate.state='pending' and candidate.available_at<=now())
      or (candidate.state='processing' and candidate.lease_until<now()))
    and not exists (
      select 1 from sms_frontdesk_jobs earlier
      where earlier.to_number=candidate.to_number and earlier.from_number=candidate.from_number
      and earlier.sequence<candidate.sequence and earlier.state in ('pending','processing')
    ) order by candidate.sequence for update skip locked limit 1
  ) returning j.*;
$$;
revoke all on function public.claim_sms_frontdesk_job(uuid) from public,anon,authenticated;
grant execute on function public.claim_sms_frontdesk_job(uuid) to service_role;

-- Administrative recovery must be deliberate, authenticated and observable.
-- The original receipt key and job ID survive recovery, so forwarding is safe
-- even if a service accepted a previous request whose response was lost.
create or replace function public.retry_sms_frontdesk_job(p_id uuid)
returns boolean language sql security definer set search_path=public as $$
 with retried as (update sms_frontdesk_jobs set state='pending', attempts=0,
   available_at=now(), lease_owner=null, lease_until=null, updated_at=now()
   where id=p_id and state='failed' returning id) select exists(select 1 from retried);
$$;
revoke all on function public.retry_sms_frontdesk_job(uuid) from public,anon,authenticated;
grant execute on function public.retry_sms_frontdesk_job(uuid) to service_role;

-- Controlled end-to-end verification is independent of process liveness.
-- Evidence must identify the exact built release and actual tenant/tool.
create table if not exists public.sms_readiness_evidence (
  id uuid primary key default gen_random_uuid(),
  release_hash text not null,
  tenant_id uuid not null references public.tenants(id),
  trade text not null,
  tool text not null,
  passed boolean not null,
  evidence jsonb not null,
  verified_at timestamptz not null default now(),
  unique(release_hash,tenant_id,trade,tool)
);
alter table public.sms_readiness_evidence enable row level security;
revoke all on public.sms_readiness_evidence from anon, authenticated;
grant all on public.sms_readiness_evidence to service_role;
