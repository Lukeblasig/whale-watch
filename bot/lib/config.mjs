// Loads bot/config.json and checks every field. Anything wrong throws, and the run places nothing.
import fs from "node:fs";
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../filters.js");

const MODES = ["paper"];
// "autoBest" in filters stands for every Best filter whose record clears autoBest.minNetRoiPct after fees
export const AUTO = "autoBest";
// Replaces "autoBest" with the qualifying Best filter ids (highest after-fee ROI first). baseline = baseline.json from the bot's log.
export function expandFilters(c, baseline) {
  if (!c.filters.includes(AUTO)) return { ...c, autoPicked: null };
  const A = c.autoBest, rows = Object.entries((baseline && baseline.filters) || {})
    .filter(([id, b]) => F.PRESETS.some(p => p.id === id) && typeof b.net === "number" && b.net >= A.minNetRoiPct && b.n >= A.minBets)
    .sort((a, b) => b[1].net - a[1].net);
  const picked = rows.map(([id]) => id);
  const filters = [...new Set(c.filters.flatMap(id => id === AUTO ? picked : [id]))].filter(id => !c.shadowFilters.includes(id));
  return { ...c, filters, autoPicked: rows.map(([id, b]) => ({ id, net: b.net, n: b.n })) };
} // "kalshi-demo" and "live" get added only when their phase starts
const isNum = (x, min = 0) => typeof x === "number" && Number.isFinite(x) && x >= min;

export function validateConfig(c) {
  const errs = [];
  if (!c || typeof c !== "object") throw new Error("config is not an object");
  if (!MODES.includes(c.mode)) errs.push(`mode must be one of ${MODES.join(", ")} (got ${JSON.stringify(c.mode)})`);
  if (typeof c.killSwitch !== "boolean") errs.push("killSwitch must be true or false");
  const ids = F.RULES;
  if (!Array.isArray(c.filters) || !c.filters.length) errs.push("filters must list at least one rule id");
  else c.filters.forEach(id => { if (id !== AUTO && !ids.has(id)) errs.push(`unknown filter "${id}"`); });
  if ((c.filters || []).includes(AUTO)) {
    const A = c.autoBest || {};
    if (typeof A.minNetRoiPct !== "number") errs.push("autoBest.minNetRoiPct must be a number, e.g. 2");
    if (!isNum(A.minBets)) errs.push("autoBest.minBets must be a number (0 = no minimum)");
  }
  if (new Set(c.filters || []).size !== (c.filters || []).length) errs.push("filters lists the same id twice");
  if (!Array.isArray(c.shadowFilters)) errs.push("shadowFilters must be a list (can be empty)");
  else c.shadowFilters.forEach(id => { if (!ids.has(id)) errs.push(`unknown shadow filter "${id}"`); else if ((c.filters || []).includes(id)) errs.push(`"${id}" is in both filters and shadowFilters`); });
  if (c.mode !== "paper" && !isNum(c.unitUsd, 0.01)) errs.push("unitUsd must be set before any non-paper mode");
  const L = c.limits || {};
  if (L.stakeUnits !== 1) errs.push("stakeUnits must be 1: flat 1 unit until live results exist");
  for (const k of ["maxUnitsPerDay", "maxOpenUnits", "lossStopUnits"]) if (!isNum(L[k], 1)) errs.push(`limits.${k} must be a number of at least 1`);
  if (c.lossStopResetAt !== null && isNaN(Date.parse(c.lossStopResetAt))) errs.push("lossStopResetAt must be null or a date like 2026-11-20T09:00:00-06:00");
  const K = c.checks || {};
  for (const k of ["maxPriceRiseCents", "startCutoffMinutes", "maxDataAgeMinutes", "maxQuoteAgeMinutes"]) if (!isNum(K[k])) errs.push(`checks.${k} must be a number`);
  if (K.maxPriceDropCents !== null && !isNum(K.maxPriceDropCents)) errs.push("checks.maxPriceDropCents must be a number or null");
  for (const k of ["minPrice", "maxPrice"]) if (K[k] != null && !(isNum(K[k]) && K[k] < 1)) errs.push(`checks.${k} must be a price like 0.10, or null`);
  if (K.minPrice != null && K.maxPrice != null && K.minPrice >= K.maxPrice) errs.push("checks.minPrice must be below checks.maxPrice");
  if (isNum(K.startCutoffMinutes) && K.startCutoffMinutes < 5) errs.push("checks.startCutoffMinutes below 5 would allow near-live bets");
  const fe = c.fees || {};
  for (const v of ["Polymarket", "Kalshi"]) if (!isNum(fe[v]) || fe[v] > 0.2) errs.push(`fees.${v} must be a rate like 0.03`);
  const G = c.trialGates || {};
  for (const k of ["clvBets", "roiBets", "minNetRoiPct", "maxMedianSlipCents", "trialBets", "trialWeeks"]) if (typeof G[k] !== "number") errs.push(`trialGates.${k} must be a number`);
  if (errs.length) throw new Error("Config invalid, nothing placed:\n - " + errs.join("\n - "));
  return c;
}

export function loadConfig(file) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new Error(`Config unreadable (${e.message}), nothing placed`); }
  return validateConfig(c);
}

// Kill switch: the config flag, or the WW_KILL repo variable (flip it from the GitHub app without editing files)
export const killed = (c, env = process.env) => c.killSwitch === true || /^(1|true|yes|on)$/i.test(env.WW_KILL || "");
