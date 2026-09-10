-- Roll back only this preparation RPC. Existing balance/payment history remains.
drop function if exists public.prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text);
