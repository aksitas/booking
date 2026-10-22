// Real-PostgreSQL check of the migrations: applies them to a THROWAWAY local cluster
// (never a remote/production database), then fires concurrent overlapping inserts.
// Usage: npm run test:db   (needs PostgreSQL >= 14 binaries; set PG_BIN if not on PATH)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const bin = (name) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);
const port = String(54000 + Math.floor(Math.random() * 900));
const dir = mkdtempSync(join(tmpdir(), "aksitas-pg-"));
const data = join(dir, "data");
const run = (cmd, args, input) => {
  const r = spawnSync(bin(cmd), args, { encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const psqlArgs = ["-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"];
const sql = (q) => run("psql", [...psqlArgs, "-c", q]).trim();
// Piped via stdin: deep checkout paths can exceed what psql -f can open on Windows.
const sqlFile = (url) => run("psql", [...psqlArgs, "-f", "-"], readFileSync(url, "utf8"));
const sqlAsync = (q) => new Promise((resolve) => {
  const p = spawn(bin("psql"), [...psqlArgs, "-c", q]);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ ok: code === 0, err }));
});

let started = false;
try {
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  // stdio must be detached: the postmaster inherits pg_ctl's handles, and a captured pipe never closes (hangs on Windows).
  const st = spawnSync(bin("pg_ctl"), ["-D", data, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", join(dir, "log.txt"), "-w", "start"], { stdio: "ignore", timeout: 60_000 });
  started = true;
  if (st.status !== 0) throw new Error(`pg_ctl start failed (${st.status}); see ${join(dir, "log.txt")}`);
  // Supabase roles the migrations reference.
  sql("create role anon nologin; create role authenticated nologin; create role service_role nologin;");

  const migDir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) sqlFile(new URL(f, migDir).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  // Hardening migration must be safe to apply twice.
  sqlFile(new URL(files.at(-1), migDir).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  console.log(`✔ migrations applied (${files.join(", ")}), hardening migration re-applied idempotently`);

  const ins = (i, start, mins) =>
    `insert into public.bookings(service,full_name,email,agenda,start_at,end_at,idempotency_key)
     values ('coaching','User ${i}','u${i}@example.com','agenda', '${start}', timestamptz '${start}' + interval '${mins} minutes', 'key-${start}-${i}')`;

  // 20 parallel connections race for overlapping 09:00 / 09:15 / 09:30 intervals.
  const attempts = Array.from({ length: 20 }, (_, i) =>
    sqlAsync(ins(i, ["2026-11-02T02:00:00Z", "2026-11-02T02:15:00Z", "2026-11-02T02:30:00Z"][i % 3], i % 2 ? 60 : 45)));
  const results = await Promise.all(attempts);
  const wins = results.filter((r) => r.ok).length;
  assert.equal(wins, 1, `expected exactly 1 winner, got ${wins}`);
  assert.ok(results.filter((r) => !r.ok).every((r) => /confirmed_bookings_no_overlap|23P01|conflicting key/.test(r.err)), "losers fail on the exclusion constraint");
  console.log(`✔ 20 concurrent overlapping inserts → exactly 1 reserved, 19 rejected by exclusion constraint`);

  // Back-to-back sessions ([) ranges) must both be allowed.
  sql(ins(100, "2026-11-02T03:00:00Z", 60));
  console.log("✔ adjacent interval (10:00 after 09:00–09:45/10:00) accepted");

  // A failed row frees the slot.
  sql(`update public.bookings set status='failed' where start_at='2026-11-02T03:00:00Z'`);
  sql(ins(101, "2026-11-02T03:00:00Z", 45));
  console.log("✔ failed booking releases its interval");

  // Stale holds: released unless the customer may already have been emailed.
  sql(ins(200, "2026-11-03T02:00:00Z", 45) + `; update public.bookings set created_at=now()-interval '20 minutes', zoom_meeting_id='z1' where idempotency_key like 'key-2026-11-03T02:00:00Z-200'`);
  sql(ins(201, "2026-11-03T03:00:00Z", 45) + `; update public.bookings set created_at=now()-interval '20 minutes', admin_notified_at=now() where idempotency_key like 'key-2026-11-03T03:00:00Z-201'`);
  assert.equal(sql("select public.expire_stale_bookings()"), "2");
  assert.equal(sql("select status||':'||needs_reconciliation from public.bookings where email='u200@example.com'"), "failed:true");
  assert.equal(sql("select status||':'||needs_reconciliation from public.bookings where email='u201@example.com'"), "processing:true");
  console.log("✔ expire_stale_bookings releases un-notified holds, keeps & flags notified ones");

  // Rate limiter: 3 allowed, 4th denied within the window.
  const hits = [1, 2, 3, 4].map(() => sql("select public.booking_rate_limit_hit('t', 600, 3)"));
  assert.deepEqual(hits, ["t", "t", "t", "f"]);
  console.log("✔ booking_rate_limit_hit allows 3 then denies");

  // Least privilege: browser roles cannot read bookings.
  const anon = spawnSync(bin("psql"), [...psqlArgs, "-c", "set role anon; select count(*) from public.bookings"], { encoding: "utf8" });
  assert.notEqual(anon.status, 0);
  assert.match(anon.stderr, /permission denied/);
  console.log("✔ anon role denied on public.bookings");
  console.log("\nALL DB CHECKS PASSED");
} finally {
  if (started) spawnSync(bin("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "ignore", timeout: 60_000 });
  rmSync(dir, { recursive: true, force: true });
}
