-- ════════════════════════════════════════════════════════════════════
-- Migration 052 — admin bulk loader: atomic commit + rollback
--                  (Phase 1 · spec §8 step 8, §9 rules 9/11/12/13/17)
--
-- The Approve button calls commit_import_batch(); the Roll-back button
-- calls rollback_import_batch(). Both are plpgsql functions, so each runs
-- in ONE implicit transaction — all-or-nothing, no LLM calls, INSERT/UPDATE
-- only (§9 rule 11). No staged data touches a live table until Approve.
--
-- Also adds the UNIQUE (trade, name) indexes the loader's NEW-vs-UPDATE
-- classification and the commit's UPDATE-by-name depend on. A
-- pg_constraint check on 2026-05-21 confirmed zero existing (trade,name)
-- duplicates in either table, so these cannot fail on current data.
--
-- ADDITIVE: new indexes + new functions. Changes no existing behaviour —
-- nothing calls these functions until the Phase 1 admin routes ship.
-- Apply with: node --env-file=.env.local scripts/run-migration-052.mjs
-- ════════════════════════════════════════════════════════════════════

-- 1. (trade, name) uniqueness — the loader treats it as the natural key.
create unique index if not exists shared_assemblies_trade_name_key
  on shared_assemblies (trade, name);
create unique index if not exists shared_materials_trade_name_key
  on shared_materials (trade, name);

-- 2. commit_import_batch — copy a staged batch into the live tables.
create or replace function commit_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_status    text;
  v_row       record;
  v_before    jsonb;
  v_new_id    uuid;
  v_inserts   jsonb := '[]'::jsonb;
  v_updates   jsonb := '[]'::jsonb;
  v_committed int  := 0;
  v_skipped   int  := 0;
begin
  -- Idempotency (§9 rule 12): re-running an already-committed batch is a
  -- no-op. The API idempotency_key dedups the request; this is the
  -- data-layer backstop. FOR UPDATE locks the batch against a concurrent
  -- commit.
  select status into v_status from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import batch % not found', p_batch_id;
  end if;
  if v_status = 'committed' then
    return jsonb_build_object('ok', true, 'already_committed', true);
  end if;
  if v_status <> 'staged' then
    raise exception 'batch % is %, only a staged batch can be committed',
      p_batch_id, v_status;
  end if;

  -- Only rows that passed validation AND passed/skipped smoke-test commit
  -- (§8 step 8). Smoke-failed rows are left in staging, untouched.
  for v_row in
    select * from import_staged_rows
     where batch_id = p_batch_id
       and validation_status = 'passed'
       and smoke_status in ('passed', 'skipped')
  loop
    if v_row.target_table = 'shared_assemblies' then
      if v_row.row_class = 'NEW' then
        insert into shared_assemblies
          (trade, name, description, default_unit, default_unit_price_ex_gst,
           default_labour_hours, default_exclusions, category,
           clarifying_questions, default_enabled)
        values
          (v_row.payload->>'trade',
           v_row.payload->>'name',
           v_row.payload->>'description',
           v_row.payload->>'default_unit',
           (v_row.payload->>'default_unit_price_ex_gst')::numeric,
           (v_row.payload->>'default_labour_hours')::numeric,
           v_row.payload->>'default_exclusions',
           v_row.payload->>'category',
           coalesce(v_row.payload->'clarifying_questions', '[]'::jsonb),
           (v_row.payload->>'default_enabled')::boolean)
        returning id into v_new_id;
        v_inserts := v_inserts ||
          jsonb_build_object('table', 'shared_assemblies', 'id', v_new_id);
      else
        select to_jsonb(sa.*) into v_before from shared_assemblies sa
          where sa.trade = v_row.payload->>'trade'
            and sa.name  = v_row.payload->>'name';
        if v_before is null then
          raise exception 'UPDATE target shared_assemblies (%, %) no longer exists',
            v_row.payload->>'trade', v_row.payload->>'name';
        end if;
        update shared_assemblies set
          description               = v_row.payload->>'description',
          default_unit              = v_row.payload->>'default_unit',
          default_unit_price_ex_gst = (v_row.payload->>'default_unit_price_ex_gst')::numeric,
          default_labour_hours      = (v_row.payload->>'default_labour_hours')::numeric,
          default_exclusions        = v_row.payload->>'default_exclusions',
          category                  = v_row.payload->>'category',
          clarifying_questions      = coalesce(v_row.payload->'clarifying_questions', '[]'::jsonb),
          default_enabled           = (v_row.payload->>'default_enabled')::boolean
         where trade = v_row.payload->>'trade'
           and name  = v_row.payload->>'name';
        v_updates := v_updates || jsonb_build_object(
          'table', 'shared_assemblies', 'id', v_before->>'id', 'before', v_before);
      end if;
      v_committed := v_committed + 1;

    elsif v_row.target_table = 'shared_materials' then
      if v_row.row_class = 'NEW' then
        insert into shared_materials
          (trade, name, brand, unit, default_unit_price_ex_gst)
        values
          (v_row.payload->>'trade',
           v_row.payload->>'name',
           v_row.payload->>'brand',
           v_row.payload->>'unit',
           (v_row.payload->>'default_unit_price_ex_gst')::numeric)
        returning id into v_new_id;
        v_inserts := v_inserts ||
          jsonb_build_object('table', 'shared_materials', 'id', v_new_id);
      else
        select to_jsonb(sm.*) into v_before from shared_materials sm
          where sm.trade = v_row.payload->>'trade'
            and sm.name  = v_row.payload->>'name';
        if v_before is null then
          raise exception 'UPDATE target shared_materials (%, %) no longer exists',
            v_row.payload->>'trade', v_row.payload->>'name';
        end if;
        update shared_materials set
          brand                     = v_row.payload->>'brand',
          unit                      = v_row.payload->>'unit',
          default_unit_price_ex_gst = (v_row.payload->>'default_unit_price_ex_gst')::numeric
         where trade = v_row.payload->>'trade'
           and name  = v_row.payload->>'name';
        v_updates := v_updates || jsonb_build_object(
          'table', 'shared_materials', 'id', v_before->>'id', 'before', v_before);
      end if;
      v_committed := v_committed + 1;

    else
      raise exception 'unknown target_table: %', v_row.target_table;
    end if;
  end loop;

  select count(*) into v_skipped from import_staged_rows
   where batch_id = p_batch_id
     and not (validation_status = 'passed'
              and smoke_status in ('passed', 'skipped'));

  -- changes holds the before-values of every UPDATE + the ids of every
  -- INSERT — everything rollback needs (§9 rule 9).
  update import_batches set
    status       = 'committed',
    committed_at = now(),
    changes      = jsonb_build_object('inserts', v_inserts, 'updates', v_updates)
   where id = p_batch_id;

  return jsonb_build_object(
    'ok', true, 'committed', v_committed, 'skipped', v_skipped);
end;
$$;

-- 3. rollback_import_batch — revert a committed batch from its before-values.
create or replace function rollback_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_status  text;
  v_changes jsonb;
  v_entry   jsonb;
  v_before  jsonb;
  v_used    int := 0;
  v_reverted int := 0;
  v_deleted  int := 0;
begin
  select status, changes into v_status, v_changes
    from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import batch % not found', p_batch_id;
  end if;
  if v_status = 'rolled_back' then
    return jsonb_build_object('ok', true, 'already_rolled_back', true);
  end if;
  if v_status <> 'committed' then
    raise exception 'batch % is %, only a committed batch can be rolled back',
      p_batch_id, v_status;
  end if;

  -- §9 rule 17 — rollback is blocked once a committed row has downstream
  -- usage. The checkable signal is a tenant_service_offerings row pointing
  -- at the assembly. (Quotes embed their numbers in jsonb with no FK back
  -- to the assembly — spec §11 — so a drafted quote cannot be detected
  -- here; the offerings check is the practical guard.)
  for v_entry in
    select * from jsonb_array_elements(v_changes->'inserts')
    union all
    select * from jsonb_array_elements(v_changes->'updates')
  loop
    if v_entry->>'table' = 'shared_assemblies' then
      select count(*) into v_used from tenant_service_offerings
        where assembly_id = (v_entry->>'id')::uuid;
      if v_used > 0 then
        raise exception
          'rollback blocked: shared_assemblies row % is now offered by a tenant — retire the service instead',
          v_entry->>'id';
      end if;
    end if;
  end loop;

  -- Revert UPDATEs to their captured before-values.
  for v_entry in select * from jsonb_array_elements(v_changes->'updates')
  loop
    v_before := v_entry->'before';
    if v_entry->>'table' = 'shared_assemblies' then
      update shared_assemblies set
        description               = v_before->>'description',
        default_unit              = v_before->>'default_unit',
        default_unit_price_ex_gst = (v_before->>'default_unit_price_ex_gst')::numeric,
        default_labour_hours      = (v_before->>'default_labour_hours')::numeric,
        default_exclusions        = v_before->>'default_exclusions',
        category                  = v_before->>'category',
        clarifying_questions      = v_before->'clarifying_questions',
        default_enabled           = (v_before->>'default_enabled')::boolean
       where id = (v_entry->>'id')::uuid;
    elsif v_entry->>'table' = 'shared_materials' then
      update shared_materials set
        brand                     = v_before->>'brand',
        unit                      = v_before->>'unit',
        default_unit_price_ex_gst = (v_before->>'default_unit_price_ex_gst')::numeric
       where id = (v_entry->>'id')::uuid;
    end if;
    v_reverted := v_reverted + 1;
  end loop;

  -- Delete the INSERTed rows.
  for v_entry in select * from jsonb_array_elements(v_changes->'inserts')
  loop
    if v_entry->>'table' = 'shared_assemblies' then
      delete from shared_assemblies where id = (v_entry->>'id')::uuid;
    elsif v_entry->>'table' = 'shared_materials' then
      delete from shared_materials where id = (v_entry->>'id')::uuid;
    end if;
    v_deleted := v_deleted + 1;
  end loop;

  update import_batches set status = 'rolled_back' where id = p_batch_id;

  return jsonb_build_object(
    'ok', true, 'reverted', v_reverted, 'deleted', v_deleted);
end;
$$;

notify pgrst, 'reload schema';
