-- ════════════════════════════════════════════════════════════════════
-- Migration 030 — sms_conversations.followup_quote
--
-- Pins WHICH quote a manual follow-up text was about, so when the
-- customer replies the AI knows what "resend the quote" refers to.
--
-- Why a dedicated column (not conversation_state):
--   /api/sms/inbound persists slot extraction with
--     .update({ conversation_state: <clean {slots,sources,...}> })
--   which REPLACES the whole JSONB — anything stashed inside
--   conversation_state (like a follow-up pin) is wiped on the first
--   reply that extracts any slot. A separate column is immune to every
--   conversation_state rewrite (slot-merge, seeding, backfill), so the
--   pin survives the entire conversation.
--
-- Shape (jsonb, nullable): {
--   quote_id, share_token, job_label, total_inc_gst, tier,
--   quote_url, sent_at, expires_at
-- }  — see lib/sms/followup-context.ts
--
-- Idempotent + additive: nullable column, ADD COLUMN IF NOT EXISTS.
-- Safe to re-run; no backfill; existing rows get NULL (no pin).
-- ════════════════════════════════════════════════════════════════════

alter table sms_conversations
  add column if not exists followup_quote jsonb;

comment on column sms_conversations.followup_quote is
  'Migration 030: the specific quote a manual follow-up text was about (set by /api/tenant/followups/text, read by /api/sms/inbound). Lives OUTSIDE conversation_state so slot-merge writes never clobber it. Carries its own expires_at — stale pins are ignored.';
