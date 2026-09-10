-- Keep durable purchase history on rollback; removing it permits duplicate purchases.
begin;
drop function if exists public.claim_tenant_provisioning(uuid);
commit;
