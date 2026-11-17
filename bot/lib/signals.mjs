// Turns the collector's pending bets into signals: which whale bets fire which Best filters right now.
// Uses filters.js, the exact rules the site uses, so the site and the bot can't disagree about what fired.
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../filters.js");
const byId = new Map(F.PRESETS.map(p => [p.id, p]));

export function findSignals(pending, cfg, now) {
  const want = [...cfg.filters.map(id => [id, "trade"]), ...cfg.watchFilters.filter(id => !cfg.filters.includes(id)).map(id => [id, "watch"])];
  const picks = new Map();
  for (const e of Object.values(pending)) {
    // same eligibility as the site's live filter list: $1k+, 3–97¢, game not started, bet placed pre-game, not backfill
    if (e.result || e.source === "backfill" || !F.liveEligible(e, now)) continue;
    const b = F.normL(e);
    const hit = want.filter(([id]) => { const pr = byId.get(id); return F.venueOk(pr, b.venue) && pr.t(b); });
    if (!hit.length) continue;
    const venue = F.venueOf(e), marketKey = venue + "|" + e.conditionId, pickKey = marketKey + "|" + e.idx;
    const sig = {
      sigKey: e.key, pickKey, marketKey, venue, conditionId: e.conditionId, idx: e.idx, name: e.name, title: e.title, slug: e.slug,
      league: e.league, start: e.start, q: e.q, usd: e.usd, score: e.score, sharp: !!e.sharp, flow: b.flow, whaleTs: e.ts,
      trade: hit.filter(([, k]) => k === "trade").map(([id]) => id), watch: hit.filter(([, k]) => k === "watch").map(([id]) => id)
    };
    // one signal per pick: if several whales are on the same side, prefer one that fires a traded filter, then the highest score
    const cur = picks.get(pickKey), rank = s => (s.trade.length ? 1000 : 0) + s.score;
    if (!cur || rank(sig) > rank(cur)) picks.set(pickKey, sig);
  }
  // soonest games first, so the daily limit goes to bets that can't wait
  return [...picks.values()].sort((a, b) => a.start - b.start || b.score - a.score);
}
