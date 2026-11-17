// Replays history through the bot's own decide() to see how the limits and price slippage would have played out.
// There's no saved order-book history, so the fill is the whale's price plus SLIP cents (default 0), arriving LAG minutes later.
// Usage: node bot/replay.mjs [data dir]   env: SLIP=1  LAG=15  FROM=2026-10-01  CONFIG=path
import path from "node:path"; import fs from "node:fs"; import { fileURLToPath } from "node:url"; import { createRequire } from "node:module";
import { loadSettled } from "./lib/data.mjs";
import { validateConfig } from "./lib/config.mjs";
import { decide, unitsFor, dayKey } from "./lib/limits.mjs";
import { findSignals } from "./lib/signals.mjs";
const F = createRequire(import.meta.url)("../filters.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = validateConfig(JSON.parse(fs.readFileSync(process.env.CONFIG || path.join(here, "config.json"))));
const SLIP = Number(process.env.SLIP || 0) / 100, LAG = Number(process.env.LAG || 15) * 60;
const FROM = process.env.FROM ? Date.parse(process.env.FROM) / 1000 : 0;

const entries = await loadSettled(process.argv[2], e => e.result && e.ts >= FROM && e.start && e.ts < e.start && e.source !== "backfill" && e.usd >= 1000 && !F.isJunk(e));
// Each settled bet becomes a signal LAG after it was placed, judged by the same findSignals() the live bot uses
const evs = [];
for (const e of entries) {
  const at = e.ts + LAG;
  const [s] = findSignals({ [e.key]: { ...e, result: null } }, cfg, at);
  if (s && s.trade.length) evs.push({ at, s, e });
}
evs.sort((a, b) => a.at - b.at);
const orders = []; let settleQ = [];
const skips = {};
for (const { at, s, e } of evs) {
  // settle anything finished before this moment
  settleQ = settleQ.filter(([t, o, r]) => { if (t > at) return true; Object.assign(o, { status: "settled", result: r.result, units: unitsFor(r.result, o.fillPrice, 1), whaleUnits: r.units, settledAt: t }); return false; });
  const fill = Math.min(0.99, +(s.q + SLIP).toFixed(4));
  const d = decide(s, orders, cfg, { ask: fill, at, source: "replay" }, at);
  if (d.action === "skip") { const k = d.reason.replace(/\d+(\.\d+)?/g, "#"); skips[k] = (skips[k] || 0) + 1; continue; }
  if (d.fill == null) { skips["price above limit (would rest)"] = (skips["price above limit (would rest)"] || 0) + 1; continue; }
  const o = { pickKey: s.pickKey, marketKey: s.marketKey, filter: s.trade[0], status: "filled", stakeUnits: 1, createdAt: at, fillPrice: d.fill, whale: { q: s.q } };
  orders.push(o);
  settleQ.push([e.settledAt || s.start + 3 * 3600, o, e]);
}
settleQ.forEach(([t, o, r]) => Object.assign(o, { status: "settled", result: r.result, units: unitsFor(r.result, o.fillPrice, 1), whaleUnits: r.units, settledAt: t }));
const s = orders.filter(o => o.status === "settled"), u = s.reduce((a, o) => a + o.units, 0), wu = s.reduce((a, o) => a + (o.whaleUnits || 0), 0);
const days = new Map(); orders.forEach(o => days.set(dayKey(o.createdAt), (days.get(dayKey(o.createdAt)) || 0) + 1));
const perDay = [...days.values()].sort((a, b) => a - b);
let eq = 0, peak = 0, mdd = 0; s.slice().sort((a, b) => a.settledAt - b.settledAt).forEach(o => { eq += o.units; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); });
console.log(`Replay: lag ${LAG / 60} min, fill = whale price + ${SLIP * 100}¢, ${evs.length} signals`);
console.log(`Bets ${s.length}: ${s.filter(o => o.result === "W").length}-${s.filter(o => o.result === "L").length}, ${u.toFixed(1)}u, ROI ${(u / s.length * 100).toFixed(1)}% (at the whale's price: ${(wu / s.length * 100).toFixed(1)}%)`);
console.log(`Worst drawdown ${mdd.toFixed(1)}u. Bets per active day: median ${perDay[perDay.length >> 1]}, max ${perDay[perDay.length - 1]}, over ${perDay.length} days`);
console.log("Skipped:", JSON.stringify(skips));
const byF = {}; s.forEach(o => { const b = byF[o.filter] ||= { n: 0, u: 0 }; b.n++; b.u += o.units; });
console.log("By credited filter:", Object.entries(byF).map(([k, v]) => `${k} ${v.n} bets ${(v.u / v.n * 100).toFixed(1)}%`).join(" | "));
