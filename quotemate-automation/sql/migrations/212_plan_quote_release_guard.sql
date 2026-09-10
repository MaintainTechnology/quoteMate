-- The public plan token reads the extraction itself. Once the owner releases
-- that row, editing it must not silently publish new quantities or prices.
-- Migration 201 locks this same row before approval, so the row mutation and
-- release serialize on one PostgreSQL row lock (no separate parent lock).
begin;

create or replace function public.guard_plan_quote_release()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if old.released_at is not null then
    if tg_op = 'DELETE' then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
    -- Cache backfill and worker fencing metadata do not change the reviewed
    -- result. All other fields, including future source/price fields, freeze.
    if (to_jsonb(new) - array['report_pdf_path','updated_at','sms_work_id','sms_work_owner'])
      is distinct from
       (to_jsonb(old) - array['report_pdf_path','updated_at','sms_work_id','sms_work_owner']) then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.guard_plan_quote_truncate()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public set row_security=off as $$
begin
  if exists(select 1 from public.plan_extractions where released_at is not null) then
    raise exception using errcode='QM001',message='released_quote_immutable';
  end if;
  return null;
end $$;

drop trigger if exists sms_plan_quote_guard on public.plan_extractions;
create trigger sms_plan_quote_guard before update or delete on public.plan_extractions
  for each row execute function public.guard_plan_quote_release();
drop trigger if exists sms_plan_quote_truncate_guard on public.plan_extractions;
create trigger sms_plan_quote_truncate_guard before truncate on public.plan_extractions
  for each statement execute function public.guard_plan_quote_truncate();

create or replace function public.sms_plan_quote_guard_ready()
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select not exists (
    select 1 from (values
      ('sms_plan_quote_guard','public.guard_plan_quote_release()',27),
      ('sms_plan_quote_truncate_guard','public.guard_plan_quote_truncate()',34)
    ) as required(trigger_name,function_name,event_type)
    left join pg_trigger t on t.tgrelid=to_regclass('public.plan_extractions') and t.tgname=required.trigger_name
    where t.oid is null or t.tgenabled not in ('O','A') or t.tgisinternal or
      t.tgfoid is distinct from to_regprocedure(required.function_name) or t.tgtype<>required.event_type or
      t.tgattr<>''::int2vector or t.tgqual is not null
  );
$$;
revoke all on function public.guard_plan_quote_release() from public,anon,authenticated;
revoke all on function public.guard_plan_quote_truncate() from public,anon,authenticated;
revoke all on function public.sms_plan_quote_guard_ready() from public,anon,authenticated;
grant execute on function public.sms_plan_quote_guard_ready() to service_role;
notify pgrst,'reload schema';
commit;
