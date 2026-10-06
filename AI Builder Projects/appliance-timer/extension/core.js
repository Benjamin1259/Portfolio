// Shared logic for the popup and the background badge updater.

export const TZ = "America/Los_Angeles";
export const FORECAST_DAYS = 16;
const SITES = { fresno: [36.737, -119.787], altamont: [37.735, -121.650], sf: [37.758, -122.435] };

// Starting points for the appliance list; users edit their own copy in the popup.
// kWh per run and whole-hour run lengths are typical values, not your machines.
export const PRESETS = [
  // Energy Star: 239 kWh/yr over 215 test cycles ≈ 1.1 kWh per Normal cycle.
  // Its Delay Start only offers 3, 6 or 9 hours.
  { name: "Samsung dishwasher", model: "DW80CG4021SR", kwh: 1.1, hours: 2, delays: [3, 6, 9] },
  // Inglis (Whirlpool) top-load agitator washer, mechanical timer: motor only on cold/cold.
  { name: "Inglis washer", model: "top-load", kwh: 0.3, hours: 1,
    note: "No delay start, so start it by hand. Hot water is heated by your water heater, not counted here." },
  // Insignia NS-TDRG67W1 is gas-fired: heat comes from gas; electricity only runs the drum motor.
  { name: "Insignia gas dryer", model: "NS-TDRG67W1", kwh: 0.3, hours: 1,
    note: "Gas dryer: only the drum motor uses electricity, so timing barely changes your bill." },
  { name: "Dishwasher", kwh: 1.2, hours: 2 },
  { name: "Washer", kwh: 0.5, hours: 1 },
  { name: "Dryer (electric)", kwh: 3.0, hours: 1 },
  { name: "Dryer (heat pump)", kwh: 1.5, hours: 2 },
  { name: "EV charging", kwh: 30, hours: 4 },
  { name: "Oven", kwh: 2.5, hours: 1 },
  { name: "Water heater boost", kwh: 4.0, hours: 2 },
  { name: "Pool pump", kwh: 6.0, hours: 4 },
];
const DEFAULT_APPLIANCES = ["Samsung dishwasher", "Inglis washer", "Insignia gas dryer"]
  .map(n => ({ ...PRESETS.find(p => p.name === n) }));
const APPLIANCES_KEY = "appliances";

// ---------- saved settings ----------
// In Chrome, settings are shared with the Mac app when it's installed: the extension reaches the app's settings file
// through native messaging (Chrome starts the app in a small helper mode). Chrome's own storage keeps a copy and is
// used alone when the Mac app isn't there. In the Mac app, chrome.storage.local is the app's shim (the same file).
const NATIVE_HOST = "com.appliance_timer.settings";
const chromeLocal = globalThis.chrome?.storage?.local;
const canNative = !!globalThis.chrome?.runtime?.sendNativeMessage;
const native = msg => new Promise(resolve => {
  try { chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, r => resolve(chrome.runtime.lastError ? null : r)); }
  catch { resolve(null); }
});
const store = chromeLocal && {
  async get(key) {
    if (canNative) {
      const r = await native({ op: "get", key });
      if (r?.ok && r.value != null) return { [key]: r.value };
      if (r?.ok) {            // the Mac app has nothing for this yet: share Chrome's copy with it
        const mine = await chromeLocal.get(key);
        if (mine[key] != null) await native({ op: "set", items: { [key]: mine[key] } });
        return mine;
      }
    }
    return chromeLocal.get(key);
  },
  async set(items) {
    await chromeLocal.set(items);
    if (canNative) await native({ op: "set", items });
  },
};

export async function getAppliances() {
  try {
    const saved = store ? (await store.get(APPLIANCES_KEY))[APPLIANCES_KEY]
      : JSON.parse(localStorage.getItem(APPLIANCES_KEY) ?? "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through to defaults */ }
  return DEFAULT_APPLIANCES.map(a => ({ ...a }));
}

export async function saveAppliances(list) {
  try {
    if (store) await store.set({ [APPLIANCES_KEY]: list });
    else localStorage.setItem(APPLIANCES_KEY, JSON.stringify(list));
  } catch { /* list just won't persist */ }
}

// ---------- appliance lookup ----------
// Finds a model's energy use in ENERGY STAR's public certified-products data (data.energystar.gov, no key needed).
// Its yearly kWh is turned into kWh per run with the yearly run counts of the federal test procedures.
const ENERGY_STAR = [
  { id: "q8py-6w3f", kind: "dishwasher", annual: "annual_energy_use_kwh_year", runs: 215, hours: 2 },
  { id: "bghd-e2wd", kind: "washer", annual: "annual_energy_use_kwh_year", runs: 295, hours: 1 },
  { id: "t9u7-4d2j", kind: "dryer", annual: "estimated_annual_energy_use_kwh_yr", runs: 283, hours: 1 },
];
const GAS_DRYER_KWH = 0.3;  // a gas dryer's yearly figure includes the gas; its electricity is just the drum motor

const alnum = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
// Words that look like model numbers: letters and digits mixed, 5+ characters
const modelWords = q => q.split(/\s+/).filter(w => alnum(w).length >= 5 && /\d/.test(w) && /[a-z]/i.test(w));

// ENERGY STAR model patterns: each * stands for one optional character (letter, digit or nothing)
const wildcard = m => new RegExp("^" + m.toUpperCase().replace(/[^A-Z0-9*]/g, "").replace(/\*/g, "[A-Z0-9]?") + "$");

// ---------- EV lookup ----------
// Electric cars from the EPA's fueleconomy.gov database (free, no key): energy use in kWh per 100 miles.
// The user types year, make and model ("2024 Tesla Model 3"); the year defaults to the latest few model years.
const FE = "https://www.fueleconomy.gov/ws/rest/vehicle";
const feJSON = async path => {
  const r = await fetch(FE + path, { headers: { Accept: "application/json" } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  const items = j?.menuItem ?? j;
  return Array.isArray(items) ? items : items ? [items] : [];
};
export const CHARGING_LOSS = 0.9;   // ~10% of the energy from the wall is lost while charging
export const CHARGERS = [
  { kw: 7.2, label: "Level 2 home charger (7.2 kW)" },
  { kw: 11.5, label: "Level 2 home charger (11.5 kW)" },
  { kw: 1.4, label: "Regular outlet (1.4 kW)" },
];
const looksLikeCar = q => /\b(ev|car|electric vehicle|tesla|rivian|lucid|polestar|bolt|leaf|ioniq|mach-e|model [3sxy])\b/i.test(q);

/** EVs and plug-in hybrids matching the text: [{name, year, make, model, kwhPer100mi, type}], best first. */
export async function lookupVehicle(query) {
  const words = query.toLowerCase().replace(/[^a-z0-9. -]/g, " ").split(/\s+/).filter(Boolean);
  const yearWord = words.find(w => /^(20[1-3]\d)$/.test(w));
  const thisYear = new Date().getFullYear();
  const years = yearWord ? [+yearWord] : [thisYear + 1, thisYear, thisYear - 1];
  const rest = words.filter(w => w !== yearWord);
  const found = [];
  for (const year of years) {
    const makes = await feJSON(`/menu/make?year=${year}`).catch(() => []);
    const make = makes.map(m => m.value).find(m => m.toLowerCase().split(/\s+/).every(part => rest.includes(part)));
    if (!make) continue;
    const modelWords = rest.filter(w => !make.toLowerCase().split(/\s+/).includes(w) && !["ev", "car", "electric"].includes(w));
    const models = (await feJSON(`/menu/model?year=${year}&make=${encodeURIComponent(make)}`).catch(() => []))
      .map(m => m.value).filter(m => modelWords.every(w => m.toLowerCase().includes(w))).slice(0, 6);
    const cars = await Promise.all(models.map(async model => {   // in parallel: one request chain per model
      const opts = await feJSON(`/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`).catch(() => []);
      for (const o of opts.slice(0, 2)) {
        const v = await fetch(`${FE}/${o.value}`, { headers: { Accept: "application/json" } }).then(r => r.json()).catch(() => null);
        if (v && ["EV", "Plug-in Hybrid"].includes(v.atvType) && +v.combE > 0)
          return { name: `${year} ${make} ${model}`, year, make, model, kwhPer100mi: +(+v.combE).toFixed(1), type: v.atvType };
      }
      return null;
    }));
    found.push(...cars.filter(Boolean));
    if (found.length) break;
  }
  return found.slice(0, 5);
}
export { looksLikeCar };

/** An EV appliance entry from a car, charger power and miles driven per day. */
export function evAppliance(car, chargerKw, milesPerDay) {
  const kwh = Math.min(100, Math.max(0.1, Math.round(milesPerDay * car.kwhPer100mi / 100 / CHARGING_LOSS * 10) / 10));
  return {
    type: "ev", name: `${car.make} ${car.model}`.slice(0, 40), kwh,
    hours: Math.min(12, Math.max(1, Math.ceil(kwh / chargerKw))),
    car: { year: car.year, kwhPer100mi: car.kwhPer100mi }, chargerKw, milesPerDay, plugIn: 0, readyBy: 7,
  };
}

export const webSearchURL = q => `https://www.google.com/search?q=${encodeURIComponent(`${q} kWh per cycle energy use`)}`;

/** Matches for what the user typed (brand and model number), best first: [{name, model, kind, kwh, hours, how}].
 *  Returns null if the text has no model number in it. */
export async function lookupAppliance(query) {
  const words = modelWords(query);
  if (!words.length) return null;
  const found = [];
  await Promise.all(ENERGY_STAR.flatMap(set => words.map(async w => {
    const head = w.toUpperCase().replace(/'/g, "").slice(0, 5);
    const url = `https://data.energystar.gov/resource/${set.id}.json?$limit=20&$where=` +
      encodeURIComponent(`upper(model_number) like '%${head}%'`);
    const rows = await fetch(url).then(r => r.ok ? r.json() : []).catch(() => []);
    for (const r of rows) {
      // A listed model like "DW80CG4021**" (each * = one optional character) covers what was typed if its fixed
      // part starts the typed number, or the typed number starts it
      const fixed = alnum(r.model_number.split("*")[0]), typed = alnum(w);
      if (fixed.length < 5 || !(typed.startsWith(fixed) || fixed.startsWith(typed))) continue;
      const exact = wildcard(r.model_number).test(typed);
      const yearly = +r[set.annual];
      const gas = set.kind === "dryer" && /gas/i.test(`${r.type} ${r.product_type}`);
      if (!gas && !(yearly > 0)) continue;
      const kwh = gas ? GAS_DRYER_KWH : Math.max(0.1, Math.round(yearly / set.runs * 10) / 10);
      const mins = +r.estimated_energy_test_cycle_time_min;
      found.push({
        name: `${r.brand_name} ${gas ? "gas " : ""}${set.kind}`.slice(0, 40),
        model: r.model_number, kind: set.kind, kwh,
        hours: mins > 0 ? Math.min(12, Math.max(1, Math.round(mins / 60))) : set.hours,
        exact, score: Math.min(fixed.length, typed.length) + (exact ? 100 : 0),
        how: gas ? "gas dryer: electricity for the drum motor only"
          : `ENERGY STAR: ${yearly} kWh a year ÷ ${set.runs} runs${set.kind === "washer" ? " (includes heating the water)" : ""}`,
      });
    }
  })));
  // Keep only exact model matches if there are any, and only the type named ("washer", …) if one was
  let best = found.some(f => f.exact) ? found.filter(f => f.exact) : found;
  const named = ENERGY_STAR.map(x => x.kind).filter(k => new RegExp(`\\b${k}\\b`, "i").test(query));
  if (named.length && best.some(f => named.includes(f.kind))) best = best.filter(f => named.includes(f.kind));
  const seen = new Set();
  return best.sort((a, b) => b.score - a.score)
    .filter(f => !seen.has(f.model + f.kind) && seen.add(f.model + f.kind))
    .slice(0, 5);
}

export const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
export const sum = a => a.reduce((s, v) => s + v, 0);

// ---------- network time ----------
// Network time is the default: the computer clock is used only if the user picks
// it, or if every network source fails. Response headers like Date are readable
// because the extension has host permission for these servers.
const TIME_PREF_KEY = "timeSource";  // "network" (default) | "device"
let clockOffsetMs = null, clockSource = "device", clockVia = "";

const storage = store;
export async function getTimePref() {
  try {
    if (storage) return (await storage.get(TIME_PREF_KEY))[TIME_PREF_KEY] ?? "network";
    return localStorage.getItem(TIME_PREF_KEY) ?? "network";
  } catch { return "network"; }
}
export async function setTimePref(pref) {
  try {
    if (storage) await storage.set({ [TIME_PREF_KEY]: pref });
    else localStorage.setItem(TIME_PREF_KEY, pref);
  } catch { /* preference just won't persist */ }
}

// Other saved settings (e.g. alerts), stored as JSON
export async function getPref(key, fallback) {
  try {
    const v = storage ? (await storage.get(key))[key] : JSON.parse(localStorage.getItem(key) ?? "null");
    return v ?? fallback;
  } catch { return fallback; }
}
export async function setPref(key, value) {
  try {
    if (storage) await storage.set({ [key]: value });
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* setting just won't persist */ }
}

// ---------- calendar ----------
// The moment a Pacific-time date and hour happens (hour 24 = the midnight after), daylight saving included.
export function ptTime(iso, hour) {
  const [y, m, d] = iso.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, hour);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric" });
  let t = want;
  for (let i = 0; i < 2; i++) {   // shift by the difference between the wanted and shown Pacific time
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, +x.value]));
    t += want - Date.UTC(p.year, p.month - 1, p.day, p.hour);
  }
  return new Date(t);
}

const calStamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");   // 20261005T180000Z
const calDate = iso => iso.replace(/-/g, "");

/** Event: {title, details, start, end} (Dates) or {title, details, date, allDay: true}. */
export function googleCalendarURL(ev) {
  const dates = ev.allDay ? `${calDate(ev.date)}/${calDate(addDays(ev.date, 1))}` : `${calStamp(ev.start)}/${calStamp(ev.end)}`;
  return "https://calendar.google.com/calendar/render?" +
    new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates, details: ev.details }).toString();
}

/** The event as an .ics file (Apple Calendar, Outlook…), with a reminder: 10 min before, or 8am for all-day. */
export function icsText(ev) {
  const t = s => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const when = ev.allDay
    ? [`DTSTART;VALUE=DATE:${calDate(ev.date)}`, `DTEND;VALUE=DATE:${calDate(addDays(ev.date, 1))}`]
    : [`DTSTART:${calStamp(ev.start)}`, `DTEND:${calStamp(ev.end)}`];
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Appliance Timer//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@appliance-timer`, `DTSTAMP:${calStamp(new Date())}`, ...when,
    `SUMMARY:${t(ev.title)}`, `DESCRIPTION:${t(ev.details)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${t(ev.title)}`, ev.allDay ? "TRIGGER:PT8H" : "TRIGGER:-PT10M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

// Each source returns epoch ms, or throws.
const TIME_SOURCES = [
  ["Open-Meteo", async () => {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${SITES.sf[0]}&longitude=${SITES.sf[1]}&current=temperature_2m`, { cache: "no-store" });
    const header = r.headers.get("date");
    if (header) return new Date(header).getTime();
    // Outside the extension, CORS hides the Date header; use the API's own
    // "current" timestamp instead (local time, rounded to 15 minutes).
    const j = await r.json();
    return Date.parse(j.current.time + "Z") - j.utc_offset_seconds * 1000;
  }],
  ["Cloudflare", async () => {
    const text = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", { cache: "no-store" })).text();
    const ts = /^ts=([\d.]+)$/m.exec(text);
    if (!ts) throw new Error("no timestamp");
    return parseFloat(ts[1]) * 1000;
  }],
];

export async function syncClock() {
  if ((await getTimePref()) === "device") {
    clockOffsetMs = 0; clockSource = "device"; clockVia = "chosen";
    return;
  }
  // The Mac app reads server time natively, where the web page can't see it
  const nativeTime = globalThis.applianceTimerNative?.networkTime;
  if (nativeTime) {
    try {
      const sent = Date.now(), r = await nativeTime(), rtt = Date.now() - sent;
      if (Number.isFinite(r.ms)) {
        clockOffsetMs = r.ms + rtt / 2 - Date.now();
        clockSource = "network"; clockVia = r.via;
        return;
      }
    } catch { /* fall back to the page's own sources */ }
  }
  for (const [name, get] of TIME_SOURCES) {
    try {
      const sent = Date.now(), t = await get(), rtt = Date.now() - sent;
      if (!Number.isFinite(t)) continue;
      clockOffsetMs = t + rtt / 2 - Date.now();  // split the round trip
      clockSource = "network"; clockVia = name;
      return;
    } catch { /* try the next source */ }
  }
  clockOffsetMs = 0; clockSource = "device"; clockVia = "fallback";
}

export const now = () => new Date(Date.now() + (clockOffsetMs ?? 0));
export const clockInfo = () => ({ source: clockSource, via: clockVia, offsetSec: Math.round((clockOffsetMs ?? 0) / 1000) });

// ---------- Pacific-time date helpers ----------
export const todayPT = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now());
export const hourPT = () => +new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now());
export const timePT = () => now().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
export const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
export const dayOfYear = iso => { const d = new Date(iso + "T12:00:00Z"); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1; };
export const niceDate = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
export const hrLong = h => { h = ((h % 24) + 24) % 24; return h === 0 ? "midnight" : h < 12 ? h + "am" : h === 12 ? "noon" : (h - 12) + "pm"; };
export const hrShort = h => { h = ((h % 24) + 24) % 24; return h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p"; };

// ---------- model ----------
let model = null;
export class NoModelError extends Error {}
export async function loadModel() {
  if (!model) {
    // no-store: the daily retrain rewrites model.json, and each panel open should get the newest one
    const r = await fetch(new URL("model.json", import.meta.url), { cache: "no-store" }).catch(() => null);
    if (!r?.ok) throw new NoModelError("No price model installed yet");
    model = await r.json();
  }
  return model;
}

// ---------- weather ----------
// Model sites (solar / heat / wind roles) come from model.json; San Francisco is only for the weather card.
const VAR = { solar: "shortwave_radiation", heat: "temperature_2m", wind: "wind_speed_100m" };
let forecastCache = null;  // { at, promise }: shared so simultaneous callers (the 7-day view) make one request
function getForecast() {
  if (forecastCache && Date.now() - forecastCache.at < 60 * 60 * 1000) return forecastCache.promise;
  const promise = fetchForecast().catch(e => { forecastCache = null; throw e; });  // don't cache failures
  forecastCache = { at: Date.now(), promise };
  return promise;
}

async function fetchForecast() {
  const names = Object.keys(model.sites);
  const common = `&hourly=shortwave_radiation,temperature_2m,wind_speed_100m&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&timezone=${encodeURIComponent(TZ)}&forecast_days=${FORECAST_DAYS}`;
  const q = (lats, lons, extra = "") => fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}${common}${extra}`)
    .then(r => { if (!r.ok) throw new Error(`weather service returned ${r.status}`); return r.json(); });
  // One request for all model sites (Open-Meteo returns a list for comma-separated coordinates)
  const [multi, sf] = await Promise.all([
    q(names.map(n => model.sites[n].lat).join(","), names.map(n => model.sites[n].lon).join(",")),
    q(SITES.sf[0], SITES.sf[1], "&daily=temperature_2m_max,temperature_2m_min,weather_code"),
  ]);
  const list = Array.isArray(multi) ? multi : [multi];
  return { sites: Object.fromEntries(names.map((n, i) => [n, list[i]])), sf };
}

// Per-site hourly arrays for one day, plus the Fresno/Altamont series the weather card shows.
function shapeWeather(perSite, sf = null) {
  return { sites: perSite, rad: perSite.fresno.solar, temp: perSite.fresno.heat, wind: perSite.altamont.wind, sf };
}

function typicalDay(iso) {
  const doy = Math.min(dayOfYear(iso), 365) - 1, C = model.climatology;
  const perSite = Object.fromEntries(Object.entries(model.sites).map(([n, s]) =>
    [n, Object.fromEntries(s.roles.map(r => [r, C[`${n}_${VAR[r]}`][doy]]))]));
  return shapeWeather(perSite);
}

function forecastDay(fc, iso) {
  const first = Object.values(fc.sites)[0];
  const idx = first.hourly.time.map((t, i) => t.startsWith(iso) ? i : -1).filter(i => i >= 0);
  if (idx.length !== 24) return null;
  const typ = typicalDay(iso).sites;
  const perSite = {};
  for (const [n, s] of Object.entries(model.sites)) {
    perSite[n] = {};
    for (const r of s.roles) {
      // Open-Meteo radiation at hour h+1 is the average over h → h+1, i.e. the price interval that starts at h.
      // The model was trained with that alignment (radiation_shift_hours = −1), so read one step ahead.
      const series = fc.sites[n].hourly[VAR[r]];
      const shift = r === "solar" ? -(model.radiation_shift_hours ?? 0) : 0;
      const vals = idx.map(i => series[Math.min(i + shift, series.length - 1)]);
      if (vals.filter(v => v == null).length > 6) return null;          // mostly missing: treat as no forecast
      perSite[n][r] = vals.map((v, h) => v ?? typ[n][r][h]);            // fill gaps with typical weather
    }
  }
  const di = fc.sf.daily.time.indexOf(iso);
  const sf = di < 0 ? null : { hi: fc.sf.daily.temperature_2m_max[di], lo: fc.sf.daily.temperature_2m_min[di], code: fc.sf.daily.weather_code[di] };
  return shapeWeather(perSite, sf);
}

// Recent actual prices as inputs (never displayed). Must match lag_features() in recent_prices.py: a date predicted
// k days ahead uses prices up to day d − max(k, 1). model.recent_prices holds the last weeks of hourly prices,
// refreshed by the daily retrain; if it's out of date, the newest day on file before that is used.
function lagFeatures(iso) {
  const R = model.recent_prices;
  if (!R) return { day: {}, hour: null };
  const days = Object.keys(R).sort();
  const gap = Math.max(daysBetween(todayPT(), iso), 1);
  const want = addDays(iso, -gap);
  let i = days.length - 1;
  while (i > 0 && days[i] > want) i--;
  const mean = d => avg(R[d]);
  return {
    day: {
      lagmean_day: mean(days[i]) / 100,
      lagmean7_day: avg(days.slice(Math.max(0, i - 6), i + 1).map(mean)) / 100,
      laggap_day: Math.min(gap, model.lag_max_gap) / model.lag_max_gap,
    },
    hour: R[days[i]].map(v => v / 100),
  };
}

// Inputs for one day, one object per hour. Must match features() in search.py (+ lag_features()).
function features(iso, w) {
  const a = dayOfYear(iso) / 365.25 * 2 * Math.PI;
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  const mon0 = (dow + 6) % 7;  // Monday = 0, matching pandas dayofweek
  const lag = lagFeatures(iso);
  const day = {
    doy_sin: Math.sin(a), doy_cos: Math.cos(a), doy_sin2: Math.sin(2 * a), doy_cos2: Math.cos(2 * a),
    holiday: model.holidays?.includes(iso) ? 1 : 0,
    ...lag.day,
  };
  for (let k = 0; k < 7; k++) day[`dow${k}`] = k === mon0 ? 1 : 0;
  for (const [n, s] of Object.entries(w.sites)) {
    if (s.solar) day[`${n}_rad_day`] = sum(s.solar) / 10000;
    if (s.heat) day[`${n}_tmax_day`] = Math.max(...s.heat) / 100;
    if (s.wind) day[`${n}_wind_day`] = avg(s.wind) / 50;
  }
  return Array.from({ length: 24 }, (_, h) => {
    const f = { ...day };
    for (const [n, s] of Object.entries(w.sites)) {
      if (s.solar) f[`${n}_rad`] = s.solar[h] / 1000;
      if (s.heat) f[`${n}_temp`] = s.heat[h] / 100;
      if (s.wind) f[`${n}_wind`] = s.wind[h] / 50;
    }
    if (lag.hour) f.lag_hour = lag.hour[h];
    return f;
  });
}

// ---- ensemble members (exported by train_extension_model.py) ----

// Per-hour lasso: one linear model per hour of the day.
function lassoPredict(F) {
  return model.lasso.map((m, h) => m.intercept + model.features.reduce((s, k, i) => s + m.coef[i] * F[h][k], 0));
}

// LightGBM: sum of the trees' leaf values. Inputs are the features plus hour_sin, hour_cos, hour.
function lgbmPredict(F) {
  const names = model.lgbm.features;
  return F.map((f, h) => {
    const a = h / 24 * 2 * Math.PI;
    const x = names.map(k => k === "hour_sin" ? Math.sin(a) : k === "hour_cos" ? Math.cos(a) : k === "hour" ? h : f[k]);
    let total = 0;
    for (const tree of model.lgbm.trees) {
      let n = tree;
      while (n.v === undefined) {
        const v = x[n.f];
        n = (Number.isNaN(v) ? n.d : v <= n.t) ? n.l : n.r;
      }
      total += n.v;
    }
    return total;
  });
}

// erf (Abramowitz–Stegun 7.1.26 would be too coarse; this rational approximation is accurate to ~1e-7)
function erf(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : -y;
}
const gelu = x => 0.5 * x * (1 + erf(x / Math.SQRT2));

// Day-curve net: the whole day's inputs → all 24 hourly prices; averaged over its trained copies (seeds).
function netPredict(F) {
  const N = model.net;
  const x = [...N.daily.map(k => F[0][k]), ...N.hourly.flatMap(k => F.map(f => f[k]))].map((v, i) => (v - N.mu[i]) / N.sd[i]);
  const outs = N.seeds.map(layers => layers.reduce((h, L, li) => {
    const z = L.W.map((row, o) => row.reduce((s, w, i) => s + w * h[i], L.b[o]));
    return li < layers.length - 1 ? z.map(gelu) : z;
  }, x));
  return Array.from({ length: 24 }, (_, h) => avg(outs.map(o => o[h])) * N.ysd + N.ymu);
}

// The ensemble: weighted blend of the three members, minus the level shift (older years' bias).
function predictPrices(iso, w) {
  return blend(features(iso, w));
}
function blend(F) {
  const parts = [lassoPredict(F), lgbmPredict(F), netPredict(F)];
  return Array.from({ length: 24 }, (_, h) => parts.reduce((s, p, i) => s + model.weights[i] * p[h], 0) - model.shift);
}

// ---------- recommendations ----------
// Start hours (>= from) for an n-hour run that finishes by hour `end` (24 = midnight; past 24 = the next morning),
// cheapest first.
function windows(prices, n, from, end = 24) {
  const out = [];
  for (let s = from; s + n <= Math.min(end, prices.length); s++) out.push({ start: s, avg: avg(prices.slice(s, s + n)) });
  return out.sort((a, b) => a.avg - b.avg);
}

// Best start, worst start, and the contiguous range of starts that are nearly as good.
export function recommend(prices, n, from = 0, end = 24) {
  const ws = windows(prices, n, from, end);
  if (!ws.length) return null;
  const best = ws[0], worst = ws[ws.length - 1];
  const ok = new Set(ws.filter(w => w.avg <= best.avg + (worst.avg - best.avg) * 0.15).map(w => w.start));
  let a = best.start, b = best.start;
  while (ok.has(a - 1)) a--;
  while (ok.has(b + 1)) b++;
  return { best, worst, a, b, spread: worst.avg - best.avg };
}

// Energy cost ($) of a run started at each hour; null where it wouldn't finish by hour `end`.
export function runCosts(prices, kwh, hours, end = 24) {
  return prices.map((_, s) => s + hours <= Math.min(end, prices.length) ? kwh * avg(prices.slice(s, s + hours)) / 1000 : null);
}

// ---------- when each appliance may run ----------
// Ordinary appliances run on the chosen day and finish by midnight. An EV charges from its plug-in hour until its
// "ready by" hour the next morning, so plans carry 48 hours of prices (the day and the day after).
export const isEV = a => a?.type === "ev";
export const runWindow = a => isEV(a) ? { start: a.plugIn ?? 0, end: 24 + (a.readyBy ?? 7) } : { start: 0, end: 24 };

// Cost by start hour for one appliance on a plan, null outside its window (and before now, today)
export function applianceCosts(p, a) {
  const w = runWindow(a), from = Math.max(p.from, w.start);
  return runCosts(p.prices48, a.kwh, a.hours, w.end).map((c, s) => s < from ? null : c);
}

// One appliance's best run on a plan: {best, worst, a, b, spread, costs} (as recommend), or null if none fits
export function bestRun(p, a) {
  const w = runWindow(a);
  const r = recommend(p.prices48, a.hours, Math.max(p.from, w.start), w.end);
  return r && { ...r, costs: applianceCosts(p, a) };
}

// Running everything together: total cost by common start hour (today's hours), each appliance within its own
// window; null where something wouldn't fit.
export function togetherCosts(p, list) {
  const each = list.map(a => applianceCosts(p, a));
  return p.prices48.map((_, s) => s > 23 || !list.length || each.some(c => c[s] == null) ? null : sum(each.map(c => c[s])));
}

// For machines with fixed Delay Start buttons: which button to press if loaded now.
// `nowHour` is the current hour; a delay of d starts the run during hour nowHour + d.
export function bestDelay(prices, kwh, hours, delays, nowHour) {
  const costs = runCosts(prices, kwh, hours);
  const opts = [0, ...delays]
    .map(d => ({ delay: d, start: nowHour + d }))
    .filter(o => o.start + hours <= 24)
    .map(o => ({ ...o, cost: costs[o.start] }));
  if (!opts.length) return null;
  const best = opts.reduce((m, o) => o.cost < m.cost ? o : m);
  return { best, now: opts[0] };
}

// ---------- How the model is doing ----------
// retrain.py (run daily after CAISO publishes prices) grades each newly published day BEFORE retraining: the model
// that existed then predicts the day from the forecast issued the day before, and both the predicted and actual
// hourly prices are saved to scores.json. The card grades those against the user's own appliances.
export async function loadScores() {
  const r = await fetch(new URL("scores.json", import.meta.url), { cache: "no-store" }).catch(() => null);
  return r?.ok ? r.json() : null;
}

// Everything the UI needs for one date.
export async function planFor(iso, withNext = true) {
  await loadModel();
  const today = todayPT(), ahead = daysBetween(today, iso);
  let w = null, mode = "typical", error = "";
  if (ahead >= 0 && ahead < FORECAST_DAYS) {
    try { w = forecastDay(await getForecast(), iso); if (w) mode = "forecast"; }
    catch (e) { error = e.message; }
  }
  if (!w) w = typicalDay(iso);
  const from = iso === today ? Math.min(hourPT() + 1, 23) : 0;
  // Days CAISO has already published (today, tomorrow after ~1pm, recent past): its real prices, not a prediction
  const actual = model.published?.includes(iso) ? model.recent_prices?.[iso] : null;
  const prices = actual ?? predictPrices(iso, w);
  // The next day too, for runs that carry on overnight (EV charging)
  const next = withNext ? await planFor(addDays(iso, 1), false) : null;
  return { iso, ahead, mode, error, weather: w, typical: typicalDay(iso), from, model,
           prices, priceSource: actual ? "actual" : "predicted",
           prices48: next ? [...prices, ...next.prices] : prices, nextSource: next?.priceSource };
}
