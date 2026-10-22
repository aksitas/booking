# AKSITAS Booking — production integration scaffold

This package upgrades the static prototype to a production-oriented booking flow:
- Supabase Postgres is the source of truth for reservations.
- Supabase Edge Function exposes live slots and booking endpoints.
- Google Calendar FreeBusy is checked before offering/confirming a slot.
- PostgreSQL exclusion constraint prevents overlapping in-app bookings.
- Zoom Server-to-Server OAuth creates the meeting.
- Resend sends customer confirmation and an internal notification.
- Order: reserve (DB) → re-check Google → Zoom → Google event → internal email → customer email → `confirmed`. Any failure before the customer email deletes the created Zoom meeting / Google event, tells the team to ignore the earlier notice, and marks the row `failed` (slot released).
- Abuse protection: Cloudflare Turnstile (fails closed if not configured), per-IP and per-email rate limits in Postgres, Origin allow-list on `POST /book`.
- Retries are idempotent: the browser sends an `Idempotency-Key`; a retried submission returns the original booking instead of a duplicate.
- Stale `processing` holds (crashed/timed-out runs) are released after 10 minutes unless the customer may already have been emailed; those are kept and flagged `needs_reconciliation`.

**No integration is active until you configure credentials, deploy, and run the verification checklist.** This is a deployable starter implementation, not a claim that AKSITAS credentials or provider accounts have already been connected.

## Architecture

`GitHub Pages frontend → Supabase Edge Function → Supabase Postgres + Google Calendar + Zoom + Resend`

Browser receives only Supabase publishable/anon key. Service-role key and all third-party secrets remain in Edge Function secrets.

## 1. Prerequisites
- GitHub repository and GitHub Pages enabled.
- Supabase project.
- Google Cloud project with Google Calendar API enabled.
- Google OAuth client and refresh token authorized for the calendar that should be checked/updated.
- Zoom account with Server-to-Server OAuth app and meeting scopes.
- Resend account and a verified sender domain.
- A real operational notification email for AKSITAS.

## 2. Create database schema
Apply both migrations in order (`supabase db push`, or paste each into SQL Editor):
1. `supabase/migrations/202610220001_booking_schema.sql` (skip if already applied)
2. `supabase/migrations/202610220002_booking_hardening.sql` (additive, safe to re-run; adds rate limiting, stale-hold expiry, reconciliation flags, revokes anon/authenticated grants)

The table includes a Postgres exclusion constraint over `tstzrange(start_at,end_at,'[)')`; two concurrent reservations cannot both occupy overlapping times while their status is `processing` or `confirmed`. RLS is enabled without public policies. The Edge Function uses the server-only service role.

## 3. Configure Google Calendar
1. In Google Cloud Console, create/select a project and enable Google Calendar API.
2. Configure OAuth consent screen and create an OAuth client.
3. Generate a refresh token with Calendar event and free/busy access for the Google account that owns the booking calendar. Use an OAuth tool/flow appropriate for your organization; do not paste tokens into frontend files.
4. Ensure the authorized account can read FreeBusy and create/delete events on `GOOGLE_CALENDAR_ID`. `primary` works only for the authorized user's primary calendar.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`.

OAuth scopes commonly required: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.freebusy`. Use least privilege consistent with the operations.

## 4. Configure Zoom
1. Create a Zoom Server-to-Server OAuth app in Zoom App Marketplace.
2. Activate the app and grant the scopes required to create, read, and delete meetings (for example meeting write/delete scopes supported by the account).
3. Set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.
4. Set `ZOOM_HOST_USER_ID` to the Zoom host user ID or email permitted by the app. `me` may not be accepted by all Zoom endpoints/account setups; test the actual host identifier.

Zoom meeting policy (waiting room, no join-before-host) is set in code. Review these defaults against AKSITAS policy.

## 5. Configure Resend email
1. Verify a sending domain in Resend.
2. Create an API key.
3. Set `RESEND_API_KEY`, `EMAIL_FROM` to a verified sender, and `BOOKING_NOTIFICATION_EMAIL` to the team inbox.
4. Test delivery to both customer and team. The code reports success only if the provider API accepts both emails; provider acceptance does not guarantee inbox placement.

## 6. Deploy the Edge Function
Install Supabase CLI, then from this directory:

```bash
supabase login
supabase projects list
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set --env-file .env.production
supabase functions deploy booking-api
```

Create `.env.production` locally from `.env.example`, fill values, and **never commit it**. `.gitignore` ignores `.env.*` except `.env.example`. Alternatively, add each secret in Dashboard → Edge Function Secrets. Supabase-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are normally available automatically; if the project uses new secret-key naming, adapt server initialization to the current Supabase project credentials and test.

`verify_jwt = false` is intentional for public customer booking. The handler validates payload and uses server-side secrets. Bot protection: create a Cloudflare Turnstile widget for the Pages hostname, set `TURNSTILE_SECRET_KEY` as a secret and the site key in `app.js`. Without the secret, `POST /book` returns 503 (fail closed) unless `ALLOW_UNVERIFIED_BOOKINGS=true` is set for a test project. Never expose the service-role key.

## 7. Configure frontend
In `app.js`, replace:
- `apiUrl` with `https://YOUR_PROJECT_REF.supabase.co/functions/v1/booking-api`
- `publishableKey` with the Supabase publishable key (or legacy anon key if your project still uses it).
- `turnstileSiteKey` with the Cloudflare Turnstile site key.

Only publishable/anon keys may be included in frontend code, and only because public table access is blocked by RLS and booking writes happen in the Edge Function.

Push `index.html`, `styles.css`, `app.js` to the GitHub Pages source root. If using a repo named `booking` in the `aksitas` account, likely URL is `https://aksitas.github.io/booking/`. Confirm Pages settings and test the exact deployed URL. Set `ALLOWED_ORIGIN` to that exact origin (no trailing path), e.g. `https://aksitas.github.io`; GitHub Pages project sites still have the origin `https://aksitas.github.io`.

## Local development and tests
Requires Node ≥ 22.18 (no npm dependencies).
- `npm test` — unit + HTTP tests of the booking core with fake providers (happy path, every failure path, concurrency, idempotency, validation, bot/rate-limit/origin checks).
- `npm run test:db` — creates a throwaway local PostgreSQL cluster (set `PG_BIN` to the Postgres `bin` folder), applies both migrations twice, races 20 overlapping inserts, checks stale-hold expiry, rate limiter and anon permissions. Never point it at a real database.
- `npm run dev` — serves the site at http://localhost:8787 with the real handler and fake Google/Zoom/email. Add `?fail=zoom|google|email` to simulate an outage on the next booking.

## API
- `GET /health` — readiness/configuration flags only, no secret values.
- `GET /slots?date=YYYY-MM-DD&service=coaching|consulting` — checks Google Calendar FreeBusy and overlapping DB bookings.
- `POST /book` — validates request, reserves DB interval, re-checks calendar, creates Zoom meeting + Google Calendar event, sends email and marks booking confirmed.

Example request:
```json
{
  "service": "coaching",
  "startAt": "2026-11-02T02:00:00.000Z",
  "fullName": "Test User",
  "email": "you@example.com",
  "company": "Example",
  "role": "Founder",
  "agenda": "Diskusi prioritas kuartal berikutnya"
}
```
`POST /book` requires an `Idempotency-Key` header (16–64 chars, `[A-Za-z0-9-]`) and a `captchaToken` field when Turnstile is enabled. Errors return `{ error, code }`; `code` is one of `slot_taken`, `in_progress`, `retry_new_key`, `integration_failed`, `rate_limited`, `captcha_failed`, `invalid_*`, `not_configured`.

`startAt` must be an ISO timestamp matching one of the offered slot starts. Availability uses Asia/Jakarta, weekdays, starts 09:00, 10:00, 11:00, 13:00, 14:00, 15:00, 16:00 WIB. Coaching is 45 minutes; consulting is 60 minutes. Change the schedule in `businessHoursFor()` and align front-end calendar limits if needed.

## Verification checklist — do this before announcing launch
1. Open `/health`; confirm `google`, `zoom`, and `email` all report `true`. This means secrets are present, not that provider credentials work.
2. Request a slot for a future weekday. Confirm the returned slots match the intended timezone and live calendar.
3. Book a test slot with an internal test email. Confirm a `confirmed` row, a Google Calendar event, a Zoom meeting and both emails.
4. Book the same slot from a second browser/session; expect HTTP 409 and no duplicate meeting.
5. Test a slot already occupied directly in Google Calendar; it must not be offered and the booking must be rejected if it becomes busy between display and submit.
6. Test invalid emails, past dates, weekends, invalid service, malformed timestamps, long inputs and repeated submissions.
7. Check Supabase function logs and provider logs.
8. Verify event deletion/compensation and manually reconcile any failed row. External API operations are not a distributed transaction; a crash between provider calls can leave an orphaned external event. Add a scheduled reconciliation job and alerting before high-volume production.
9. Review privacy notice, retention/deletion policy, consent language, and applicable Indonesian personal-data obligations.
10. Configure backups, monitoring, rate limiting, and admin-only cancellation/reschedule workflows before public scale.

## Current scope and known hardening work
Still required before launch: end-to-end tests with real provider accounts, admin cancellation/reschedule, a scheduled job (pg_cron) calling `expire_stale_bookings()` plus alerting on `needs_reconciliation`, and review of privacy/consent. A database row is reserved before external APIs are called; failures are marked `failed`, freeing the exclusion constraint. Supabase Edge Function runtime timeouts and provider outages must be tested. Use a durable job/queue orchestration if you need stronger recovery guarantees.

## Useful official documentation
- Supabase Edge Functions deploy: https://supabase.com/docs/guides/functions/deploy
- Supabase Edge Function secrets: https://supabase.com/docs/guides/functions/secrets
- Google Calendar FreeBusy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google Calendar API: https://developers.google.com/workspace/calendar/api/v3/reference
- Zoom Server-to-Server OAuth: https://godevelopers.zoom.us/docs/internal-apps/
- Resend Email API: https://resend.com/features/email-api
