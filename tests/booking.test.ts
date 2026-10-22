// Run: npm test  (Node >= 22.18 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { availableSlots, type BookingRow, createBooking, createHandler, type Deps, PublicError, validateBooking } from "../supabase/functions/booking-api/booking.ts";

// Thursday 2026-10-22 17:00 WIB. Next bookable day: Friday 2026-10-23.
const NOW = new Date("2026-10-22T10:00:00Z");
const FRI_0900 = "2026-10-23T02:00:00.000Z";
const ORIGIN = "https://aksitas.github.io";
const valid = (o: Record<string, unknown> = {}) => ({
  service: "coaching", startAt: FRI_0900, fullName: "Test User", email: "Test@Example.com",
  company: "Example", role: "Founder", agenda: "Diskusi prioritas", ...o,
});

type Fail = Partial<Record<"zoom" | "google" | "adminMail" | "customerMail" | "busy" | "finalUpdate", boolean>>;
function fakeDeps(fail: Fail = {}, opts: { busy?: { start: string; end: string }[] } = {}) {
  const rows: (BookingRow & { idempotency_key: string; [k: string]: unknown })[] = [];
  const calls: string[] = [];
  const events = new Set<string>(), meetings = new Set<string>();
  const sent: { to: string; subject: string }[] = [];
  let n = 0;
  const active = (r: BookingRow) => r.status === "processing" || r.status === "confirmed";
  const deps: Deps = {
    now: () => NOW,
    log: () => {},
    db: {
      async expireStale() {},
      async insertProcessing(row) {
        await Promise.resolve(); // yield, so concurrent callers interleave like real I/O
        // Mirrors the unique(idempotency_key) and exclusion constraints in the migration.
        if (rows.some((r) => r.idempotency_key === row.idempotency_key)) return { conflict: true };
        if (rows.some((r) => active(r) && new Date(r.start_at) < new Date(row.end_at) && new Date(r.end_at) > new Date(row.start_at)))
          return { conflict: true };
        const r = { ...row, id: `b${++n}`, status: "processing" as const };
        rows.push(r);
        return { row: { ...r } };
      },
      async findByIdempotencyKey(key) { return rows.find((r) => r.idempotency_key === key) ?? null; },
      async update(id, patch) {
        if (fail.finalUpdate && patch.status === "confirmed") return false;
        Object.assign(rows.find((r) => r.id === id)!, patch);
        return true;
      },
      async activeBetween() { return rows.filter(active).map((r) => ({ start: r.start_at, end: r.end_at })); },
    },
    calendar: {
      async busy() { calls.push("busy"); if (fail.busy) throw new Error("google down"); return opts.busy ?? []; },
      async createEvent() { calls.push("google"); if (fail.google) throw new Error("google 500"); const id = `g${++n}`; events.add(id); return id; },
      async deleteEvent(id) { calls.push("deleteGoogle"); events.delete(id); },
    },
    zoom: {
      async createMeeting() { calls.push("zoom"); if (fail.zoom) throw new Error("zoom 401"); const id = `z${++n}`; meetings.add(id); return { id, joinUrl: `https://zoom.us/j/${id}` }; },
      async deleteMeeting(id) { calls.push("deleteZoom"); meetings.delete(id); },
    },
    mail: {
      async send(m) {
        const kind = m.to === "team@aksitas.test" ? "adminMail" : "customerMail";
        calls.push(kind);
        if (fail[kind] && !m.subject.startsWith("DIBATALKAN")) throw new Error(`${kind} rejected`);
        sent.push({ to: m.to, subject: m.subject });
      },
    },
    verifyHuman: async (t) => t === "ok-token",
    rateLimit: async () => true,
    hash: async (v) => `h:${v}`,
    config: {
      allowedOrigins: [ORIGIN], notificationEmail: "team@aksitas.test", requireHuman: true,
      humanCheckConfigured: true, configured: {},
    },
  };
  return { deps, rows, calls, events, meetings, sent };
}
const KEY = "0123456789abcdef0123";

test("valid booking confirms with Zoom, Google event and both emails", async () => {
  const f = fakeDeps();
  const res = await createBooking(f.deps, valid(), KEY);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "confirmed");
  assert.match(res.body.joinUrl!, /^https:\/\/zoom\.us\/j\//);
  assert.equal(f.rows.length, 1);
  const row = f.rows[0];
  assert.equal(row.status, "confirmed");
  assert.equal(row.email, "test@example.com");
  assert.equal(row.end_at, "2026-10-23T02:45:00.000Z"); // coaching = 45 min
  assert.ok(row.zoom_meeting_id && row.google_event_id && row.confirmation_sent_at && row.admin_notified_at);
  assert.deepEqual(f.calls, ["busy", "zoom", "google", "adminMail", "customerMail"]);
  assert.deepEqual(f.sent.map((s) => s.to), ["team@aksitas.test", "test@example.com"]);
});

test("consulting is 60 minutes", async () => {
  const f = fakeDeps();
  await createBooking(f.deps, valid({ service: "consulting" }), KEY);
  assert.equal(f.rows[0].end_at, "2026-10-23T03:00:00.000Z");
});

for (const step of ["zoom", "google", "adminMail", "customerMail"] as const) {
  test(`failure at ${step} never reports success and cleans up`, async () => {
    const f = fakeDeps({ [step]: true });
    await assert.rejects(createBooking(f.deps, valid(), KEY), (e: PublicError) => e.status === 502);
    assert.equal(f.rows[0].status, "failed");
    assert.equal(f.events.size, 0, "no orphan Google event");
    assert.equal(f.meetings.size, 0, "no orphan Zoom meeting");
    assert.ok(!f.sent.some((s) => s.to === "test@example.com"), "customer never told it is confirmed");
    if (step === "customerMail") assert.ok(f.sent.some((s) => s.subject.startsWith("DIBATALKAN")), "team told to ignore earlier notice");
  });
}

test("slot that became busy in Google between display and submit is rejected (409)", async () => {
  const f = fakeDeps({}, { busy: [{ start: "2026-10-23T02:30:00Z", end: "2026-10-23T03:00:00Z" }] });
  await assert.rejects(createBooking(f.deps, valid(), KEY), (e: PublicError) => e.status === 409 && e.code === "slot_taken");
  assert.equal(f.rows[0].status, "failed");
  assert.ok(!f.calls.includes("zoom"));
});

test("two concurrent overlapping attempts: exactly one confirms", async () => {
  const f = fakeDeps();
  const results = await Promise.allSettled([
    createBooking(f.deps, valid({ email: "a@example.com" }), "aaaaaaaaaaaaaaaaaaaa"),
    createBooking(f.deps, valid({ email: "b@example.com", service: "consulting" }), "bbbbbbbbbbbbbbbbbbbb"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as PublicError).status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(f.rows.filter((r) => r.status === "confirmed").length, 1);
  assert.equal(f.meetings.size, 1);
});

test("retrying the same submission returns the original booking, no duplicates", async () => {
  const f = fakeDeps();
  const first = await createBooking(f.deps, valid(), KEY);
  const again = await createBooking(f.deps, valid(), KEY);
  assert.equal(again.status, 200);
  assert.equal(again.body.bookingId, first.body.bookingId);
  assert.equal(f.meetings.size, 1);
});

test("final DB update failure after customer email keeps slot held and still returns details", async () => {
  const f = fakeDeps({ finalUpdate: true });
  const res = await createBooking(f.deps, valid(), KEY);
  assert.equal(res.status, 201);
  assert.equal(f.rows[0].status, "processing"); // still blocks the slot; expiry flags it for reconciliation
  assert.ok(f.rows[0].admin_notified_at);
  assert.equal(f.meetings.size, 1);
});

test("server-side validation rejects bad input", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["weekend", { startAt: "2026-10-24T02:00:00.000Z" }],
    ["today/past", { startAt: "2026-10-22T09:00:00.000Z" }],
    ["off-grid time", { startAt: "2026-10-23T02:30:00.000Z" }],
    ["lunch hour", { startAt: "2026-10-23T05:00:00.000Z" }],
    [">60 days", { startAt: "2027-01-05T02:00:00.000Z" }],
    ["garbage time", { startAt: "tomorrow" }],
    ["bad email", { email: "nope@" }],
    ["header injection", { fullName: "A\r\nBcc: x@y.z" }],
    ["long agenda", { agenda: "x".repeat(5001) }],
    ["unknown service", { service: "therapy" }],
    ["non-string name", { fullName: { $ne: 1 } }],
  ];
  for (const [label, o] of bad) assert.throws(() => validateBooking(valid(o), NOW), PublicError, label);
});

test("slots exclude Google busy and DB bookings; Google outage is an error, not 'all free'", async () => {
  const f = fakeDeps({}, { busy: [{ start: "2026-10-23T03:00:00Z", end: "2026-10-23T04:00:00Z" }] });
  await createBooking(f.deps, valid(), KEY); // occupies 09:00
  const slots = await availableSlots(f.deps, "2026-10-23", "coaching");
  assert.deepEqual(slots.map((s) => s.label), ["11:00 WIB", "13:00 WIB", "14:00 WIB", "15:00 WIB", "16:00 WIB"]);
  assert.deepEqual(await availableSlots(f.deps, "2026-10-24", "coaching"), []); // Saturday
  await assert.rejects(availableSlots(f.deps, "2026-02-31", "coaching"), (e: PublicError) => e.status === 400);
  await assert.rejects(availableSlots(fakeDeps({ busy: true }).deps, "2026-10-23", "coaching"), (e: PublicError) => e.status === 503);
});

// ---------- HTTP handler ----------
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.supabase.co/functions/v1/booking-api/book", {
    method: "POST", body: JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json", "idempotency-key": KEY, "x-forwarded-for": "1.2.3.4", ...headers },
  });

test("HTTP: happy path, CORS echoes only the allowed origin", async () => {
  const h = createHandler(fakeDeps().deps);
  const r = await h(post(valid({ captchaToken: "ok-token" })));
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  const evil = await h(post(valid({ captchaToken: "ok-token" }), { origin: "https://evil.example" }));
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("HTTP: bot protection, rate limit and idempotency key are enforced", async () => {
  const f = fakeDeps();
  const h = createHandler(f.deps);
  assert.equal((await h(post(valid()))).status, 403); // no captcha token
  assert.equal((await h(post(valid({ captchaToken: "bad" })))).status, 403);
  assert.equal((await h(post(valid({ captchaToken: "ok-token" }), { "idempotency-key": "x" }))).status, 400);
  f.deps.rateLimit = async () => false;
  assert.equal((await h(post(valid({ captchaToken: "ok-token" })))).status, 429);
  assert.equal(f.rows.length, 0);
});

test("HTTP: missing Turnstile secret fails closed unless explicitly opted out", async () => {
  const f = fakeDeps();
  f.deps.config.humanCheckConfigured = false;
  assert.equal((await createHandler(f.deps)(post(valid()))).status, 503);
  f.deps.config.requireHuman = false;
  assert.equal((await createHandler(f.deps)(post(valid()))).status, 201);
});

test("HTTP: unknown errors are generic and do not leak internals", async () => {
  const f = fakeDeps();
  f.deps.db.insertProcessing = async () => { throw new Error("password=hunter2 connection refused"); };
  const r = await createHandler(f.deps)(post(valid({ captchaToken: "ok-token" })));
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /hunter2/);
});
