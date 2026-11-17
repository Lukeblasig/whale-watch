// Turns the collector's pending bets into candidates: which whale bets fire which rules right now.
// Rules come from filters.js (the site's own file), so the site and the bot can't disagree about what fired.
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../filters.js");

// Bets the rules may consider at all: $1k+, sane price, not backfill, placed before the game
const base = e => !e.result && e.source !== "backfill" && e.usd >= 1000 && !F.isJunk(e) && e.start && e.ts < e.start;

// firstAlert (persisted between runs): ruleId|marketKey -> { key, start }. Once a market's first qualifying alert has been
// seen, later alerts there (either side) are ignored for that rule, even if the first one was skipped.
export function findCandidates(pending, cfg, now, firstAlert = {}) {
  const entries = Object.values(pending).filter(base);
  const out = [];
  const rules = [...cfg.filters.map(id => [id, "trade"]), ...cfg.shadowFilters.map(id => [id, "shadow"])];
  for (const [id, kind] of rules) {
    const rule = F.RULES.get(id);
    const hits = entries.filter(e => rule.t(e));
    const chosen = new Map(); // pickKey -> entry
    if (rule.firstPerMarket) {
      const first = new Map(); // marketKey -> earliest qualifying entry
      hits.forEach(e => { const mk = mkey(e), c = first.get(mk); if (!c || e.ts < c.ts || (e.ts === c.ts && e.key < c.key)) first.set(mk, e); });
      for (const [mk, e] of first) {
        const mem = firstAlert[id + "|" + mk];
        const pick = mem ? pending[mem.key] : e;
        if (!mem) firstAlert[id + "|" + mk] = { key: e.key, start: e.start };
        if (pick && base(pick) && F.liveEligible(pick, now)) chosen.set(pkey(pick), pick);
      }
    } else {
      // several whales on the same side: keep the highest score (same rule as the filter records)
      hits.filter(e => F.liveEligible(e, now)).forEach(e => { const k = pkey(e), c = chosen.get(k); if (!c || e.score > c.score) chosen.set(k, e); });
    }
    for (const e of chosen.values()) out.push({ rule: id, kind, ...toSig(e) });
  }
  return out;
}
const mkey = e => F.venueOf(e) + "|" + e.conditionId;
const pkey = e => mkey(e) + "|" + e.idx;
const toSig = e => ({
  sigKey: e.key, pickKey: pkey(e), marketKey: mkey(e), venue: F.venueOf(e), conditionId: e.conditionId, idx: e.idx, name: e.name, title: e.title,
  slug: e.slug, league: e.league, marketType: F.marketType(e.title), start: e.start, q: e.q, usd: e.usd, score: e.score, sharp: !!e.sharp,
  flow: F.normL(e).flow, whaleTs: e.ts, wallet: e.wallet || null
});

// Real orders: one candidate per pick, credited to the first rule in config order; the others are kept as alsoMatched
export function tradeSignals(cands, cfg) {
  const by = new Map();
  for (const id of cfg.filters) for (const c of cands.filter(c => c.kind === "trade" && c.rule === id)) {
    const s = by.get(c.pickKey);
    if (s) s.alsoMatched.push(id); else by.set(c.pickKey, { ...c, alsoMatched: [] });
  }
  // soonest games first, so the daily limit goes to bets that can't wait
  return [...by.values()].sort((a, b) => a.start - b.start || a.whaleTs - b.whaleTs);
}

export function pruneFirstAlert(firstAlert, now) {
  for (const k in firstAlert) if (firstAlert[k].start < now - 86400) delete firstAlert[k];
}
