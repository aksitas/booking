// Admin API for admin.html: password login → signed 8-hour session token → list / mark paid / cancel.
// Runtime-agnostic like booking.ts (Web Crypto only), so it is tested under Node with fakes.
import {
  type BookingRow, type Deps, escapeHtml, type ExtraRoutes, fmtRupiah, fmtWhen, paymentDeadline, PublicError, SERVICE,
} from "./booking.ts";

export const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;
const LIST_LIMIT = 300;
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(s: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
// The signing key derives from the password, so changing ADMIN_PASSWORD signs everyone out.
async function sign(password: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", await sha256(`aksitas-admin-session:${password}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))));
}
export async function issueAdminToken(password: string, now: Date) {
  const exp = String(now.getTime() + ADMIN_SESSION_MS);
  return { token: `${exp}.${await sign(password, exp)}`, expiresAt: new Date(Number(exp)).toISOString() };
}
export async function verifyAdminToken(password: string, token: string, now: Date) {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) <= now.getTime()) return false;
  return sameBytes(enc.encode(sig), enc.encode(await sign(password, exp)));
}

/** What the admin page sees for each booking. */
export function adminRow(b: BookingRow) {
  const svc = SERVICE[b.service];
  const created = b.created_at ? new Date(b.created_at) : null;
  return {
    id: b.id, service: b.service, serviceTitle: svc.title, status: b.status,
    startAt: b.start_at, endAt: b.end_at, durationMinutes: svc.duration,
    price: svc.price, priceLabel: fmtRupiah(svc.price),
    fullName: b.full_name, email: b.email, company: b.company, role: b.role, agenda: b.agenda,
    meetingUrl: b.meeting_url ?? null, createdAt: b.created_at ?? null,
    paidAt: b.paid_at ?? null,
    paymentDeadline: created ? paymentDeadline(created, new Date(b.start_at)).toISOString() : null,
    cancelledAt: b.cancelled_at ?? null, cancellationReason: b.cancellation_reason ?? null,
  };
}

function cancellationEmail(b: BookingRow, reason: string) {
  const svc = SERVICE[b.service], when = fmtWhen(new Date(b.start_at)), h = escapeHtml;
  const why = reason ? `\nAlasan: ${reason}` : "";
  return {
    to: b.email,
    subject: `Booking dibatalkan — AKSITAS ${svc.title}`,
    html: `<p>Halo ${h(b.full_name)},</p><p>Booking ${svc.title} Anda pada <strong>${h(when)}</strong> telah <strong>dibatalkan</strong> oleh tim AKSITAS.${reason ? `<br>Alasan: ${h(reason)}` : ""}</p><p>Tautan Google Meet untuk sesi ini tidak berlaku lagi. Jika ini keliru atau Anda ingin menjadwalkan ulang, balas email ini.</p><p>ID booking: ${h(b.id)}</p><p>Salam,<br>Tim AKSITAS</p>`,
    text: `Halo ${b.full_name},\n\nBooking ${svc.title} Anda pada ${when} telah dibatalkan oleh tim AKSITAS.${why}\n\nTautan Google Meet untuk sesi ini tidak berlaku lagi. Jika ini keliru atau Anda ingin menjadwalkan ulang, balas email ini.\nID booking: ${b.id}\n\nSalam,\nTim AKSITAS`,
  };
}

export function createAdminRoutes(deps: Deps): ExtraRoutes {
  return async (req, { path, url, ipKey, originAllowed, json }) => {
    const m = path.match(/\/admin(\/.*)?$/);
    if (!m) return null;
    const sub = m[1] ?? "";
    const password = deps.config.adminPassword ?? "";
    // The admin page is a browser page on the booking site; nothing else may call these endpoints.
    if (!originAllowed) throw new PublicError(403, "Origin tidak diizinkan.", "forbidden_origin");
    if (password.length < MIN_PASSWORD_LENGTH) throw new PublicError(503, "Halaman admin belum diaktifkan (ADMIN_PASSWORD belum diatur).", "admin_not_configured");

    if (req.method === "POST" && sub === "/login") {
      if (!(await deps.rateLimit(`admin-login:${ipKey}`, 900, 5)))
        throw new PublicError(429, "Terlalu banyak percobaan login. Coba lagi dalam 15 menit.", "rate_limited");
      const body = await req.json().catch(() => null);
      const given = typeof body?.password === "string" ? body.password : "";
      if (!sameBytes(await sha256(given), await sha256(password))) {
        deps.log("admin login failed");
        throw new PublicError(401, "Kata sandi salah.", "bad_password");
      }
      return json(await issueAdminToken(password, deps.now()));
    }

    const token = req.headers.get("x-admin-token") ?? "";
    if (!(await verifyAdminToken(password, token, deps.now())))
      throw new PublicError(401, "Sesi berakhir. Silakan login lagi.", "unauthorized");

    if (req.method === "GET" && sub === "/bookings") {
      // "upcoming": sessions from today (WIB) on; "all": also the last 90 days.
      const days = url.searchParams.get("scope") === "all" ? 90 : 0;
      const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(deps.now())}T00:00:00+07:00`);
      const rows = await deps.db.listBookings(new Date(today.getTime() - days * 86_400_000), LIST_LIMIT);
      return json({ bookings: rows.filter((r) => r.status !== "failed").map(adminRow) });
    }

    const action = sub.match(/^\/bookings\/([0-9a-f-]{36})\/(paid|cancel)$/);
    if (req.method === "POST" && action) {
      const b = await deps.db.getBooking(action[1]);
      if (!b) throw new PublicError(404, "Booking tidak ditemukan.", "not_found");
      const body = await req.json().catch(() => ({}));

      if (action[2] === "paid") {
        if (b.status !== "confirmed") throw new PublicError(409, "Hanya booking aktif yang bisa ditandai lunas.", "not_active");
        const paidAt = body?.paid === false ? null : deps.now().toISOString();
        if (!(await deps.db.update(b.id, { paid_at: paidAt }))) throw new PublicError(500, "Gagal menyimpan status pembayaran.", "db_error");
        return json({ booking: adminRow({ ...b, paid_at: paidAt }) });
      }

      // cancel
      if (b.status !== "confirmed" && b.status !== "processing") throw new PublicError(409, "Booking ini sudah tidak aktif.", "not_active");
      const reason = typeof body?.reason === "string" ? body.reason.replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
      let calendarRemoved = !b.google_event_id;
      if (b.google_event_id) {
        try { await deps.calendar.deleteEvent(b.google_event_id); calendarRemoved = true; }
        catch (e) { deps.log("admin cancel: calendar delete failed", e); }
      }
      const cancelledAt = deps.now().toISOString();
      if (!(await deps.db.update(b.id, { status: "cancelled", cancelled_at: cancelledAt, cancellation_reason: reason || null })))
        throw new PublicError(500, "Gagal membatalkan booking.", "db_error");
      let emailSent = false;
      if (body?.notify === true) {
        try { await deps.mail.send(cancellationEmail(b, reason)); emailSent = true; }
        catch (e) { deps.log("admin cancel: email failed", e); }
      }
      return json({
        booking: adminRow({ ...b, status: "cancelled", cancelled_at: cancelledAt, cancellation_reason: reason || null }),
        calendarRemoved, emailSent,
      });
    }
    return json({ error: "Endpoint tidak ditemukan.", code: "not_found" }, 404);
  };
}
