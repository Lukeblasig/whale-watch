// Whale Watch paper trader (phase 1). Runs after each collector save, decides what it WOULD bet, and logs it.
// No keys, no money, no order calls: there is no code here that can place a real order.
//
//   node bot/paper.mjs                 reads the data branch, writes its log to ./botlog
//   BOT_LOG_DIR=dir  WW_DATA_DIR=dir   use a local log folder / local copy of the data files (for testing)
//   BOT_CONFIG=file                    use another config file
//   WW_NOW=<unix seconds>              pretend it's this time (for testing against saved data)
//
// Two kinds of paper orders:
//   real    the rules in config.filters, with every limit applied. This is the trial.
//   shadow  the rules in config.shadowFilters, same price rules but no stake limits, each with its own record.
import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadConfig, killed } from "./lib/config.mjs";
import { getData, partsForTs } from "./lib/data.mjs";
import { findCandidates, tradeSignals, pruneFirstAlert } from "./lib/signals.mjs";
import { decide, updateResting, unitsFor, feeUnits } from "./lib/limits.mjs";
import { getQuote } from "./lib/prices.mjs";
import { openStore } from "./lib/store.mjs";
import { summarize } from "./lib/summary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Number(process.env.WW_NOW) || Math.floor(Date.now() / 1000);
const dataOpts = { dir: process.env.WW_DATA_DIR };
const store = openStore(process.env.BOT_LOG_DIR || "botlog");
const S = store.state;
S.orders ||= []; S.firstAlert ||= {};
const orders = S.orders;
const real = () => orders.filter(o => !o.shadow);
const stats = { candidates: 0, ordered: 0, filled: 0, rested: 0, skipped: 0, shadowOrdered: 0, settled: 0, cancelled: 0, closes: 0 };
let dataUpdated = null;

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
  dataUpdated = idx.updated;
  const dataAgeMin = (NOW - idx.updated) / 60;

  // 3. Settle finished orders from the collector's own results (same results the filter records use)
  await settleOrders(idx, pending, cfg);

  // 4. Kill switch: cancel anything resting, place nothing new
  if (killed(cfg)) {
    for (const o of orders.filter(o => o.status === "resting")) cancel(o, "kill switch");
    store.log({ type: "run", note: "kill switch on: no new orders" });
    return finish(cfg, "kill switch on");
  }

  // 5. Candidates now, and one quote per pick for everything that needs a price this run
  const stale = dataAgeMin > cfg.checks.maxDataAgeMinutes;
  const cands = stale ? [] : findCandidates(pending, cfg, NOW, S.firstAlert);
  stats.candidates = cands.length;
  const active = orders.filter(o => (o.status === "filled" || o.status === "resting") && o.start > NOW);
  const need = new Map();
  [...active, ...cands].forEach(x => need.set(x.pickKey, x));
  const keys = [...need.keys()];
  const qs = await pool(keys, 4, k => getQuote(need.get(k), { feed, allowFallback }));
  const quotes = new Map(keys.map((k, i) => [k, qs[i]]));

  // 6. Closing line: keep the latest quote taken before the start on every live order
  for (const o of active) {
    const q = quotes.get(o.pickKey);
    if (q && q.at < o.start) { o.close = { bid: q.bid, ask: q.ask, mid: q.mid, at: q.at, minsBefore: Math.round((o.start - q.at) / 60), source: q.source }; stats.closes++; }
  }

  // 7. Resting orders: fill (as a maker, no fee) if the price came back under the limit; cancel at the cutoff
  for (const o of orders.filter(o => o.status === "resting")) {
    const q = quotes.get(o.pickKey), u = updateResting(o, q, cfg, NOW);
    if (!u) continue;
    if (u.status === "cancelled") { cancel(o, u.reason); continue; }
    Object.assign(o, { status: "filled", fillPrice: u.fill, filledAt: NOW, taker: false, feeUnits: 0, priceSource: q.source, slippageCents: cents(u.fill - o.whale.q) });
    stats.filled++;
    store.log({ type: "fill", id: o.id, rule: o.rule, shadow: !!o.shadow, price: u.fill, maker: true, source: q.source });
  }

  if (stale) {
    store.log({ type: "run", note: `data is ${Math.round(dataAgeMin)} min old (limit ${cfg.checks.maxDataAgeMinutes}): no new orders` });
    return finish(cfg, "stale data");
  }

  // 8. Real orders: every limit applies
  for (const s of tradeSignals(cands, cfg)) {
    if (real().some(o => o.pickKey === s.pickKey && o.status !== "cancelled")) continue;
    const q = quotes.get(s.pickKey);
    const d = decide(s, real(), cfg, q, NOW); // throws on any broken check: the run stops, nothing more is placed
    if (d.action === "skip") {
      if (store.logOnce(s.pickKey, s.start, { type: "skip", reason: d.reason, rule: s.rule, pick: pickInfo(s), quote: q && { ask: q.ask, source: q.source } })) stats.skipped++;
      continue;
    }
    place(s, d, q, cfg, false);
  }

  // 9. Shadow orders: same price rules, no stake limits, one per rule per pick
  const shadowCfg = { ...cfg, limits: { ...cfg.limits, maxUnitsPerDay: Infinity, maxOpenUnits: Infinity, lossStopUnits: Infinity } };
  for (const s of cands.filter(c => c.kind === "shadow")) {
    const mine = orders.filter(o => o.shadow && o.rule === s.rule);
    if (mine.some(o => o.pickKey === s.pickKey && o.status !== "cancelled")) continue;
    const q = quotes.get(s.pickKey);
    const d = decide(s, mine, shadowCfg, q, NOW);
    if (d.action === "skip") { store.logOnce(s.rule + "|" + s.pickKey, s.start, { type: "skip", shadow: true, reason: d.reason, rule: s.rule, pick: pickInfo(s) }); continue; }
    place({ ...s, alsoMatched: [] }, d, q, cfg, true);
  }
  pruneFirstAlert(S.firstAlert, NOW);
  return finish(cfg, "ok");
}

function place(s, d, q, cfg, shadow) {
  const filled = d.fill != null;
  const o = {
    id: `${NOW}-${orders.length + 1}`, mode: cfg.mode, shadow, rule: s.rule, alsoMatched: s.alsoMatched || [],
    sigKey: s.sigKey, pickKey: s.pickKey, marketKey: s.marketKey, venue: s.venue, conditionId: s.conditionId, idx: s.idx,
    name: s.name, title: s.title, slug: s.slug, league: s.league, marketType: s.marketType, start: s.start,
    whale: { q: s.q, usd: s.usd, score: s.score, sharp: s.sharp, flow: s.flow, ts: s.whaleTs, wallet: s.wallet },
    stakeUnits: cfg.limits.stakeUnits, limitPrice: d.limitPrice, createdAt: NOW,
    quoteAtOrder: { ask: q.ask, bid: q.bid, mid: q.mid, depth: q.depth, at: q.at, source: q.source },
    status: filled ? "filled" : "resting", fillPrice: d.fill, filledAt: filled ? NOW : null,
    // filling on placement crosses the spread: taker fee. A resting order that fills later is a maker fill: no fee.
    taker: filled ? true : null, feeUnits: filled ? +feeUnits(s.venue, d.fill, cfg.limits.stakeUnits, cfg).toFixed(4) : null,
    priceSource: filled ? q.source : null, slippageCents: filled ? cents(d.fill - s.q) : null,
    close: q.at < s.start ? { bid: q.bid, ask: q.ask, mid: q.mid, at: q.at, minsBefore: Math.round((s.start - q.at) / 60), source: q.source } : null
  };
  orders.push(o);
  if (shadow) stats.shadowOrdered++; else { stats.ordered++; filled ? stats.filled++ : stats.rested++; }
  store.log({ type: "order", id: o.id, shadow, status: o.status, rule: o.rule, alsoMatched: o.alsoMatched, pick: pickInfo(s),
    whale: o.whale, limit: o.limitPrice, ask: q.ask, source: q.source });
}

function cancel(o, reason) {
  Object.assign(o, { status: "cancelled", cancelledAt: NOW, cancelReason: reason });
  stats.cancelled++;
  store.log({ type: "cancel", id: o.id, rule: o.rule, shadow: !!o.shadow, reason });
}
const cents = x => Math.round(x * 1000) / 10;
const pickInfo = s => ({ venue: s.venue, league: s.league, title: s.title, side: s.name, start: s.start, whaleKey: s.sigKey, q: s.q, score: s.score, sharp: s.sharp, marketType: s.marketType });

async function settleOrders(idx, pending, cfg) {
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
      const gross = unitsFor(e.result, o.fillPrice, o.stakeUnits), fee = o.feeUnits || 0;
      Object.assign(o, { status: "settled", result: e.result, grossUnits: +gross.toFixed(4), units: +(gross - fee).toFixed(4), whaleUnits: e.units ?? null, settledAt: NOW });
      stats.settled++;
      store.log({ type: "settle", id: o.id, rule: o.rule, shadow: !!o.shadow, result: e.result, units: o.units, fee, whaleUnits: e.units ?? null, fill: o.fillPrice, whaleQ: o.whale.q, closeMid: o.close ? o.close.mid : null });
    } else if (!pending[o.sigKey] && NOW - o.whale.ts > 15 * 86400) {
      // the collector drops bets that never settle after two weeks (voided or delisted markets)
      Object.assign(o, { status: "void", units: 0, grossUnits: 0, settledAt: NOW });
      store.log({ type: "settle", id: o.id, rule: o.rule, shadow: !!o.shadow, result: "void", units: 0 });
    }
  }
}

function finish(cfg, status) {
  const summary = summarize(orders, cfg, NOW);
  summary.lastRun = { at: NOW, status, ...stats };
  summary.dataUpdated = dataUpdated;
  summary.killSwitch = killed(cfg);
  store.log({ type: "run", status, ...stats, openUnits: summary.openUnits, unitsToday: summary.unitsToday });
  const n = store.save(summary);
  const r = summary.real;
  console.log(`Paper run ${status}: ${stats.candidates} candidates, ${stats.ordered} new orders (${stats.filled} filled, ${stats.rested} resting), ${stats.skipped} new skips, ` +
    `${stats.shadowOrdered} shadow, ${stats.settled} settled, ${stats.cancelled} cancelled, ${stats.closes} closing quotes. ` +
    `Trial ${r.w}-${r.l}, net ${r.netUnits}u, CLV ${r.clvAvgCents ?? "–"}¢ on ${r.clvN}. Open ${summary.openUnits}u, today ${summary.unitsToday}u. ${n} log lines.`);
}

main().catch(e => {
  // Fail closed: log why, place nothing further, and exit non-zero so GitHub flags the run
  try { store.log({ type: "run", status: "error", error: String(e.message || e) }); store.save(); } catch {}
  console.error("Paper run stopped, no further orders: " + (e.message || e));
  process.exit(1);
});
