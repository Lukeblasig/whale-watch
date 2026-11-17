// Whale Watch paper trader (phase 1). Runs after each collector save, decides what it WOULD bet, and logs it.
// No keys, no money, no order calls: there is no code here that can place a real order.
//
//   node bot/paper.mjs                 reads the data branch, writes its log to ./botlog
//   BOT_LOG_DIR=dir  WW_DATA_DIR=dir   use a local log folder / local copy of the data files (for testing)
//   WW_NOW=<unix seconds>              pretend it's this time (for testing against saved data)
import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadConfig, killed } from "./lib/config.mjs";
import { getData, partsForTs } from "./lib/data.mjs";
import { findSignals } from "./lib/signals.mjs";
import { decide, updateResting, unitsFor, lossStopHit, openUnits, unitsToday, drawdown } from "./lib/limits.mjs";
import { getQuote } from "./lib/prices.mjs";
import { openStore } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Number(process.env.WW_NOW) || Math.floor(Date.now() / 1000);
const dataOpts = { dir: process.env.WW_DATA_DIR };
const store = openStore(process.env.BOT_LOG_DIR || "botlog");
const S = store.state, orders = S.orders;
const stats = { signals: 0, ordered: 0, filled: 0, rested: 0, skipped: 0, watch: 0, settled: 0, cancelled: 0 };

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function main() {
  // 1. Config. Anything wrong here stops the run before it can place anything.
  const cfg = loadConfig(process.env.BOT_CONFIG || path.join(here, "config.json"));
  const allowFallback = cfg.mode === "paper";

  // 2. Data the site reads
  const [idx, feed, pending] = await Promise.all(["index.json", "feed.json", "pending.json"].map(f => getData(f, dataOpts)));
  const dataAgeMin = (NOW - idx.updated) / 60;

  // 3. Settle finished orders from the collector's own results (same results the filter records use)
  await settleOrders(idx, pending);

  // 4. Kill switch: cancel anything resting, place nothing new
  if (killed(cfg)) {
    for (const o of orders.filter(o => o.status === "resting")) cancel(o, "kill switch");
    store.log({ type: "run", note: "kill switch on: no new orders" });
    return finish(cfg, "kill switch on");
  }

  // 5. Resting orders: fill if the price came back under the limit, cancel at the cutoff
  const resting = orders.filter(o => o.status === "resting");
  const rq = await pool(resting, 4, o => getQuote(o, { feed, allowFallback }));
  resting.forEach((o, i) => {
    const u = updateResting(o, rq[i], cfg, NOW);
    if (!u) return;
    if (u.status === "cancelled") return cancel(o, u.reason);
    Object.assign(o, { status: "filled", fillPrice: u.fill, filledAt: NOW, priceSource: rq[i].source, slippageCents: Math.round((u.fill - o.whale.q) * 100) });
    stats.filled++;
    store.log({ type: "fill", id: o.id, filter: o.filter, price: u.fill, source: rq[i].source });
  });

  // 6. New signals
  if (dataAgeMin > cfg.checks.maxDataAgeMinutes) {
    store.log({ type: "run", note: `data is ${Math.round(dataAgeMin)} min old (limit ${cfg.checks.maxDataAgeMinutes}): no new orders` });
    return finish(cfg, "stale data");
  }
  const sigs = findSignals(pending, cfg, NOW);
  stats.signals = sigs.length;
  for (const s of sigs.filter(s => !s.trade.length)) {
    if (store.logOnce(s.pickKey, s.start, { type: "watch", reason: "watch", pick: pickInfo(s), filters: s.watch })) stats.watch++;
  }
  const tradeSigs = sigs.filter(s => s.trade.length && !orders.some(o => o.pickKey === s.pickKey && o.status !== "cancelled"));
  const quotes = await pool(tradeSigs, 4, s => getQuote(s, { feed, allowFallback }));
  tradeSigs.forEach((s, i) => {
    const q = quotes[i];
    const d = decide(s, orders, cfg, q, NOW); // throws on any broken check: the run stops, nothing more is placed
    if (d.action === "skip") {
      if (store.logOnce(s.pickKey, s.start, { type: "skip", reason: d.reason, filter: s.trade[0], pick: pickInfo(s), quote: q && { ask: q.ask, source: q.source } })) stats.skipped++;
      return;
    }
    const o = {
      id: `${NOW}-${orders.length + 1}`, mode: cfg.mode, filter: s.trade[0], alsoMatched: s.trade.slice(1), watchMatched: s.watch,
      sigKey: s.sigKey, pickKey: s.pickKey, marketKey: s.marketKey, venue: s.venue, conditionId: s.conditionId, idx: s.idx,
      name: s.name, title: s.title, slug: s.slug, league: s.league, start: s.start,
      whale: { q: s.q, usd: s.usd, score: s.score, sharp: s.sharp, flow: s.flow, ts: s.whaleTs },
      stakeUnits: cfg.limits.stakeUnits, limitPrice: d.limitPrice, createdAt: NOW,
      quoteAtOrder: { ask: q.ask, depth: q.depth, at: q.at, source: q.source },
      status: d.fill != null ? "filled" : "resting", fillPrice: d.fill, filledAt: d.fill != null ? NOW : null,
      priceSource: d.fill != null ? q.source : null, slippageCents: d.fill != null ? Math.round((d.fill - s.q) * 100) : null
    };
    orders.push(o);
    stats.ordered++; d.fill != null ? stats.filled++ : stats.rested++;
    store.log({ type: "order", id: o.id, status: o.status, filter: o.filter, alsoMatched: o.alsoMatched, pick: pickInfo(s),
      whale: o.whale, limit: o.limitPrice, ask: q.ask, source: q.source });
  });
  return finish(cfg, "ok");
}

function cancel(o, reason) {
  Object.assign(o, { status: "cancelled", cancelledAt: NOW, cancelReason: reason });
  stats.cancelled++;
  store.log({ type: "cancel", id: o.id, filter: o.filter, reason });
}
const pickInfo = s => ({ venue: s.venue, league: s.league, title: s.title, side: s.name, start: s.start, whaleKey: s.sigKey, q: s.q, score: s.score });

async function settleOrders(idx, pending) {
  const open = orders.filter(o => o.status === "filled" && NOW > o.start + 3600);
  const partCache = new Map();
  const loadPart = async k => { if (!partCache.has(k)) partCache.set(k, await getData(`settled-${k}.json`, dataOpts).catch(() => ({}))); return partCache.get(k); };
  for (const o of open) {
    let e = pending[o.sigKey];
    if (!e || !e.result) {
      e = null;
      if (!pending[o.sigKey]) for (const k of partsForTs(idx, o.whale.ts)) { const p = await loadPart(k); if (p[o.sigKey]) { e = p[o.sigKey]; break; } }
    }
    if (e && e.result) {
      const units = unitsFor(e.result, o.fillPrice, o.stakeUnits);
      Object.assign(o, { status: "settled", result: e.result, units, whaleUnits: e.units ?? null, settledAt: NOW });
      stats.settled++;
      store.log({ type: "settle", id: o.id, filter: o.filter, result: e.result, units: +units.toFixed(4), whaleUnits: e.units ?? null, fill: o.fillPrice, whaleQ: o.whale.q });
    } else if (!pending[o.sigKey] && NOW - o.whale.ts > 15 * 86400) {
      // the collector drops bets that never settle after two weeks (voided or delisted markets)
      Object.assign(o, { status: "void", units: 0, settledAt: NOW });
      store.log({ type: "settle", id: o.id, filter: o.filter, result: "void", units: 0 });
    }
  }
}

function summarize(cfg) {
  const rec = list => {
    const s = list.filter(o => o.status === "settled"), u = s.reduce((a, o) => a + o.units, 0), wu = s.reduce((a, o) => a + (o.whaleUnits || 0), 0);
    const fills = list.filter(o => o.fillPrice != null), slip = fills.reduce((a, o) => a + (o.fillPrice - o.whale.q), 0);
    return { orders: list.length, settled: s.length, w: s.filter(o => o.result === "W").length, l: s.filter(o => o.result === "L").length,
      units: +u.toFixed(3), roi: s.length ? +(u / s.length * 100).toFixed(2) : null,
      whaleUnits: +wu.toFixed(3), whaleRoi: s.length ? +(wu / s.length * 100).toFixed(2) : null,
      avgSlippageCents: fills.length ? +(slip / fills.length * 100).toFixed(2) : null,
      open: list.filter(o => o.status === "filled").length, resting: list.filter(o => o.status === "resting").length,
      cancelled: list.filter(o => o.status === "cancelled").length,
      liveQuotes: fills.filter(o => !/not a live quote/.test(o.priceSource || "")).length };
  };
  const placed = orders.filter(o => o.status !== "cancelled");
  const byFilter = {};
  cfg.filters.forEach(id => byFilter[id] = rec(orders.filter(o => o.filter === id)));
  return { updated: NOW, mode: cfg.mode, overall: rec(orders), byFilter, openUnits: openUnits(orders), unitsToday: unitsToday(orders, NOW),
    drawdown: drawdown(orders, cfg.lossStopResetAt), lossStop: !!lossStopHit(orders, cfg), placed: placed.length,
    note: "units = our result at our own fill price; whaleUnits = the same bets at the whale's price (what the filter record measures)" };
}

function finish(cfg, status) {
  const summary = summarize(cfg);
  store.log({ type: "run", status, ...stats, openUnits: summary.openUnits, unitsToday: summary.unitsToday });
  const n = store.save(summary);
  const o = summary.overall;
  console.log(`Paper run ${status}: ${stats.signals} signals, ${stats.ordered} new orders (${stats.filled} filled, ${stats.rested} resting), ${stats.skipped} new skips, ${stats.watch} watch-only, ${stats.settled} settled, ${stats.cancelled} cancelled. ` +
    `Record ${o.w}-${o.l}, ${o.units}u (whale's price: ${o.whaleUnits}u). Open ${summary.openUnits}u, today ${summary.unitsToday}u. ${n} log lines.`);
}

main().catch(e => {
  // Fail closed: log why, place nothing further, and exit non-zero so GitHub flags the run
  try { store.log({ type: "run", status: "error", error: String(e.message || e) }); store.save(); } catch {}
  console.error("Paper run stopped, no further orders: " + (e.message || e));
  process.exit(1);
});
