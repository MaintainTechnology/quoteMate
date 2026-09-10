drop table if exists public.sms_readiness_evidence;
drop function if exists public.retry_sms_frontdesk_job(uuid);
drop function if exists public.claim_sms_frontdesk_job(uuid);
drop table if exists public.sms_frontdesk_jobs;
