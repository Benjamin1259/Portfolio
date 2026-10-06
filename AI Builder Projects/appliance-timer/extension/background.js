// Keeps the toolbar badge showing today's best start time for your appliances.

import { syncClock, planFor, todayPT, bestRun, getAppliances, hrShort, hrLong, NoModelError } from "./core.js";

async function updateBadge() {
  try {
    await syncClock();
    const [plan, appliances] = await Promise.all([planFor(todayPT()), getAppliances()]);
    const recs = appliances
      .map(a => ({ a, r: bestRun(plan, a) }))
      .filter(x => x.r);
    if (!recs.length) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Appliance Timer: today's cheap hours have passed. Open for tomorrow." });
      return;
    }
    // Badge follows the appliance that uses the most energy, since its timing matters most.
    const top = recs.reduce((m, x) => x.a.kwh > m.a.kwh ? x : m);
    await chrome.action.setBadgeText({ text: hrShort(top.r.best.start) });
    await chrome.action.setBadgeBackgroundColor({ color: "#1c5cab" });
    await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    const lines = recs.map(({ a, r }) => {
      const c = r.costs[r.best.start];
      return `${a.name}: ${hrLong(r.best.start)} (~${(c * 100).toFixed(c < 0.1 ? 1 : 0)}¢)`;
    });
    await chrome.action.setTitle({ title: `Appliance Timer: best start times today\n${lines.join("\n")}` });
  } catch (e) {
    if (e instanceof NoModelError) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Appliance Timer: no price model installed yet" });
      return;
    }
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setTitle({ title: `Appliance Timer: couldn't update (${e.message})` });
  }
}

// Clicking the toolbar icon opens the side panel (instead of a popup).
const useSidePanel = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  useSidePanel();
  chrome.alarms.create("refresh", { periodInMinutes: 30 });
  updateBadge();
});
chrome.runtime.onStartup.addListener(useSidePanel);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.alarms.onAlarm.addListener(a => a.name === "refresh" && updateBadge());
chrome.runtime.onMessage.addListener(msg => msg === "refresh-badge" && updateBadge());
