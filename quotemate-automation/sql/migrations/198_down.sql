-- Additive rollback intentionally preserves receipts, checkpoints and delivery
-- identities. Roll application back only after draining pending/running/retry
-- jobs on EVERY service; dropping this ledger would lose acknowledged messages.
do $$ begin
  if exists(select 1 from public.sms_work_jobs where status in ('pending','running','retry')) then
    raise exception 'SMS work remains outstanding; rollback refused';
  end if;
end $$;
-- Keep additive columns/functions for recorded recovery and compatibility.
