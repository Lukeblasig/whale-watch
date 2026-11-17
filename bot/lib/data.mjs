// Reads the collector's files from the data branch: the same files the site reads. The bot never scrapes venues for signals.
import fs from "node:fs"; import path from "node:path";
export const DATA_BASE = process.env.WW_DATA_BASE || "https://raw.githubusercontent.com/lukeblasig/whale-watch/data/";

export async function getData(name, { dir, base = DATA_BASE, tries = 3 } = {}) {
  if (dir) return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + name + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw err;
}
// Every settled bet the collector has saved (large: hundreds of MB). Only the report and backtests need this.
export async function loadSettled(dir, keep = () => true) {
  const idx = await getData("index.json", { dir });
  const files = idx.months.flatMap(m => (idx.parts || {})[m] || [m]).map(k => `settled-${k}.json`);
  const out = [];
  for (const f of files) { const o = await getData(f, { dir }); for (const k in o) if (keep(o[k])) out.push(o[k]); }
  return out;
}
// Settled file part that should hold a bet placed at ts (parts are sorted oldest first within each month)
export function partsForTs(idx, ts) {
  const m = new Date(ts * 1000).toISOString().slice(0, 7);
  return ((idx.parts || {})[m] || (idx.months.includes(m) ? [m] : [])).slice().reverse();
}
