import test from "node:test";
import assert from "node:assert/strict";
import { decide, drawdown, updateResting, unitsFor, dayKey, openUnits, feeUnits, clvOf } from "../lib/limits.mjs";
import { findCandidates, tradeSignals } from "../lib/signals.mjs";
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../filters.js");
import { validateConfig, killed } from "../lib/config.mjs";
import fs from "node:fs";

const base = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));
const cfg = (over = {}) => ({ ...base, ...over, limits: { ...base.limits, ...(over.limits || {}) }, checks: { ...base.checks, ...(over.checks || {}) } });
const NOW = 1794950000;
const sig = (o = {}) => ({ pickKey: "Polymarket|c1|0", marketKey: "Polymarket|c1", q: 0.8, start: NOW + 3 * 3600, ...o });
const quote = (ask, at = NOW) => ({ ask, at, source: "test" });
const ord = (o = {}) => ({ pickKey: "Polymarket|x|0", marketKey: "Polymarket|x", status: "filled", stakeUnits: 1, createdAt: NOW, ...o });

test("places a filled order at the current ask when the price hasn't moved", () => {
  const d = decide(sig(), [], cfg(), quote(0.81), NOW);
  assert.equal(d.action, "order"); assert.equal(d.fill, 0.81); assert.equal(d.limitPrice, 0.81);
});
test("limit is the whale's price + 1¢, rounded down to a whole cent", () => {
  assert.equal(decide(sig({ q: 0.6156 }), [], cfg(), quote(0.62), NOW).limitPrice, 0.62);
  assert.equal(decide(sig({ q: 0.6156 }), [], cfg(), quote(0.63), NOW).fill, null);
});
test("rests (no fill) when the price rose more than the limit allows", () => {
  const d = decide(sig(), [], cfg(), quote(0.82), NOW);
  assert.equal(d.action, "order"); assert.equal(d.fill, null);
});
test("price drop check: off by default (takes the better price), skips when turned on", () => {
  assert.equal(decide(sig(), [], cfg(), quote(0.6), NOW).fill, 0.6);
  assert.match(decide(sig(), [], cfg({ checks: { maxPriceDropCents: 3 } }), quote(0.76), NOW).reason, /fell/);
  assert.equal(decide(sig(), [], cfg({ checks: { maxPriceDropCents: 3 } }), quote(0.77), NOW).action, "order");
});
test("no price, or a stale price, means no order", () => {
  assert.match(decide(sig(), [], cfg(), null, NOW).reason, /no current price/);
  assert.match(decide(sig(), [], cfg(), quote(0.8, NOW - 31 * 60), NOW).reason, /old/);
});
test("start-time cutoff keeps every bet pre-game", () => {
  assert.match(decide(sig({ start: NOW + 9 * 60 }), [], cfg(), quote(0.8), NOW).reason, /under 10 min/);
  assert.match(decide(sig({ start: NOW - 1 }), [], cfg(), quote(0.8), NOW).reason, /started/);
  assert.equal(decide(sig({ start: NOW + 11 * 60 }), [], cfg(), quote(0.8), NOW).action, "order");
});
test("one bet per pick, and never both sides of a market", () => {
  assert.match(decide(sig(), [ord({ pickKey: "Polymarket|c1|0", marketKey: "Polymarket|c1" })], cfg(), quote(0.8), NOW).reason, /already bet this pick/);
  assert.match(decide(sig(), [ord({ pickKey: "Polymarket|c1|1", marketKey: "Polymarket|c1" })], cfg(), quote(0.8), NOW).reason, /other side/);
  // a cancelled (never filled) order doesn't use up the pick
  assert.equal(decide(sig(), [ord({ pickKey: "Polymarket|c1|0", marketKey: "Polymarket|c1", status: "cancelled" })], cfg(), quote(0.8), NOW).action, "order");
});
test("daily limit counts resting, filled and settled orders placed today (Central time)", () => {
  const today = Array.from({ length: base.limits.maxUnitsPerDay }, (_, i) => ord({ pickKey: "P|" + i, marketKey: "P|" + i, status: i % 2 ? "settled" : "resting", settledAt: NOW, units: 0 }));
  assert.match(decide(sig(), today, cfg(), quote(0.8), NOW).reason, /daily limit/);
  const yesterday = today.map(o => ({ ...o, createdAt: NOW - 86400 }));
  assert.equal(decide(sig(), yesterday, cfg(), quote(0.8), NOW).action, "order");
});
test("open exposure limit counts resting and filled, not settled", () => {
  const open = Array.from({ length: base.limits.maxOpenUnits }, (_, i) => ord({ pickKey: "P|" + i, marketKey: "P|" + i, createdAt: NOW - 86400 * 2 }));
  assert.equal(openUnits(open), base.limits.maxOpenUnits);
  assert.match(decide(sig(), open, cfg({ limits: { maxUnitsPerDay: 9999 } }), quote(0.8), NOW).reason, /open exposure/);
});
test("loss stop pauses on drawdown from the high point, and a reset date clears it", () => {
  const s = (u, t) => ord({ pickKey: "S|" + t, marketKey: "S|" + t, status: "settled", units: u, settledAt: NOW - 1000 + t, createdAt: NOW - 86400 * 3 });
  const L = base.limits.lossStopUnits;
  const hist = [s(5, 1), ...Array.from({ length: L }, (_, i) => s(-1, 2 + i))];
  assert.equal(drawdown(hist).current, L);
  const d = decide(sig(), hist, cfg(), quote(0.8), NOW);
  assert.equal(d.kind, "paused"); assert.match(d.reason, /loss stop/);
  const reset = new Date((NOW - 1) * 1000).toISOString();
  assert.equal(decide(sig(), hist, cfg({ lossStopResetAt: reset }), quote(0.8), NOW).action, "order");
});
test("resting orders fill when the price comes back, cancel at the cutoff", () => {
  const o = { start: NOW + 3600, limitPrice: 0.83 };
  assert.equal(updateResting(o, quote(0.84), cfg(), NOW), null);
  assert.deepEqual(updateResting(o, quote(0.82), cfg(), NOW), { status: "filled", fill: 0.82 });
  assert.equal(updateResting({ ...o, start: NOW + 300 }, quote(0.82), cfg(), NOW).status, "cancelled");
});
test("units use our own fill price", () => {
  assert.equal(unitsFor("W", 0.8, 1).toFixed(4), "0.2500");
  assert.equal(unitsFor("L", 0.8, 1), -1);
  assert.equal(unitsFor("P", 0.8, 1), 0);
});
test("days roll over at midnight Central, not UTC", () => {
  const t = Date.parse("2026-11-18T05:30:00Z") / 1000; // 11:30pm Nov 17 Central
  assert.equal(dayKey(t), "2026-11-17");
});
test("config: the shipped file is valid; broken values stop the bot", () => {
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig({ ...base, filters: ["nope"] }), /unknown filter/);
  assert.throws(() => validateConfig({ ...base, shadowFilters: ["pmSharp3h"] }), /both/);
  assert.throws(() => validateConfig({ ...base, fees: { Polymarket: 0.03 } }), /Kalshi/);
  assert.throws(() => validateConfig({ ...base, limits: { ...base.limits, maxOpenUnits: null } }), /maxOpenUnits/);
  assert.throws(() => validateConfig({ ...base, limits: { ...base.limits, stakeUnits: 2 } }), /flat 1 unit/);
  assert.throws(() => validateConfig({ ...base, mode: "live" }), /mode/);
  assert.throws(() => validateConfig({ ...base, checks: { ...base.checks, startCutoffMinutes: 0 } }), /near-live/);
});
test("kill switch: config flag or WW_KILL variable", () => {
  assert.equal(killed(base, {}), false);
  assert.equal(killed({ ...base, killSwitch: true }, {}), true);
  assert.equal(killed(base, { WW_KILL: "true" }), true);
  assert.equal(killed(base, { WW_KILL: "" }), false);
});

test("taker fee is rate × (1 − P) per unit staked", () => {
  assert.equal(feeUnits("Polymarket", 0.8, 1, base).toFixed(4), "0.0060");
  assert.equal(feeUnits("Kalshi", 0.5, 1, base).toFixed(4), "0.0350");
});
test("CLV is the closing mid minus our fill", () => {
  assert.deepEqual(clvOf({ fillPrice: 0.6, close: { mid: 0.63 } }), { cents: 3, pct: 5 });
  assert.equal(clvOf({ fillPrice: 0.6, close: null }), null);
});
test("market type from titles", () => {
  assert.equal(F.marketType("Knicks vs. Raptors"), "moneyline");
  assert.equal(F.marketType("Spread: Knicks (-4.5)"), "spread");
  assert.equal(F.marketType("Knicks vs. Raptors: O/U 220.5"), "total");
  assert.equal(F.marketType("Will Arsenal vs. Chelsea end in a draw?"), "draw");
});
test("pmSharp3h: Polymarket, sharp, whale bet 10 min to 3 h before start, first alert per market only", () => {
  const start = NOW + 2 * 3600;
  const e = (key, o) => ({ key, venue: "Polymarket", conditionId: "m1", idx: 0, name: "A", title: "A vs. B", q: 0.6, usd: 5000, score: 50, sharp: true, source: "live", result: null, start, ts: start - 3600, ...o });
  const cfgT = { ...base, filters: ["pmSharp3h"], shadowFilters: [] };
  const pend = { a: e("a", { ts: start - 5000 }), b: e("b", { ts: start - 4000, idx: 1 }), c: e("c", { conditionId: "m2", sharp: false }),
    d: e("d", { conditionId: "m3", ts: start - 4 * 3600 }), k: e("k", { conditionId: "m4", venue: "Kalshi" }), z: e("z", { conditionId: "m5", ts: start - 300 }) };
  const mem = {};
  const c1 = findCandidates(pend, cfgT, NOW, mem);
  assert.deepEqual(c1.map(c => c.sigKey), ["a"]);            // m1's first alert only; m2 not sharp; m3 too early; m4 Kalshi; m5 under 10 min
  // a later run where "a" is gone from the list: the first alert was already seen, so "b" (later, other side) stays ignored
  const { a, ...rest } = pend;
  assert.deepEqual(findCandidates(rest, cfgT, NOW, mem).map(c => c.sigKey), []);
  assert.equal(tradeSignals(c1, cfgT)[0].rule, "pmSharp3h");
});
