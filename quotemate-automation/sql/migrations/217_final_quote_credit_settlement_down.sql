-- Preserve settlement/payment and delivery evidence during rollback.
begin;
drop trigger if exists a_final_quote_credit on public.sms_outbox;
drop function if exists public.reflect_final_quote_credit();
drop function if exists public.settle_final_quote_credit(uuid,uuid);
-- quote_credit_settlements is retained intentionally as an accounting audit.
commit;
