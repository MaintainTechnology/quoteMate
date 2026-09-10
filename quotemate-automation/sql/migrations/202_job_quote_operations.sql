-- T02: one immutable, tenant-owned receipt per portal/native job draft.
-- This is a claim, not a retry queue: an abandoned claim is never reclaimed.
begin;

create table public.job_quote_operations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  intake_id uuid not null unique,
  status text not null default 'processing'
    check (status in ('processing', 'unknown', 'failed_no_commit', 'completed')),
  quote_id uuid references public.quotes(id),
  pinned boolean not null default false,
  pin_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, operation_id),
  check (status <> 'completed' or quote_id is not null),
  check (status <> 'failed_no_commit' or quote_id is null)
);
alter table public.job_quote_operations enable row level security;
revoke all on public.job_quote_operations from public, anon, authenticated;
grant select, insert, update on public.job_quote_operations to service_role;

create function public.guard_job_quote_operation_identity() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.tenant_id, new.operation_id, new.request_hash, new.intake_id, new.created_at)
     is distinct from
     (old.tenant_id, old.operation_id, old.request_hash, old.intake_id, old.created_at) then
    raise exception 'job quote operation identity is immutable';
  end if;
  if old.status in ('completed', 'failed_no_commit') and new is distinct from old then
    raise exception 'terminal job quote operation is immutable';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger job_quote_operation_identity before update on public.job_quote_operations
for each row execute function public.guard_job_quote_operation_identity();

create function public.claim_job_quote_operation(
  p_tenant_id uuid, p_operation_id uuid, p_request_hash text, p_pin_requested boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare receipt public.job_quote_operations; won boolean;
begin
  insert into public.job_quote_operations(tenant_id, operation_id, request_hash, intake_id, pin_requested)
  values (p_tenant_id, p_operation_id, p_request_hash, gen_random_uuid(), p_pin_requested)
  on conflict (tenant_id, operation_id) do nothing returning * into receipt;
  won := found;
  if not won then
    select * into strict receipt from public.job_quote_operations
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
  end if;
  return jsonb_build_object('claimed', won, 'operation', to_jsonb(receipt));
end $$;
revoke all on function public.claim_job_quote_operation(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_job_quote_operation(uuid, uuid, text, boolean) to service_role;
revoke all on function public.guard_job_quote_operation_identity() from public, anon, authenticated;
commit;
