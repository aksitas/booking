-- AKSITAS booking schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create type public.booking_status as enum ('processing','confirmed','failed','cancelled');
create type public.booking_service as enum ('coaching','consulting');

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  service public.booking_service not null,
  status public.booking_status not null default 'processing',
  full_name text not null check (char_length(full_name) between 2 and 120),
  email text not null check (char_length(email) <= 254),
  company text,
  role text,
  agenda text not null check (char_length(agenda) between 3 and 5000),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'Asia/Jakarta',
  google_event_id text,
  zoom_meeting_id text,
  zoom_join_url text,
  confirmation_sent_at timestamptz,
  idempotency_key text unique,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_positive_duration check (end_at > start_at),
  constraint confirmed_bookings_no_overlap exclude using gist (
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('processing','confirmed'))
);

create index bookings_start_at_idx on public.bookings(start_at);
create index bookings_status_created_idx on public.bookings(status, created_at desc);

alter table public.bookings enable row level security;
-- No public policies: browser clients cannot read/write bookings directly.
-- Edge Function uses the server-only service role key. Never expose it in the frontend.

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger bookings_touch_updated_at before update on public.bookings
for each row execute function public.touch_updated_at();

-- Optional admin view; only grant access through a separately authenticated admin backend.
