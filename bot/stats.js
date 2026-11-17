/* Paper-trade statistics, shared by the bot (summary.json) and the tracker page, so both show the same numbers.
   Display only: the limits that stop orders live in bot/lib/limits.mjs.
   Loads as a plain <script> in the browser (sets window.WWStats) and via require() in Node. */
(function (root) {
"use strict";
const CENTRAL = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const dayKey = sec => CENTRAL.format(new Date(sec * 1000));
const sum = (l, f) => l.reduce((a, x) => a + (f(x) || 0), 0);
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Closing line value: mid price at the last quote before the start, minus our fill. Positive = we beat the close.
function clvOf(o) {
  if (o.fillPrice == null || !o.close || !(o.close.mid > 0)) return null;
  return { cents: (o.close.mid - o.fillPrice) * 100, pct: (o.close.mid / o.fillPrice - 1) * 100 };
}
// 90% range for a per-bet average, treating bets on the same game as one draw (they win and lose together)
function ci90(list, val) {
  const n = list.length; if (n < 10) return null;
  const mean = sum(list, val) / n, g = new Map();
  list.forEach(o => { const k = o.venue + "|" + (o.slug || o.conditionId); g.set(k, (g.get(k) || 0) + val(o) - mean); });
  const G = g.size; if (G < 5) return null;
  let ss = 0; g.forEach(v => ss += v * v);
  const se = Math.sqrt(ss * G / (G - 1)) / n;
  return [mean - 1.645 * se, mean + 1.645 * se];
}

function record(list) {
  const settled = list.filter(o => o.status === "settled"), graded = settled.filter(o => o.result === "W" || o.result === "L" || o.result === "P");
  const fills = list.filter(o => o.fillPrice != null);
  const clvs = fills.map(o => [o, clvOf(o)]).filter(([o, c]) => c && (o.status !== "filled" || o.start <= Date.now() / 1000));
  const clvClosed = clvs.filter(([o]) => o.start <= Date.now() / 1000 || o.status === "settled");
  const slips = fills.map(o => (o.fillPrice - o.whale.q) * 100);
  const net = sum(graded, o => o.units), gross = sum(graded, o => o.grossUnits ?? o.units), whale = sum(graded, o => o.whaleUnits);
  const ci = ci90(graded, o => o.units);
  const cciArr = clvClosed.map(([o, c]) => ({ ...o, _c: c.cents }));
  const cci = ci90(cciArr, o => o._c);
  return {
    orders: list.length, fills: fills.length, settled: graded.length,
    w: graded.filter(o => o.result === "W").length, l: graded.filter(o => o.result === "L").length, p: graded.filter(o => o.result === "P").length,
    netUnits: r2(net), grossUnits: r2(gross), fees: r2(sum(graded, o => o.feeUnits)),
    netRoi: graded.length ? r2(net / graded.length * 100) : null, grossRoi: graded.length ? r2(gross / graded.length * 100) : null,
    netRoiCI: ci && ci.map(x => r2(x * 100)),
    whaleUnits: r2(whale), whaleRoi: graded.length ? r2(whale / graded.length * 100) : null,
    clvN: clvClosed.length, clvAvgCents: clvClosed.length ? r2(sum(clvClosed, ([, c]) => c.cents) / clvClosed.length) : null,
    clvAvgPct: clvClosed.length ? r2(sum(clvClosed, ([, c]) => c.pct) / clvClosed.length) : null,
    clvBeatPct: clvClosed.length ? r2(clvClosed.filter(([, c]) => c.cents > 0).length / clvClosed.length * 100) : null,
    clvCI: cci && cci.map(r2),
    medianSlipCents: r2(median(slips)), avgSlipCents: slips.length ? r2(slips.reduce((a, b) => a + b, 0) / slips.length) : null,
    takerPct: fills.length ? r2(fills.filter(o => o.taker).length / fills.length * 100) : null,
    liveQuotePct: fills.length ? r2(fills.filter(o => !/not a live quote/.test(o.priceSource || "")).length / fills.length * 100) : null,
    open: list.filter(o => o.status === "filled").length, resting: list.filter(o => o.status === "resting").length,
    cancelled: list.filter(o => o.status === "cancelled").length
  };
}

// The audit's stop rules for the trial, each as pending / pass / fail
function gates(rec, G, startedAt, now) {
  const weeks = startedAt ? (now - startedAt) / (7 * 86400) : 0;
  const g = [];
  g.push(rec.clvN < G.clvBets
    ? { id: "clv", label: `Beat the close after ${G.clvBets} bets`, status: "pending", progress: rec.clvN / G.clvBets, detail: `${rec.clvN} of ${G.clvBets} bets have a closing price${rec.clvAvgCents != null ? `; average so far ${fmt(rec.clvAvgCents)}¢` : ""}` }
    : { id: "clv", label: `Beat the close after ${G.clvBets} bets`, status: rec.clvAvgCents > 0 ? "pass" : "fail", progress: 1, detail: `Average CLV ${fmt(rec.clvAvgCents)}¢ on ${rec.clvN} bets. Audit: stop if fills don't beat the close.` });
  g.push(rec.settled < G.roiBets
    ? { id: "roi", label: `Net ROI above ${G.minNetRoiPct}% after ${G.roiBets} bets`, status: "pending", progress: rec.settled / G.roiBets, detail: `${rec.settled} of ${G.roiBets} settled${rec.netRoi != null ? `; ${fmt(rec.netRoi)}% so far` : ""}` }
    : { id: "roi", label: `Net ROI above ${G.minNetRoiPct}% after ${G.roiBets} bets`, status: rec.netRoi >= G.minNetRoiPct ? "pass" : "fail", progress: 1, detail: `Net ROI ${fmt(rec.netRoi)}% on ${rec.settled} bets` });
  g.push(rec.medianSlipCents == null
    ? { id: "slip", label: `Median fill no more than ${G.maxMedianSlipCents}¢ worse than the whale`, status: "pending", progress: 0, detail: "No fills yet" }
    : { id: "slip", label: `Median fill no more than ${G.maxMedianSlipCents}¢ worse than the whale`, status: rec.medianSlipCents <= G.maxMedianSlipCents ? (rec.fills >= 50 ? "pass" : "pending") : "fail", progress: Math.min(1, rec.fills / 50), detail: `Median ${fmt(rec.medianSlipCents)}¢ over ${rec.fills} fills` });
  g.push({ id: "length", label: `Trial length: ${G.trialWeeks} weeks or ${G.trialBets} bets`, status: weeks >= G.trialWeeks || rec.settled >= G.trialBets ? "pass" : "pending",
    progress: Math.min(1, Math.max(weeks / G.trialWeeks, rec.settled / G.trialBets)), detail: `${weeks.toFixed(1)} weeks, ${rec.settled} settled bets` });
  return g;
}
const fmt = x => x == null ? "–" : (x > 0 ? "+" : "") + x.toFixed(2);

// Cumulative results in settle order: net units, units at the whale's price, and running CLV
function curve(list) {
  const s = list.filter(o => o.status === "settled" && o.result).sort((a, b) => a.settledAt - b.settledAt || a.start - b.start);
  let net = 0, whale = 0, clv = 0, cn = 0;
  return s.map(o => { net += o.units || 0; whale += o.whaleUnits || 0; const c = clvOf(o); if (c) { clv += c.cents; cn++; }
    return { t: o.settledAt, net: r2(net), whale: r2(whale), clvAvg: cn ? r2(clv / cn) : null }; });
}

function summarize(orders, cfg, now) {
  const real = orders.filter(o => !o.shadow), shadow = orders.filter(o => o.shadow);
  const active = real.filter(o => o.status === "filled" || o.status === "resting");
  const counted = real.filter(o => o.status === "resting" || o.status === "filled" || o.status === "settled");
  const since = cfg.lossStopResetAt ? Date.parse(cfg.lossStopResetAt) / 1000 : 0;
  let eq = 0, peak = 0, dd = 0;
  real.filter(o => o.status === "settled" && o.settledAt >= since).sort((a, b) => a.settledAt - b.settledAt).forEach(o => { eq += o.units; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); });
  const rec = record(real), startedAt = real.length ? Math.min(...real.map(o => o.createdAt)) : null;
  const byRule = {}, byShadow = {};
  cfg.filters.forEach(id => byRule[id] = record(real.filter(o => o.rule === id)));
  cfg.shadowFilters.forEach(id => byShadow[id] = record(shadow.filter(o => o.rule === id)));
  return {
    updated: now, mode: cfg.mode, startedAt, real: rec, byRule, byShadow,
    openUnits: sum(active, o => o.stakeUnits), unitsToday: sum(counted.filter(o => dayKey(o.createdAt) === dayKey(now)), o => o.stakeUnits),
    drawdown: { units: r2(eq), max: r2(dd), current: r2(peak - eq) }, lossStop: peak - eq >= cfg.limits.lossStopUnits,
    gates: gates(rec, cfg.trialGates, startedAt, now),
    config: { filters: cfg.filters, shadowFilters: cfg.shadowFilters, limits: cfg.limits, checks: cfg.checks, fees: cfg.fees, trialGates: cfg.trialGates, unitUsd: cfg.unitUsd, lossStopResetAt: cfg.lossStopResetAt },
    note: "units are net of taker fees at our own fill price; whaleUnits are the same bets at the whale's price before fees; CLV = closing mid minus our fill"
  };
}

const api = { dayKey, clvOf, ci90, record, gates, curve, summarize, median };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WWStats = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
