-- AKSITAS booking: run expire_stale_bookings() every 5 minutes so a crashed or timed-out booking
-- never holds a slot for long (see 202610220002 for what the function releases vs. keeps).
-- Safe to re-run: cron.schedule with an existing job name updates that job instead of adding one.
create extension if not exists pg_cron;

select cron.schedule(
  'aksitas-expire-stale-bookings',
  '*/5 * * * *',
  $$select public.expire_stale_bookings()$$
);
