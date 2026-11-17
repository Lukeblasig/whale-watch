// Prints every Best filter's settled pre-game record and edge signal, from the collector's data.
// Usage: node bot/report.mjs <dir with settled-*.json>   (or no dir: downloads from the data branch)
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
import { loadSettled } from "./lib/data.mjs";
const F = createRequire(import.meta.url)("../filters.js");
const entries = await loadSettled(process.argv[2]);
const picks = F.presetPicks(entries);
const rows = F.PRESETS.map(pr => F.presetRecord(pr, picks)).sort((a, b) => (b.signal.z ?? -99) - (a.signal.z ?? -99));
const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
console.log(`${picks.length} settled picks counted\n`);
console.log(pad("filter", 22) + lp("bets", 6) + lp("W-L", 11) + lp("units", 9) + lp("ROI", 8) + lp("z", 7) + lp("games", 7) + "  signal");
for (const r of rows) console.log(pad(r.id, 22) + lp(r.n, 6) + lp(r.w + "-" + r.l, 11) + lp(r.u.toFixed(1), 9) + lp(r.roi.toFixed(1) + "%", 8)
  + lp(r.signal.z == null ? "–" : r.signal.z.toFixed(2), 7) + lp(r.signal.games ?? "–", 7) + "  " + r.signal.label);
if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows.map(({ list, ...r }) => r), null, 1));
