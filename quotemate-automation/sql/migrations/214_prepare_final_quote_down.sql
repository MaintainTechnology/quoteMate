begin;
drop function if exists public.prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid);
drop index if exists public.quotes_one_final_per_parent;
commit;
