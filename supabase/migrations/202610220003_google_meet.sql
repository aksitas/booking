-- AKSITAS booking: video calls moved from Zoom to Google Meet (created with the Calendar event).
-- Additive and safe to re-run. The old zoom_* columns are left in place (unused) so no data is dropped.
alter table public.bookings add column if not exists meeting_url text;
