// Mac app only: the menu bar title, doing what the extension's background.js does for the toolbar badge.

import { syncClock, planFor, todayPT, addDays, now, ptTime, getPref, bestRun, getAppliances, hrShort, hrLong,
  NoModelError } from "./core.js";

const show = (text, title) => globalThis.applianceTimerNative?.badge(text, title);

async function updateBadge() {
  try {
    await syncClock();
    const [plan, appliances] = await Promise.all([planFor(todayPT()), getAppliances()]);
    const recs = appliances
      .map(a => ({ a, r: bestRun(plan, a) }))
      .filter(x => x.r);
    if (!recs.length) {
      return show("", "Appliance Timer: today's cheap hours have passed. Open for tomorrow.");
    }
    // Follows the appliance that uses the most energy, since its timing matters most.
    const top = recs.reduce((m, x) => x.a.kwh > m.a.kwh ? x : m);
    const lines = recs.map(({ a, r }) => {
      const c = r.costs[r.best.start];
      return `${a.name}: ${hrLong(r.best.start)} (~${(c * 100).toFixed(c < 0.1 ? 1 : 0)}¢)`;
    });
    show(hrShort(top.r.best.start), `Appliance Timer: best start times today\n${lines.join("\n")}`);
  } catch (e) {
    if (e instanceof NoModelError) return show("", "Appliance Timer: no price model installed yet");
    show("?", `Appliance Timer: couldn't update (${e.message})`);
  }
}

const cents = d => `${(d * 100).toFixed(d < 0.095 ? 1 : 0)}¢`;

// "Start now" alerts: a notification at each appliance's cheapest start, today (remaining hours) and tomorrow.
// Rescheduled on every page load, refresh and appliance change, so a new forecast or model moves them.
async function scheduleAlerts() {
  const N = globalThis.applianceTimerNative;
  if (!N?.schedule) return;
  if (!(await getPref("alerts", {})).startNow) return N.schedule([]);
  const appliances = await getAppliances(), today = todayPT(), items = [];
  for (const iso of [today, addDays(today, 1)]) {
    const p = await planFor(iso);
    for (const a of appliances) {
      const r = bestRun(p, a);
      if (!r) continue;
      const at = ptTime(iso, r.best.start);
      if (at <= now()) continue;
      const c = r.costs;
      items.push({
        id: `start-${iso}-${a.name}`, at: at.getTime(),
        title: a.type === "ev" ? `Start charging the ${a.name} now` : `Start the ${a.name} now`,
        body: `Its cheapest ${a.hours}h window starts now: ${hrLong(r.best.start)}–${hrLong(r.best.start + a.hours)}, ` +
          `about ${cents(c[r.best.start])} (vs ${cents(c[r.worst.start])} at ${hrLong(r.worst.start)}).`,
      });
    }
  }
  await N.schedule(items);
}

globalThis.__updateBadge = () => updateBadge().then(() => scheduleAlerts()).catch(e => console.error(e));
globalThis.__updateBadge();
