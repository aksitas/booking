// Supabase Edge Function entry point: wires real providers into the runtime-agnostic core.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type BookingRow, createHandler, type Deps, type Interval, localParts, SERVICE, TZ } from "./booking.ts";

// Trimmed: values pasted into the dashboard's multi-line secret field often carry a trailing newline.
const env = (key: string) => {
  const v = Deno.env.get(key)?.trim();
  if (!v) throw new Error(`Server configuration missing: ${key}`);
  return v;
};
const has = (...keys: string[]) => keys.every((k) => Boolean(Deno.env.get(k)?.trim()));

// Projects on the new API keys expose sb_secret_* keys via SUPABASE_SECRET_KEYS; older ones via SUPABASE_SERVICE_ROLE_KEY.
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof keys.default === "string") return keys.default;
  } catch { /* fall through */ }
  throw new Error("Server configuration missing: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS");
}
const supabase = createClient(env("SUPABASE_URL"), serverKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- Google Calendar ----------
let googleToken: { value: string; exp: number } | null = null;
async function googleAccessToken(): Promise<string> {
  if (googleToken && googleToken.exp > Date.now() + 60_000) return googleToken.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_REFRESH_TOKEN"), grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Google OAuth failed (${r.status}): ${d.error ?? "no token"}`);
  googleToken = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 };
  return googleToken.value;
}
async function google(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Calendar API error (${r.status}): ${d?.error?.message ?? "request failed"}`);
  return d;
}
const calendarId = () => env("GOOGLE_CALENDAR_ID");

// ---------- Zoom ----------
let zoomToken: { value: string; exp: number } | null = null;
async function zoomAccessToken(): Promise<string> {
  if (zoomToken && zoomToken.exp > Date.now() + 60_000) return zoomToken.value;
  const r = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env("ZOOM_CLIENT_ID")}:${env("ZOOM_CLIENT_SECRET")}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: env("ZOOM_ACCOUNT_ID") }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Zoom OAuth failed (${r.status}): ${d.reason ?? d.error ?? "no token"}`);
  zoomToken = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 };
  return zoomToken.value;
}

const title = (b: BookingRow) => `AKSITAS ${SERVICE[b.service].title} — ${b.full_name}`;

const deps: Deps = {
  now: () => new Date(),
  log: (message, detail) => console.error(`[booking-api] ${message}`, detail ?? ""),
  db: {
    async expireStale() {
      const { error } = await supabase.rpc("expire_stale_bookings");
      if (error) throw error;
    },
    async insertProcessing(row) {
      const { data, error } = await supabase.from("bookings")
        .insert({ ...row, status: "processing", timezone: TZ }).select("*").single();
      if (error) return { conflict: error.code === "23P01" || error.code === "23505", error };
      return { row: data as BookingRow };
    },
    async findByIdempotencyKey(key) {
      const { data, error } = await supabase.from("bookings").select("*").eq("idempotency_key", key).maybeSingle();
      if (error) throw error;
      return data as BookingRow | null;
    },
    async update(id, patch) {
      const { error } = await supabase.from("bookings").update(patch).eq("id", id);
      if (error) console.error("[booking-api] db update failed", error);
      return !error;
    },
    async activeBetween(start, end) {
      const { data, error } = await supabase.from("bookings").select("start_at,end_at")
        .in("status", ["processing", "confirmed"]).lt("start_at", end.toISOString()).gt("end_at", start.toISOString());
      if (error) throw error;
      return (data ?? []).map((r) => ({ start: r.start_at, end: r.end_at }));
    },
  },
  calendar: {
    async busy(start, end) {
      const id = calendarId();
      const d = await google("/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: TZ, items: [{ id }] }),
      });
      const cal = d.calendars?.[id];
      // FreeBusy reports per-calendar problems (notFound, no access) inside a 200 response.
      if (!cal || cal.errors?.length) throw new Error(`Google FreeBusy calendar error: ${JSON.stringify(cal?.errors ?? "missing")}`);
      return (cal.busy ?? []) as Interval[];
    },
    async createEvent(b) {
      // sendUpdates=none: the attendee is only notified through our confirmation email, which is
      // sent after every step succeeded. A Google invite here could reach them before confirmation.
      const d = await google(`/calendars/${encodeURIComponent(calendarId())}/events?sendUpdates=none`, {
        method: "POST",
        body: JSON.stringify({
          summary: title(b),
          description: `Booking ID: ${b.id}\nPeserta: ${b.full_name}\nEmail: ${b.email}\nPerusahaan: ${b.company || "-"}\nPeran: ${b.role || "-"}\nAgenda: ${b.agenda}\nZoom: ${b.zoom_join_url}`,
          location: b.zoom_join_url ?? "Zoom",
          start: { dateTime: b.start_at, timeZone: TZ },
          end: { dateTime: b.end_at, timeZone: TZ },
          attendees: [{ email: b.email, displayName: b.full_name }],
          extendedProperties: { private: { aksitasBookingId: b.id } },
        }),
      });
      if (!d.id) throw new Error("Google Calendar returned no event id");
      return d.id as string;
    },
    async deleteEvent(eventId) {
      await google(`/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: "DELETE" });
    },
  },
  zoom: {
    async createMeeting(b) {
      const p = localParts(new Date(b.start_at));
      const r = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(env("ZOOM_HOST_USER_ID"))}/meetings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await zoomAccessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: title(b).slice(0, 200), type: 2,
          start_time: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`, timezone: TZ,
          duration: SERVICE[b.service].duration, agenda: b.agenda.slice(0, 1800),
          settings: { join_before_host: false, waiting_room: true, approval_type: 2, meeting_authentication: false },
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id || !d.join_url) throw new Error(`Zoom API error (${r.status}): ${d.message ?? "could not create meeting"}`);
      return { id: String(d.id), joinUrl: String(d.join_url) };
    },
    async deleteMeeting(id) {
      const r = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${await zoomAccessToken()}` },
      });
      if (!r.ok && r.status !== 404) throw new Error(`Zoom delete failed (${r.status})`);
    },
  },
  mail: {
    async send(m) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env("EMAIL_FROM"), to: [m.to], reply_to: env("BOOKING_NOTIFICATION_EMAIL"),
          subject: m.subject.replace(/[\r\n]+/g, " "), html: m.html, text: m.text,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) throw new Error(`Email provider rejected message (${r.status}): ${d.message ?? "unknown error"}`);
    },
  },
  async verifyHuman(token, ip) {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: env("TURNSTILE_SECRET_KEY"), response: token, remoteip: ip }),
    });
    const d = await r.json().catch(() => ({}));
    return r.ok && d.success === true;
  },
  async rateLimit(bucket, windowSeconds, max) {
    const { data, error } = await supabase.rpc("booking_rate_limit_hit", { p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max });
    if (error) {
      console.error("[booking-api] rate limit check failed", error);
      // Fail closed for writes, open for read-only availability.
      return !bucket.startsWith("book");
    }
    return data === true;
  },
  async hash(value) {
    const salt = Deno.env.get("RATE_LIMIT_SALT") ?? "aksitas-booking";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${value}`));
    return Array.from(new Uint8Array(buf).slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  },
  config: {
    allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? Deno.env.get("ALLOWED_ORIGIN") ?? "https://aksitas.github.io")
      .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    notificationEmail: Deno.env.get("BOOKING_NOTIFICATION_EMAIL") ?? "",
    requireHuman: Deno.env.get("ALLOW_UNVERIFIED_BOOKINGS") !== "true",
    humanCheckConfigured: has("TURNSTILE_SECRET_KEY"),
    configured: {
      google: has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_CALENDAR_ID"),
      zoom: has("ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_HOST_USER_ID"),
      email: has("RESEND_API_KEY", "EMAIL_FROM", "BOOKING_NOTIFICATION_EMAIL"),
      botProtection: has("TURNSTILE_SECRET_KEY") || Deno.env.get("ALLOW_UNVERIFIED_BOOKINGS") === "true",
    },
  },
};

Deno.serve(createHandler(deps));
