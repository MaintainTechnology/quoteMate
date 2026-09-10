-- Published commercial tenders read the latest priced extraction by run.
-- Keep that source and its public run identity immutable after release.
-- Migration 201's release operation locks the run before the extraction.
-- A concurrent extraction UPDATE already owns its row before this trigger:
-- PostgreSQL may abort a resulting deadlock; neither transaction may bypass
-- the guard. This is a safe abort, not a promise of lock-free concurrency.
begin;

create or replace function public.guard_commercial_quote_extraction()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public set row_security=off as $$
declare
  old_run uuid;
  new_run uuid;
  old_priced boolean := false;
  new_priced boolean := false;
  parent record;
  new_parent_owned boolean := false;
  old_parent_visible boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_run := old.paint_run_id;
    old_priced := old.priced_bom is not null;
  end if;
  if tg_op <> 'DELETE' then
    new_run := new.paint_run_id;
    new_priced := new.priced_bom is not null;
  end if;

  if tg_op = 'UPDATE' and
     new.id is not distinct from old.id and
     new.priced_bom is not distinct from old.priced_bom and
     new.priced_at is not distinct from old.priced_at and
     new.tenant_id is not distinct from old.tenant_id and
     new.paint_run_id is not distinct from old.paint_run_id then
    return new;
  end if;

  -- Ordinary plan extractions have no paint_run_id and retain their own
  -- release contract. A commercial result must belong to its actual run.
  for parent in
    select r.id,r.tenant_id,r.released_at from public.paint_runs r
    where r.id = any(array[old_run,new_run]) order by r.id for update
  loop
    if parent.id = old_run then old_parent_visible := true; end if;
    if old_priced and parent.id = old_run and parent.released_at is not null then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
    if new_priced and parent.id = new_run then
      new_parent_owned := parent.tenant_id = new.tenant_id;
      if parent.released_at is not null then
        raise exception using errcode='QM001',message='released_quote_immutable';
      end if;
    end if;
  end loop;

  -- ON DELETE CASCADE removes an unreleased parent before its children.
  -- The parent row guard already rejects deletion of a released run.
  if tg_op <> 'DELETE' and old_priced and old_run is not null and not old_parent_visible then
    raise exception using errcode='QM001',message='commercial_priced_parent_unavailable';
  end if;
  if new_priced and new_run is not null and not coalesce(new_parent_owned,false) then
    raise exception using errcode='QM001',message='commercial_priced_result_requires_owned_run';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.guard_commercial_quote_run()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if old.released_at is not null then
    if tg_op = 'DELETE' then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
    if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or
       new.public_token is distinct from old.public_token or new.released_at is distinct from old.released_at then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.guard_commercial_quote_truncate()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public set row_security=off as $$
begin
  -- Statement triggers cover removal paths that do not invoke row triggers.
  if tg_table_name = 'paint_runs' then
    if exists(select 1 from public.paint_runs where released_at is not null) then
      raise exception using errcode='QM001',message='released_quote_immutable';
    end if;
  elsif exists(select 1 from public.plan_extractions e join public.paint_runs r on r.id=e.paint_run_id
      where r.released_at is not null and e.priced_bom is not null) then
    raise exception using errcode='QM001',message='released_quote_immutable';
  end if;
  return null;
end $$;

drop trigger if exists sms_commercial_extraction_guard on public.plan_extractions;
create trigger sms_commercial_extraction_guard before insert or update or delete on public.plan_extractions
  for each row execute function public.guard_commercial_quote_extraction();
drop trigger if exists sms_commercial_run_guard on public.paint_runs;
create trigger sms_commercial_run_guard before update or delete on public.paint_runs
  for each row execute function public.guard_commercial_quote_run();
drop trigger if exists sms_commercial_extraction_truncate_guard on public.plan_extractions;
create trigger sms_commercial_extraction_truncate_guard before truncate on public.plan_extractions
  for each statement execute function public.guard_commercial_quote_truncate();
drop trigger if exists sms_commercial_run_truncate_guard on public.paint_runs;
create trigger sms_commercial_run_truncate_guard before truncate on public.paint_runs
  for each statement execute function public.guard_commercial_quote_truncate();

-- Read-only schema capability, including actual event coverage and whether
-- the expected trigger is enabled for ordinary application transactions.
create or replace function public.sms_commercial_quote_guard_ready()
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select not exists (
    select 1 from (values
      ('public.plan_extractions','sms_commercial_extraction_guard','public.guard_commercial_quote_extraction()',31),
      ('public.paint_runs','sms_commercial_run_guard','public.guard_commercial_quote_run()',27),
      ('public.plan_extractions','sms_commercial_extraction_truncate_guard','public.guard_commercial_quote_truncate()',34),
      ('public.paint_runs','sms_commercial_run_truncate_guard','public.guard_commercial_quote_truncate()',34)
    ) as required(table_name,trigger_name,function_name,event_type)
    left join pg_trigger t on t.tgrelid=to_regclass(required.table_name) and t.tgname=required.trigger_name
    where t.oid is null or t.tgenabled not in ('O','A') or t.tgisinternal or
      t.tgfoid is distinct from to_regprocedure(required.function_name) or t.tgtype<>required.event_type or
      t.tgattr<>''::int2vector or t.tgqual is not null
  );
$$;
revoke all on function public.guard_commercial_quote_extraction() from public,anon,authenticated;
revoke all on function public.guard_commercial_quote_run() from public,anon,authenticated;
revoke all on function public.guard_commercial_quote_truncate() from public,anon,authenticated;
revoke all on function public.sms_commercial_quote_guard_ready() from public,anon,authenticated;
grant execute on function public.sms_commercial_quote_guard_ready() to service_role;

notify pgrst,'reload schema';
commit;
