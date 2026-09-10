-- Website-only durable plan analysis. Apply after 198 and 201, before website code.
begin;
alter table public.sms_work_jobs drop constraint if exists sms_work_jobs_kind_check;
alter table public.sms_work_jobs add constraint sms_work_jobs_kind_check check(kind in ('inbound','intake','estimate','plan'));
alter table public.plan_upload_requests add column if not exists input_sha256 text,
  add column if not exists analysis_work_id uuid references public.sms_work_jobs(id),
  add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid;
alter table public.plan_extractions add column if not exists sms_source_key text,
  add column if not exists sms_work_id uuid, add column if not exists sms_work_owner uuid;
create unique index if not exists plan_extractions_sms_source_key on public.plan_extractions(sms_source_key);
create or replace trigger guard_sms_work_write before insert or update on public.plan_upload_requests
  for each row execute function public.guard_sms_work_write();
create or replace trigger guard_sms_work_write before insert or update on public.plan_extractions
  for each row execute function public.guard_sms_work_write();

-- Input metadata and work receipt commit together; content-addressed storage
-- prevents another upload from replacing bytes underneath an active worker.
create or replace function public.submit_sms_plan(p_request uuid,p_hash text,p_filename text,p_size bigint,p_path text,p_payload jsonb)
returns public.sms_work_jobs language plpgsql security definer set search_path=public as $$
declare r public.plan_upload_requests; j public.sms_work_jobs; upload_id uuid;
begin
  select * into r from plan_upload_requests where id=p_request for update;
  if not found then raise exception 'plan_request_missing' using errcode='P0002'; end if;
  if r.expires_at<clock_timestamp() then raise exception 'plan_request_expired' using errcode='22023'; end if;
  if p_hash is null or p_path is null or p_size is null or p_hash !~ '^[0-9a-f]{64}$' or p_path<>r.id::text||'/'||p_hash||'/plan.pdf' or p_size<5 or p_size>33554432 then
    raise exception 'invalid_plan_input' using errcode='22023';
  end if;
  if r.analysis_work_id is not null then
    select * into j from sms_work_jobs where id=r.analysis_work_id;
    if r.input_sha256=p_hash then return j; end if;
    if j.status in ('pending','running','retry') then raise exception 'plan_already_queued' using errcode='55000'; end if;
  end if;
  if r.status='complete' then raise exception 'plan_already_complete' using errcode='55000'; end if;
  insert into plan_uploads(tenant_id,filename,size_bytes,source,pdf_path)
    values(r.tenant_id,p_filename,p_size,'sms',p_path) returning id into upload_id;
  j := enqueue_sms_work('plan:'||r.id::text||':'||p_hash,'plan','plan:'||r.id::text,gen_random_uuid(),
    p_payload,r.tenant_id,'platform');
  update plan_upload_requests set status='analysing',error=null,plan_upload_id=upload_id,
    plan_extraction_id=null,input_sha256=p_hash,analysis_work_id=j.id,updated_at=clock_timestamp() where id=r.id;
  return j;
end $$;
revoke all on function public.submit_sms_plan(uuid,text,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.submit_sms_plan(uuid,text,text,bigint,text,jsonb) to service_role;
-- Recover legacy after()-only requests without reupload or network I/O. The
-- legacy version fingerprints the saved upload identity, not its PDF bytes.
-- Retire old upload producers before migration/resuming these jobs.
do $$ declare r public.plan_upload_requests; j public.sms_work_jobs; version text; saved_id uuid; begin
  for r in select * from plan_upload_requests where status in ('analysing','failed')
    and plan_upload_id is not null and analysis_work_id is null for update loop
    version:=encode(sha256(convert_to('legacy-plan:'||r.plan_upload_id::text,'UTF8')),'hex');
    select id into saved_id from plan_extractions where plan_upload_id=r.plan_upload_id and tenant_id=r.tenant_id
      order by case when id=r.plan_extraction_id then 0 else 1 end,created_at desc,id desc limit 1;
    j:=enqueue_sms_work('plan:'||r.id::text||':'||version,'plan','plan:'||r.id::text,gen_random_uuid(),
      jsonb_build_object('url','https://plan-worker.invalid/internal/plan-analysis','headers','{}'::jsonb,
        'body',jsonb_build_object('requestId',r.id,'inputHash',version)::text),r.tenant_id,'platform');
    update plan_upload_requests set input_sha256=version,analysis_work_id=j.id,plan_extraction_id=coalesce(saved_id,r.plan_extraction_id),
      status='analysing',updated_at=clock_timestamp() where id=r.id;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
