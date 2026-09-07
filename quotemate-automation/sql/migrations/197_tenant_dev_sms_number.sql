-- ═══════════════════════════════════════════════════════════════════
-- Migration 197 — a second, development-only SMS number per tenant.
--
-- Why:
--   tenants.twilio_sms_number is a single text column, and
--   tenantByDestinationSms() resolves the tradie by matching it. That
--   makes one number per tenant a hard limit, so a developer cannot
--   point a spare Twilio number at a laptop without first stealing the
--   tenant's live number — which takes their production line down for
--   the duration.
--
--   This column is that spare slot. A tenant keeps its real number
--   working while a second number routes the same tenant's traffic to
--   a local dev machine.
--
-- Safety — read before assuming this is a production route:
--   The lookup that reads this column is gated on
--   NODE_ENV === 'development' (lib/tenant/lookup.ts). `npm run dev`
--   sets that; Vercel sets 'production' on BOTH production and preview
--   deploys. So a number in this column resolves on a developer's
--   machine and NOWHERE else. If someone later repoints that number at
--   the production webhook by mistake, it resolves to no tenant and the
--   line behaves as disconnected — it does not silently start quoting
--   as the tenant. Fail-safe by construction, and no new env var to
--   forget to set.
--
--   It is deliberately NOT unique-constrained against twilio_sms_number:
--   the dev lookup runs only after both production lookups miss, so a
--   value that collides with a live number can never win.
--
-- Idempotent: safe to run twice.
-- ═══════════════════════════════════════════════════════════════════

alter table public.tenants add column if not exists twilio_sms_number_dev text;

comment on column public.tenants.twilio_sms_number_dev is
  'Development-only second inbound SMS number. Resolved by tenantByDestinationSms only when NODE_ENV=development, after both production lookups miss. Never routes on Vercel (production or preview). Migration 197.';

-- Partial index: the dev lookup is an equality probe, and only the few
-- rows that actually carry a dev number are worth indexing.
create index if not exists tenants_twilio_sms_number_dev_idx
  on public.tenants (twilio_sms_number_dev)
  where twilio_sms_number_dev is not null;

notify pgrst, 'reload schema';
