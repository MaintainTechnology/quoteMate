-- ═══════════════════════════════════════════════════════════════════
-- QuoteMate · Database initialiser
-- Paste this entire file into Supabase SQL Editor and click Run.
--
-- Creates: 7 tables, the match_intakes function, the pgvector extension,
--          and seed data for the "easy 5" electrical jobs + AU pricing book.
--
-- This is idempotent on the function and seed inserts but NOT on table
-- creation. If you need to reset, drop tables manually first or run the
-- "RESET" block at the bottom of this file.
-- ═══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────
-- 1. Extensions
-- ──────────────────────────────────────────────
create extension if not exists vector;

-- ──────────────────────────────────────────────
-- 2. Lookup tables (read by Estimator tools)
-- ──────────────────────────────────────────────
create table if not exists shared_assemblies (
  id uuid primary key default gen_random_uuid(),
  trade text not null default 'electrical',
  name text not null,
  description text,
  default_unit text,
  default_unit_price_ex_gst numeric(10,2),
  default_labour_hours numeric(6,2),
  default_exclusions text,
  category text  -- explicit grounding category (migration 029); NULL → categorise() name regex
);

create table if not exists shared_materials (
  id uuid primary key default gen_random_uuid(),
  trade text not null default 'electrical',
  name text not null,
  brand text,
  unit text,
  default_unit_price_ex_gst numeric(10,2)
);

create table if not exists pricing_book (
  id uuid primary key default gen_random_uuid(),
  hourly_rate numeric(8,2) default 110,
  call_out_minimum numeric(8,2) default 150,
  apprentice_rate numeric(8,2) default 60,
  default_markup_pct numeric(5,2) default 28,
  risk_buffer_pct numeric(5,2) default 15,
  gst_registered boolean default true,
  licence_type text,
  licence_number text,
  licence_state text,
  licence_expiry date,
  overlays jsonb default '{}'::jsonb
);

-- ──────────────────────────────────────────────
-- 3. Pipeline tables (written by the AI engines)
-- ──────────────────────────────────────────────
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  vapi_call_id text unique,
  caller_number text,
  duration_seconds int,
  transcript text,
  recording_url text,
  photo_urls jsonb default '[]'::jsonb,
  ended_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists intakes (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  job_type text,
  address text,
  suburb text,
  scope jsonb,
  access jsonb,
  property jsonb,
  risks jsonb,
  inspection_required boolean default false,
  caller jsonb,
  timing jsonb,
  confidence text,
  confidence_reason text,
  embedding vector(1536),
  created_at timestamptz default now()
);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid references intakes(id) on delete cascade,
  status text default 'draft',

  scope_of_works text,
  assumptions jsonb default '[]'::jsonb,
  risk_flags jsonb default '[]'::jsonb,

  good jsonb,
  better jsonb,
  best jsonb,

  optional_upsells jsonb default '[]'::jsonb,
  estimated_timeframe text,
  needs_inspection boolean default false,
  inspection_reason text,
  gst_note text,

  selected_tier text default 'better',
  subtotal_ex_gst numeric(12,2),
  gst numeric(12,2),
  total_inc_gst numeric(12,2),

  created_at timestamptz default now(),
  sent_at timestamptz,
  accepted_at timestamptz,

  -- WP6 (migration 026): price-hold / urgency + post-deposit booking state.
  -- price_hold_until: when the quoted price stops being held (urgency).
  -- booking_state: null | 'reserved' (deposit paid) | 'booked' (slot chosen).
  price_hold_until timestamptz,
  booking_state text
);

create table if not exists quote_line_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references quotes(id) on delete cascade,
  tier text not null,
  description text not null,
  quantity numeric(10,2),
  unit text,
  unit_price_ex_gst numeric(10,2),
  total_ex_gst numeric(12,2),
  source text
);

-- ──────────────────────────────────────────────
-- 4. Similarity-search function (used by Stage 04)
-- ──────────────────────────────────────────────
create or replace function match_intakes(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (id uuid, scope jsonb, similarity float)
language sql stable as $$
  select id, scope, 1 - (embedding <=> query_embedding) as similarity
  from intakes
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ──────────────────────────────────────────────
-- 5. Seed data — only inserts if tables are empty
-- ──────────────────────────────────────────────
insert into shared_assemblies (trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions)
select * from (values
  ('electrical', 'Install LED downlight',                  'Cut hole, terminate, fit fixture, test',                  'each', 28.00, 0.40, 'Excludes new wiring runs and ceiling repair'),
  ('electrical', 'Replace double GPO',                     'Disconnect, remove old, fit new, test',                   'each', 22.00, 0.30, 'Excludes new circuit work'),
  ('electrical', 'Install customer-supplied ceiling fan',  'Mount, terminate to existing wiring, test',               'each', 35.00, 1.00, 'Excludes ceiling reinforcement and supply of fan'),
  ('electrical', 'Hardwire 240V smoke alarm',              'Mount, terminate, test interconnect',                     'each', 30.00, 0.50, 'Excludes ceiling penetrations beyond standard'),
  ('electrical', 'Install outdoor IP-rated LED light',     'Mount weatherproof fitting on existing circuit',          'each', 32.00, 0.60, 'Excludes new circuit and underground cabling')
) as v(trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions)
where not exists (select 1 from shared_assemblies);

insert into shared_materials (trade, name, brand, unit, default_unit_price_ex_gst)
select * from (values
  ('electrical', 'Basic LED downlight',              null::text,  'each', 28.00),
  ('electrical', 'Tri-colour LED downlight',         null::text,  'each', 48.00),
  ('electrical', 'Dimmable IP-rated downlight',      null::text,  'each', 72.00),
  ('electrical', 'Standard double GPO',              'Clipsal',   'each', 25.00),
  ('electrical', 'USB double GPO',                   'Clipsal',   'each', 70.00),
  ('electrical', 'Hardwired smoke alarm',            'Clipsal',   'each', 95.00),
  ('electrical', 'RCBO safety switch',               'Clipsal',   'each', 85.00),
  ('electrical', 'Sundries (terminals, wire, clips)', null::text, 'each', 50.00)
) as v(trade, name, brand, unit, default_unit_price_ex_gst)
where not exists (select 1 from shared_materials);

insert into pricing_book (hourly_rate, default_markup_pct, licence_type, licence_state)
select 110, 28, 'NECA', 'NSW'
where not exists (select 1 from pricing_book);

-- ═══════════════════════════════════════════════════════════════════
-- RESET BLOCK — uncomment and run only if you want to wipe everything
-- and start over from scratch.
-- ═══════════════════════════════════════════════════════════════════
-- drop table if exists quote_line_items cascade;
-- drop table if exists quotes cascade;
-- drop table if exists intakes cascade;
-- drop table if exists calls cascade;
-- drop table if exists pricing_book cascade;
-- drop table if exists shared_materials cascade;
-- drop table if exists shared_assemblies cascade;
-- drop function if exists match_intakes(vector, int);
