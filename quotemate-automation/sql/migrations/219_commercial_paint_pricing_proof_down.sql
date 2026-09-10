-- Disable new price/save controls before rollback. Retain historical proofs
-- for saved quote recovery and audit; no data or quote is deleted.
begin;
drop function if exists public.save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb);
drop function if exists public.persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb);
drop function if exists public.commercial_paint_pricing_source(uuid,uuid,uuid);
notify pgrst,'reload schema';
commit;
