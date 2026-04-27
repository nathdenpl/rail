"use strict";

const $ = (id) => document.getElementById(id);

let routesAll = [];
let routes = [];
let stationsAll = [];
let stationsIndex = [];
let mode = "departures"; // departures | arrivals
let lastRenderedEvents = [];
let lastPastEvents = [];
let modalOpen = false;
let modalEvent = null;
let modalRAF = null;

function normalizeKey(s){ return String(s || "").trim().toLowerCase(); }
function stripDiacritics(s){
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normalizeStationQuery(s){
  let x = stripDiacritics(String(s || "").trim().toLowerCase());
  x = x.replace(/[-'’.,()/]/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  x = x.replace(/\bst\b/g, "saint");
  x = x.replace(/\bpt\b/g, "pont");
  return x;
}
function compactKey(s){ return String(s || "").replace(/\s+/g, ""); }
function stationAbbrevCompact(key){
  return compactKey(
    String(key || "")
      .replace(/\bsaint\b/g, "st")
      .replace(/\bpont\b/g, "pt")
  );
}
function maxTypoDistance(queryLen, candidateLen){
  const q = Number(queryLen) || 0;
  const c = Number(candidateLen) || 0;
  const minLen = Math.min(q, c);
  if(minLen < 5) return 0;
  if(minLen < 8) return 1;
  return 2;
}
function levenshtein(a,b){
  a = String(a || ""); b = String(b || "");
  const n = a.length, m = b.length;
  if(n === 0) return m;
  if(m === 0) return n;
  const dp = new Array(m + 1);
  for(let j=0;j<=m;j++) dp[j] = j;
  for(let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for(let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1] === b[j-1]) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j-1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[m];
}
function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function toMinutes(t){
  if(!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(t));
  if(!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function toSeconds(t){
  const m = toMinutes(t);
  return (m == null) ? null : m * 60;
}
function displayTime(t){
  const m = toMinutes(t);
  if(m == null) return "--";
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}`;
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function lineBadgeClass(line){
  const l = normalizeKey(line);
  if(l.startsWith("ir")) return "moveLine--ir";
  if(l.startsWith("ic")) return "moveLine--ic";
  if(l.startsWith("re")) return "moveLine--re";
  if(l.startsWith("r")) return "moveLine--r";
  return "moveLine--other";
}
function filterStations(query){
  const raw = String(query || "").trim();
  if(!raw) return stationsAll.slice(0, 10);
  const q = normalizeStationQuery(raw);
  const qc = compactKey(q);
  if(!q) return stationsAll.slice(0, 10);

  const scored = [];
  for(const st of stationsIndex){
    let score = 0;
    if(st.key === q || st.compact === qc || st.abbrevCompact === qc) score = 1000;
    else if(st.key.startsWith(q) || st.compact.startsWith(qc) || st.abbrevCompact.startsWith(qc)) score = 900;
    else if(st.key.includes(q) || st.compact.includes(qc) || st.abbrevCompact.includes(qc)) score = 800;
    else{
      const maxD = maxTypoDistance(qc.length, st.compact.length);
      if(maxD > 0){
        const d = Math.min(
          levenshtein(qc, st.compact),
          levenshtein(qc, st.abbrevCompact)
        );
        if(d <= maxD) score = 650 - d * 60;
      }
    }
    if(score > 0) scored.push({ name: st.name, score });
  }
  scored.sort((a,b)=>b.score - a.score || a.name.localeCompare(b.name, "fr", { sensitivity:"base" }));
  return scored.slice(0, 10).map(x=>x.name);
}
function bestStationGuess(raw){
  const q = String(raw || "").trim();
  if(!q) return null;
  const suggestions = filterStations(q);
  if(!suggestions.length) return null;
  const best = suggestions[0];
  const qn = compactKey(normalizeStationQuery(q));
  const bObj = stationsIndex.find(x => x.name === best);
  if(!bObj) return best;
  if(bObj.compact === qn || bObj.abbrevCompact === qn) return best;
  if(bObj.compact.startsWith(qn) || bObj.abbrevCompact.startsWith(qn)) return best;
  if((bObj.compact.includes(qn) || bObj.abbrevCompact.includes(qn)) && qn.length >= 4) return best;
  const maxD = maxTypoDistance(qn.length, bObj.compact.length);
  if(maxD > 0){
    const d = Math.min(
      levenshtein(qn, bObj.compact),
      levenshtein(qn, bObj.abbrevCompact)
    );
    if(d <= maxD) return best;
  }
  return null;
}
function uniqueCaseInsensitive(list){
  const seen = new Set();
  const out = [];
  for(const s of list){
    const k = normalizeKey(s);
    if(!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(s).trim());
  }
  return out;
}

function parseLocalDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
function addDays(d, n){
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}
function addMonthsLocal(d, n){
  const x = new Date(d.getTime());
  const day = x.getDate();
  x.setMonth(x.getMonth() + n);
  if(x.getDate() !== day) x.setDate(0);
  x.setHours(0,0,0,0);
  return x;
}
function isSameLocalDay(a,b){
  return !!a && !!b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function isoDate(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function refreshOverlayBodyClass(){
  const st = $("stationOverlay");
  const dt = $("dateOverlay");
  const mm = $("mobileMenu");
  const open = (st && !st.hidden) || (dt && !dt.hidden) || (mm && !mm.hidden);
  document.body.classList.toggle("overlay-open", !!open);
}

function initHeaderMenu(){
  const btn = $("menuBtn");
  const menu = $("mobileMenu");
  if(!btn || !menu) return;

  function closeMenu(){
    menu.setAttribute("hidden", "");
    btn.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    refreshOverlayBodyClass();
  }

  btn.addEventListener("click", ()=>{
    const opening = menu.hasAttribute("hidden");
    if(opening) menu.removeAttribute("hidden");
    else menu.setAttribute("hidden", "");
    btn.classList.toggle("is-open", opening);
    btn.setAttribute("aria-expanded", String(opening));
    refreshOverlayBodyClass();
  });

  menu.querySelectorAll("a").forEach((a)=>{
    a.addEventListener("click", closeMenu);
  });

  document.addEventListener("mousedown", (e)=>{
    if(menu.hasAttribute("hidden")) return;
    if(menu.contains(e.target) || btn.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener("keydown", (e)=>{
    if(e.key !== "Escape") return;
    if(menu.hasAttribute("hidden")) return;
    closeMenu();
  });
}

async function loadRoutes(){
  const res = await fetch("../routes.json", { cache:"no-store" });
  if(!res.ok) throw new Error("Impossible de charger routes.json");
  const data = await res.json();
  routesAll = (Array.isArray(data.routes) ? data.routes : []).map(r => ({
    id: String(r.id || ""),
    line: String(r.line || ""),
    schedule: Array.isArray(r.schedule) ? r.schedule.map(s => ({
      station: String(s.station || "").trim(),
      arr: s.arr ? String(s.arr) : null,
      dep: s.dep ? String(s.dep) : null,
      voie: (s.Voie ?? s.voie) == null || (s.Voie ?? s.voie) === "" ? null : String(s.Voie ?? s.voie)
    })) : []
  }));
  routes = routesAll.slice();

  const allStations = [];
  for(const r of routes){
    for(const s of r.schedule){
      if(s.station) allStations.push(s.station);
    }
  }
  stationsAll = uniqueCaseInsensitive(allStations)
    .sort((a,b)=>a.localeCompare(b, "fr", { sensitivity:"base" }));
  stationsIndex = stationsAll.map(name=>{
    const key = normalizeStationQuery(name);
    return { name, key, compact: compactKey(key), abbrevCompact: stationAbbrevCompact(key) };
  });
}

function routeTerminus(route){
  if(!route || !route.schedule || route.schedule.length === 0) return "";
  return route.schedule[route.schedule.length - 1].station || "";
}
function routeOrigin(route){
  if(!route || !route.schedule || route.schedule.length === 0) return "";
  return route.schedule[0].station || "";
}

function nowRefMinutesForSelectedDate(){
  const md = parseLocalDate($("mockDate")?.value || "");
  const now = new Date();
  if(md && isSameLocalDay(md, now)) return now.getHours() * 60 + now.getMinutes();
  return 0;
}
function nowSecondsForSelectedDate(){
  const md = parseLocalDate($("mockDate")?.value || "");
  const now = new Date();
  if(md && !isSameLocalDay(md, now)) return -1e12;
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
}

function buildStationEvents(stationName){
  const key = normalizeKey(stationName);
  const out = [];

  for(const r of routes){
    const sched = r.schedule || [];
    for(let i=0;i<sched.length;i++){
      const s = sched[i];
      if(normalizeKey(s.station) !== key) continue;

      if(mode === "departures"){
        // Départs = uniquement une heure de départ réelle.
        const t = s.dep;
        const m = toMinutes(t);
        if(m == null) continue;
        out.push({
          time: t,
          timeMin: m,
          routeId: r.id,
          line: r.line,
          route: r,
          stationName: s.station,
          stationIndex: i,
          focusFromIndex: i,
          focusToIndex: sched.length - 1,
          title: `Direction ${routeTerminus(r)}`,
          subtitle: `Départ de ${s.station}`
        });
      } else {
        // Arrivées = uniquement une heure d'arrivée réelle.
        const t = s.arr;
        const m = toMinutes(t);
        if(m == null) continue;
        out.push({
          time: t,
          timeMin: m,
          routeId: r.id,
          line: r.line,
          route: r,
          stationName: s.station,
          stationIndex: i,
          focusFromIndex: 0,
          focusToIndex: i,
          title: `Depuis ${routeOrigin(r)}`,
          subtitle: `Arrivée à ${s.station}`
        });
      }
      break;
    }
  }

  return out.sort((a,b)=> a.timeMin - b.timeMin || a.routeId.localeCompare(b.routeId, "fr"));
}

function renderEvents(){
  let station = ($("station")?.value || "").trim();
  const title = $("resultTitle");
  const status = $("status");
  const results = $("results");
  if(!title || !status || !results) return;

  const modeLabel = mode === "departures" ? "départs" : "arrivées";
  title.textContent = mode === "departures" ? `Prochains ${modeLabel}` : `Prochaines ${modeLabel}`;

  if(!station){
    status.textContent = "Choisis une gare pour afficher les prochains mouvements.";
    results.innerHTML = "";
    lastRenderedEvents = [];
    lastPastEvents = [];
    return;
  }

  const guess = bestStationGuess(station);
  if(guess){
    station = guess;
    if($("station")) $("station").value = guess;
  }

  const events = buildStationEvents(station);
  const modeLabelSingular = mode === "departures" ? "départ" : "arrivée";

  if(events.length === 0){
    status.textContent = `Aucun ${modeLabelSingular} à venir pour ${station}.`;
    results.innerHTML = "";
    lastRenderedEvents = [];
    lastPastEvents = [];
    return;
  }

  const refMin = nowRefMinutesForSelectedDate();
  const past = events.filter(e => e.timeMin < refMin).sort((a,b)=>a.timeMin - b.timeMin);
  const future = events.filter(e => e.timeMin >= refMin).sort((a,b)=>a.timeMin - b.timeMin);

  const limitedMain = future;
  const limitedPast = past;
  lastRenderedEvents = limitedMain;
  lastPastEvents = limitedPast;

  status.textContent = limitedMain.length
    ? `${limitedMain.length} relation(s) affichée(s) pour ${station}.`
    : `Aucun ${modeLabelSingular} à venir pour ${station}.`;

  const renderCard = (e, idx) => `
    <article class="moveCard is-clickable" data-eventindex="${idx}">
      <div class="moveCard__top">
        <div class="moveTime">${displayTime(e.time)}</div>
        <div class="moveMeta">
          <span class="moveLine ${lineBadgeClass(e.line)}">${escapeHtml(e.line)}</span>
          <h3 class="moveTitle">${escapeHtml(e.title)}</h3>
          <div class="moveSub">${escapeHtml(e.subtitle)}</div>
        </div>
      </div>
    </article>
  `;

  const prevBtn = limitedPast.length
    ? `<button class="prevBtn" id="prevBtn" type="button">Relations précédentes (${limitedPast.length})</button>`
    : "";
  const prevHtml = limitedPast.length
    ? `<div class="prevWrap" id="prevWrap" hidden>${limitedPast.map((e,i)=>renderCard(e, `past:${i}`)).join("")}</div>`
    : "";

  results.innerHTML = `
    <div class="resultsToolbar">${prevBtn}</div>
    ${prevHtml}
    <div class="mainWrap">${limitedMain.map((e,i)=>renderCard(e, i)).join("")}</div>
  `;

  const btn = $("prevBtn");
  if(btn){
    btn.addEventListener("click", ()=>{
      const wrap = $("prevWrap");
      if(!wrap) return;
      const opening = wrap.hasAttribute("hidden");
      if(opening){
        wrap.removeAttribute("hidden");
        btn.textContent = "Masquer les relations précédentes";
      } else {
        wrap.setAttribute("hidden", "");
        btn.textContent = `Relations précédentes (${limitedPast.length})`;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      bindMoveCardClicks();
    });
  }
  bindMoveCardClicks();
}

function stopObj(s){
  return {
    station: s.station,
    arr: s.arr || null,
    dep: s.dep || null,
    voie: (s.voie == null || s.voie === "") ? null : String(s.voie),
    arrMin: toMinutes(s.arr),
    depMin: toMinutes(s.dep)
  };
}

function renderStationCell(stop){
  const voie = (stop && stop.voie != null && String(stop.voie).trim() !== "")
    ? `<span class="vTrack">Voie ${escapeHtml(String(stop.voie))}</span>`
    : "";
  return `<div class="vStation"><span class="vStationName">${escapeHtml(stop?.station || "")}</span>${voie}</div>`;
}

function stopProgressMin(stop, isFirst, isLast){
  if(isFirst) return stop.depMin ?? stop.arrMin ?? null;
  if(isLast) return stop.arrMin ?? stop.depMin ?? null;
  return stop.arrMin ?? stop.depMin ?? null;
}

function setRowTimes(row, modeName){
  const arr = row.dataset.arr || "";
  const dep = row.dataset.dep || "";
  let depAligned = "";
  let arrAbove = "";

  if(modeName === "origin"){
    depAligned = displayTime(dep || arr || "");
  } else if(modeName === "terminus"){
    depAligned = displayTime(arr || dep || "");
  } else {
    depAligned = displayTime(dep || "");
    arrAbove = displayTime(arr || "");
  }

  const timeCell = row.querySelector(".vTimeCell");
  if(!timeCell) return;
  timeCell.innerHTML = `
    ${arrAbove ? `<div class="vArrTime">${escapeHtml(arrAbove)}</div>` : ""}
    <div class="vDepTime">${escapeHtml(depAligned)}</div>
  `;

  const isFirst = modeName === "origin";
  const isLast = modeName === "terminus";
  row.dataset.tmin = stopProgressMin({ arr, dep }, isFirst, isLast) ?? "";
}

function updateUserBoundaryTimes(){
  const wrap = $("modalVWrap");
  if(!wrap) return;
  const user = wrap.querySelector("#userSegment");
  if(!user) return;

  const rows = Array.from(user.querySelectorAll(".vRow"));
  if(rows.length === 0) return;

  const preOpen = !($("foldPre")?.hasAttribute("hidden") ?? true);
  const postOpen = !($("foldPost")?.hasAttribute("hidden") ?? true);
  const first = rows[0];
  const last = rows[rows.length - 1];

  let firstMode = preOpen ? "middle" : "origin";
  let lastMode = postOpen ? "middle" : "terminus";
  if((first.dataset.dep || "") && !(first.dataset.arr || "")) firstMode = "origin";
  if((last.dataset.arr || "") && !(last.dataset.dep || "")) lastMode = "terminus";

  setRowTimes(first, firstMode);
  if(last !== first) setRowTimes(last, lastMode);
}

function getAllModalRowsVisible(){
  const wrap = $("modalVWrap");
  if(!wrap) return [];
  const rows = [];
  const pre = $("foldPre");
  const post = $("foldPost");
  if(pre && !pre.hasAttribute("hidden")) rows.push(...pre.querySelectorAll(".vRow"));
  const user = wrap.querySelector("#userSegment");
  if(user) rows.push(...user.querySelectorAll(".vRow"));
  if(post && !post.hasAttribute("hidden")) rows.push(...post.querySelectorAll(".vRow"));
  return rows;
}

function layoutModalRail(){
  const wrap = $("modalVWrap");
  const rail = $("modalRail");
  if(!wrap || !rail) return;
  const rows = getAllModalRowsVisible();
  if(rows.length < 2) return;

  const wrapRect = wrap.getBoundingClientRect();
  const firstDot = rows[0].querySelector(".vDot");
  const lastDot = rows[rows.length - 1].querySelector(".vDot");
  if(!firstDot || !lastDot) return;

  const a = firstDot.getBoundingClientRect();
  const b = lastDot.getBoundingClientRect();
  const yTop = (a.top + a.bottom) / 2 - wrapRect.top;
  const yBottom = (b.top + b.bottom) / 2 - wrapRect.top;

  rail.style.top = `${yTop}px`;
  rail.style.height = `${Math.max(0, yBottom - yTop)}px`;
}

function bindModalToggles(){
  const wrap = $("modalVWrap");
  if(!wrap) return;
  const overlay = $("modalOverlay");
  const modalEl = overlay ? overlay.querySelector(".modal") : null;

  wrap.querySelectorAll(".vToggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const fold = btn.dataset.toggle === "pre" ? $("foldPre") : $("foldPost");
      if(!fold) return;
      const opening = fold.hasAttribute("hidden");
      if(opening){
        fold.removeAttribute("hidden");
        if(btn.dataset.toggle === "post") fold.after(btn);
      } else {
        fold.setAttribute("hidden", "");
        if(btn.dataset.toggle === "post") fold.before(btn);
      }
      const plus = btn.querySelector(".vTogglePlus");
      if(plus) plus.textContent = opening ? "−" : "+";
      requestAnimationFrame(()=>{
        updateUserBoundaryTimes();
        layoutModalRail();
        updateModalLive();
        if(opening && btn.dataset.toggle === "post" && modalEl){
          modalEl.scrollTo({ top: modalEl.scrollHeight, behavior: "smooth" });
        }
      });
    });
  });
}

function updateModalLive(){
  if(!modalOpen || !modalEvent) return;
  const wrap = $("modalVWrap");
  const dot = $("modalLiveDot");
  const rail = $("modalRail");
  if(!wrap || !dot || !rail) return;

  const nowBase = nowSecondsForSelectedDate();
  const rows = getAllModalRowsVisible().filter(r => r.offsetParent !== null);
  if(rows.length < 2){
    wrap.classList.remove("is-live");
    return;
  }

  const wrapRect = wrap.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const railTop = railRect.top - wrapRect.top;
  const railBottom = railRect.bottom - wrapRect.top;

  const rawStops = rows.map(row=>{
    const dotEl = row.querySelector(".vDot");
    if(!dotEl) return null;
    const dr = dotEl.getBoundingClientRect();
    const y = (dr.top + dr.bottom) / 2 - wrapRect.top;
    return { y, arrSec: toSeconds(row.dataset.arr || ""), depSec: toSeconds(row.dataset.dep || "") };
  }).filter(Boolean);
  if(rawStops.length < 2){
    wrap.classList.remove("is-live");
    return;
  }

  // Déplie les horaires pour gérer les trajets qui passent minuit.
  let dayOffset = 0;
  let last = null;
  const unwrap = (v)=>{
    if(v == null) return null;
    let u = v + dayOffset;
    if(last != null && u < last){
      dayOffset += 86400;
      u = v + dayOffset;
    }
    last = u;
    return u;
  };

  const stops = rawStops.map(s => ({
    y: s.y,
    arrSec: unwrap(s.arrSec),
    depSec: unwrap(s.depSec)
  }));

  const firstDep = stops.find(s => s.depSec != null);
  const lastArr = [...stops].reverse().find(s => s.arrSec != null);
  if(!firstDep || !lastArr){
    wrap.classList.remove("is-live");
    return;
  }

  const nowCandidates = [nowBase, nowBase + 86400];
  const now = nowCandidates.find(x => x >= firstDep.depSec && x <= lastArr.arrSec);

  const isLive = now != null;
  wrap.classList.toggle("is-live", isLive);
  if(!isLive) return;

  for(const s of stops){
    if(s.arrSec != null && s.depSec != null && now >= s.arrSec && now < s.depSec){
      dot.style.top = `${clamp(s.y, railTop, railBottom)}px`;
      return;
    }
  }

  for(let i=0;i<stops.length-1;i++){
    const a = stops[i];
    const b = stops[i+1];
    if(a.depSec == null || b.arrSec == null) continue;
    if(now >= a.depSec && now <= b.arrSec){
      const pct = clamp((now - a.depSec) / Math.max(0.001, b.arrSec - a.depSec), 0, 1);
      const y = a.y + pct * (b.y - a.y);
      dot.style.top = `${clamp(y, railTop, railBottom)}px`;
      return;
    }
  }
}

function loopModalLive(){
  updateModalLive();
  modalRAF = requestAnimationFrame(loopModalLive);
}

function renderModalTimeline(event){
  const route = event.route;
  const sched = route.schedule || [];
  const iFrom = event.focusFromIndex;
  const iTo = event.focusToIndex;

  const pre = iFrom > 0 ? sched.slice(0, iFrom).map(stopObj) : [];
  const mid = sched.slice(iFrom, iTo + 1).map(stopObj);
  const post = iTo < sched.length - 1 ? sched.slice(iTo + 1).map(stopObj) : [];

  const rowHTML = (s, muted) => {
    const isFirst = !!(s.dep && !s.arr);
    const isLast = !!(s.arr && !s.dep);
    let depAligned = "";
    let arrAbove = "";

    if(isFirst){
      depAligned = displayTime(s.dep || s.arr || "");
    } else if(isLast){
      depAligned = displayTime(s.arr || s.dep || "");
    } else {
      depAligned = displayTime(s.dep || "");
      arrAbove = displayTime(s.arr || "");
    }

    const tMin = stopProgressMin(s, isFirst, isLast);
    return `
      <div class="vRow ${muted ? "is-muted" : ""}" data-arr="${escapeHtml(s.arr || "")}" data-dep="${escapeHtml(s.dep || "")}" data-tmin="${tMin ?? ""}">
        <div class="vTimeCell">
          ${arrAbove ? `<div class="vArrTime">${escapeHtml(arrAbove)}</div>` : ""}
          <div class="vDepTime">${escapeHtml(depAligned)}</div>
        </div>
        <div class="vLineCol"><span class="vDot"></span></div>
        ${renderStationCell(s)}
      </div>
    `;
  };

  const toggleRow = (kind, text) => `
    <button class="vToggle" type="button" data-toggle="${escapeHtml(kind)}">
      <span class="vTogglePlus">+</span>
      <span class="vToggleText">${escapeHtml(text)}</span>
    </button>
  `;

  return `
    <div class="vWrap" id="modalVWrap">
      <div class="vRail" id="modalRail"></div>
      <div class="vLive" id="modalLiveDot"></div>
      ${pre.length ? toggleRow("pre", `Itinéraire depuis ${pre[0].station}`) : ""}
      <div class="vFold" id="foldPre" hidden>${pre.map(s => rowHTML(s, true)).join("")}</div>
      <div id="userSegment">${mid.map(s => rowHTML(s, false)).join("")}</div>
      ${post.length ? toggleRow("post", `Itinéraire jusqu’à ${post[post.length-1].station}`) : ""}
      <div class="vFold" id="foldPost" hidden>${post.map(s => rowHTML(s, true)).join("")}</div>
    </div>
  `;
}

function openModal(event){
  modalOpen = true;
  modalEvent = event;
  const overlay = $("modalOverlay");
  const title = $("modalTitle");
  const sub = $("modalSub");
  const body = $("modalBody");
  if(!overlay || !title || !sub || !body) return;

  const station = $("station")?.value || event.stationName || "";
  title.textContent = `${station} · ${mode === "departures" ? "départ" : "arrivée"}`;
  sub.textContent = `${event.line} · ${event.routeId} · ${event.title}`;
  body.innerHTML = renderModalTimeline(event);

  bindModalToggles();
  overlay.hidden = false;
  document.body.classList.add("modalOpen");
  requestAnimationFrame(()=>{
    updateUserBoundaryTimes();
    layoutModalRail();
    updateModalLive();
  });

  if(modalRAF != null) cancelAnimationFrame(modalRAF);
  modalRAF = requestAnimationFrame(loopModalLive);
}

function closeModal(){
  modalOpen = false;
  modalEvent = null;
  const overlay = $("modalOverlay");
  if(overlay) overlay.hidden = true;
  document.body.classList.remove("modalOpen");
  if(modalRAF != null){
    cancelAnimationFrame(modalRAF);
    modalRAF = null;
  }
}

function bindMoveCardClicks(){
  document.querySelectorAll(".moveCard[data-eventindex]").forEach(card=>{
    card.addEventListener("click", ()=>{
      const id = String(card.dataset.eventindex || "");
      let event = null;
      if(/^\d+$/.test(id)){
        event = lastRenderedEvents[Number(id)] || null;
      } else {
        const m = /^past:(\d+)$/.exec(id);
        if(m) event = lastPastEvents[Number(m[1])] || null;
      }
      if(!event) return;
      openModal(event);
    });
  });
}

function bindModalEvents(){
  const overlay = $("modalOverlay");
  const closeBtn = $("modalCloseBtn");
  if(!overlay) return;

  overlay.addEventListener("mousedown", (e)=>{
    const modal = overlay.querySelector(".modal");
    if(modal && !modal.contains(e.target)) closeModal();
  });
  closeBtn?.addEventListener("click", closeModal);
}

function setMode(nextMode){
  mode = nextMode === "arrivals" ? "arrivals" : "departures";
  const toggle = $("modeToggle");
  const dep = $("modeDepartures");
  const arr = $("modeArrivals");
  if(toggle) toggle.dataset.mode = mode;
  if(dep){
    const active = mode === "departures";
    dep.classList.toggle("is-active", active);
    dep.setAttribute("aria-selected", String(active));
  }
  if(arr){
    const active = mode === "arrivals";
    arr.classList.toggle("is-active", active);
    arr.setAttribute("aria-selected", String(active));
  }
  renderEvents();
}

let stationPickerOpen = false;
function renderStationList(filterText){
  const list = $("stationList");
  const hint = $("stationHint");
  if(!list) return;

  const q = String(filterText || "").trim();
  const items = q ? filterStations(q) : stationsAll.slice(0, 200);

  list.innerHTML = "";
  let currentLetter = "";
  for(const name of items){
    const letter = (name[0] || "#").toUpperCase();
    if(letter !== currentLetter){
      currentLetter = letter;
      const sec = document.createElement("div");
      sec.className = "stationSection";
      sec.textContent = letter;
      list.appendChild(sec);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stationItem";
    btn.textContent = name;
    btn.addEventListener("click", ()=>{
      $("station").value = name;
      closeStationPicker();
      renderEvents();
    });
    list.appendChild(btn);
  }

  if(hint){
    const guess = bestStationGuess(q);
    hint.textContent = guess ? `Entrée = valider « ${guess} »` : (items.length ? `Entrée = « ${items[0]} »` : "Aucune gare");
  }
}

function openStationPicker(){
  stationPickerOpen = true;
  $("dateOverlay").hidden = true;
  const overlay = $("stationOverlay");
  overlay.hidden = false;
  refreshOverlayBodyClass();
  const s = $("stationSearchInput");
  if(s){
    // UX demandé: on repart sur un champ vide pour retaper rapidement une autre gare.
    s.value = "";
    renderStationList(s.value);
    setTimeout(()=>s.focus(), 0);
  }
}

function closeStationPicker(){
  stationPickerOpen = false;
  const overlay = $("stationOverlay");
  overlay.hidden = true;
  refreshOverlayBodyClass();
}

function parseSelectedDate(){
  const raw = ($("mockDate")?.value || "").trim();
  return parseLocalDate(raw) || new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
}

function updateDateLabel(){
  const d = parseSelectedDate();
  const lbl = $("dateBtnLabel");
  if(lbl) lbl.textContent = `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()}`;
}

function dateLimits(){
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0,0,0,0);
  return { min: addDays(t0, -14), max: addMonthsLocal(t0, 6), today: t0 };
}

function clampSelectedDate(){
  const md = $("mockDate");
  if(!md) return;
  const d = parseSelectedDate();
  const { min, max } = dateLimits();
  const c = d < min ? min : d > max ? max : d;
  md.value = isoDate(c);
}

function renderMonths(){
  const monthSel = $("dateMonthSelect");
  if(!monthSel) return;
  monthSel.innerHTML = "";

  const { min, max } = dateLimits();
  const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  const end = new Date(max.getFullYear(), max.getMonth(), 1);

  while(cursor <= end){
    const y = cursor.getFullYear();
    const m = cursor.getMonth() + 1;
    const opt = document.createElement("option");
    opt.value = `${y}-${String(m).padStart(2,"0")}`;
    opt.textContent = cursor.toLocaleDateString("fr-FR", { month:"long", year:"numeric" });
    monthSel.appendChild(opt);
    cursor.setMonth(cursor.getMonth() + 1);
  }
}

function renderDaysForMonth(year, month){
  const daySel = $("dateDaySelect");
  if(!daySel) return;
  daySel.innerHTML = "";

  const { min, max } = dateLimits();
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);

  for(let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)){
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if(day < min || day > max) continue;
    const opt = document.createElement("option");
    opt.value = isoDate(day);
    opt.textContent = `${day.getDate()}. ${day.toLocaleDateString("fr-FR", { weekday:"short" })}`;
    daySel.appendChild(opt);
  }
}

function syncDatePickersFromSelectedDate(){
  const d = parseSelectedDate();
  const monthSel = $("dateMonthSelect");
  const daySel = $("dateDaySelect");
  if(!monthSel || !daySel) return;

  monthSel.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  renderDaysForMonth(d.getFullYear(), d.getMonth() + 1);
  daySel.value = isoDate(d);
}

function updateDayNavState(){
  const prev = $("dayPrevBtn");
  const next = $("dayNextBtn");
  if(!prev || !next) return;
  const d = parseSelectedDate();
  const { min, max } = dateLimits();
  prev.disabled = addDays(d, -1) < min;
  next.disabled = addDays(d, 1) > max;
}

function openDateOverlay(){
  closeStationPicker();
  const overlay = $("dateOverlay");
  overlay.hidden = false;
  refreshOverlayBodyClass();
  renderMonths();
  syncDatePickersFromSelectedDate();
}

function closeDateOverlay(){
  const overlay = $("dateOverlay");
  overlay.hidden = true;
  refreshOverlayBodyClass();
}

function stepDay(delta){
  const md = $("mockDate");
  const d = parseSelectedDate();
  const { min, max } = dateLimits();
  const n = addDays(d, delta);
  if(n < min || n > max) return;
  md.value = isoDate(n);
  updateDateLabel();
  updateDayNavState();
  renderEvents();
}

(async function init(){
  await loadRoutes();
  initHeaderMenu();
  bindModalEvents();

  const today = dateLimits().today;
  $("mockDate").value = isoDate(today);
  clampSelectedDate();
  updateDateLabel();
  updateDayNavState();

  $("searchBtn")?.addEventListener("click", renderEvents);
  $("station")?.addEventListener("focus", ()=>{
    // UX demandé: efface la saisie courante avant réécriture.
    $("station").value = "";
    openStationPicker();
  });
  $("station")?.addEventListener("keydown", (e)=>{ if(e.key === "Enter") renderEvents(); });

  $("stationCloseBtn")?.addEventListener("click", closeStationPicker);
  $("stationOverlay")?.addEventListener("mousedown", (e)=>{
    const sheet = e.currentTarget.querySelector(".stationSheet");
    if(sheet && !sheet.contains(e.target)) closeStationPicker();
  });
  $("stationSearchInput")?.addEventListener("input", (e)=> renderStationList(e.target.value));
  $("stationSearchInput")?.addEventListener("keydown", (e)=>{
    if(e.key === "Escape"){
      e.preventDefault();
      closeStationPicker();
      return;
    }
    if(e.key === "Enter"){
      e.preventDefault();
      const raw = String($("stationSearchInput")?.value || "");
      const guess = bestStationGuess(raw);
      if(guess){
        $("station").value = guess;
        closeStationPicker();
        renderEvents();
        return;
      }
      const first = $("stationList")?.querySelector(".stationItem");
      if(first){
        $("station").value = first.textContent || "";
        closeStationPicker();
        renderEvents();
      }
    }
  });

  $("dateBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); openDateOverlay(); });
  $("dateCloseBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); closeDateOverlay(); });
  $("dateOverlay")?.addEventListener("mousedown", (e)=>{
    const sheet = e.currentTarget.querySelector(".dateSheet");
    if(sheet && !sheet.contains(e.target)) closeDateOverlay();
  });

  $("dateMonthSelect")?.addEventListener("change", ()=>{
    const v = $("dateMonthSelect").value;
    const parts = v.split("-");
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    renderDaysForMonth(y, m);
    const first = $("dateDaySelect")?.querySelector("option");
    if(first) $("dateDaySelect").value = first.value;
  });

  $("dateApplyBtn")?.addEventListener("click", ()=>{
    const v = $("dateDaySelect")?.value;
    if(v){
      $("mockDate").value = v;
      clampSelectedDate();
      updateDateLabel();
      updateDayNavState();
      closeDateOverlay();
      renderEvents();
    }
  });

  document.querySelectorAll("#dateOverlay .quickBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const q = btn.dataset.quick;
      const { today } = dateLimits();
      if(q === "today") $("mockDate").value = isoDate(today);
      if(q === "tomorrow") $("mockDate").value = isoDate(addDays(today, 1));
      if(q === "after") $("mockDate").value = isoDate(addDays(today, 2));
      clampSelectedDate();
      syncDatePickersFromSelectedDate();
      updateDateLabel();
      updateDayNavState();
    });
  });

  $("dayPrevBtn")?.addEventListener("click", ()=> stepDay(-1));
  $("dayNextBtn")?.addEventListener("click", ()=> stepDay(1));

  $("modeDepartures")?.addEventListener("click", ()=> setMode("departures"));
  $("modeArrivals")?.addEventListener("click", ()=> setMode("arrivals"));

  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape"){
      closeModal();
      closeStationPicker();
      closeDateOverlay();
    }
  });
})();
