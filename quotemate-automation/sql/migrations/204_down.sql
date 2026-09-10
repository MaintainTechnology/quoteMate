-- Held successor rows and their customer tokens are retained intentionally.
-- Roll back application callers before removing these functions.
begin;
drop function if exists public.sms_owned_quote_revision_contract();
drop function if exists public.sms_revise_roof_owned(uuid,uuid,jsonb,jsonb);
drop function if exists public.sms_redraft_solar_owned(uuid,uuid,jsonb,jsonb,jsonb);
notify pgrst,'reload schema';
commit;
