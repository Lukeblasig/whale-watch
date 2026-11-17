// The bot's own log, kept on its own branch (bot-log), never mixed into the collector's data files.
//   state.json            open and past orders, plus which skips were already logged
//   decisions/YYYY-MM.jsonl  one line per decision: order, fill, skip, cancel, settle, watch, run
//   summary.json          paper record overall and per filter, for a log page later
import fs from "node:fs"; import path from "node:path";

export function openStore(dir) {
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  const file = path.join(dir, "state.json");
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, orders: [], logged: {} };
  const lines = [];
  return {
    state,
    log(rec) { lines.push({ t: Math.floor(Date.now() / 1000), ...rec }); },
    // log a skip only the first time this pick gets this reason, so a 15-minute loop doesn't repeat itself
    logOnce(pickKey, start, rec) {
      const k = pickKey + "|" + rec.reason;
      if (state.logged[k]) return false;
      state.logged[k] = start || 0; this.log(rec); return true;
    },
    save(summary) {
      const cutoff = Date.now() / 1000 - 2 * 86400;
      for (const k in state.logged) if (state.logged[k] < cutoff) delete state.logged[k];
      fs.writeFileSync(file, JSON.stringify(state, null, 1));
      if (summary) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 1));
      const byMonth = {};
      lines.forEach(l => (byMonth[new Date(l.t * 1000).toISOString().slice(0, 7)] ||= []).push(JSON.stringify(l)));
      for (const [m, ls] of Object.entries(byMonth)) fs.appendFileSync(path.join(dir, "decisions", m + ".jsonl"), ls.join("\n") + "\n");
      return lines.length;
    }
  };
}
