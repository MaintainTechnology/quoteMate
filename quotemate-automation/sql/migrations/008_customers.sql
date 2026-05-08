-- ════════════════════════════════════════════════════════════════════
-- Persistent customer memory — keyed by phone number across both
-- voice and SMS channels.
--
-- Goal: when a returning customer texts or calls, the agent looks them
-- up by phone number, greets them by name, and skips the universal
-- must-ask questions (name, suburb, address) for fields it already
-- knows. Mid-conversation updates (different name, new address) get
-- written back AFTER the workflow completes.
--
-- The customer_id FK on calls / sms_conversations / intakes lets us
-- aggregate every past interaction per customer for context.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  phone_number        text unique not null,           -- E.164, the lookup key
  first_name          text,
  full_name           text,                            -- best-known full name
  email               text,
  address             text,
  suburb              text,
  notes               text,                            -- free-form, tradie editable
  preferred_channel   text,                            -- 'voice' | 'sms' | null
  total_quotes        int  not null default 0,
  total_bookings      int  not null default 0,
  first_contacted_at  timestamptz not null default now(),
  last_contacted_at   timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Phone-number lookup is the hot path — every inbound SMS/call hits this.
create index if not exists customers_phone_idx on customers (phone_number);

-- FK columns on the existing source tables. Nullable so existing rows
-- (created before this feature) don't break. New rows always get linked.
alter table public.sms_conversations
  add column if not exists customer_id uuid references customers(id) on delete set null;

alter table public.calls
  add column if not exists customer_id uuid references customers(id) on delete set null;

alter table public.intakes
  add column if not exists customer_id uuid references customers(id) on delete set null;

create index if not exists sms_conversations_customer_idx on sms_conversations (customer_id);
create index if not exists calls_customer_idx on calls (customer_id);
create index if not exists intakes_customer_idx on intakes (customer_id);

comment on table customers is
  'Persistent customer memory keyed by phone number. Populated automatically by the SMS + voice pipelines. Used by the dialog agents to greet by name and skip already-known fields.';
