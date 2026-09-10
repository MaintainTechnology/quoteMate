-- Roll back only this compatibility probe; leave all quote/payment data and
-- mobile-owned writer functions intact. Quoting readiness then fails closed.
begin;
drop function if exists public.sms_quote_chain_ready();
notify pgrst,'reload schema';
commit;
