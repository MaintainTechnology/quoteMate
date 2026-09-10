-- Local rollback only. Removing receipts loses duplicate protection: stop job
-- drafting and retain/export receipts before an authorised production rollback.
begin;
drop function if exists public.claim_job_quote_operation(uuid, uuid, text, boolean);
drop table if exists public.job_quote_operations;
drop function if exists public.guard_job_quote_operation_identity();
commit;
