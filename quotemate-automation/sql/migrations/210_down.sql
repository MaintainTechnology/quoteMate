-- Disable/drain platform plan jobs before rollback. Preserve historical receipts.
begin;
drop function if exists public.submit_sms_plan(uuid,text,text,bigint,text,jsonb);
drop trigger if exists guard_sms_work_write on public.plan_upload_requests;
drop trigger if exists guard_sms_work_write on public.plan_extractions;
-- Keep columns and the plan kind so existing work/audit evidence remains readable.
commit;
