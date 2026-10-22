// Local preview: serves the static site and the REAL booking handler wired to in-memory fakes
// (no Google/email calls). Run: npm run dev  → http://localhost:8787
// Add ?fail=google|email to the page URL to simulate a provider outage on the next booking.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHandler, type Deps, type BookingRow } from "../supabase/functions/booking-api/booking.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows: (BookingRow & Record<string, unknown>)[] = [];
let fail = "";
let n = 0;
const active = (r: BookingRow) => r.status === "processing" || r.status === "confirmed";
const maybeFail = (what: string) => { if (fail === what) { fail = ""; throw new Error(`simulated ${what} outage`); } };

const deps: Deps = {
  now: () => new Date(),
  log: (m, d) => console.log(`[api] ${m}`, d ?? ""),
  db: {
    async expireStale() {},
    async insertProcessing(row) {
      if (rows.some((r) => r.idempotency_key === row.idempotency_key)) return { conflict: true };
      if (rows.some((r) => active(r) && r.start_at < row.end_at && r.end_at > row.start_at)) return { conflict: true };
      const r = { ...row, id: crypto.randomUUID(), status: "processing" as const };
      rows.push(r);
      return { row: { ...r } };
    },
    async findByIdempotencyKey(k) { return rows.find((r) => r.idempotency_key === k) ?? null; },
    async update(id, patch) { Object.assign(rows.find((r) => r.id === id)!, patch); return true; },
    async activeBetween() { return rows.filter(active).map((r) => ({ start: r.start_at, end: r.end_at })); },
  },
  calendar: {
    async busy() { return []; },
    async createEvent() { maybeFail("google"); const id = `evt${++n}`; return { id, meetUrl: `https://meet.google.com/dev-test-${n}` }; },
    async deleteEvent(id) { console.log(`[fake google] deleted ${id}`); },
  },
  mail: { async send(m) { maybeFail("email"); console.log(`[fake email] to=${m.to} subject=${m.subject}`); } },
  verifyHuman: async () => true,
  rateLimit: async () => true,
  hash: async (v) => v,
  config: { allowedOrigins: [ORIGIN], notificationEmail: "team@aksitas.test", requireHuman: false, humanCheckConfigured: false, configured: { fake: true } },
};
const api = createHandler(deps);
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  if (url.pathname.startsWith("/api/")) {
    const body = req.method === "POST" ? await new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); }) : undefined;
    const headers = new Headers(Object.entries(req.headers).map(([k, v]) => [k, String(v)]) as [string, string][]);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    const r = await api(new Request(`${ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(await r.text());
  }
  if (url.searchParams.has("fail")) fail = url.searchParams.get("fail")!;
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  // Root files plus one level of assets/; no "..", so nothing outside the project is served.
  if (!/^(assets\/)?[\w-]+(\.[\w-]+)*$/.test(file)) { res.writeHead(404); return res.end(); }
  try {
    let content: string | Buffer = await readFile(join(root, file));
    // Point the page at this server; Turnstile is off locally (its widget only runs on aksitas.github.io).
    if (file === "app.js") content = content.toString("utf8")
      .replace(/apiUrl: "[^"]*"/, `apiUrl: "${ORIGIN}/api"`).replace(/publishableKey: "[^"]*"/, `publishableKey: "local-dev"`)
      .replace(/turnstileSiteKey: "[^"]*"/, `turnstileSiteKey: ""`);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain; charset=utf-8" });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, () => console.log(`AKSITAS booking dev preview on ${ORIGIN} (fake providers)`));
