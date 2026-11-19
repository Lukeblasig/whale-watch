/* Whale Watch filter rules, shared by the site (index.html) and the auto-bettor (bot/).
   Edit the Best filters HERE ONLY, so the site and the bot can never disagree about what fired.
   Loads as a plain <script> in the browser (sets window.WWFilters) and via require() in Node. */
(function (root) {
"use strict";
// Each preset was picked from the results analysis; its record is recomputed live from the settled bets.
  const SOCCER = new Set(["Other soccer", "EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "UCL", "UEL", "Conference League", "MLS", "NWSL"]);
  const PRESETS = [
    // Rebuilt Nov 1 from pre-game results: each was profitable both before and after Oct 23 and survives the multiple-testing check.
    { id: "soc7090agree40", name: "Soccer · 70–90¢ · score 40+ · big money agrees", t: b => SOCCER.has(b.league) && b.q >= .7 && b.q < .9 && b.score >= 40 && b.flow === "agree" },
    { id: "socSharp4060agree60", name: "Soccer · sharps · 40–60¢ · score 60+ · big money agrees", t: b => SOCCER.has(b.league) && b.sharp && b.q >= .4 && b.q < .6 && b.score >= 60 && b.flow === "agree" },
    { id: "socSharpAgree60", name: "Soccer · sharps · score 60+ · big money agrees", t: b => SOCCER.has(b.league) && b.sharp && b.score >= 60 && b.flow === "agree" },
    { id: "socSharp6090agree50", name: "Soccer · sharps · 60–90¢ · score 50+ · big money agrees", t: b => SOCCER.has(b.league) && b.sharp && b.q >= .6 && b.q < .9 && b.score >= 50 && b.flow === "agree" },
    { id: "soc6090agree", name: "Soccer · 60–90¢ · big money agrees", t: b => SOCCER.has(b.league) && b.q >= .6 && b.q < .9 && b.flow === "agree" },
    { id: "socAgree40", name: "Soccer · score 40+ · big money agrees", t: b => SOCCER.has(b.league) && b.score >= 40 && b.flow === "agree" },
    { id: "socSharp4050s50", name: "Soccer · sharps · 40–50¢ · score 50+", t: b => SOCCER.has(b.league) && b.sharp && b.q >= .4 && b.q < .5 && b.score >= 50 },
    { id: "soc4560agree", name: "Soccer · 45–60¢ · score 50+ · big money agrees", t: b => SOCCER.has(b.league) && b.q >= .45 && b.q < .6 && b.score >= 50 && b.flow === "agree" },
    { id: "socSharp4050", name: "Soccer · sharps · 40–50¢", t: b => SOCCER.has(b.league) && b.sharp && b.q >= .4 && b.q < .5 },
    { id: "soc8090ok", name: "Soccer · 80–90¢ · big money not against", t: b => SOCCER.has(b.league) && b.q >= .8 && b.q < .9 && (b.flow === "agree" || b.flow === "none") },
    { id: "p8090ok", name: "80–90¢ · big money not against · all sports", t: b => b.q >= .8 && b.q < .9 && (b.flow === "agree" || b.flow === "none") },
    { id: "soc7090ok", name: "Soccer · 70–90¢ · big money not against", t: b => SOCCER.has(b.league) && b.q >= .7 && b.q < .9 && (b.flow === "agree" || b.flow === "none") },
    { id: "sharp6090agree", name: "Sharps · 60–90¢ · big money agrees · all sports", t: b => b.sharp && b.q >= .6 && b.q < .9 && b.flow === "agree" },
    { id: "p7090ok", name: "70–90¢ · big money not against · all sports", t: b => b.q >= .7 && b.q < .9 && (b.flow === "agree" || b.flow === "none") },
    { id: "sharp4050", name: "Sharps · 40–50¢ · all sports", t: b => b.sharp && b.q >= .4 && b.q < .5 },
    { id: "cfb5060", name: "CFB · 50–60¢ · big money not against", t: b => b.league === "CFB" && b.q >= .5 && b.q < .6 && (b.flow === "agree" || b.flow === "none") },
    // Tennis: both venues. Kalshi start times were 3h late until Nov 10, so its older "pre-game" tennis bets were mostly in-game; the collector fixed them
    { id: "ten70", name: "Tennis · score 70+", venues: ["Polymarket", "Kalshi"], t: b => b.league === "Tennis" && b.score >= 70 },
    { id: "ten60", name: "Tennis · score 60+", venues: ["Polymarket", "Kalshi"], t: b => b.league === "Tennis" && b.score >= 60 },
    { id: "ten50", name: "Tennis · score 50+", venues: ["Polymarket", "Kalshi"], t: b => b.league === "Tennis" && b.score >= 50 },
    // Same tennis filters split by venue, so each one's own record shows
    { id: "tenP70", name: "Tennis · Polymarket · score 70+", venues: ["Polymarket"], t: b => b.league === "Tennis" && b.score >= 70 },
    { id: "tenP50", name: "Tennis · Polymarket · score 50+", venues: ["Polymarket"], t: b => b.league === "Tennis" && b.score >= 50 },
    { id: "tenK70", name: "Tennis · Kalshi · score 70+", venues: ["Kalshi"], t: b => b.league === "Tennis" && b.score >= 70 },
    { id: "tenK60", name: "Tennis · Kalshi · score 60+", venues: ["Kalshi"], t: b => b.league === "Tennis" && b.score >= 60 },
    // Nov 6: smaller groups with big ROI that were positive in both halves of the data; watch them as they grow
    { id: "ucl7090s60", name: "UCL · 70–90¢ · score 60+", t: b => b.league === "UCL" && b.q >= .7 && b.q < .9 && b.score >= 60 },
    { id: "osoc60agree", name: "Other soccer · score 60+ · big money agrees", t: b => b.league === "Other soccer" && b.score >= 60 && b.flow === "agree" },
    { id: "osoc4060s60agree", name: "Other soccer · 40–60¢ · score 60+ · big money agrees", t: b => b.league === "Other soccer" && b.q >= .4 && b.q < .6 && b.score >= 60 && b.flow === "agree" },
    { id: "osoc70", name: "Other soccer · score 70+", t: b => b.league === "Other soccer" && b.score >= 70 },
    { id: "ucl50agree", name: "UCL · score 50+ · big money agrees", t: b => b.league === "UCL" && b.score >= 50 && b.flow === "agree" },
    { id: "ucl4060agree", name: "UCL · 40–60¢ · big money agrees", t: b => b.league === "UCL" && b.q >= .4 && b.q < .6 && b.flow === "agree" },
    { id: "esp6090s70", name: "Esports · 60–90¢ · score 70+", t: b => b.league === "Esports" && b.q >= .6 && b.q < .9 && b.score >= 70 },
    { id: "esp4060agree", name: "Esports · 40–60¢ · big money agrees", t: b => b.league === "Esports" && b.q >= .4 && b.q < .6 && b.flow === "agree" },
    { id: "seraSharp50", name: "Serie A · sharps · score 50+", t: b => b.league === "Serie A" && b.sharp && b.score >= 50 },
    { id: "sera6090agree", name: "Serie A · 60–90¢ · big money agrees", t: b => b.league === "Serie A" && b.q >= .6 && b.q < .9 && b.flow === "agree" },
    { id: "nbaSharp7090s60", name: "NBA · sharps · 70–90¢ · score 60+", t: b => b.league === "NBA" && b.sharp && b.q >= .7 && b.q < .9 && b.score >= 60 },
    { id: "uel7090s50", name: "UEL · 70–90¢ · score 50+", t: b => b.league === "UEL" && b.q >= .7 && b.q < .9 && b.score >= 50 },
    { id: "ufc5070", name: "UFC · 50–70¢", t: b => b.league === "UFC" && b.q >= .5 && b.q < .7 },
    { id: "mls50", name: "MLS · score 50+", t: b => b.league === "MLS" && b.score >= 50 },
    // brought back on request; these faded in the Oct 23–Nov 1 check, so watch their records
    { id: "soc60", name: "Other soccer · score 60+", t: b => b.league === "Other soccer" && b.score >= 60 },
    { id: "soc50", name: "Other soccer · score 50+", t: b => b.league === "Other soccer" && b.score >= 50 },
    { id: "esp7090", name: "Esports 70–90¢", t: b => b.league === "Esports" && b.q >= .7 && b.q < .9 },
    // Nov 19: found using only what was known at the alert (money flow as of the alert, Kalshi pattern points from
    // earlier fills only), first alert per pick, net of fees and a 1¢ worse fill. Each passed a false-discovery check
    // over 31,000 tested combinations and was positive both before and after Nov 6.
    { id: "sharp8090agree", name: "Sharps · 80–90¢ · big money agrees", t: b => b.sharp && b.q >= .8 && b.q < .9 && b.flow === "agree" },
    { id: "sharp4060ml70", name: "Sharps · moneylines · 40–60¢ · score 70+", t: b => b.sharp && b.mt === "moneyline" && b.q >= .4 && b.q < .6 && b.score >= 70 },
    { id: "sharpMl70", name: "Sharps · moneylines · score 70+", t: b => b.sharp && b.mt === "moneyline" && b.score >= 70 },
    { id: "soc4050ml40", name: "Soccer moneylines · 40–50¢ · score 40+", t: b => SOCCER.has(b.league) && b.mt === "moneyline" && b.q >= .4 && b.q < .5 && b.score >= 40 },
    { id: "socSharp4060ml40", name: "Soccer · sharps · moneylines · 40–60¢ · score 40+", t: b => SOCCER.has(b.league) && b.sharp && b.mt === "moneyline" && b.q >= .4 && b.q < .6 && b.score >= 40 },
    { id: "soc7090s60", name: "Soccer · 70–90¢ · score 60+", t: b => SOCCER.has(b.league) && b.q >= .7 && b.q < .9 && b.score >= 60 },
    { id: "ten7090sharp3h", name: "Tennis · sharps · 70–90¢ · bet within 3h of start", t: b => b.league === "Tennis" && b.sharp && b.q >= .7 && b.q < .9 && b.lead != null && b.lead <= 3 * 3600 }
  ];

  const flowOf = (flow, n) => n === 0 ? "none" : flow >= 10 ? "agree" : flow <= -5 ? "disagree" : "mixed";
  const venueOf = e => e.venue || "Polymarket";
  // Market type from the title: moneyline, spread, total or draw
  const marketType = t => /draw/i.test(t || "") ? "draw" : /spread|\([+-]\d/i.test(t || "") ? "spread" : /o\/u|\bover\b|\bunder\b|total/i.test(t || "") ? "total" : "moneyline";
  // A settled or pending ledger entry -> the shape filters test. Score and money flow come from a0, the snapshot taken
  // when the bet was first seen (the alert). The saved f keeps updating until the game ends, including in-game money,
  // so testing on it let filters use information nobody had when the alert went out.
  const normL = e => { const a = e.a0;
    return { q: e.q, score: a ? a.score : e.score, league: e.league || "Other", venue: venueOf(e), sharp: !!e.sharp, usd: e.usd,
      flow: a ? flowOf(a.flow, a.n) : e.f ? flowOf(e.f.flow, e.f.n) : null, timing: e.start ? (e.ts < e.start ? "pre" : "live") : null,
      mt: marketType(e.title), lead: e.start ? e.start - e.ts : null }; };
  // A live position built in the browser (score parts in p.parts) -> the same shape; live means it is the alert right now
  const normP = p => ({ q: p.q, score: p.score, league: p.league || "Other", venue: p.venue, sharp: !!p.sharp, usd: p.usd,
    flow: p.parts ? flowOf(p.parts.flow, p.parts.n) : null, timing: p.start ? (p.ts < p.start ? "pre" : "live") : null,
    mt: marketType(p.title), lead: p.start ? p.start - p.ts : null });

  // The tool tracks pre-game bets only: records use bets placed before the game, live bets are games not yet started
  const PRE_ONLY = true;
  // "Upcoming": the bet was placed before the game and the game hasn't started yet, so it can still be copied pre-game.
  const upcoming = (p, nowSec) => !!p.start && p.ts < p.start && p.start > (nowSec ?? Date.now() / 1000);
  // Filters use Polymarket only unless they list Kalshi too (only where Kalshi has its own track record)
  const venueOk = (pr, v) => (pr.venues || ["Polymarket"]).includes(v);
  const isJunk = e => e.junk || e.q < 0.03 || e.q > 0.97;

  // Settled bets that can count toward a filter's record: $1k+, not backfill, sane price, oldest first.
  // presetRecord then keeps one bet per market side: the FIRST alert that matched the filter, as someone copying it would.
  function presetPicks(entries) {
    return entries.filter(e => e.result && e.usd >= 1000 && e.source !== "backfill" && e.q >= 0.03 && e.q <= 0.97 && !e.junk).sort((a, b) => a.ts - b.ts);
  }
  const pickKey = e => venueOf(e) + "|" + e.conditionId + "|" + e.idx;
  // One game: Polymarket's event slug, Kalshi's event ticker (its market ticker minus the last part)
  const gameKey = e => venueOf(e) === "Kalshi" ? "K|" + String(e.conditionId).replace(/-[^-]+$/, "") : "P|" + (e.slug || e.eventSlug || e.conditionId);
  // Units after Polymarket's 0.03 / Kalshi's 0.07 taker fee and a fill 1¢ worse than the whale's price
  const FEE_RATE = { Polymarket: 0.03, Kalshi: 0.07 };
  const netUnits = e => { if (e.result === "P") return 0; const p = Math.min(0.99, e.q + 0.01), fee = FEE_RATE[venueOf(e)] * (1 - p); return e.result === "W" ? (1 - p) / p - fee : -1 - fee; };
  // Is a group's ROI bigger than luck? Bets on the same game rise and fall together, so the spread is measured per game,
  // and the bar for "real" is set high because the tables show many groups at once.
  function edgeSignal(list) {
    const n = list.length;
    if (n < 30) return { key: "few", label: "Too few bets", z: null, n, games: null };
    const mean = list.reduce((a, e) => a + (e.units || 0), 0) / n;
    const g = new Map();
    list.forEach(e => { const k = gameKey(e); g.set(k, (g.get(k) || 0) + (e.units || 0) - mean); });
    const G = g.size; if (G < 15) return { key: "few", label: "Too few games", z: null, n, games: G };
    let ss = 0; g.forEach(v => ss += v * v);
    const se = Math.sqrt(ss * G / (G - 1)) / n || 1, z = mean / se;
    const r = (key, label) => ({ key, label, z, n, games: G });
    if (z >= 2.5) return r("up", "Likely real edge");
    if (z <= -2.5) return r("down", "Likely real loser");
    if (z >= 1.5) return r("maybe", "Promising, keep watching");
    if (z <= -1.5) return r("maybe", "Leaning negative");
    return r("few", "Could be luck");
  }
  // A filter's settled record (same numbers the Best tab shows)
  // normL of a settled bet never changes, so it is worked out once per bet (records run 47 filters over every bet)
  const normMemo = new WeakMap();
  const normOnce = e => { let b = normMemo.get(e); if (!b) { b = normL(e); normMemo.set(e, b); } return b; };
  function presetRecord(pr, picks) {
    const seen = new Set(), list = [];
    picks.forEach(e => { const b = normOnce(e); if ((PRE_ONLY && b.timing !== "pre") || !venueOk(pr, b.venue) || !pr.t(b)) return;
      const k = pickKey(e); if (seen.has(k)) return; seen.add(k); list.push(e); });
    const n = list.length, u = list.reduce((a, e) => a + (e.units || 0), 0);
    return { id: pr.id, name: pr.name, list, n, w: list.filter(e => e.result === "W").length, l: list.filter(e => e.result === "L").length,
      u, roi: n ? u / n * 100 : 0, net: n ? list.reduce((a, e) => a + netUnits(e), 0) / n * 100 : 0, signal: edgeSignal(list) };
  }
  // A position that can be copied right now: the same test the site's presetTrades() applies
  const liveEligible = (e, nowSec) => e.usd >= 1000 && e.q >= 0.03 && e.q <= 0.97 && !e.junk && (!PRE_ONLY || upcoming(e, nowSec));

  /* Trial rules (Nov 17 P/L audit). Unlike the Best filters, these only use what was known when the whale bet:
     venue, sharp flag, minutes before start, market type. Each takes a raw ledger entry (needs ts, start, title).
     firstPerMarket: only the earliest qualifying alert in a market counts; later alerts there, either side, are ignored. */
  const lead = e => e.start && e.ts ? e.start - e.ts : -1;
  const pmSharp3h = e => venueOf(e) === "Polymarket" && !!e.sharp && lead(e) >= 600 && lead(e) <= 3 * 3600;
  const TRIAL_RULES = [
    { id: "pmSharp3h", name: "Polymarket sharp · bet 10 min–3 h before start · first alert per market", firstPerMarket: true, t: pmSharp3h },
    { id: "pmSharp3hML", name: "Same, moneylines only", firstPerMarket: true, t: e => pmSharp3h(e) && marketType(e.title) === "moneyline" },
    // The score + money-flow cut from the Results analysis, forward-tested at the moment it fires (flow then can only count earlier bets)
    { id: "flowAgree2080s70", name: "Money flow agrees · 20–80¢ · score 70+", t: e => { const b = normL(e); return b.flow === "agree" && e.q >= .2 && e.q <= .8 && e.score >= 70; } }
  ];
  // Every rule the bot can trade or shadow, by id: trial rules, plus each Best filter wrapped to take a raw entry
  const RULES = new Map([
    ...TRIAL_RULES.map(r => [r.id, r]),
    ...PRESETS.map(pr => [pr.id, { id: pr.id, name: pr.name, firstPerMarket: false, t: e => { const b = normL(e); return venueOk(pr, b.venue) && pr.t(b); } }])
  ]);

  const api = { SOCCER, PRESETS, flowOf, venueOf, normL, normP, PRE_ONLY, upcoming, venueOk, isJunk, presetPicks, pickKey, gameKey, netUnits, FEE_RATE, edgeSignal, presetRecord, liveEligible,
    marketType, TRIAL_RULES, RULES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WWFilters = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
