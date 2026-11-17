// Writes baseline.json: every Best filter's settled pre-game record and edge signal, so the tracker can show
// paper results next to what the filter's history predicted. Heavy (reads every settled file), so the workflow runs it once a day.
// Usage: node bot/baseline.mjs <out file> [data dir]
import fs from "node:fs"; import { createRequire } from "node:module";
import { loadSettled, getData } from "./lib/data.mjs";
const F = createRequire(import.meta.url)("../filters.js");
const [out, dir] = process.argv.slice(2);
if (!out) { console.error("usage: node bot/baseline.mjs <out file> [data dir]"); process.exit(1); }
const idx = await getData("index.json", { dir });
// keep only what presetPicks could count, so memory stays small
const entries = await loadSettled(dir, e => e.result && e.usd >= 1000 && e.source !== "backfill" && !F.isJunk(e));
const picks = F.presetPicks(entries);
const filters = {};
for (const pr of F.PRESETS) {
  const r = F.presetRecord(pr, picks);
  const avgQ = r.n ? r.list.reduce((a, e) => a + e.q, 0) / r.n : null;
  filters[pr.id] = { name: pr.name, venues: pr.venues || ["Polymarket"], n: r.n, w: r.w, l: r.l, units: +r.u.toFixed(2), roi: +r.roi.toFixed(2),
    avgPrice: avgQ && +avgQ.toFixed(3), signal: r.signal.label, signalKey: r.signal.key, z: r.signal.z == null ? null : +r.signal.z.toFixed(2), games: r.signal.games };
}
fs.writeFileSync(out, JSON.stringify({ updated: Math.floor(Date.now() / 1000), dataUpdated: idx.updated, picks: picks.length, filters }, null, 1));
console.log(`Baseline: ${picks.length} settled picks, ${F.PRESETS.length} filters -> ${out}`);
