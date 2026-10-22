(() => {
  "use strict";
  // Public client configuration only. Never put service-role keys or provider secrets here.
  const CONFIG = {
    apiUrl: "https://xjmvgrqtrunfpdkxqdst.supabase.co/functions/v1/booking-api",
    publishableKey: "sb_publishable_6TWSur18V_L3iVQdO8Q8GQ_p2tDBadA",
    // Cloudflare Turnstile *site* key (public). Leave empty only if the backend sets ALLOW_UNVERIFIED_BOOKINGS=true.
    turnstileSiteKey: "",
    timezone: "Asia/Jakarta",
  };
  const SERVICES = {
    coaching: { title:"Coaching Session", heading:"Make room<br>for growth.", description:"Sesi terarah untuk membantu Anda menemukan perspektif dan langkah berikutnya.", duration:45 },
    consulting: { title:"Consulting Session", heading:"Find your<br>next direction.", description:"Diskusi strategis untuk mengurai tantangan dan merumuskan pendekatan yang lebih terarah.", duration:60 }
  };
  const $ = id => document.getElementById(id);
  const state = { service:"coaching", month:new Date(), date:null, time:null, selectedSlot:null, slots:[], lastBooking:null, idemKey:null, captchaToken:"" };
  state.month = new Date(state.month.getFullYear(), state.month.getMonth(), 1);
  const now = new Date();
  const minDate = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  const maxDate = new Date(now.getFullYear(),now.getMonth(),now.getDate()+60);
  const pad=n=>String(n).padStart(2,"0");
  const dateKey=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const sameDay=(a,b)=>a&&b&&dateKey(a)===dateKey(b);
  const formatDate=d=>d?new Intl.DateTimeFormat("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(d):"Belum dipilih";
  const formatShort=d=>d?new Intl.DateTimeFormat("id-ID",{day:"numeric",month:"short",year:"numeric"}).format(d):"Belum dipilih";
  const isAvailable=d=>d>=minDate&&d<=maxDate&&d.getDay()!==0&&d.getDay()!==6;
  const apiReady=()=>!CONFIG.apiUrl.includes("YOUR_PROJECT_REF")&&!CONFIG.publishableKey.includes("YOUR_SUPABASE");
  const newKey=()=>(crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join(""));
  async function api(path, options={}) {
    if(!apiReady()) throw Object.assign(new Error("Booking online belum aktif. Silakan hubungi AKSITAS."),{code:"not_configured"});
    let response;
    try{
      response=await fetch(`${CONFIG.apiUrl}${path}`,{
        ...options,
        headers:{"Content-Type":"application/json","apikey":CONFIG.publishableKey,"Authorization":`Bearer ${CONFIG.publishableKey}`,...(options.headers||{})}
      });
    }catch{throw Object.assign(new Error("Koneksi terputus. Periksa internet Anda lalu coba lagi."),{code:"network"});}
    const payload=await response.json().catch(()=>({error:"Respons server tidak valid."}));
    if(!response.ok) throw Object.assign(new Error(payload.error||"Permintaan gagal. Silakan coba lagi."),{code:payload.code,status:response.status});
    return payload;
  }
  // Bot protection widget, loaded only when a site key is configured.
  function initTurnstile(){
    if(!CONFIG.turnstileSiteKey)return;
    window.onAksitasTurnstile=()=>window.turnstile.render("#captcha",{sitekey:CONFIG.turnstileSiteKey,language:"id",callback:t=>{state.captchaToken=t;},"expired-callback":()=>{state.captchaToken="";},"error-callback":()=>{state.captchaToken="";}});
    const sc=document.createElement("script");sc.src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onAksitasTurnstile&render=explicit";sc.async=true;sc.defer=true;document.head.append(sc);
  }
  const resetCaptcha=()=>{state.captchaToken="";if(window.turnstile&&CONFIG.turnstileSiteKey)window.turnstile.reset("#captcha");};
  function renderCalendar(){
    const year=state.month.getFullYear(),month=state.month.getMonth();
    $("monthLabel").textContent=new Intl.DateTimeFormat("id-ID",{month:"long",year:"numeric"}).format(state.month);
    $("calendarDays").innerHTML="";
    const offset=new Date(year,month,1).getDay(),count=new Date(year,month+1,0).getDate();
    for(let i=0;i<offset;i++){const b=document.createElement("span");b.className="day outside";$("calendarDays").append(b);}
    for(let day=1;day<=count;day++){
      const date=new Date(year,month,day),btn=document.createElement("button");
      btn.type="button";btn.className="day";btn.textContent=day;btn.setAttribute("aria-label",formatDate(date));
      if(isAvailable(date))btn.classList.add("available");
      if(sameDay(state.date,date)){btn.classList.add("selected");btn.setAttribute("aria-pressed","true");}else btn.setAttribute("aria-pressed","false");
      btn.disabled=!isAvailable(date);
      if(isAvailable(date))btn.addEventListener("click",async()=>{
        state.date=date;state.time=null;renderCalendar();renderSummary();await renderTimes();
      });
      $("calendarDays").append(btn);
    }
    $("prevMonth").disabled=year===minDate.getFullYear()&&month<=minDate.getMonth();
    $("nextMonth").disabled=year===maxDate.getFullYear()&&month>=maxDate.getMonth();
    $("prevMonth").style.opacity=$("prevMonth").disabled?".3":"1";$("nextMonth").style.opacity=$("nextMonth").disabled?".3":"1";
  }
  function showSlotMessage(message){
    $("timeSlots").innerHTML="";
    const d=document.createElement("div");d.className="empty-slots";d.textContent=message;$("timeSlots").append(d);
  }
  async function renderTimes(){
    $("timeSlots").innerHTML="";
    $("selectedDateLabel").textContent=state.date?formatDate(state.date):"Pilih tanggal";
    $("availableLabel").textContent=state.date?"Memuat ketersediaan...":"Pilih tanggal untuk melihat waktu";
    if(!state.date){showSlotMessage("Slot waktu akan tampil setelah tanggal dipilih.");return;}
    showSlotMessage("Memeriksa kalender dan jadwal...");
    try{
      const result=await api(`/slots?date=${encodeURIComponent(dateKey(state.date))}&service=${encodeURIComponent(state.service)}`);
      if(!state.date||result.service!==state.service||result.date!==dateKey(state.date))return; // superseded by a newer selection
      $("availableLabel").textContent=result.slots.length?`${result.slots.length} slot tersedia`:"Tidak ada slot tersedia";
      if(!result.slots.length){showSlotMessage("Tidak ada slot tersedia pada tanggal ini. Silakan pilih tanggal lain.");return;}
      state.slots=result.slots;renderTimesFromState();
    }catch(error){
      $("availableLabel").textContent="Ketersediaan belum dapat dimuat";
      showSlotMessage(error.message);
    }
  }
  function renderTimesFromState(){
    $("timeSlots").innerHTML="";
    state.slots.forEach(slot=>{
      const btn=document.createElement("button");btn.type="button";btn.className="time-slot";btn.textContent=slot.label;
      btn.setAttribute("aria-pressed",state.time===slot.start?"true":"false");if(state.time===slot.start)btn.classList.add("selected");
      btn.addEventListener("click",()=>{state.time=slot.start;state.selectedSlot=slot;renderTimesFromState();renderSummary();});
      $("timeSlots").append(btn);
    });
  }
  function renderSummary(){
    const s=SERVICES[state.service];
    $("summaryType").textContent=s.title;$("summaryHeading").innerHTML=s.heading;$("summaryDescription").textContent=s.description;
    $("summaryDuration").textContent=s.duration+" menit";$("summaryDate").textContent=state.date?formatShort(state.date):"Belum dipilih";
    const t=state.selectedSlot?.label || (state.time?new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Jakarta"}).format(new Date(state.time))+" WIB":"Pilih slot waktu");
    $("summaryTime").textContent=t;
  }
  document.querySelectorAll(".service-card").forEach(btn=>btn.addEventListener("click",async()=>{
    state.service=btn.dataset.service;state.time=null;state.selectedSlot=null;
    document.querySelectorAll(".service-card").forEach(b=>{const sel=b===btn;b.classList.toggle("selected",sel);b.setAttribute("aria-pressed",String(sel));});
    renderSummary();if(state.date)await renderTimes();
  }));
  $("prevMonth").addEventListener("click",()=>{if(!$("prevMonth").disabled){state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1);renderCalendar();}});
  $("nextMonth").addEventListener("click",()=>{if(!$("nextMonth").disabled){state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1);renderCalendar();}});
  function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  $("bookingForm").addEventListener("submit",async e=>{
    e.preventDefault();const err=$("formError");err.hidden=true;
    if(!state.date||!state.time){err.textContent="Pilih tanggal dan slot waktu yang tersedia terlebih dahulu.";err.hidden=false;$("calendarDays").scrollIntoView({behavior:"smooth",block:"center"});return;}
    if(!$("bookingForm").reportValidity())return;
    if(!$("consent").checked){err.textContent="Mohon setujui penggunaan data untuk proses booking.";err.hidden=false;return;}
    if(CONFIG.turnstileSiteKey&&!state.captchaToken){err.textContent="Mohon selesaikan verifikasi keamanan terlebih dahulu.";err.hidden=false;return;}
    const submit=$("bookingForm").querySelector('button[type="submit"]');submit.disabled=true;submit.textContent="Memproses booking...";
    const data={service:state.service,startAt:state.time,fullName:$("fullName").value.trim(),email:$("email").value.trim(),company:$("company").value.trim(),role:$("role").value.trim(),agenda:$("agenda").value.trim(),captchaToken:state.captchaToken};
    // The key is reused only when the previous attempt got no answer (network drop), so a retry cannot double book.
    state.idemKey=state.idemKey||newKey();
    try{
      const result=await api("/book",{method:"POST",body:JSON.stringify(data),headers:{"Idempotency-Key":state.idemKey}});
      state.idemKey=null;state.lastBooking=result;
      $("successText").textContent=`Sesi ${SERVICES[result.service||state.service].title} pada ${formatDate(state.date)}, pukul ${result.localTime||state.selectedSlot?.label||""} telah terkonfirmasi. Detail dan tautan Zoom telah dikirim ke ${data.email}. ID booking: ${result.bookingId}.`;
      $("successModal").hidden=false;document.body.classList.add("no-scroll");$("closeModal").focus();
      $("summaryTime").textContent=result.localTime||state.selectedSlot?.label||"Terkonfirmasi";
    }catch(error){
      if(error.code!=="network"&&error.code!=="in_progress")state.idemKey=null;
      err.textContent=error.message||"Booking gagal. Silakan pilih slot lain atau coba lagi.";err.hidden=false;
      if(error.code==="slot_taken"){state.time=null;state.selectedSlot=null;await renderTimes();renderSummary();}
    }finally{resetCaptcha();submit.disabled=false;submit.innerHTML='Ajukan booking <span>↗</span>';}
  });
  function closeModal(){$("successModal").hidden=true;document.body.classList.remove("no-scroll");}
  $("closeModal").addEventListener("click",closeModal);$("successModal").addEventListener("click",e=>{if(e.target===$("successModal"))closeModal();});
  $("downloadIcs").addEventListener("click",()=>{
    const b=state.lastBooking;if(!b?.startAt)return;
    const svc=SERVICES[b.service]||SERVICES[state.service],start=new Date(b.startAt),end=b.endAt?new Date(b.endAt):new Date(start.getTime()+svc.duration*60000);
    const stamp=d=>`${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
    const esc=v=>String(v||"").replace(/\\/g,"\\\\").replace(/,/g,"\\,").replace(/;/g,"\\;").replace(/\n/g,"\\n");
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//AKSITAS//Booking//ID","CALSCALE:GREGORIAN","BEGIN:VEVENT",`UID:${esc(b.bookingId)}@aksitas`,`DTSTAMP:${stamp(new Date())}`,`DTSTART:${stamp(start)}`,`DTEND:${stamp(end)}`,`SUMMARY:${esc(svc.title+" — AKSITAS")}`,`DESCRIPTION:${esc("Booking terkonfirmasi. Zoom: "+(b.joinUrl||"Periksa email konfirmasi"))}`,`LOCATION:${esc(b.joinUrl||"Online via Zoom")}`,"END:VEVENT","END:VCALENDAR"];
    const url=URL.createObjectURL(new Blob([lines.join("\r\n")],{type:"text/calendar;charset=utf-8"})),a=document.createElement("a");
    a.href=url;a.download=`aksitas-booking-${b.bookingId}.ics`;a.click();URL.revokeObjectURL(url);
  });
  $("year").textContent=new Date().getFullYear();
  initTurnstile();renderCalendar();renderTimes();renderSummary();
})();