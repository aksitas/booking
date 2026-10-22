// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_SESSION_MS, createAdminRoutes, issueAdminToken, verifyAdminToken } from "../supabase/functions/booking-api/admin.ts";
import { type BookingRow, createHandler, type Deps } from "../supabase/functions/booking-api/booking.ts";

const NOW = new Date("2026-10-22T10:00:00Z"); // Thu 17:00 WIB
const ORIGIN = "https://aksitas.github.io";
const PASSWORD = "correct horse battery staple";
const ID = "11111111-2222-3333-4444-555555555555";

function setup(over: Partial<Deps["config"]> = {}) {
  const rows: BookingRow[] = [
    { id: ID, service: "consulting", status: "confirmed", full_name: "Klien Uji", email: "klien@example.com", company: null, role: null,
      agenda: "Strategi", start_at: "2026-10-29T02:00:00.000Z", end_at: "2026-10-29T03:00:00.000Z",
      google_event_id: "evt1", meeting_url: "https://meet.google.com/abc-defg-hij", created_at: "2026-10-22T09:00:00.000Z" },
    { id: "99999999-2222-3333-4444-555555555555", service: "coaching", status: "failed", full_name: "Gagal", email: "x@example.com", company: null, role: null,
      agenda: "x", start_at: "2026-10-30T02:00:00.000Z", end_at: "2026-10-30T02:45:00.000Z", created_at: "2026-10-22T09:30:00.000Z" },
  ];
  const deletedEvents: string[] = [], sent: { to: string; subject: string }[] = [];
  let loginHits = 0;
  const deps = {
    now: () => NOW,
    log: () => {},
    db: {
      async listBookings() { return rows.map((r) => ({ ...r })); },
      async getBooking(id: string) { return rows.find((r) => r.id === id) ?? null; },
      async update(id: string, patch: Record<string, unknown>) { Object.assign(rows.find((r) => r.id === id)!, patch); return true; },
    },
    calendar: { async deleteEvent(id: string) { deletedEvents.push(id); } },
    mail: { async send(m: { to: string; subject: string }) { sent.push(m); } },
    rateLimit: async (bucket: string) => (bucket.startsWith("admin-login") ? ++loginHits <= 5 : true),
    hash: async (v: string) => v,
    config: { allowedOrigins: [ORIGIN], notificationEmail: "team@aksitas.test", requireHuman: true, humanCheckConfigured: true, configured: {}, adminPassword: PASSWORD, ...over },
  } as unknown as Deps;
  const h = createHandler(deps, createAdminRoutes(deps));
  const call = (path: string, init: { method?: string; body?: unknown; token?: string; origin?: string } = {}) =>
    h(new Request(`https://x.supabase.co/functions/v1/booking-api/admin${path}`, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { origin: init.origin ?? ORIGIN, "content-type": "application/json", ...(init.token ? { "x-admin-token": init.token } : {}) },
    }));
  const login = async () => (await (await call("/login", { method: "POST", body: { password: PASSWORD } })).json()).token as string;
  return { rows, deletedEvents, sent, call, login };
}

test("admin: wrong password is 401, right password returns an 8-hour token", async () => {
  const s = setup();
  assert.equal((await s.call("/login", { method: "POST", body: { password: "nope" } })).status, 401);
  const r = await s.call("/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.expiresAt, new Date(NOW.getTime() + ADMIN_SESSION_MS).toISOString());
});

test("admin: login attempts are rate limited", async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) await s.call("/login", { method: "POST", body: { password: "nope" } });
  assert.equal((await s.call("/login", { method: "POST", body: { password: PASSWORD } })).status, 429);
});

test("admin: disabled without a strong ADMIN_PASSWORD, and only from the booking site", async () => {
  assert.equal((await setup({ adminPassword: "" }).call("/login", { method: "POST", body: { password: "" } })).status, 503);
  assert.equal((await setup({ adminPassword: "short" }).call("/login", { method: "POST", body: { password: "short" } })).status, 503);
  assert.equal((await setup().call("/login", { method: "POST", body: { password: PASSWORD }, origin: "https://evil.example" })).status, 403);
});

test("admin: tokens expire, are bound to the password, and cannot be forged", async () => {
  const { token } = await issueAdminToken(PASSWORD, NOW);
  assert.ok(await verifyAdminToken(PASSWORD, token, NOW));
  assert.ok(!(await verifyAdminToken(PASSWORD, token, new Date(NOW.getTime() + ADMIN_SESSION_MS + 1))), "expired");
  assert.ok(!(await verifyAdminToken("another long password", token, NOW)), "password changed → signed out");
  const [exp, sig] = token.split(".");
  assert.ok(!(await verifyAdminToken(PASSWORD, `${Number(exp) + 999999}.${sig}`, NOW)), "extended expiry rejected");
  const s = setup();
  assert.equal((await s.call("/bookings")).status, 401);
  assert.equal((await s.call("/bookings", { token: "garbage" })).status, 401);
});

test("admin: list hides failed attempts and shows price + payment deadline", async () => {
  const s = setup();
  const r = await s.call("/bookings", { token: await s.login() });
  const { bookings } = await r.json();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].priceLabel, "Rp500.000");
  assert.equal(bookings[0].paymentDeadline, "2026-10-23T09:00:00.000Z"); // created + 24h
  assert.equal(bookings[0].email, "klien@example.com");
});

test("admin: mark paid and undo", async () => {
  const s = setup();
  const token = await s.login();
  const paid = await (await s.call(`/bookings/${ID}/paid`, { method: "POST", token, body: { paid: true } })).json();
  assert.equal(paid.booking.paidAt, NOW.toISOString());
  assert.equal(s.rows[0].paid_at, NOW.toISOString());
  await s.call(`/bookings/${ID}/paid`, { method: "POST", token, body: { paid: false } });
  assert.equal(s.rows[0].paid_at, null);
});

test("admin: cancel removes the calendar event, frees the slot, and optionally emails the client", async () => {
  const s = setup();
  const token = await s.login();
  const r = await s.call(`/bookings/${ID}/cancel`, { method: "POST", token, body: { reason: "Belum bayar\r\nBcc: x", notify: true } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(s.deletedEvents, ["evt1"]);
  assert.equal(s.rows[0].status, "cancelled");
  assert.equal(s.rows[0].cancellation_reason, "Belum bayar Bcc: x");
  assert.ok(j.calendarRemoved && j.emailSent);
  assert.deepEqual(s.sent.map((m) => m.subject), ["Booking dibatalkan — AKSITAS Consulting"]);
  // Second cancel is refused instead of double-processing.
  assert.equal((await s.call(`/bookings/${ID}/cancel`, { method: "POST", token, body: {} })).status, 409);
});
