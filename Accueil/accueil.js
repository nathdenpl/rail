"use strict";

/* ==========================================================
   ACCUEIL
   - Ne charge plus routes.json
   - Charge gares.json (liste des gares)
   - Suggestions sous inputs (fromSuggest/toSuggest) réparées
   - Overlay plein écran conservé
   - Nettoyage: doublons/contradictions retirés, ordre logique
   ========================================================== */

const $ = (id) => document.getElementById(id);

function refreshOverlayBodyClass(){
  const st = document.getElementById("stationOverlay");
  const dt = document.getElementById("dateOverlay");
  const mm = document.getElementById("mobileMenu");
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

async function fetchFirstOk(urls){
  let lastErr = null;
  for(const url of urls){
    try{
      const res = await fetch(url, { cache: "no-store" });
      if(res.ok) return { url, res };
    }catch(err){
      lastErr = err;
    }
  }
  if(lastErr) throw lastErr;
  throw new Error("Aucun chemin ne fonctionne pour gares.json");
}

/* ---------- Normalisation (accents / Saint -> St / compact) ---------- */
function stripDiacritics(str){
  try{
    return str.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  }catch{
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
}

function normalizeStationQuery(s){
  return stripDiacritics(String(s || "").trim().toLowerCase())
    .replace(/[’'`´]/g, "'")
    .replace(/\s+/g, " ");
}

function compactKey(s){
  return normalizeStationQuery(s)
    .replace(/\bsaint\b/g, "st")
    .replace(/\bst\b/g, "st")
    .replace(/[^a-z0-9]/g, "");
}

function uniqueCaseInsensitive(list){
  const seen = new Set();
  const out = [];
  for(const s of list){
    const k = String(s).trim().toLowerCase();
    if(!k) continue;
    if(!seen.has(k)){
      seen.add(k);
      out.push(String(s).trim());
    }
  }
  return out;
}

/* ---------- Données gares ---------- */
let stationsAll = [];
let stationsIndex = []; // [{ name, key, compact }]
let stationsReady = false;

async function loadStations(){
  // Robuste: selon où tu "Go Live", la racine peut changer.
  // On essaye plusieurs chemins plausibles.
  const candidates = [
    "../gares.json",   // FR/Accueil -> FR/gares.json  (structure folders)
    "./gares.json",    // si accueil.html est à la racine FR/
    "gares.json",      // fallback
    "/gares.json"      // fallback absolu
  ];

  const { url, res } = await fetchFirstOk(candidates);
  const data = await res.json();

  // Supporte ton format actuel:
  // { "gares": [ { "name": "Brigue" }, ... ] }
  // + un format futur:
  // { "stations": [ ... ] }
  let names = [];

  if(data && Array.isArray(data.gares)){
    names = data.gares
      .map(x => (x && x.name) ? String(x.name) : "")
      .filter(Boolean);
  }else if(data && Array.isArray(data.stations)){
    names = data.stations
      .map(x => (typeof x === "string") ? x : (x && x.name) ? x.name : "")
      .map(String)
      .filter(Boolean);
  }else{
    throw new Error(`gares.json: format invalide (source: ${url})`);
  }

  stationsAll = uniqueCaseInsensitive(names)
    .sort((a,b)=>a.localeCompare(b, "fr", { sensitivity:"base" }));

  stationsIndex = stationsAll.map(name => ({
    name,
    key: normalizeStationQuery(name),
    compact: compactKey(name)
  }));

  stationsReady = true;

  // Bonus debug (console uniquement)
  console.info("gares.json chargé depuis:", url, "stations:", stationsAll.length);
}

/* ---------- Similarité (erreur humaine: stmaurice, loechelesb...) ---------- */
function levenshtein(a,b){
  a = String(a||"");
  b = String(b||"");
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, ()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + cost
      );
    }
  }
  return dp[m][n];
}

function bestStationGuess(raw){
  const q = normalizeStationQuery(raw);
  if(!q) return null;

  // exact normalisé
  const exact = stationsIndex.find(s => s.key === q);
  if(exact) return exact.name;

  const cq = compactKey(raw);
  if(!cq) return null;

  // exact compact
  const compactExact = stationsIndex.find(s => s.compact === cq);
  if(compactExact) return compactExact.name;

  // contient
  const contains = stationsIndex.filter(s => s.compact.includes(cq) || cq.includes(s.compact));
  if(contains.length){
    contains.sort((a,b)=>{
      const da = Math.abs(a.compact.length - cq.length);
      const db = Math.abs(b.compact.length - cq.length);
      return da - db || a.name.localeCompare(b.name, "fr");
    });
    return contains[0].name;
  }

  // distance d’édition
  let best = null;
  let bestScore = Infinity;
  for(const s of stationsIndex){
    const d = levenshtein(cq, s.compact);
    if(d < bestScore){
      bestScore = d;
      best = s;
    }
  }

  const maxAllowed = cq.length <= 4 ? 1 : cq.length <= 7 ? 2 : 3;
  if(best && bestScore <= maxAllowed) return best.name;

  return best ? best.name : null;
}

/* ---------- Filtrage & suggestions ---------- */
function filterStations(query, limit=12){
  if(!stationsReady) return [];
  const q = normalizeStationQuery(query);
  if(!q) return stationsAll.slice(0, limit);

  const cq = compactKey(query);
  const scored = stationsIndex
    .map(s => {
      const hit = (cq && s.compact.includes(cq)) || s.key.includes(q);
      const dist = cq ? levenshtein(cq, s.compact) : 999;
      return { name: s.name, hit, dist };
    })
    .filter(x => x.hit || x.dist <= 3)
    .sort((a,b)=>a.dist - b.dist || a.name.localeCompare(b.name, "fr"));

  return scored.slice(0, limit).map(x => x.name);
}

function showSuggest(boxEl, names, activeIndex=-1){
  if(!boxEl) return;
  if(!names.length){
    boxEl.classList.remove("open");
    boxEl.innerHTML = "";
    return;
  }

  boxEl.innerHTML = names.map((n, i) =>
    `<div class="suggestItem" data-idx="${i}" role="option" aria-selected="${i===activeIndex}">
      ${n}
    </div>`
  ).join("");

  boxEl.classList.add("open");
}

function hideSuggest(boxEl){
  if(!boxEl) return;
  boxEl.classList.remove("open");
  boxEl.innerHTML = "";
}

function wireInputSuggestions(inputEl, boxEl){
  let items = [];
  let active = -1;

  const refresh = () => {
    items = filterStations(inputEl.value, 12);
    active = -1;
    showSuggest(boxEl, items, active);
  };

  inputEl.addEventListener("input", refresh);
  inputEl.addEventListener("focus", refresh);

  // click sur suggestion
  boxEl.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".suggestItem");
    if(!el) return;
    e.preventDefault(); // empêche blur avant sélection
    const idx = Number(el.dataset.idx);
    const value = items[idx];
    if(value){
      inputEl.value = value;
      hideSuggest(boxEl);
      inputEl.focus();
    }
  });

  inputEl.addEventListener("keydown", (e) => {
    if(!boxEl.classList.contains("open")) return;

    if(e.key === "Escape"){
      e.preventDefault();
      hideSuggest(boxEl);
      return;
    }

    if(e.key === "ArrowDown"){
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
      showSuggest(boxEl, items, active);
      return;
    }

    if(e.key === "ArrowUp"){
      e.preventDefault();
      active = Math.max(active - 1, 0);
      showSuggest(boxEl, items, active);
      return;
    }

    if(e.key === "Enter"){
      // si une suggestion est sélectionnée, on la prend
      if(active >= 0 && items[active]){
        e.preventDefault();
        inputEl.value = items[active];
        hideSuggest(boxEl);
      }
    }
  });

  // fermer quand on clique ailleurs
  document.addEventListener("mousedown", (e) => {
    if(e.target === inputEl) return;
    if(boxEl.contains(e.target)) return;
    hideSuggest(boxEl);
  });

  // au blur: on corrige "au mieux" (saint/loeche etc.)
  inputEl.addEventListener("blur", () => {
    const raw = (inputEl.value || "").trim();
    if(!raw) return;
    const norm = normalizeStationQuery(raw);
    const exact = stationsIndex.find(s => s.key === norm);
    if(exact){ inputEl.value = exact.name; return; }
    const guess = bestStationGuess(raw);
    if(guess) inputEl.value = guess;
  });
}

/* ---------- Overlay plein écran (station picker) ---------- */
let stationPickerOpen = false;
let stationPickerTarget = null;
let suppressPickerFocusUntil = 0;

function renderStationList(query){
  const list = $("stationList");
  if(!list) return;

  const items = filterStations(query, 200);
  list.innerHTML = "";

  let currentLetter = "";
  for(const name of items){
    const letter = (name[0] || "#")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();

    if(letter !== currentLetter){
      currentLetter = letter;
      const section = document.createElement("div");
      section.className = "stationSection";
      section.textContent = currentLetter;
      list.appendChild(section);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stationItem";
    btn.dataset.station = name;
    btn.innerHTML = `<span class="stationName">${name}</span>`;
    btn.addEventListener("click", () => {
      if(stationPickerTarget) stationPickerTarget.value = name;
      closeStationPicker();
    });

    list.appendChild(btn);
  }

  const hint = $("stationHint");
  if(hint){
    if(query && items.length){
      const guess = bestStationGuess(query);
      hint.textContent = guess ? `Entrée = “${guess}”` : "";
    }else{
      hint.textContent = "";
    }
  }
}

function openStationPicker(inputEl){
  if(Date.now() < suppressPickerFocusUntil) return;
  if(stationPickerOpen) return;

  stationPickerTarget = inputEl;
  stationPickerOpen = true;

  window.__fr_closeDateOverlay?.();

  refreshOverlayBodyClass();

  const overlay = $("stationOverlay");
  if(overlay) overlay.hidden = false;

  refreshOverlayBodyClass();

  const q = $("stationSearchInput");
  if(q){
    q.value = inputEl.value || "";
    renderStationList(q.value);
    setTimeout(() => q.focus(), 0);
  }
}

function closeStationPicker(){
  suppressPickerFocusUntil = Date.now() + 400;

  try { $("stationSearchInput")?.blur(); } catch {}
  try { stationPickerTarget?.blur(); } catch {}

  stationPickerOpen = false;
  stationPickerTarget = null;

  refreshOverlayBodyClass();

  const overlay = $("stationOverlay");
  if(overlay) overlay.hidden = true;

  refreshOverlayBodyClass();
}

// expose for other overlays
window.__fr_closeStationPicker = closeStationPicker;


/* ---------- Navigation vers horaires ---------- */
function goToHoraire(){
  const fromEl = $("from");
  const toEl = $("to");
  if(!fromEl || !toEl) return;

  // normalise/guess (soft)
  const fromRaw = (fromEl.value || "").trim();
  const toRaw = (toEl.value || "").trim();

  if(fromRaw){
    const g = bestStationGuess(fromRaw);
    if(g) fromEl.value = g;
  }
  if(toRaw){
    const g = bestStationGuess(toRaw);
    if(g) toEl.value = g;
  }

  const from = (fromEl.value || "").trim();
  const to = (toEl.value || "").trim();

  if(!from || !to){
    // au choix: ouvrir overlay sur champ manquant
    if(!from) openStationPicker(fromEl);
    else openStationPicker(toEl);
    return;
  }

  const params = new URLSearchParams();
  params.set("from", from);
  params.set("to", to);

  const d = ($("mockDate")?.value || "").trim();
  const t = ($("mockTime")?.value || "").trim();
  if(d) params.set("date", d);
  if(t) params.set("time", t);

  window.location.href = `../Horaires/horaires.html?${params.toString()}`;
}

function swapInputs(){
  const a = $("from");
  const b = $("to");
  if(!a || !b) return;
  [a.value, b.value] = [b.value, a.value];
}

/* ---------- INIT ---------- */
(async function init(){
  const fromInput = $("from");
  const toInput = $("to");
  const status = $("status");

  // ne jamais afficher d’erreurs techniques en UI
  if(status) status.textContent = "";

  try{
    const homeBrandLink = document.getElementById("homeBrandLink");

    homeBrandLink?.addEventListener("click", (e) => {
      // On empêche la navigation (sinon jump + éventuel #)
      e.preventDefault();

      // Scroll smooth vers le haut
      window.scrollTo({ top: 0, behavior: "smooth" });

      // Nettoie l’URL si jamais il y a un hash (ex: # ou #top)
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    });

    await loadStations();
    initHeaderMenu();

    // Comportement identique à Horaires: pas de dropdown inline actif.
    // Le choix de gare passe par l'overlay OG.
    // wireInputSuggestions(fromInput, $("fromSuggest"));
    // wireInputSuggestions(toInput, $("toSuggest"));

    // Boutons
    $("searchBtn")?.addEventListener("click", goToHoraire);
    $("swapBtn")?.addEventListener("click", swapInputs);

    // Enter -> rechercher
    fromInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") { e.preventDefault(); goToHoraire(); } });
    toInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") { e.preventDefault(); goToHoraire(); } });

    fromInput?.addEventListener("pointerdown", ()=>{
      fromInput.value = "";
    });
    toInput?.addEventListener("pointerdown", ()=>{
      toInput.value = "";
    });

    $("from")?.addEventListener("focus", (e)=>{ window.__fr_closeDateOverlay?.(); openStationPicker(e.target); });
    $("to")?.addEventListener("focus", (e)=>{ window.__fr_closeDateOverlay?.(); openStationPicker(e.target); });

    // Overlay: fermeture
    $("stationCloseBtn")?.addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation();
      closeStationPicker();
    });

    $("stationOverlay")?.addEventListener("mousedown", (e)=>{
      const sheet = e.currentTarget.querySelector(".stationSheet");
      if(sheet && !sheet.contains(e.target)) closeStationPicker();
    });

    document.addEventListener("keydown", (e)=>{
      if(e.key === "Escape" && stationPickerOpen){
        e.preventDefault();
        closeStationPicker();
      }
    });

    // Overlay: recherche
    $("stationSearchInput")?.addEventListener("input", (e)=>{
      renderStationList(e.target.value);
    });

    $("stationSearchInput")?.addEventListener("keydown", (e)=>{
      if(e.key === "Escape"){
        e.preventDefault();
        closeStationPicker();
        return;
      }
      if(e.key === "Enter"){
        e.preventDefault();
        const raw = e.target.value;
        const guess = bestStationGuess(raw);

        if(guess && stationPickerTarget){
          stationPickerTarget.value = guess;
          closeStationPicker();
          return;
        }

        const firstItem = $("stationList")?.querySelector(".stationItem");
        if(firstItem && stationPickerTarget){
          stationPickerTarget.value = firstItem.dataset.station || "";
          closeStationPicker();
        }
      }
    });

  }catch(err){
    // Log uniquement (pas d’affichage public)
    console.error(err);
    if(status) status.textContent = "";
  }
})();



/* =========================================================
   DATE PICKER OVERLAY (accueil) — inspiré VR.fi
   - date stockée dans #mockDate (input hidden)
   - heure optionnelle dans #mockTime (vide = maintenant si aujourd'hui)
   - limite: -2 semaines / +6 mois
   ========================================================= */
(function initDateOverlayAccueil(){
  const $ = (id)=>document.getElementById(id);
  const overlay = $("dateOverlay");
  const btn = $("dateBtn");
  const btnLabel = $("dateBtnLabel");
  const closeBtn = $("dateCloseBtn");
  const applyBtn = $("dateApplyBtn");
  const monthSel = $("dateMonthSelect");
  const daySel = $("dateDaySelect");
  const md = $("mockDate");
  const mt = $("mockTime");

  if(!overlay || !btn || !btnLabel || !closeBtn || !applyBtn || !monthSel || !daySel || !md || !mt) return;

  const LS_DATE = "fr_date";
  const LS_TIME = "fr_time";

  const fmtMonth = new Intl.DateTimeFormat("fr-FR", { month:"long", year:"numeric" });
  const fmtDow = new Intl.DateTimeFormat("fr-FR", { weekday:"short" });

  function isoDate(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const da = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
  function clampDate(d, min, max){
    if(d < min) return new Date(min);
    if(d > max) return new Date(max);
    return d;
  }
  function startOfDay(d){
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function addDays(d, n){
    const x = new Date(d);
    x.setDate(x.getDate()+n);
    return x;
  }
  function addMonths(d, n){
    const x = new Date(d);
    x.setMonth(x.getMonth()+n);
    return x;
  }
  function limits(){
    const today = startOfDay(new Date());
    const min = addDays(today, -14);
    const max = addMonths(today, 6);
    return { today, min, max };
  }

  function parseSelectedDate(){
    const raw = (md.value || "").trim();
    if(raw){
      const d = new Date(raw+"T00:00:00");
      if(!Number.isNaN(d.getTime())) return d;
    }
    const saved = localStorage.getItem(LS_DATE);
    if(saved){
      const d = new Date(saved+"T00:00:00");
      if(!Number.isNaN(d.getTime())) return d;
    }
    return startOfDay(new Date());
  }

  function setSelectedDate(d){
    const { min, max } = limits();
    const dd = clampDate(startOfDay(d), min, max);
    md.value = isoDate(dd);
    localStorage.setItem(LS_DATE, md.value);
    updateBtnLabel();
  }

  function updateBtnLabel(){
    const sel = parseSelectedDate();
    btnLabel.textContent = `${sel.getDate()}.${sel.getMonth()+1}.${sel.getFullYear()}`;
  }

  function open(){
    // Ferme d'abord l'overlay des gares pour éviter le conflit OG/OD.
    window.__fr_closeStationPicker?.();
    overlay.hidden = false;
    refreshOverlayBodyClass();
    renderMonths();
    syncPickersFromDate(parseSelectedDate());
  }
  function close(){
    overlay.hidden = true;
    refreshOverlayBodyClass();
  }

  function renderMonths(){
    const { min, max } = limits();
    monthSel.innerHTML = "";
    const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
    const end = new Date(max.getFullYear(), max.getMonth(), 1);

    while(cursor <= end){
      const y = cursor.getFullYear();
      const m = cursor.getMonth()+1;
      const opt = document.createElement("option");
      opt.value = `${y}-${String(m).padStart(2,"0")}`;
      opt.textContent = fmtMonth.format(cursor).replace(/^\w/, c=>c.toUpperCase());
      monthSel.appendChild(opt);
      cursor.setMonth(cursor.getMonth()+1);
    }
  }

  function renderDaysForMonth(year, month){
    const { min, max } = limits();
    daySel.innerHTML = "";
    const first = new Date(year, month-1, 1);
    const last = new Date(year, month, 0);
    let cursor = first;
    let lastWeek = null;

    while(cursor <= last){
      const d0 = startOfDay(cursor);
      if(d0 >= min && d0 <= max){
        const week = getISOWeek(d0);
        if(lastWeek !== null && week !== lastWeek){
          const sep = document.createElement("option");
          sep.disabled = true;
          sep.textContent = "────────";
          sep.className = "weekSep";
          daySel.appendChild(sep);
        }
        lastWeek = week;

        const opt = document.createElement("option");
        opt.value = isoDate(d0);
        const wd = fmtDow.format(d0);
        opt.textContent = `${d0.getDate()}. ${wd}`;
        daySel.appendChild(opt);
      }
      cursor = addDays(cursor, 1);
    }
  }

  function syncPickersFromDate(sel){
    const y = sel.getFullYear();
    const m = sel.getMonth()+1;
    const mv = `${y}-${String(m).padStart(2,"0")}`;
    monthSel.value = mv;
    renderDaysForMonth(y, m);
    // choisir le jour exact si présent
    const dv = isoDate(sel);
    const opt = [...daySel.options].find(o=>o.value===dv);
    if(opt) daySel.value = dv;
    else{
      // fallback: premier jour dispo du mois
      const firstValid = [...daySel.options].find(o=>!o.disabled);
      if(firstValid) daySel.value = firstValid.value;
    }
  }

  // ISO week helper
  function getISOWeek(date){
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  // initial values
  setSelectedDate(parseSelectedDate());
  const savedTime = localStorage.getItem(LS_TIME);
  if(savedTime && !mt.value) mt.value = savedTime;

  // events
  // Expose pour permettre à OG de fermer OD proprement.
  window.__fr_closeDateOverlay = close;

  btn.addEventListener("click", (e)=>{ e.preventDefault(); open(); });
  closeBtn.addEventListener("click", (e)=>{ e.preventDefault(); close(); });

  overlay.addEventListener("mousedown", (e)=>{
    const sheet = overlay.querySelector(".dateSheet");
    if(sheet && !sheet.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !overlay.hidden){
      e.preventDefault();
      close();
    }
  });

  monthSel.addEventListener("change", ()=>{
    const [yS,mS] = monthSel.value.split("-");
    const y = Number(yS), m = Number(mS);
    renderDaysForMonth(y,m);
    const firstValid = [...daySel.options].find(o=>!o.disabled);
    if(firstValid) daySel.value = firstValid.value;
  });

  daySel.addEventListener("change", ()=>{
    if(daySel.value) setSelectedDate(new Date(daySel.value+"T00:00:00"));
  });

  overlay.querySelectorAll(".quickBtn").forEach(b=>{
    b.addEventListener("click", ()=>{
      const q = b.dataset.quick;
      const { today } = limits();
      if(q==="today") setSelectedDate(today);
      if(q==="tomorrow") setSelectedDate(addDays(today,1));
      if(q==="after") setSelectedDate(addDays(today,2));
      syncPickersFromDate(parseSelectedDate());
    });
  });

  applyBtn.addEventListener("click", ()=>{
    const v = daySel.value;
    if(v){
      setSelectedDate(new Date(v+"T00:00:00"));
      close();
    }
  });

  mt.addEventListener("input", ()=>{
    localStorage.setItem(LS_TIME, mt.value || "");
  });

})();
