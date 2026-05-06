-- ════════════════════════════════════════════════════════════════════
-- SMS hardening — prevent duplicate inbound rows from webhook retries.
--
-- Without this constraint, a Twilio retry (timeout, fallback URL config,
-- or any external retry trigger) could persist the same inbound message
-- twice and cause the SMS Agent to dispatch duplicate replies. The
-- application-layer idempotency check in app/api/sms/inbound/route.ts
-- handles the common case, but a partial unique index closes the
-- racy window where two retries land in the same millisecond.
--
-- Index is partial — only enforces uniqueness on inbound rows where the
-- SID is set. Outbound rows can still share SIDs across edge cases (e.g.
-- before Twilio assigns one); legacy rows without a SID are unaffected.
-- ════════════════════════════════════════════════════════════════════

create unique index if not exists sms_messages_unique_inbound_sid_idx
  on sms_messages (twilio_message_sid)
  where direction = 'inbound' and twilio_message_sid is not null;
