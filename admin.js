(() => {
  "use strict";
  // Public values only (same as app.js). The admin password never appears here; the server checks it.
  const CONFIG = {
    apiUrl: "https://xjmvgrqtrunfpdkxqdst.supabase.co/functions/v1/booking-api",
    publishableKey: "sb_publishable_6TWSur18V_L3iVQdO8Q8GQ_p2tDBadA",
  };
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "aksitas-admin-session";
  const state = { scope: "upcoming", bookings: [], cancelling: null };

  // Session lives only in this tab (sessionStorage) and expires server-side after 8 hours.
  const session = {
    get() { try { const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null"); return s && new Date(s.expiresAt) > new Date() ? s.token : null; } catch { return null; } },
    set(v) { try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(v)); } catch {} },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  async function api(path, { method = "GET", body } = {}) {
    const token = session.get();
    let res;
    try {
      res = await fetch(`${CONFIG.apiUrl}/admin${path}`, {
        method,
        headers: {
          "Content-Type": "application/json", apikey: CONFIG.publishableKey, Authorization: `Bearer ${CONFIG.publishableKey}`,
          ...(token ? { "x-admin-token": token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error("Koneksi terputus. Periksa internet lalu coba lagi."); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/login") { session.clear(); showLogin("Sesi berakhir. Silakan masuk lagi."); throw new Error(data.error || "Sesi berakhir."); }
    if (!res.ok) throw new Error(data.error || "Permintaan gagal.");
    return data;
  }

  const fmt = (iso, opts) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", ...opts }).format(new Date(iso)).replace(/\./g, ":");
  const fmtDay = (iso) => fmt(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const fmtTime = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " WIB";
  const fmtShort = (iso) => fmt(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " WIB";
  const el = (tag, props = {}, ...children) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c != null) n.append(c);
    return n;
  };

  function paymentState(b) {
    if (b.status === "cancelled") return "cancelled";
    if (b.paidAt) return "paid";
    return b.paymentDeadline && new Date(b.paymentDeadline) < new Date() ? "overdue" : "unpaid";
  }

  function render() {
    const q = $("search").value.trim().toLowerCase();
    const shown = state.bookings.filter((b) => !q || [b.fullName, b.email, b.id, b.company || ""].some((v) => v.toLowerCase().includes(q)));
    const active = state.bookings.filter((b) => b.status === "confirmed");
    $("statActive").textContent = active.length;
    $("statUnpaid").textContent = active.filter((b) => paymentState(b) === "unpaid").length;
    $("statOverdue").textContent = active.filter((b) => paymentState(b) === "overdue").length;
    $("statPaid").textContent = active.filter((b) => paymentState(b) === "paid").length;

    const list = $("list");
    list.replaceChildren();
    if (!shown.length) { list.append(el("div", { className: "card empty", textContent: q ? "Tidak ada booking yang cocok." : "Belum ada booking pada rentang ini." })); return; }
    for (const b of shown) {
      const pay = paymentState(b);
      const badges = el("div", { className: "badges" },
        el("span", { className: "badge", textContent: `${b.serviceTitle} · ${b.durationMinutes} menit · ${b.priceLabel}` }),
        pay === "cancelled" ? el("span", { className: "badge cancelled", textContent: "Dibatalkan" + (b.cancelledAt ? " " + fmtShort(b.cancelledAt) : "") }) : null,
        pay === "paid" ? el("span", { className: "badge paid", textContent: "Lunas " + fmtShort(b.paidAt) }) : null,
        pay === "unpaid" ? el("span", { className: "badge unpaid", textContent: "Belum bayar · batas " + fmtShort(b.paymentDeadline) }) : null,
        pay === "overdue" ? el("span", { className: "badge overdue", textContent: "Lewat batas bayar (" + fmtShort(b.paymentDeadline) + ")" }) : null,
      );
      const who = el("div", { className: "who" },
        el("b", { textContent: b.fullName }),
        el("p", {}, el("a", { href: `mailto:${b.email}`, textContent: b.email }), [b.company, b.role].filter(Boolean).length ? " · " + [b.company, b.role].filter(Boolean).join(" · ") : ""),
        badges,
        el("p", { className: "agenda", textContent: b.agenda }),
        b.cancellationReason ? el("p", { textContent: "Alasan batal: " + b.cancellationReason }) : null,
        el("p", { className: "muted", textContent: "ID " + b.id + (b.createdAt ? " · dibooking " + fmtShort(b.createdAt) : "") }),
      );
      const actions = el("div", { className: "actions" });
      if (b.status === "confirmed") {
        if (b.meetingUrl) actions.append(el("a", { className: "btn ghost", href: b.meetingUrl, target: "_blank", rel: "noopener", textContent: "Buka Google Meet ↗" }));
        const paidBtn = el("button", { className: b.paidAt ? "btn ghost" : "btn", type: "button", textContent: b.paidAt ? "Batalkan tanda lunas" : "Tandai lunas" });
        paidBtn.addEventListener("click", () => markPaid(b, !b.paidAt, paidBtn));
        const cancelBtn = el("button", { className: "btn danger", type: "button", textContent: "Batalkan booking" });
        cancelBtn.addEventListener("click", () => openCancel(b));
        actions.append(paidBtn, cancelBtn);
      }
      list.append(el("article", { className: `card booking${b.status === "cancelled" ? " is-cancelled" : ""}` },
        el("div", { className: "when" }, el("b", { textContent: fmtTime(b.startAt) }), el("span", { textContent: fmtDay(b.startAt) })),
        who, actions));
    }
  }

  async function load() {
    $("listError").hidden = true;
    $("refresh").disabled = true;
    try { state.bookings = (await api(`/bookings?scope=${state.scope}`)).bookings; render(); }
    catch (e) { $("listError").textContent = e.message; $("listError").hidden = false; }
    finally { $("refresh").disabled = false; }
  }

  function replace(updated) {
    state.bookings = state.bookings.map((b) => (b.id === updated.id ? updated : b));
    render();
  }

  async function markPaid(b, paid, btn) {
    btn.disabled = true;
    try { replace((await api(`/bookings/${b.id}/paid`, { method: "POST", body: { paid } })).booking); }
    catch (e) { alert(e.message); btn.disabled = false; }
  }

  function openCancel(b) {
    state.cancelling = b;
    $("cancelWho").textContent = `${b.fullName} · ${b.serviceTitle} · ${fmtDay(b.startAt)}, ${fmtTime(b.startAt)}`;
    $("cancelReason").value = paymentState(b) === "overdue" ? "Pembayaran tidak diterima sampai batas waktu." : "";
    $("cancelNotify").checked = true;
    $("cancelError").hidden = true;
    $("cancelDialog").showModal();
  }

  $("cancelBack").addEventListener("click", () => $("cancelDialog").close());
  $("cancelConfirm").addEventListener("click", async () => {
    const b = state.cancelling, btn = $("cancelConfirm");
    btn.disabled = true;
    try {
      const r = await api(`/bookings/${b.id}/cancel`, { method: "POST", body: { reason: $("cancelReason").value, notify: $("cancelNotify").checked } });
      $("cancelDialog").close();
      replace(r.booking);
      const notes = [];
      if (!r.calendarRemoved) notes.push("acara Google Calendar gagal dihapus, hapus manual di kalender");
      if ($("cancelNotify").checked && !r.emailSent) notes.push("email ke klien gagal terkirim");
      if (notes.length) alert("Booking dibatalkan, tetapi " + notes.join(" dan ") + ".");
    } catch (e) { $("cancelError").textContent = e.message; $("cancelError").hidden = false; }
    finally { btn.disabled = false; }
  });

  function showLogin(message) {
    $("appView").hidden = true; $("logout").hidden = true; $("loginView").hidden = false;
    $("loginError").textContent = message || ""; $("loginError").hidden = !message;
    $("password").focus();
  }
  function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false; $("logout").hidden = false;
    load();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginForm").querySelector("button");
    btn.disabled = true; $("loginError").hidden = true;
    try {
      session.set(await api("/login", { method: "POST", body: { password: $("password").value } }));
      $("password").value = "";
      showApp();
    } catch (err) { $("loginError").textContent = err.message; $("loginError").hidden = false; }
    finally { btn.disabled = false; }
  });
  $("logout").addEventListener("click", () => { session.clear(); state.bookings = []; showLogin(); });
  $("refresh").addEventListener("click", load);
  $("search").addEventListener("input", render);
  document.querySelectorAll("[data-scope]").forEach((btn) => btn.addEventListener("click", () => {
    state.scope = btn.dataset.scope;
    document.querySelectorAll("[data-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    load();
  }));

  if (session.get()) showApp(); else showLogin();
})();
