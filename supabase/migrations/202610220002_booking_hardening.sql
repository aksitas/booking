-- AKSITAS booking hardening. Additive and safe to re-run: no data is deleted or rewritten
-- except stale 'processing' holds, which the expiry function marks 'failed' (never deletes).

-- Least privilege: browsers never touch these tables directly; only the Edge Function
-- (service role) does. RLS already blocks anon/authenticated, revoking grants is defence in depth.
revoke all on table public.bookings from anon, authenticated;

-- Track progress of each external step so a crashed/timed-out run can be reconciled.
alter table public.bookings add column if not exists admin_notified_at timestamptz;
alter table public.bookings add column if not exists needs_reconciliation boolean not null default false;

create index if not exists bookings_processing_created_idx
  on public.bookings(created_at) where status = 'processing';
create index if not exists bookings_reconcile_idx
  on public.bookings(created_at) where needs_reconciliation;

-- A run that dies mid-way (function timeout, crash) would otherwise hold its slot forever,
-- because the exclusion constraint covers 'processing' rows. Holds older than max_age are:
--  * released (status 'failed') when the customer cannot have been emailed yet
--    (admin_notified_at is null; the internal notice always precedes the customer email),
--    flagged for reconciliation if a Zoom meeting or Google event may be orphaned;
--  * otherwise kept holding the slot and flagged, so a customer who may already hold
--    meeting details is never double-booked. A human resolves those.
create or replace function public.expire_stale_bookings(max_age interval default interval '10 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer; m integer;
begin
  update public.bookings
     set status = 'failed',
         failure_reason = coalesce(failure_reason, 'stale_processing_timeout'),
         needs_reconciliation = (zoom_meeting_id is not null or google_event_id is not null)
   where status = 'processing' and admin_notified_at is null and created_at < now() - max_age;
  get diagnostics n = row_count;
  update public.bookings
     set needs_reconciliation = true,
         failure_reason = coalesce(failure_reason, 'stale_after_notification')
   where status = 'processing' and admin_notified_at is not null
     and not needs_reconciliation and created_at < now() - max_age;
  get diagnostics m = row_count;
  return n + m;
end;
$$;

-- Fixed-window rate limiter. Keys are hashed by the Edge Function; no raw IPs are stored.
create table if not exists public.booking_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
alter table public.booking_rate_limits enable row level security;
revoke all on table public.booking_rate_limits from anon, authenticated;

-- Atomically counts one hit and returns true while the bucket is within its limit.
create or replace function public.booking_rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n integer;
begin
  insert into public.booking_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into n;
  -- Opportunistic cleanup of old windows (cheap, bounded by index).
  if random() < 0.01 then
    delete from public.booking_rate_limits where window_start < now() - interval '2 days';
  end if;
  return n <= p_max;
end;
$$;

revoke all on function public.expire_stale_bookings(interval) from public, anon, authenticated;
revoke all on function public.booking_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.expire_stale_bookings(interval) to service_role;
    grant execute on function public.booking_rate_limit_hit(text, integer, integer) to service_role;
  end if;
end $$;
