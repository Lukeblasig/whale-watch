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
    { id: "esp7090", name: "Esports 70–90¢", t: b => b.league === "Esports" && b.q >= .7 && b.q < .9 }
  ];

  const flowOf = (flow, n) => n === 0 ? "none" : flow >= 10 ? "agree" : flow <= -5 ? "disagree" : "mixed";
  const venueOf = e => e.venue || "Polymarket";
  // A settled or pending ledger entry (collector format, score parts in e.f) -> the shape filters test
  const normL = e => ({ q: e.q, score: e.score, league: e.league || "Other", venue: venueOf(e), sharp: !!e.sharp, usd: e.usd,
    flow: e.f ? flowOf(e.f.flow, e.f.n) : null, timing: e.start ? (e.ts < e.start ? "pre" : "live") : null });
  // A live position built in the browser (score parts in p.parts) -> the same shape
  const normP = p => ({ q: p.q, score: p.score, league: p.league || "Other", venue: p.venue, sharp: !!p.sharp, usd: p.usd,
    flow: p.parts ? flowOf(p.parts.flow, p.parts.n) : null, timing: p.start ? (p.ts < p.start ? "pre" : "live") : null });

  // The tool tracks pre-game bets only: records use bets placed before the game, live bets are games not yet started
  const PRE_ONLY = true;
  // "Upcoming": the bet was placed before the game and the game hasn't started yet, so it can still be copied pre-game.
  const upcoming = (p, nowSec) => !!p.start && p.ts < p.start && p.start > (nowSec ?? Date.now() / 1000);
  // Filters use Polymarket only unless they list Kalshi too (only where Kalshi has its own track record)
  const venueOk = (pr, v) => (pr.venues || ["Polymarket"]).includes(v);
  const isJunk = e => e.junk || e.q < 0.03 || e.q > 0.97;

  // Settled bets that count toward a filter's record: $1k+, not backfill, sane price, one per market side (highest score wins)
  function presetPicks(entries) {
    const g = new Map();
    entries.forEach(e => {
      if (!e.result || e.usd < 1000 || e.source === "backfill" || e.q < 0.03 || e.q > 0.97 || e.junk) return;
      const k = venueOf(e) + "|" + e.conditionId + "|" + e.idx, c = g.get(k);
      if (!c || e.score > c.score) g.set(k, e);
    });
    return [...g.values()];
  }
  // Is a group's ROI bigger than luck? Bets on the same game rise and fall together, so the spread is measured per game,
  // and the bar for "real" is set high because the tables show many groups at once.
  function edgeSignal(list) {
    const n = list.length;
    if (n < 30) return { key: "few", label: "Too few bets", z: null, n, games: null };
    const mean = list.reduce((a, e) => a + (e.units || 0), 0) / n;
    const g = new Map();
    list.forEach(e => { const k = (e.venue || "") + "|" + (e.slug || e.eventSlug || e.conditionId); g.set(k, (g.get(k) || 0) + (e.units || 0) - mean); });
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
  function presetRecord(pr, picks) {
    const list = picks.filter(e => { const b = normL(e); return (!PRE_ONLY || b.timing === "pre") && venueOk(pr, b.venue) && pr.t(b); });
    const n = list.length, u = list.reduce((a, e) => a + (e.units || 0), 0);
    return { id: pr.id, name: pr.name, list, n, w: list.filter(e => e.result === "W").length, l: list.filter(e => e.result === "L").length,
      u, roi: n ? u / n * 100 : 0, signal: edgeSignal(list) };
  }
  // A position that can be copied right now: the same test the site's presetTrades() applies
  const liveEligible = (e, nowSec) => e.usd >= 1000 && e.q >= 0.03 && e.q <= 0.97 && !e.junk && (!PRE_ONLY || upcoming(e, nowSec));

  const api = { SOCCER, PRESETS, flowOf, venueOf, normL, normP, PRE_ONLY, upcoming, venueOk, isJunk, presetPicks, edgeSignal, presetRecord, liveEligible };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WWFilters = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
