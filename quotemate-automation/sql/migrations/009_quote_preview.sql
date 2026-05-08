-- ════════════════════════════════════════════════════════════════════
-- 009 — AI preview image columns on quotes
--
-- Adds the persistence layer for the Gemini-generated "what your job
-- could look like" image shown on /q/[token].
--
-- Lifecycle states stored in preview_status:
--   idle         default; not yet attempted
--   no_photos    customer hasn't uploaded any photos → no preview possible
--   generating   Gemini call in flight (atomic claim via UPDATE..WHERE)
--   ready        image stored at preview_image_path, render on quote page
--   failed       Gemini errored or storage write failed; section hidden
--
-- The customer's first uploaded photo (intakes.photo_paths[0]) is the
-- reference image fed to Gemini — preview is GENERATED FROM their
-- actual room, not a stock visualisation.
-- ════════════════════════════════════════════════════════════════════

alter table public.quotes
  add column if not exists preview_image_path text,
  add column if not exists preview_status text not null default 'idle',
  add column if not exists preview_generated_at timestamptz,
  add column if not exists preview_prompt text,
  add column if not exists preview_error text;

comment on column public.quotes.preview_status is
  'AI preview lifecycle: idle | no_photos | generating | ready | failed';

comment on column public.quotes.preview_image_path is
  'Storage path inside the intake-photos bucket. Re-sign on render via refreshSignedUrl().';

comment on column public.quotes.preview_prompt is
  'Full text prompt sent to Gemini — kept for debugging + iteration.';

-- Partial index for ops queries (find stuck-generating, recent failures).
create index if not exists quotes_preview_status_idx
  on public.quotes (preview_status, preview_generated_at desc)
  where preview_status in ('generating', 'failed');
