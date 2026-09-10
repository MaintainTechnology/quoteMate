-- Remove only this guard, never saved resources or release evidence.
-- Published links require a replacement protection before rollback.
begin;
do $$ begin
  if exists(select 1 from public.paint_runs where released_at is not null) then
    raise exception 'Cannot remove commercial release guard while published runs exist';
  end if;
end $$;
drop trigger if exists sms_commercial_extraction_guard on public.plan_extractions;
drop trigger if exists sms_commercial_run_guard on public.paint_runs;
drop trigger if exists sms_commercial_extraction_truncate_guard on public.plan_extractions;
drop trigger if exists sms_commercial_run_truncate_guard on public.paint_runs;
drop function if exists public.sms_commercial_quote_guard_ready();
drop function if exists public.guard_commercial_quote_extraction();
drop function if exists public.guard_commercial_quote_run();
drop function if exists public.guard_commercial_quote_truncate();
commit;
