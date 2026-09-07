-- ═══════════════════════════════════════════════════════════════════
-- Migration 197 DOWN — remove the development-only SMS number column.
--
-- Safe to run at any time. The column is read by exactly one code path
-- (tenantByDestinationSms, gated on NODE_ENV=development), and that path
-- is a last-resort fallback after both production lookups have already
-- missed. Dropping it therefore cannot affect any production routing —
-- it only stops developer machines resolving their spare number, which
-- then behaves as an unowned line again.
-- ═══════════════════════════════════════════════════════════════════

drop index if exists public.tenants_twilio_sms_number_dev_idx;

alter table public.tenants drop column if exists twilio_sms_number_dev;

notify pgrst, 'reload schema';
