-- ════════════════════════════════════════════════════════════════════
-- Photo paths — persist storage paths (not signed URLs) so the public
-- /q/[token] quote page can re-sign on every render.
--
-- Background: signed URLs from `intake-photos` bucket expire after 24h.
-- Persisting only signed URLs means a customer revisiting their quote
-- two days later sees broken images. Storage paths are permanent —
-- re-signing via supabase.storage.createSignedUrl() is cheap and works
-- forever. Keeps photo_urls columns intact for vision-call backwards
-- compatibility (Sonnet/Opus consume URLs, not paths).
--
-- Columns added (all default to empty array, never null):
--   intakes.photo_paths            — aggregated path list, populated by
--                                     /api/intake/structure on insert.
--   calls.photo_paths              — voice-path photos, set by upload route.
--   sms_conversations.photo_paths  — SMS upload-link photos.
--   sms_messages.photo_paths       — per-message MMS attachments.
--
-- The /api/intake/structure handler aggregates paths from the per-channel
-- sources and writes them onto `intakes.photo_paths` so the quote page
-- has a single source of truth keyed by intake_id.
-- ════════════════════════════════════════════════════════════════════

alter table public.intakes
  add column if not exists photo_paths text[] not null default '{}';

alter table public.calls
  add column if not exists photo_paths text[] not null default '{}';

alter table public.sms_conversations
  add column if not exists photo_paths text[] not null default '{}';

alter table public.sms_messages
  add column if not exists photo_paths text[] not null default '{}';

comment on column public.intakes.photo_paths is
  'Storage paths in intake-photos bucket. Aggregated from upstream channels at structureIntake() time. Re-signed on demand by /q/[token].';
