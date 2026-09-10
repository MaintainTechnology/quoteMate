begin;
do $$ begin
  if exists(select 1 from public.plan_extractions where released_at is not null) then
    raise exception 'Cannot remove plan release guard while published plans exist';
  end if;
end $$;
drop trigger if exists sms_plan_quote_guard on public.plan_extractions;
drop trigger if exists sms_plan_quote_truncate_guard on public.plan_extractions;
drop function if exists public.guard_plan_quote_release();
drop function if exists public.guard_plan_quote_truncate();
drop function if exists public.sms_plan_quote_guard_ready();
notify pgrst,'reload schema';
commit;
