begin;
drop function if exists public.delete_supported_quote(uuid,uuid,jsonb);
drop function if exists public.quote_deletion_permission(uuid,uuid);
commit;
