-- ════════════════════════════════════════════════════════════════════
-- SMS photo parity with the Voice Agent.
--
-- Today the voice path issues a `photo_request_token` per call, sends
-- the customer an SMS with `${APP_URL}/upload/${token}`, and stores
-- uploaded photos on `calls.photo_urls`. The SMS Agent had no parallel
-- — customers could only attach MMS photos, with no proactive prompt.
-- This migration adds the same surface to sms_conversations so the SMS
-- Agent can issue an upload link mid-dialog, and so /upload/[token]
-- can resolve the token to either a call or an SMS conversation.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════

alter table sms_conversations
  add column if not exists photo_request_token   text,
  add column if not exists photo_request_sent_at timestamptz,
  add column if not exists photos_completed_at   timestamptz,
  add column if not exists photo_urls            jsonb not null default '[]'::jsonb;

-- Unique partial index — token uniqueness is what makes /upload/[token]
-- safe to resolve. NULL tokens (legacy rows) are allowed and skipped by
-- the partial predicate.
create unique index if not exists sms_conversations_photo_token_unique
  on sms_conversations (photo_request_token)
  where photo_request_token is not null;

-- Backfill tokens for existing open conversations so they can issue
-- upload links retroactively if the dialog hasn't finished. New
-- conversations get tokens at creation time in the inbound route.
update sms_conversations
   set photo_request_token = encode(gen_random_bytes(16), 'hex')
 where photo_request_token is null
   and status = 'open';
