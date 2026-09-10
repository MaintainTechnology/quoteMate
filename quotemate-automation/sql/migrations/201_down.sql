-- Deliberately retain saved quote keys, approval stamps and recovery tasks:
-- deleting them would resurrect duplicate estimates or erase owner work.
begin;
drop function if exists public.sms_customer_quote_references(uuid,text);
drop function if exists public.sms_save_solar_estimate(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid);
drop function if exists public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb);
notify pgrst,'reload schema';
commit;
