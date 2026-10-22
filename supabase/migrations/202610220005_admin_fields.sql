-- AKSITAS booking: fields used by the admin page (manual payment check and cancellation).
-- Additive and safe to re-run; no existing data is changed.
alter table public.bookings add column if not exists paid_at timestamptz;
alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.bookings add column if not exists cancellation_reason text;
