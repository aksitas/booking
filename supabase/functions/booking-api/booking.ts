// Runtime-agnostic booking core. No Deno/Node globals beyond Web APIs (fetch types, crypto),
// so the same file runs in Supabase Edge Functions and under `node --test` with fakes.

export const TZ = "Asia/Jakarta";
export const SERVICE = {
  coaching: { title: "Coaching", duration: 45 },
  consulting: { title: "Consulting", duration: 60 },
} as const;
export type ServiceKey = keyof typeof SERVICE;

// Times are Asia/Jakarta minutes after midnight. Last start 16:00, consulting ends 17:00.
export const SLOT_STARTS = [9 * 60, 10 * 60, 11 * 60, 13 * 60, 14 * 60, 15 * 60, 16 * 60];
export const MIN_LEAD_MS = 60 * 60 * 1000;
export const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const FINAL_UPDATE_ATTEMPTS = 3;

export type Interval = { start: string; end: string };
export type BookingRow = {
  id: string;
  service: ServiceKey;
  status: "processing" | "confirmed" | "failed" | "cancelled";
  full_name: string;
  email: string;
  company: string | null;
  role: string | null;
  agenda: string;
  start_at: string;
  end_at: string;
  google_event_id?: string | null;
  meeting_url?: string | null;
};
export type NewBooking = Omit<BookingRow, "id" | "status"> & { idempotency_key: string };

export interface Db {
  expireStale(): Promise<void>;
  insertProcessing(row: NewBooking): Promise<{ row?: BookingRow; conflict?: boolean; error?: unknown }>;
  findByIdempotencyKey(key: string): Promise<BookingRow | null>;
  update(id: string, patch: Record<string, unknown>): Promise<boolean>;
  activeBetween(start: Date, end: Date): Promise<Interval[]>;
}
export interface Deps {
  now(): Date;
  db: Db;
  calendar: {
    busy(start: Date, end: Date): Promise<Interval[]>;
    // Creates the calendar event together with its Google Meet link.
    createEvent(b: BookingRow): Promise<{ id: string; meetUrl: string }>;
    deleteEvent(id: string): Promise<void>;
  };
  mail: { send(m: { to: string; subject: string; html: string; text: string }): Promise<void> };
  verifyHuman(token: string, ip: string): Promise<boolean>;
  rateLimit(bucket: string, windowSeconds: number, max: number): Promise<boolean>;
  hash(value: string): Promise<string>;
  log(message: string, detail?: unknown): void;
  config: {
    allowedOrigins: string[];
    notificationEmail: string;
    // false only when explicitly opted out for a test environment.
    requireHuman: boolean;
    humanCheckConfigured: boolean;
    configured: Record<string, boolean>;
  };
}

/** Error whose message is safe to show the customer. */
export class PublicError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") { super(message); this.status = status; this.code = code; }
}

// ---------- Time helpers ----------
export function localParts(date: Date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date);
  return Object.fromEntries(p.map((x) => [x.type, x.value])) as Record<string, string>;
}
export const localDateKey = (d: Date) => { const p = localParts(d); return `${p.year}-${p.month}-${p.day}`; };
export function parseDateOnly(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00+07:00`);
  // Reject roll-overs such as 2026-02-31.
  return Number.isNaN(d.getTime()) || localDateKey(d) !== s ? null : d;
}
export function localDateTime(date: string, minutes: number): Date {
  // Jakarta has no DST; UTC+07:00 is stable.
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0"), mm = String(minutes % 60).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:00+07:00`);
}
export function isWeekday(date: Date) {
  const wd = localParts(date).weekday;
  return wd !== "Sat" && wd !== "Sun";
}
export const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("id-ID", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(".", ":") + " WIB";
export const fmtWhen = (d: Date) =>
  `${new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeZone: TZ }).format(d)}, ${fmtTime(d)}`;
const overlaps = (a: Interval, s: Date, e: Date) => new Date(a.start) < e && new Date(a.end) > s;

export function candidateSlots(date: string, service: ServiceKey, now: Date) {
  const d = parseDateOnly(date);
  if (!d) throw new PublicError(400, "Tanggal tidak valid.", "invalid_date");
  if (!isWeekday(d) || date <= localDateKey(now)) return [];
  const duration = SERVICE[service].duration;
  return SLOT_STARTS.map((min) => {
    const start = localDateTime(date, min);
    return { start, end: new Date(start.getTime() + duration * 60_000) };
  }).filter((x) => x.start.getTime() >= now.getTime() + MIN_LEAD_MS && x.start.getTime() <= now.getTime() + MAX_AHEAD_MS);
}

export async function availableSlots(deps: Deps, date: string, service: ServiceKey) {
  const all = candidateSlots(date, service, deps.now());
  if (!all.length) return [];
  const minStart = all[0].start, maxEnd = all[all.length - 1].end;
  await deps.db.expireStale().catch((e) => deps.log("expireStale failed", e));
  let busy: Interval[], booked: Interval[];
  try {
    [busy, booked] = await Promise.all([deps.calendar.busy(minStart, maxEnd), deps.db.activeBetween(minStart, maxEnd)]);
  } catch (e) {
    // Never fall back to "everything free" when a source of truth is unavailable.
    deps.log("availability lookup failed", e);
    throw new PublicError(503, "Ketersediaan jadwal belum dapat diperiksa. Silakan coba beberapa saat lagi.", "availability_unavailable");
  }
  return all
    .filter((s) => !busy.some((b) => overlaps(b, s.start, s.end)) && !booked.some((b) => overlaps(b, s.start, s.end)))
    .map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString(), label: fmtTime(s.start) }));
}

// ---------- Input validation ----------
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
function text(v: unknown, field: string, min: number, max: number, multiline = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new PublicError(400, `${field} tidak valid.`, "invalid_input");
  const s = v.trim();
  if (s.length < min) throw new PublicError(400, `${field} wajib diisi.`, "invalid_input");
  if (s.length > max) throw new PublicError(400, `${field} maksimal ${max} karakter.`, "invalid_input");
  if (CONTROL.test(s) || (!multiline && /[\r\n]/.test(s))) throw new PublicError(400, `${field} berisi karakter tidak valid.`, "invalid_input");
  return s;
}
export function validateBooking(body: any, now: Date) {
  if (!body || typeof body !== "object") throw new PublicError(400, "Body JSON tidak valid.", "invalid_input");
  const service = body.service;
  if (service !== "coaching" && service !== "consulting") throw new PublicError(400, "Layanan tidak valid.", "invalid_service");
  const full_name = text(body.fullName, "Nama", 2, 120);
  const email = text(body.email, "Email", 3, 254).toLowerCase();
  if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(email)) throw new PublicError(400, "Alamat email tidak valid.", "invalid_email");
  const company = text(body.company, "Perusahaan", 0, 180) || null;
  const role = text(body.role, "Peran", 0, 120) || null;
  const agenda = text(body.agenda, "Agenda", 3, 5000, true);
  if (typeof body.startAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(body.startAt)) throw new PublicError(400, "Waktu booking tidak valid.", "invalid_time");
  const start = new Date(body.startAt);
  if (Number.isNaN(start.getTime())) throw new PublicError(400, "Waktu booking tidak valid.", "invalid_time");
  const allowed = candidateSlots(localDateKey(start), service, now).some((s) => s.start.getTime() === start.getTime());
  if (!allowed) throw new PublicError(400, "Slot tidak tersedia. Pilih hari kerja, minimal besok, dalam 60 hari ke depan, pada jam layanan.", "invalid_slot");
  const end = new Date(start.getTime() + SERVICE[service as ServiceKey].duration * 60_000);
  return { service: service as ServiceKey, full_name, email, company, role, agenda, start, end };
}

// ---------- Email content ----------
function base64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64(s)}?=`);

/** RFC 2822 message (text + HTML alternatives), base64url-encoded as the Gmail API `raw` field expects. */
export function buildMimeMessage(m: { from: string; fromName: string; to: string; replyTo?: string; subject: string; html: string; text: string }) {
  const boundary = `aksitas-${crypto.randomUUID()}`;
  const body = (s: string) => base64(s).replace(/.{76}/g, "$&\r\n");
  const lines = [
    `From: ${encodeWord(headerSafe(m.fromName))} <${headerSafe(m.from)}>`,
    `To: <${headerSafe(m.to)}>`,
    ...(m.replyTo ? [`Reply-To: <${headerSafe(m.replyTo)}>`] : []),
    `Subject: ${encodeWord(headerSafe(m.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body(m.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body(m.html),
    `--${boundary}--`,
    "",
  ];
  return base64(lines.join("\r\n")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function emails(b: BookingRow, joinUrl: string) {
  const svc = SERVICE[b.service], start = new Date(b.start_at), when = fmtWhen(start);
  const h = escapeHtml;
  return {
    customer: {
      to: b.email,
      subject: `Booking terkonfirmasi — AKSITAS ${svc.title}`,
      html: `<p>Halo ${h(b.full_name)},</p><p>Booking ${svc.title} Anda dengan AKSITAS telah <strong>terkonfirmasi</strong>.</p><p><strong>Waktu:</strong> ${h(when)}<br><strong>Durasi:</strong> ${svc.duration} menit<br><strong>Agenda:</strong> ${h(b.agenda)}</p><p><a href="${h(joinUrl)}">Gabung Google Meet</a><br>${h(joinUrl)}</p><p>Gunakan email ini saat bergabung agar langsung masuk tanpa menunggu persetujuan.</p><p>ID booking: ${h(b.id)}<br>Jika perlu mengubah jadwal, balas email ini.</p><p>Salam,<br>Tim AKSITAS</p>`,
      text: `Halo ${b.full_name},\n\nBooking ${svc.title} Anda dengan AKSITAS telah terkonfirmasi.\nWaktu: ${when}\nDurasi: ${svc.duration} menit\nAgenda: ${b.agenda}\nGoogle Meet: ${joinUrl}\nID booking: ${b.id}\n\nJika perlu mengubah jadwal, balas email ini.\n\nSalam,\nTim AKSITAS`,
    },
    admin: (to: string) => ({
      to,
      subject: `Booking baru — ${svc.title} — ${b.full_name}`,
      html: `<p>Booking baru (konfirmasi ke peserta sedang dikirim).</p><p><strong>${h(b.full_name)}</strong> (${h(b.email)})<br>${h(b.company || "-")} · ${h(b.role || "-")}<br>${h(when)} · ${svc.duration} menit<br>Google Meet: <a href="${h(joinUrl)}">${h(joinUrl)}</a></p><p>Agenda: ${h(b.agenda)}</p><p>ID: ${h(b.id)}</p>`,
      text: `Booking baru\n${b.full_name} <${b.email}>\n${b.company || "-"} · ${b.role || "-"}\n${when} · ${svc.duration} menit\nGoogle Meet: ${joinUrl}\nAgenda: ${b.agenda}\nID: ${b.id}`,
    }),
    adminCancelled: (to: string, reason: string) => ({
      to,
      subject: `DIBATALKAN otomatis — ${svc.title} — ${b.full_name}`,
      html: `<p>Booking ${h(b.id)} (${h(when)}) <strong>tidak terkonfirmasi</strong> dan dibatalkan otomatis. Abaikan notifikasi sebelumnya.</p><p>Alasan: ${h(reason)}</p>`,
      text: `Booking ${b.id} (${when}) tidak terkonfirmasi dan dibatalkan otomatis. Abaikan notifikasi sebelumnya.\nAlasan: ${reason}`,
    }),
  };
}

// ---------- Booking orchestration ----------
const publicRow = (b: BookingRow) => ({
  bookingId: b.id, status: b.status, service: b.service, startAt: b.start_at, endAt: b.end_at,
  localTime: fmtTime(new Date(b.start_at)), joinUrl: b.meeting_url ?? undefined,
});

/**
 * Reserve → recheck calendar → Google event with Meet link → internal notice → customer email → confirm.
 * Any failure before the customer email compensates every created resource and marks the row
 * 'failed', which releases the slot. The row only becomes 'confirmed' after all steps succeed.
 */
export async function createBooking(deps: Deps, body: unknown, idempotencyKey: string) {
  const input = validateBooking(body, deps.now());
  await deps.db.expireStale().catch((e) => deps.log("expireStale failed", e));

  const ins = await deps.db.insertProcessing({
    service: input.service, full_name: input.full_name, email: input.email, company: input.company,
    role: input.role, agenda: input.agenda, start_at: input.start.toISOString(), end_at: input.end.toISOString(),
    idempotency_key: idempotencyKey,
  });
  if (!ins.row) {
    if (ins.conflict) {
      // Same submission retried (e.g. network drop): report its real state instead of a false conflict.
      const prior = await deps.db.findByIdempotencyKey(idempotencyKey);
      if (prior?.status === "confirmed") return { status: 200, body: publicRow(prior) };
      if (prior?.status === "processing") throw new PublicError(409, "Booking Anda sedang diproses. Mohon tunggu sebentar lalu periksa email Anda.", "in_progress");
      if (prior) throw new PublicError(409, "Pengajuan sebelumnya tidak berhasil. Silakan kirim ulang.", "retry_new_key");
      throw new PublicError(409, "Slot ini baru saja dipesan atau sedang diproses. Silakan pilih waktu lain.", "slot_taken");
    }
    deps.log("booking insert failed", ins.error);
    throw new PublicError(500, "Tidak dapat membuat booking saat ini. Silakan coba lagi.", "db_error");
  }

  const b = ins.row;
  let googleId = "", adminNotified = false;
  try {
    const busy = await deps.calendar.busy(input.start, input.end);
    if (busy.some((x) => overlaps(x, input.start, input.end)))
      throw new PublicError(409, "Jadwal ini baru saja menjadi tidak tersedia. Silakan pilih slot lain.", "slot_taken");

    const event = await deps.calendar.createEvent(b);
    googleId = event.id;
    b.google_event_id = event.id; b.meeting_url = event.meetUrl;
    if (!(await deps.db.update(b.id, { google_event_id: event.id, meeting_url: event.meetUrl }))) throw new Error("persist event ids failed");

    const mail = emails(b, event.meetUrl);
    await deps.mail.send(mail.admin(deps.config.notificationEmail));
    adminNotified = true;
    if (!(await deps.db.update(b.id, { admin_notified_at: deps.now().toISOString() }))) throw new Error("persist admin notice failed");

    await deps.mail.send(mail.customer);
  } catch (error) {
    deps.log("booking integration failure", error);
    const reason = error instanceof PublicError ? error.code : String(error).slice(0, 500);
    // Deleting the event also retires its Meet link.
    if (googleId) await deps.calendar.deleteEvent(googleId).catch((e) => deps.log("compensate google failed", e));
    if (adminNotified) {
      await deps.mail.send(emails(b, b.meeting_url ?? "-").adminCancelled(deps.config.notificationEmail, reason))
        .catch((e) => deps.log("admin cancel notice failed", e));
    }
    const released = await deps.db.update(b.id, { status: "failed", failure_reason: reason, needs_reconciliation: false });
    if (!released) deps.log("could not release failed booking; expiry job will release it", b.id);
    if (error instanceof PublicError) throw error;
    throw new PublicError(502, "Booking belum dapat dikonfirmasi karena kendala sistem. Slot tidak dipesan; silakan coba lagi atau hubungi AKSITAS.", "integration_failed");
  }

  // The customer now holds valid meeting details, so never roll back from here.
  const confirmedAt = deps.now().toISOString();
  for (let i = 0; i < FINAL_UPDATE_ATTEMPTS; i++) {
    if (await deps.db.update(b.id, { status: "confirmed", confirmation_sent_at: confirmedAt, failure_reason: null })) {
      b.status = "confirmed";
      return { status: 201, body: publicRow(b) };
    }
  }
  // Row stays 'processing' with admin_notified_at set; expire_stale_bookings keeps holding the slot
  // and flags it for reconciliation instead of releasing it.
  deps.log("CRITICAL: booking emailed but final status update failed; needs reconciliation", b.id);
  b.status = "confirmed";
  return { status: 201, body: publicRow(b) };
}

// ---------- HTTP ----------
function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}

export function createHandler(deps: Deps) {
  const baseHeaders = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const originAllowed = !!origin && deps.config.allowedOrigins.includes(origin);
    const headers: Record<string, string> = { ...baseHeaders };
    if (originAllowed) headers["Access-Control-Allow-Origin"] = origin!;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const fail = (e: PublicError) => json({ error: e.message, code: e.code }, e.status);

    if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers });
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "");
      const ipKey = await deps.hash(clientIp(req));

      if (req.method === "GET" && path.endsWith("/health")) {
        return json({ ok: true, service: "aksitas-booking-api", integrationsConfigured: deps.config.configured });
      }
      if (req.method === "GET" && path.endsWith("/slots")) {
        if (!(await deps.rateLimit(`slots:${ipKey}`, 60, 30))) throw new PublicError(429, "Terlalu banyak permintaan. Coba lagi dalam satu menit.", "rate_limited");
        const date = url.searchParams.get("date") ?? "", service = url.searchParams.get("service") ?? "";
        if (service !== "coaching" && service !== "consulting") throw new PublicError(400, "Layanan tidak valid.", "invalid_service");
        return json({ date, service, timezone: TZ, slots: await availableSlots(deps, date, service) });
      }
      if (req.method === "POST" && path.endsWith("/book")) {
        // Browsers always send Origin on cross-site POST; reject anything not from the booking site.
        if (!originAllowed) throw new PublicError(403, "Origin tidak diizinkan.", "forbidden_origin");
        if (!(await deps.rateLimit(`book:${ipKey}`, 600, 5))) throw new PublicError(429, "Terlalu banyak percobaan booking. Coba lagi dalam 10 menit.", "rate_limited");
        const len = Number(req.headers.get("content-length") ?? 0);
        if (len > 20_000) throw new PublicError(413, "Data terlalu besar.", "too_large");
        const body = await req.json().catch(() => null);
        if (!body) throw new PublicError(400, "Body JSON tidak valid.", "invalid_input");
        if (deps.config.requireHuman) {
          if (!deps.config.humanCheckConfigured) {
            deps.log("bot protection required but TURNSTILE_SECRET_KEY is not set");
            throw new PublicError(503, "Booking online sementara belum tersedia. Silakan hubungi AKSITAS.", "not_configured");
          }
          const token = typeof body.captchaToken === "string" ? body.captchaToken : "";
          if (!token || !(await deps.verifyHuman(token, clientIp(req)))) throw new PublicError(403, "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", "captcha_failed");
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (email && !(await deps.rateLimit(`book-email:${await deps.hash(email)}`, 86_400, 3)))
          throw new PublicError(429, "Batas booking harian untuk email ini tercapai. Hubungi AKSITAS bila perlu.", "rate_limited");
        const key = req.headers.get("idempotency-key") ?? "";
        if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new PublicError(400, "Idempotency-Key header wajib diisi.", "invalid_input");
        const result = await createBooking(deps, body, key);
        return json(result.body, result.status);
      }
      return json({ error: "Endpoint tidak ditemukan.", code: "not_found" }, 404);
    } catch (error) {
      if (error instanceof PublicError) return fail(error);
      deps.log("unhandled booking API error", error);
      return json({ error: "Layanan booking mengalami kendala. Silakan coba kembali nanti.", code: "internal" }, 500);
    }
  };
}
