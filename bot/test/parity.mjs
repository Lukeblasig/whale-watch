// Proves filters.js makes exactly the same decisions as the rules that used to be inline in index.html.
// Usage: node bot/test/parity.mjs <original index.html> <dir with settled-*.json and pending.json>
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const F = require("../../filters.js");
const [orig, dir] = process.argv.slice(2);
const html = fs.readFileSync(orig, "utf8");
const a = html.indexOf("const SOCCER = new Set("), b = html.indexOf("let pickCache = {");
const c = html.indexOf('const PRE_ONLY = true;'), d = html.indexOf("function presetTrades(");
const src = "const venueOf = e => e.venue || 'Polymarket';\n" + html.slice(a, b) + html.slice(c, d) + "\nreturn { PRESETS, normL, venueOk, upcoming };";
const O = new Function(src)();
let entries = [];
for (const f of fs.readdirSync(dir).filter(f => /^(settled-.*|pending)\.json$/.test(f))) entries.push(...Object.values(JSON.parse(fs.readFileSync(path.join(dir, f)))));
if (O.PRESETS.length !== F.PRESETS.length) throw new Error("preset count differs");
let checks = 0, diffs = 0;
O.PRESETS.forEach((po, i) => {
  const pf = F.PRESETS[i];
  if (po.id !== pf.id || po.name !== pf.name || JSON.stringify(po.venues) !== JSON.stringify(pf.venues)) { diffs++; console.log("meta differs", po.id); }
  for (const e of entries) {
    const bo = O.normL(e), bf = F.normL(e);
    const x = O.venueOk(po, bo.venue) && po.t(bo), y = F.venueOk(pf, bf.venue) && pf.t(bf);
    checks++; if (x !== y) { diffs++; if (diffs < 5) console.log("differs", po.id, e.key); }
  }
});
const now = Date.now() / 1000;
for (const e of entries) { checks++; if (O.upcoming(e) !== F.upcoming(e, now)) diffs++; }
console.log(`${entries.length} bets × ${F.PRESETS.length} filters: ${checks} checks, ${diffs} differences`);
process.exit(diffs ? 1 : 0);
