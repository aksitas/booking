-- AKSITAS booking: new service "AI Workflow & Skills Gap Mini-Diagnostic" (60 minutes, Rp500.000).
-- Additive and safe to re-run; existing bookings are untouched.
alter type public.booking_service add value if not exists 'diagnostic';
