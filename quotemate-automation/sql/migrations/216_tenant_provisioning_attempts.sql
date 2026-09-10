-- AUTH03/C02. A purchase attempt is never reclaimed after dispatch or a crash.
begin;
create table public.tenant_provisioning_attempts (
  tenant_id uuid primary key references public.tenants(id),
  operation_id uuid not null unique default gen_random_uuid(),
  state text not null default 'processing' check (state in ('processing','completed','unknown')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (state <> 'completed' or result is not null)
);
alter table public.tenant_provisioning_attempts enable row level security;
revoke all on public.tenant_provisioning_attempts from public, anon, authenticated;
grant select, update on public.tenant_provisioning_attempts to service_role;

create function public.claim_tenant_provisioning(p_tenant_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.tenants; receipt public.tenant_provisioning_attempts;
begin
  select * into strict t from public.tenants where id=p_tenant_id for update;
  select * into receipt from public.tenant_provisioning_attempts where tenant_id=p_tenant_id;
  if found then
    return jsonb_build_object('claimed',false,'operation',to_jsonb(receipt));
  end if;
  -- A legacy artifact might represent a paid purchase with a lost receipt.
  -- Its number shape cannot establish that it is fake or safe to replace.
  if nullif(btrim(t.twilio_sms_number),'') is not null
     or nullif(btrim(t.twilio_voice_number),'') is not null
     or nullif(btrim(t.twilio_number_sid),'') is not null
     or nullif(btrim(t.vapi_assistant_id),'') is not null then
    return jsonb_build_object('claimed',false,'operation',null);
  end if;
  insert into public.tenant_provisioning_attempts(tenant_id) values(p_tenant_id) returning * into receipt;
  return jsonb_build_object('claimed',true,'operation',to_jsonb(receipt));
end $$;
revoke all on function public.claim_tenant_provisioning(uuid) from public, anon, authenticated;
grant execute on function public.claim_tenant_provisioning(uuid) to service_role;

create function public.guard_tenant_provisioning_attempt() returns trigger
language plpgsql set search_path=public as $$
begin
  if (new.tenant_id,new.operation_id,new.created_at) is distinct from
     (old.tenant_id,old.operation_id,old.created_at) or old.state <> 'processing'
     or new.state not in ('completed','unknown') then
    raise exception 'provisioning attempt cannot be reclaimed or rewritten';
  end if;
  return new;
end $$;
create trigger tenant_provisioning_attempt_guard before update on public.tenant_provisioning_attempts
for each row execute function public.guard_tenant_provisioning_attempt();
revoke all on function public.guard_tenant_provisioning_attempt() from public, anon, authenticated;
commit;
