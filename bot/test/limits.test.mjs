import test from "node:test";
import assert from "node:assert/strict";
import { decide, drawdown, updateResting, unitsFor, dayKey, openUnits } from "../lib/limits.mjs";
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
  assert.equal(d.action, "order"); assert.equal(d.fill, 0.81); assert.equal(d.limitPrice, 0.83);
});
test("rests (no fill) when the price rose more than 3¢", () => {
  const d = decide(sig(), [], cfg(), quote(0.84), NOW);
  assert.equal(d.action, "order"); assert.equal(d.fill, null);
});
test("skips when the price fell more than 3¢", () => {
  assert.match(decide(sig(), [], cfg(), quote(0.76), NOW).reason, /fell/);
  assert.equal(decide(sig(), [], cfg(), quote(0.77), NOW).action, "order");
});
test("price drop check can be turned off", () => {
  assert.equal(decide(sig(), [], cfg({ checks: { maxPriceDropCents: null } }), quote(0.6), NOW).action, "order");
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
  const today = Array.from({ length: 25 }, (_, i) => ord({ pickKey: "P|" + i, marketKey: "P|" + i, status: i % 2 ? "settled" : "resting", settledAt: NOW, units: 0 }));
  assert.match(decide(sig(), today, cfg(), quote(0.8), NOW).reason, /daily limit/);
  const yesterday = today.map(o => ({ ...o, createdAt: NOW - 86400 }));
  assert.equal(decide(sig(), yesterday, cfg(), quote(0.8), NOW).action, "order");
});
test("open exposure limit counts resting and filled, not settled", () => {
  const open = Array.from({ length: 40 }, (_, i) => ord({ pickKey: "P|" + i, marketKey: "P|" + i, createdAt: NOW - 86400 * 2 }));
  assert.equal(openUnits(open), 40);
  assert.match(decide(sig(), open, cfg({ limits: { maxUnitsPerDay: 100 } }), quote(0.8), NOW).reason, /open exposure/);
});
test("loss stop pauses on drawdown from the high point, and a reset date clears it", () => {
  const s = (u, t) => ord({ pickKey: "S|" + t, marketKey: "S|" + t, status: "settled", units: u, settledAt: NOW - 1000 + t, createdAt: NOW - 86400 * 3 });
  const hist = [s(5, 1), ...Array.from({ length: 20 }, (_, i) => s(-1, 2 + i))];
  assert.equal(drawdown(hist).current, 20);
  const d = decide(sig(), hist, cfg(), quote(0.8), NOW);
  assert.equal(d.kind, "paused"); assert.match(d.reason, /loss stop/);
  const reset = new Date((NOW - 1) * 1000).toISOString();
  assert.equal(decide(sig(), hist, cfg({ lossStopResetAt: reset }), quote(0.8), NOW).action, "order");
});
test("resting orders fill when the price comes back, cancel at the cutoff", () => {
  const o = { start: NOW + 3600, limitPrice: 0.83 };
  assert.equal(updateResting(o, quote(0.85), cfg(), NOW), null);
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
