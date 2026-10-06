import {
  FORECAST_DAYS, avg, sum, syncClock, getTimePref, setTimePref, todayPT, addDays, niceDate,
  hrLong, hrShort, hourPT, planFor, loadModel, now, TZ, NoModelError, getPref, setPref, ptTime, googleCalendarURL, icsText, lookupAppliance, webSearchURL, bestRun, togetherCosts, applianceCosts, isEV, lookupVehicle, looksLikeCar, evAppliance, CHARGERS, bestDelay, getAppliances, saveAppliances,
} from "./core.js";

const $ = s => document.querySelector(s);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cents = d => d < 0.995 ? `${(d * 100).toFixed(d < 0.095 ? 1 : 0)}¢` : `$${d.toFixed(2)}`;

const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorms" };

const compare = (v, typical, [lo, hi], [more, same, less]) => v / typical > hi ? more : v / typical < lo ? less : same;

let appliances = [];
let selected = "all";   // chart view: "all" or an index into appliances
let current = null, plan = null;

// ---------- main render ----------
// Shown instead of predictions when there's no model.json (e.g. while a new model is being built).
function showNoModel(e) {
  if (!(e instanceof NoModelError)) throw e;
  $("#when").textContent = "No price model yet";
  $("#chart-day").textContent = "";
  $("#verdict").textContent = "Predictions will appear once a new model.json is added to the extension folder. " +
    "Your appliances and settings are kept.";
  for (const id of ["#apps", "#chips", "#chart", "#week-bars", "#wx"]) $(id).innerHTML = "";
  for (const id of ["#chart-sub", "#week-sum", "#source", "#foot"]) $(id).textContent = "";
}

// An hour on the plan's 48-hour clock: past midnight it's the next morning
const when = h => h >= 24 ? `${hrLong(h)} (next morning)` : hrLong(h);

// ---------- add to calendar ----------
// One event for a day's plan: a timed block if every appliance's best window fits within MAX_BLOCK hours
// (e.g. "Run appliances, noon–2pm"), otherwise an all-day "Appliance plan" listing each time.
const MAX_BLOCK = 4;
function dayEvent(p, iso) {
  const runs = appliances.map(a => {
    const r = bestRun(p, a);
    return r && { a, start: r.best.start, end: r.best.start + a.hours, cost: r.costs[r.best.start] };
  }).filter(Boolean);
  if (!runs.length) return "";
  const lines = runs.map(x => `${x.a.name}: ${hrLong(x.start)}–${hrLong(x.end)} (~${cents(x.cost)})`).join("\n");
  const details = `Cheapest predicted start times:\n${lines}\n\nFrom Appliance Timer.`;
  const first = Math.min(...runs.map(x => x.start)), last = Math.max(...runs.map(x => x.end));
  return calMenu(last - first <= MAX_BLOCK
    ? { title: "Run appliances", start: ptTime(iso, first), end: ptTime(iso, last), details }
    : { title: "Appliance plan", allDay: true, date: iso, details });
}
// A small menu on each recommendation: Google Calendar (opens a filled-in event) or Apple Calendar (.ics file).
const calEvents = new Map();
let calSeq = 0;
function calMenu(ev) {
  const i = ++calSeq;
  calEvents.set(i, ev);
  return `<details class="cal"><summary>Add to calendar</summary><div class="cal-menu">
    <a href="${esc(googleCalendarURL(ev))}" target="_blank" rel="noopener">Google Calendar</a>
    <button type="button" data-ics="${i}">Apple Calendar</button></div></details>`;
}
function saveICS(ev) {
  const text = icsText(ev), name = ev.title.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".ics";
  if (globalThis.applianceTimerNative?.openICS) return globalThis.applianceTimerNative.openICS(name, text);   // Mac app: opens in Calendar
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/calendar" })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-ics]");
  if (b) { saveICS(calEvents.get(+b.dataset.ics)); b.closest("details").open = false; return; }
  if (e.target.closest(".cal-menu a")) { e.target.closest("details").open = false; return; }
  document.querySelectorAll("details.cal[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; });
});

async function render(iso) {
  current = iso;
  $("#date").value = iso;
  let p;
  try { p = await planFor(iso); } catch (e) { return showNoModel(e); }
  if (current !== iso) return;  // a newer click won the race
  plan = p;
  drawAll();
  markWeekDay(iso);
}

function drawAll() {
  const p = plan, iso = p.iso, today = todayPT();
  $("#when").textContent = iso === today ? `Today, ${niceDate(iso)}` : niceDate(iso);
  const actual = p.priceSource === "actual";
  $("#chart-kind").textContent = actual ? "Actual" : "Predicted";
  // Say which day the chart is for (it follows the selected date, not always today)
  $("#chart-day").textContent = (iso === today ? "Today" :
    new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })) + " · ";

  // --- recommendations ---
  const all = togetherCosts(p, appliances);
  const runs = appliances.map(a => bestRun(p, a));
  const day = iso === today ? "today" : "that day";
  $("#together").innerHTML = "";
  if (!appliances.length) {
    $("#verdict").textContent = "Add your appliances below to get recommendations.";
  } else if (!runs.some(Boolean)) {
    $("#verdict").textContent = "The cheap hours today have passed. Check tomorrow.";
  } else {
    const opts = runs.filter(Boolean).map(r => ({ best: r.costs[r.best.start], worst: r.costs[r.worst.start] }));
    const bestTotal = sum(opts.map(o => o.best)), worstTotal = sum(opts.map(o => o.worst));
    $("#verdict").textContent = `If you ran everything once ${day}: about ${cents(bestTotal)} at the best times vs ${cents(worstTotal)} at the worst.`;
    // Everything started at the same time: the single best common start
    const starts = all.map((c, s) => [c, s]).filter(([c]) => c != null).sort((a, b) => a[0] - b[0]);
    if (appliances.length > 1) $("#together").innerHTML = starts.length
      ? `<b>Run everything together:</b> start at <b>${when(starts[0][1])}</b>, about ${cents(starts[0][0])}` +
        (starts.length > 1 ? ` vs ${cents(starts.at(-1)[0])} at ${when(starts.at(-1)[1])}.` : ".")
      : `<b>Run everything together:</b> no single start time fits every appliance ${day}.`;
  }
  $("#day-cal").innerHTML = dayEvent(p, iso);

  $("#apps").innerHTML = appliances.map((ap, i) => {
    const r = runs[i];
    const head = `<div class="n">${isEV(ap) ? "🔌 " : ""}${esc(ap.name)} · ${ap.kwh} kWh · ${ap.hours}h</div>`;
    if (!r) return `<div class="app">${head}<div class="t">—</div><div class="w">Not enough of today left</div></div>`;
    const c = r.costs;
    const range = isEV(ap) ? `Charges ${hrShort(r.best.start)}–${hrShort(r.best.start + ap.hours)}, ready before ${hrLong(ap.readyBy ?? 7)} tomorrow`
      : r.a === r.b ? `Done by ${hrLong(r.best.start + ap.hours)}` : `Good anytime ${hrShort(r.a)}–${hrShort(r.b)}`;
    let delay = "";
    if (ap.delays?.length && iso === today) {
      const d = bestDelay(p.prices, ap.kwh, ap.hours, ap.delays, hourPT());
      if (d) delay = `<div class="delay">${d.best.delay === 0
        ? "If you load it now: <b>start right away</b>"
        : `If you load it now: <b>Delay ${d.best.delay}h</b> (starts ~${hrLong(d.best.start)}, ~${cents(d.best.cost)})`}</div>`;
    }
    return `<div class="app">${head}
      <div class="t">${hrLong(r.best.start)}${r.best.start >= 24 ? '<span class="tmr"> next morning</span>' : ""}</div><div class="w">${range} · ~${cents(c[r.best.start])}</div>
      <div class="avoid">Worst: ${when(r.worst.start)} · ~${cents(c[r.worst.start])}</div>${delay}${
        ap.note ? `<div class="note">${esc(ap.note)}</div>` : ""}</div>`;
  }).join("");

  // --- chart ---
  if (selected !== "all" && !appliances[selected]) selected = "all";
  $("#chips").innerHTML = [["all", "All appliances"], ...appliances.map((a, i) => [String(i), a.name])]
    .map(([k, label]) => `<button role="tab" class="chip" data-k="${k}" aria-selected="${String(selected) === k}">${esc(label)}</button>`).join("");
  const costs = selected === "all" ? all : applianceCosts(p, appliances[selected]);
  $("#chart-sub").textContent = selected === "all"
    ? "Each bar is the cost of running all your appliances once, if you started them all at that hour."
    : `Each bar is the cost of one ${appliances[selected].hours}h ${isEV(appliances[selected]) ? "charge" : "run"} using ${appliances[selected].kwh} kWh, started at that hour.`;
  chart(appliances.length ? costs : p.prices.map(() => null), p.from);

  // --- weather ---
  const w = p.weather, t = p.typical;
  const tmax = Math.max(...w.temp), tmaxTyp = Math.max(...t.temp);
  const tiles = [];
  if (w.sf) tiles.push(["San Francisco", `${Math.round(w.sf.hi)}° / ${Math.round(w.sf.lo)}°`, WMO[w.sf.code] ?? ""]);
  tiles.push(["Solar · Central Valley", compare(sum(w.rad), sum(t.rad), [0.85, 1.08], ["Sunnier than usual", "Typical", "Cloudier than usual"]),
    `${(sum(w.rad) / 1000).toFixed(1)} kWh/m² of sun`]);
  tiles.push(["Heat · Central Valley", tmax - tmaxTyp > 6 ? "Hotter than usual" : tmaxTyp - tmax > 6 ? "Cooler than usual" : "Typical",
    `High ${Math.round(tmax)}°F in Fresno`]);
  tiles.push(["Wind · Altamont Pass", compare(avg(w.wind), avg(t.wind), [0.75, 1.3], ["Windier than usual", "Typical", "Calmer than usual"]),
    `${Math.round(avg(w.wind))} mph average`]);
  $("#wx").innerHTML = tiles.map(([k, v, d]) => `<div><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");

  const src = $("#source");
  src.className = "source" + (p.mode === "typical" ? " warn" : "");
  src.textContent = p.mode === "forecast"
    ? (p.ahead <= 6 ? "Using the weather forecast." : "Using the weather forecast. More than a week out, so treat it as rough.")
    : p.error ? `Couldn't load the forecast (${p.error}), so this uses typical weather for the date.`
    : p.ahead < 0 ? "Past date, so this uses typical weather for the date."
    : `More than ${FORECAST_DAYS} days out, so this uses typical weather for the date.`;

  const v = p.model.validation["2"];
  $("#foot").textContent = `Costs cover only the energy part of the price (PG&E-area wholesale prices). Days CAISO has published ` +
    `(today, and tomorrow from about 1pm) use its real prices; later days are predicted by a model trained on ${p.model.trained_on} ` +
    `using weather forecasts for 7 sites across California and the most recent published prices. ` +
    `Your bill adds delivery and fixed charges on top. In testing, the model's recommended times got ${Math.round(v.captured_model * 100)}% of the best possible savings.`;
}

// ---------- chart: cost by start hour ----------
function chart(costs, from) {
  const box = $("#chart"); box.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent?.appendChild(e); return e; };
  // Only start hours that haven't passed (on today's date the chart begins at the next full hour), up to the last
  // possible start: past midnight only for runs that may carry on overnight (EVs)
  const last = costs.reduce((m, c, h) => c != null ? h : m, -1);
  const first = costs.findIndex((c, h) => c != null && h >= from);
  if (first > from) from = first;      // e.g. an EV plugged in from 6pm: the chart starts at 6pm
  const hours = costs.map((c, h) => h).filter(h => h >= from && h <= Math.max(last, 23));
  const shown = hours.filter(h => costs[h] != null);
  if (!shown.length) {
    box.innerHTML = `<p class="chart-empty">No start times left today that finish by midnight. Try tomorrow.</p>`;
    return;
  }
  const L = 46, T = 8, W = 336, H = 130, bw = W / hours.length;
  const X = h => L + (h - from) * bw;
  const vals = shown.map(h => costs[h] * 100);  // cents
  const lo = Math.min(0, ...vals), hi = Math.max(...vals);
  const step = niceStep((hi - lo) / 4);
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step || step;
  const Y = v => T + H - (v - yMin) / (yMax - yMin) * H;
  const svg = el("svg", { viewBox: `0 0 ${L + W + 4} ${T + H + 22}`, role: "img", "aria-label": "Predicted cost to run by start hour" }, box);

  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    el("line", { x1: L, x2: L + W, y1: Y(v), y2: Y(v), stroke: Math.abs(v) < 1e-9 ? css("--axis") : css("--grid") }, svg);
    // one unit for the whole axis: dollars once the scale passes $1, cents below
    el("text", { x: L - 5, y: Y(v) + 4, "text-anchor": "end" }, svg).textContent = yMax >= 100
      ? `$${(v / 100).toFixed(step % 100 ? 2 : 0)}` : `${+v.toFixed(1)}¢`;
  }
  // Hour labels: the first visible hour, then round hours spaced to fit.
  const every = hours.length > 16 ? 6 : hours.length > 6 ? 3 : 1;
  hours.filter(h => h === from || (h % every === 0 && h - from >= every / 2))
    .forEach(h => { el("text", { x: X(h) + bw / 2, y: T + H + 17, "text-anchor": "middle" }, svg).textContent = hrShort(h); });

  const ranked = shown.map(h => [costs[h], h]).sort((a, b) => a[0] - b[0]);
  const best3 = new Set(ranked.slice(0, 3).map(([, h]) => h));
  const worst = ranked.at(-1)?.[0];
  const tip = document.createElement("div"); tip.className = "tip"; box.appendChild(tip);

  hours.forEach(h => {
    const c = costs[h];
    if (c != null) {
      const v = c * 100, x = X(h) + 1, w = bw - 2, y0 = Y(0), y1 = Y(v);
      const top = Math.min(y0, y1), bh = Math.abs(y0 - y1), r = Math.min(2, bh, w / 2);
      // rounded at the data end only
      const d = v >= 0
        ? `M${x},${y0} V${top + r} q0,-${r} ${r},-${r} h${w - 2 * r} q${r},0 ${r},${r} V${y0} Z`
        : `M${x},${y0} V${top + bh - r} q0,${r} ${r},${r} h${w - 2 * r} q${r},0 ${r},-${r} V${y0} Z`;
      el("path", { d, fill: best3.has(h) ? css("--bar-best") : css("--bar") }, svg);
    }
    const hit = el("rect", { x: X(h), y: T, width: bw, height: H, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", () => {
      const s = box.clientWidth / (L + W + 4);
      tip.innerHTML = c == null
        ? `<b>Start ${when(h)}</b> · wouldn't finish in time`
        : `<b>Start ${when(h)}</b> · ~${cents(c)}${worst != null && worst - c > 0.0005 ? ` · saves ${cents(worst - c)} vs worst` : ""}`;
      tip.style.opacity = 1;
      tip.style.left = Math.min(Math.max((X(h) + bw / 2) * s - tip.offsetWidth / 2, 0), box.clientWidth - tip.offsetWidth) + "px";
      tip.style.top = Math.max(Y(Math.max(c ?? 0, 0) * 100) * s - tip.offsetHeight - 6, 0) + "px";
    });
    hit.addEventListener("mouseleave", () => tip.style.opacity = 0);
  });
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
}

// ---------- next 7 days ----------
// Cost of running every appliance once at its best time each day (today: remaining hours only).
async function drawWeek() {
  const today = todayPT();
  let days;
  try {
    days = await Promise.all(Array.from({ length: 7 }, async (_, i) => {
      const iso = addDays(today, i), p = await planFor(iso);
      const rs = appliances.map(a => bestRun(p, a));
      const total = rs.every(Boolean) && rs.length ? sum(rs.map(r => r.costs[r.best.start])) : null;
      const bests = rs.map(r => r?.best.start);
      return { iso, total, mode: p.mode, bests, actual: p.priceSource === "actual" };
    }));
  } catch (e) { return showNoModel(e); }
  const valid = days.filter(d => d.total != null);
  if (!appliances.length || !valid.length) {
    $("#week-sum").textContent = appliances.length ? "No start times left in the coming week." : "Add appliances to compare days.";
    $("#week-bars").innerHTML = "";
    return;
  }
  const min = Math.min(...valid.map(d => d.total)), max = Math.max(...valid.map(d => d.total));
  const cheapest = valid.find(d => d.total === min);
  const short = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const long = iso => iso === today ? "today" : new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const pct = max > 0 ? Math.round((1 - min / max) * 100) : 0;
  const times = appliances.map((a, i) => cheapest.bests[i] == null ? null : `${a.name}: ${when(cheapest.bests[i])}`).filter(Boolean);
  const nActual = days.filter(d => d.actual).length;
  $("#week-sum").innerHTML = `Cheapest day: <b>${long(cheapest.iso)}</b>, about ${cents(min)} to run everything once` +
    (pct >= 1 ? `, ${pct}% less than the most expensive day.` : ". Prices look about the same all week.") +
    `<span class="week-src">${nActual === 0 ? "All days predicted by the model."
      : nActual === 1 ? "Today uses CAISO's published prices; later days are predicted by the model."
      : `The first ${nActual} days use CAISO's published prices (✓); later days are predicted by the model.`}</span>` +
    calMenu({ allDay: true, date: cheapest.iso, title: "Cheapest day to run appliances",
      details: `About ${cents(min)} to run everything once${pct >= 1 ? `, ${pct}% less than the most expensive day this week` : ""}. ` +
        `Best start times:\n${times.join("\n")}\n\nFrom Appliance Timer.` });
  $("#week-bars").innerHTML = days.map(d => {
    const h = d.total == null ? 0 : Math.max(4, d.total / max * 100);
    const isCheap = d === cheapest;
    const dayNum = +d.iso.slice(8);
    return `<button class="wday${isCheap ? " cheapest" : ""}" role="listitem" data-iso="${d.iso}"
        title="${long(d.iso)}${d.actual ? " (CAISO's published prices)" : " (predicted)"}: ${d.total == null ? "no start times left" : `about ${cents(d.total)}`}${d.iso === today ? " (rest of today)" : ""}">
      <span class="tag">${isCheap ? "Cheapest" : ""}</span>
      <span class="val">${d.total == null ? "—" : cents(d.total)}</span>
      <span class="col"><span class="bar" style="height:${h}%"></span></span>
      <span class="d"><b>${d.iso === today ? "Today" : short(d.iso)}${d.actual ? " ✓" : ""}</b>${dayNum}</span>
    </button>`;
  }).join("");
  markWeekDay($("#date").value);
}

function markWeekDay(iso) {
  document.querySelectorAll(".wday").forEach(b => {
    if (b.dataset.iso === iso) b.setAttribute("aria-current", "date");
    else b.removeAttribute("aria-current");
  });
}

$("#week-bars").addEventListener("click", e => {
  const b = e.target.closest(".wday"); if (b) render(b.dataset.iso);
});

// ---------- appliance editor ----------
const countText = () => `${appliances.length} ${appliances.length === 1 ? "appliance" : "appliances"}`;

function drawEditor() {
  $("#count").textContent = countText();
  $("#rows").innerHTML = appliances.map((a, i) => `
    <div class="row" data-i="${i}">
      <input class="name" value="${esc(a.name)}" aria-label="Name" maxlength="40">
      <label><input class="kwh" type="number" min="0.1" max="100" step="0.1" value="${a.kwh}" aria-label="kWh per run">kWh</label>
      <label><input class="hours" type="number" min="1" max="12" step="1" value="${a.hours}" aria-label="Run hours">h</label>
      <button class="del" type="button" aria-label="Remove ${esc(a.name)}">×</button>${isEV(a) ? evControls(a) : ""}
    </div>`).join("");
}

// EV rows: when the car is plugged in and when it must be charged by (the next morning)
function evControls(a) {
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${label}</option>`;
  const plug = opt(0, "any time", a.plugIn ?? 0) + Array.from({ length: 23 }, (_, i) => opt(i + 1, hrLong(i + 1), a.plugIn ?? 0)).join("");
  const ready = Array.from({ length: 9 }, (_, i) => opt(i + 4, hrLong(i + 4), a.readyBy ?? 7)).join("");
  const info = a.milesPerDay ? `${a.milesPerDay} mi/day · ${a.chargerKw} kW charger${a.car?.kwhPer100mi ? ` · ${a.car.kwhPer100mi} kWh/100 mi (EPA)` : ""}` : "";
  return `<div class="ev-row">Plugged in from <select class="plug" aria-label="Plugged in from">${plug}</select>
    · ready by <select class="ready" aria-label="Ready by">${ready}</select> next morning
    ${info ? `<span class="ev-info">${esc(info)}</span>` : ""}</div>`;
}

async function commit() {
  await saveAppliances(appliances);
  drawEditor();
  if (plan) drawAll();
  drawWeek();
  globalThis.chrome?.runtime?.sendMessage?.("refresh-badge").catch?.(() => {});
}

$("#rows").addEventListener("change", e => {
  const row = e.target.closest(".row"); if (!row) return;
  if (e.target.classList.contains("plug")) appliances[+row.dataset.i].plugIn = +e.target.value;
  if (e.target.classList.contains("ready")) appliances[+row.dataset.i].readyBy = +e.target.value;
  const a = appliances[+row.dataset.i];
  if (e.target.classList.contains("name")) a.name = e.target.value.trim() || "Appliance";
  if (e.target.classList.contains("kwh")) a.kwh = Math.min(100, Math.max(0.1, +e.target.value || a.kwh));
  if (e.target.classList.contains("hours")) a.hours = Math.min(12, Math.max(1, Math.round(+e.target.value || a.hours)));
  commit();
});
$("#rows").addEventListener("click", e => {
  if (!e.target.classList.contains("del")) return;
  appliances.splice(+e.target.closest(".row").dataset.i, 1);
  commit();
});
// Add: the user types a brand and model number; ENERGY STAR's data gives the energy per run. If it isn't listed
// (or isn't a dishwasher, washer or dryer), a Google search link helps find it, and the user enters it by hand.
let found = [];
async function addAppliance(a, focusKwh = false) {
  appliances.push(a);
  $("#query").value = ""; $("#results").innerHTML = ""; found = [];
  await commit();
  if (focusKwh) { const k = [...document.querySelectorAll("#rows .kwh")].at(-1); k.focus(); k.select(); }
}
$("#add").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $("#query").value.trim(); if (!q) return;
  const google = `<a href="${esc(webSearchURL(q))}" target="_blank" rel="noopener">Search Google for its energy use</a>`;
  const manual = `<button type="button" class="link" data-manual>add it and enter the kWh yourself</button>`;
  $("#results").innerHTML = `<p class="res-note">Looking up…</p>`;
  $("#lookup").disabled = true;
  // Appliances (ENERGY STAR) and cars (EPA) are looked up together
  const [apps, vehicles] = await Promise.all([lookupAppliance(q).catch(() => []), lookupVehicle(q).catch(() => [])]);
  $("#lookup").disabled = false;
  found = apps;
  cars = vehicles.length ? vehicles : looksLikeCar(q) ? [GENERIC_EV] : [];
  const carList = cars.map((c, i) => `
    <button type="button" class="res" data-car="${i}">
      <span class="res-name">🔌 ${esc(c.name)}</span>
      <span class="res-use"><b>${c.kwhPer100mi} kWh per 100 miles</b></span>
      <span class="res-how">${c === GENERIC_EV ? "a typical electric car (no exact match found)" : `EPA fuel economy data${c.type === "EV" ? "" : " · plug-in hybrid"}`}</span>
    </button>`).join("");
  if (cars.length && !found?.length) {
    $("#results").innerHTML = carList + `<p class="res-note">Not your car? Include the year, make and model, e.g. "2024 Tesla Model 3".</p>`;
    found = [];
    return;
  }
  if (found === null) {
    $("#results").innerHTML = `<p class="res-note">Include the model number: it's on a label inside the door or on the back.
      Or ${google.replace("Search", "search")}, then ${manual}.</p>`;
    found = [];
    return;
  }
  $("#results").innerHTML = carList + found.map((f, i) => `
    <button type="button" class="res" data-i="${i}">
      <span class="res-name">${esc(f.name)} <span class="res-model">${esc(f.model)}</span></span>
      <span class="res-use"><b>${f.kwh} kWh</b> per run · ${f.hours}h</span>
      <span class="res-how">${esc(f.how)}</span>
    </button>`).join("") +
    `<p class="res-note">${found.length ? "Not the right one? " : "Not found in ENERGY STAR's list of certified dishwashers, washers and dryers. "}${google}, then ${manual}.</p>`;
});
// Cars: pick one, then say how it's charged and how far it's driven; that sets the energy and charging time
let cars = [];
const GENERIC_EV = { name: "Electric car", make: "Electric", model: "car", kwhPer100mi: 30, type: "EV" };
function carForm(i) {
  const c = cars[i];
  $("#results").innerHTML = `<form class="car-form" data-car="${i}">
    <div class="res-name">🔌 ${esc(c.name)} · ${c.kwhPer100mi} kWh per 100 miles</div>
    <label>Charger <select class="charger">${CHARGERS.map(k => `<option value="${k.kw}">${esc(k.label)}</option>`).join("")}</select></label>
    <label>Miles driven per day <input class="miles" type="number" min="1" max="400" step="1" value="30"></label>
    <p class="res-how car-calc"></p>
    <div class="car-actions"><button type="submit">Add car</button><button type="button" class="link" data-cancel>Cancel</button></div>
  </form>`;
  const form = $(".car-form"), calc = () => {
    const a = evAppliance(c, +form.querySelector(".charger").value, +form.querySelector(".miles").value || 30);
    form.querySelector(".car-calc").textContent = `About ${a.kwh} kWh per day, ${a.hours}h to charge (including ~10% charging losses).`;
  };
  form.addEventListener("input", calc); calc();
  form.addEventListener("submit", e => {
    e.preventDefault();
    const a = evAppliance(c, +form.querySelector(".charger").value, +form.querySelector(".miles").value || 30);
    if (c === GENERIC_EV) a.name = "Electric car";
    addAppliance(a);
  });
  form.querySelector("[data-cancel]").addEventListener("click", () => { $("#results").innerHTML = ""; });
}

$("#results").addEventListener("click", e => {
  const car = e.target.closest(".res[data-car]");
  if (car) return carForm(+car.dataset.car);
  const r = e.target.closest(".res");
  if (r) { const f = found[+r.dataset.i]; return addAppliance({ name: f.name, kwh: f.kwh, hours: f.hours }); }
  if (e.target.closest("[data-manual]")) addAppliance({ name: $("#query").value.trim().slice(0, 40) || "New appliance", kwh: 1, hours: 1 }, true);
});
$("#reset").addEventListener("click", async () => {
  await saveAppliances(null);
  appliances = await getAppliances();
  selected = "all";
  commit();
});

// ---------- alerts (Mac app only) ----------
// "Start now": the Mac app schedules a macOS notification at each appliance's cheapest start (see badge.js).
const NATIVE = globalThis.applianceTimerNative;
async function setupAlerts() {
  if (!NATIVE?.notifications) return;            // Chrome: no alerts, so there are no duplicates
  $("#alerts").hidden = false;
  const prefs = await getPref("alerts", {});
  const status = await NATIVE.notifications("status");
  $("#alert-start").checked = !!prefs.startNow && status === "authorized";
  if (prefs.startNow && status === "denied") showAlertsBlocked();
}
function showAlertsBlocked() {
  $("#alert-note").innerHTML = `<span class="warn">Notifications are off for Appliance Timer.</span> Turn them on in
    System Settings → Notifications → Appliance Timer, then tick the box again.`;
}
$("#alert-start").addEventListener("change", async e => {
  const on = e.target.checked;
  if (on && (await NATIVE.notifications("request")) !== "authorized") {
    e.target.checked = false;
    return showAlertsBlocked();
  }
  $("#alert-note").textContent = "A macOS notification at each appliance's cheapest start time, today and tomorrow.";
  await setPref("alerts", { startNow: on });
  globalThis.__updateBadge?.();                  // reschedules (or clears) the notifications
});

// ---------- when the model was retrained ----------
// The daily job retrains around 2:15pm; more than 36 hours means it missed a run (e.g. the Mac was off), shown in amber.
const STALE_HOURS = 36;
async function drawModelAge() {
  const m = await loadModel().catch(() => null);
  const el = $("#model-age");
  if (!m) { el.textContent = ""; return; }
  const through = new Date(m.trained_through + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (!m.retrained_at) { el.textContent = `Model trained on prices through ${through}`; el.classList.remove("stale"); return; }
  const at = new Date(m.retrained_at);
  const day = at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  const stale = now() - at > STALE_HOURS * 3600e3;
  el.textContent = `Model retrained ${day} at ${time} · prices through ${through}${stale ? " · over a day old" : ""}`;
  el.classList.toggle("stale", stale);
}

// ---------- chips, dates ----------
$("#chips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  selected = b.dataset.k === "all" ? "all" : +b.dataset.k;
  drawAll();
});
$("#timesrc").addEventListener("change", async e => {
  await setTimePref(e.target.value);
  await syncClock();
  drawModelAge();
  render(todayPT());
  drawWeek();
  globalThis.chrome?.runtime?.sendMessage?.("refresh-badge").catch?.(() => {});
});
$("#date").addEventListener("change", e => e.target.value && render(e.target.value));
$("#prev").addEventListener("click", () => render(addDays($("#date").value, -1)));
$("#next").addEventListener("click", () => render(addDays($("#date").value, 1)));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => plan && drawAll());

appliances = await getAppliances();
drawEditor();
$("#timesrc").value = await getTimePref();
await syncClock();
drawModelAge();
setupAlerts();
setInterval(drawModelAge, 10 * 60e3);
render(todayPT());
drawWeek();
globalThis.chrome?.runtime?.sendMessage?.("refresh-badge").catch?.(() => {});
