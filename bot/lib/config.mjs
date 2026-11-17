// Loads bot/config.json and checks every field. Anything wrong throws, and the run places nothing.
import fs from "node:fs";
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../filters.js");

const MODES = ["paper"]; // "kalshi-demo" and "live" get added only when their phase starts
const isNum = (x, min = 0) => typeof x === "number" && Number.isFinite(x) && x >= min;

export function validateConfig(c) {
  const errs = [];
  if (!c || typeof c !== "object") throw new Error("config is not an object");
  if (!MODES.includes(c.mode)) errs.push(`mode must be one of ${MODES.join(", ")} (got ${JSON.stringify(c.mode)})`);
  if (typeof c.killSwitch !== "boolean") errs.push("killSwitch must be true or false");
  const ids = F.RULES;
  if (!Array.isArray(c.filters) || !c.filters.length) errs.push("filters must list at least one rule id");
  else c.filters.forEach(id => { if (!ids.has(id)) errs.push(`unknown filter "${id}"`); });
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
