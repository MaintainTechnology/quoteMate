-- ════════════════════════════════════════════════════════════════════
-- 010 — AI sample-gallery columns on quotes
--
-- The customer-facing /q/[token] page already has an AI PREVIEW that
-- edits the customer's own uploaded photo. This migration adds a
-- second visual surface: 3 GENERIC sample images (text-to-image, not
-- based on the customer's photo) showing typical examples of the
-- proposed work.
--
-- Lifecycle states stored in samples_status mirror the preview ones:
--   idle         default; not yet attempted
--   generating   3 parallel Gemini calls in flight
--   ready        all 3 stored at sample_image_paths[0..2]
--   partial      ≥1 succeeded, ≥1 failed (still render the survivors)
--   failed       all 3 failed; section hidden
--
-- These samples are intentionally job-type generic — not customer-room
-- specific — so they're "examples of similar work", complementing the
-- room-specific preview above. Together the customer sees:
--   1. Photos they sent (the "before")
--   2. AI preview from their photo (their actual room, work done)
--   3. AI sample gallery (3 generic examples of similar work)
-- ════════════════════════════════════════════════════════════════════

alter table public.quotes
  add column if not exists sample_image_paths text[] not null default '{}',
  add column if not exists samples_status text not null default 'idle',
  add column if not exists samples_generated_at timestamptz,
  add column if not exists samples_error text;

comment on column public.quotes.samples_status is
  'Sample-gallery lifecycle: idle | generating | ready | partial | failed';

comment on column public.quotes.sample_image_paths is
  'Storage paths inside intake-photos bucket. Re-sign on render via refreshSignedUrl(). Up to 3 paths.';

create index if not exists quotes_samples_status_idx
  on public.quotes (samples_status, samples_generated_at desc)
  where samples_status in ('generating', 'failed', 'partial');
