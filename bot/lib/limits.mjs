// Every rule that can stop an order. Pure functions: same inputs, same answer, easy to test.
// If any of these throws, the caller stops the whole run instead of placing anything.

const ACTIVE = new Set(["resting", "filled"]);          // money committed, result unknown
const COUNTED = new Set(["resting", "filled", "settled"]); // orders that used up a pick or a day's stake

// Calendar day in Central time, e.g. "2026-11-17"
const CENTRAL = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
export const dayKey = sec => CENTRAL.format(new Date(sec * 1000));

export const openUnits = orders => orders.filter(o => ACTIVE.has(o.status)).reduce((a, o) => a + o.stakeUnits, 0);
export const unitsToday = (orders, now) => orders.filter(o => COUNTED.has(o.status) && dayKey(o.createdAt) === dayKey(now)).reduce((a, o) => a + o.stakeUnits, 0);

// Drawdown of settled results from their high point, counting only orders settled after resetAt
export function drawdown(orders, resetAt) {
  const since = resetAt ? Date.parse(resetAt) / 1000 : 0;
  const s = orders.filter(o => o.status === "settled" && o.settledAt >= since).sort((a, b) => a.settledAt - b.settledAt);
  let eq = 0, peak = 0, dd = 0;
  for (const o of s) { eq += o.units; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { units: eq, drawdown: dd, current: peak - eq };
}
export function lossStopHit(orders, cfg) {
  const d = drawdown(orders, cfg.lossStopResetAt);
  return d.current >= cfg.limits.lossStopUnits ? d : null;
}

// Decide what to do with one signal. Returns { action: "skip", reason } or { action: "order", limitPrice, fill }.
// quote = { ask, at, source } for the side the whale bought, or null if no fresh price.
export function decide(sig, orders, cfg, quote, now) {
  const K = cfg.checks, L = cfg.limits, stake = L.stakeUnits;
  if (!(sig.start > now)) return skip("game already started");
  if (orders.some(o => o.pickKey === sig.pickKey && COUNTED.has(o.status))) return skip("already bet this pick");
  if (orders.some(o => o.marketKey === sig.marketKey && o.pickKey !== sig.pickKey && COUNTED.has(o.status))) return skip("already bet the other side of this market");
  if ((sig.start - now) / 60 < K.startCutoffMinutes) return skip(`starts in under ${K.startCutoffMinutes} min`);
  const ls = lossStopHit(orders, cfg);
  if (ls) return skip(`loss stop: down ${ls.current.toFixed(2)}u from the high (limit ${L.lossStopUnits}u)`, "paused");
  if (unitsToday(orders, now) + stake > L.maxUnitsPerDay) return skip(`daily limit of ${L.maxUnitsPerDay}u reached`);
  if (openUnits(orders) + stake > L.maxOpenUnits) return skip(`open exposure limit of ${L.maxOpenUnits}u reached`);
  if (!quote || !(quote.ask > 0 && quote.ask < 1)) return skip("no current price");
  if (now - quote.at > K.maxQuoteAgeMinutes * 60) return skip(`price is over ${K.maxQuoteAgeMinutes} min old`);
  const q = sig.q, limitPrice = round2(Math.min(0.99, q + K.maxPriceRiseCents / 100));
  if (K.maxPriceDropCents !== null && quote.ask < q - K.maxPriceDropCents / 100 - 1e-9)
    return skip(`price fell ${c(q - quote.ask)} below the whale's ${c(q)}: market moved against it`);
  return { action: "order", limitPrice, fill: quote.ask <= limitPrice + 1e-9 ? quote.ask : null };
}
const skip = (reason, kind = "skip") => ({ action: "skip", reason, kind });
const round2 = x => Math.round(x * 100) / 100;
const c = x => Math.round(x * 100) + "¢";

// A resting (unfilled) order: fill it if the price came back under the limit, cancel it at the cutoff.
export function updateResting(o, quote, cfg, now) {
  if ((o.start - now) / 60 < cfg.checks.startCutoffMinutes) return { status: "cancelled", reason: "unfilled at the start-time cutoff" };
  if (quote && now - quote.at <= cfg.checks.maxQuoteAgeMinutes * 60 && quote.ask <= o.limitPrice + 1e-9) return { status: "filled", fill: quote.ask };
  return null;
}

// Units won or lost on our own fill price (risk 1 unit to win (1 - p) / p)
export const unitsFor = (result, price, stake) => result === "W" ? stake * (1 - price) / price : result === "L" ? -stake : 0;
