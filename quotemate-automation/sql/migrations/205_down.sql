drop trigger if exists generic_quote_delivery on public.sms_outbox;
drop function if exists public.reflect_generic_quote_delivery();
drop function if exists public.approve_generic_quote_release(uuid,uuid,text,jsonb,timestamptz,jsonb,text);
alter table public.quotes drop column if exists customer_released_by;
alter table public.quotes drop column if exists customer_released_at;
