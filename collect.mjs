// Whale Watch collector. Runs on GitHub Actions every ~15 minutes.
// Pulls Polymarket + Kalshi sports whale bets, scores them, settles finished ones,
// and writes data/feed.json (recent bets) and data/ledger.json (every logged bet + result).
import fs from "node:fs";

const DATA = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const KALSHI_HOSTS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const FLOOR = 1000;
const MAX_LEDGER = 12000;
const now = () => Math.floor(Date.now() / 1000);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || "[]"); } catch { return []; } };
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "whale-watch/1.0" }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(1500 * (i + 1)); throw new Error("HTTP 429"); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw new Error(url.split("?")[0] + ": " + err.message);
}
let kHost = 0;
async function kget(path) {
  let err;
  for (let n = 0; n < KALSHI_HOSTS.length; n++) {
    const i = (kHost + n) % KALSHI_HOSTS.length;
    try { const j = await getJSON(KALSHI_HOSTS[i] + path, 2); kHost = i; return j; } catch (e) { err = e; }
  }
  throw err;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/* ---------- leagues ---------- */
const PM_LEAGUES = [
  [/^nfl-/, "NFL"], [/^(cfb|ncaaf)-/, "CFB"], [/^nba-/, "NBA"], [/^wnba-/, "WNBA"], [/^(cbb|ncaab)-/, "CBB"],
  [/^mlb-/, "MLB"], [/^nhl-/, "NHL"], [/^epl-/, "EPL"], [/^(lal|laliga)-/, "La Liga"], [/^ucl-/, "UCL"],
  [/^uel-/, "UEL"], [/^(bun|bundesliga)-/, "Bundesliga"], [/^(sea|seriea)-/, "Serie A"], [/^(fl1|ligue1)-/, "Ligue 1"],
  [/^mls-/, "MLS"], [/^nwsl-/, "NWSL"], [/^ufc-/, "UFC"], [/^(atp|wta)-/, "Tennis"], [/^(pga|golf)-/, "Golf"],
  [/^(f1|formula)/, "F1"], [/^(ipl|cricket|crint)-/, "Cricket"], [/^(boxing|box)-/, "Boxing"]
];
const pmLeague = s => { for (const [re, n] of PM_LEAGUES) if (re.test(s || "")) return n; return "Other"; };
const K_LEAGUES = [[/^KXNFL/, "NFL"], [/^KXNCAAF/, "CFB"], [/^KXWNBA/, "WNBA"], [/^KXNBA/, "NBA"], [/^KXNCAA(MB|B)/, "CBB"], [/^KXMLB/, "MLB"],
  [/^KXNHL/, "NHL"], [/^KXEPL/, "EPL"], [/^KXUCL/, "UCL"], [/^KXUEL/, "UEL"], [/^KXMLS/, "MLS"], [/^KXLALIGA/, "La Liga"], [/^KXSERIEA/, "Serie A"],
  [/^KXBUNDESLIGA/, "Bundesliga"], [/^KXLIGUE1/, "Ligue 1"], [/^KXUFC/, "UFC"], [/^KX(ATP|WTA)/, "Tennis"], [/^KXPGA/, "Golf"], [/^KXF1/, "F1"]];
const kLeague = t => { for (const [re, n] of K_LEAGUES) if (re.test(t || "")) return n; return "Other"; };
const K_SERIES = ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL", "KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL",
  "KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL", "KXNHLGAME", "KXNBAGAME", "KXWNBAGAME", "KXNCAAMBGAME",
  "KXEPLGAME", "KXUCLGAME", "KXLALIGAGAME", "KXSERIEAGAME", "KXBUNDESLIGAGAME", "KXLIGUE1GAME", "KXMLSGAME",
  "KXUFCFIGHT", "KXATPMATCH", "KXWTAMATCH"];
const kNames = m => { const y = m.yes_sub_title || "Yes"; return [y, m.no_sub_title && m.no_sub_title !== y ? m.no_sub_title : "Not " + y]; };

/* ---------- state ---------- */
fs.mkdirSync("data", { recursive: true });
const ledger = readJSON("data/ledger.json", {});
const prevFeed = readJSON("data/feed.json", { trades: [], names: {} });
const names = {};           // conditionId/ticker -> [outcome0, outcome1]
const pmMarkets = new Map(); // conditionId -> gamma market
const kMarkets = new Map();  // ticker -> kalshi market
const errors = [];

/* ---------- sharps ---------- */
async function sharps(period) {
  const pages = await Promise.all([0, 50].map(o =>
    getJSON(`${DATA}/v1/leaderboard?category=SPORTS&timePeriod=${period}&orderBy=PNL&limit=50&offset=${o}`).catch(e => { errors.push(e.message); return []; })));
  const out = {};
  pages.flat().forEach(r => { if (r && r.proxyWallet && Number(r.pnl) > 0) out[r.proxyWallet.toLowerCase()] = { rank: Number(r.rank), pnl: Number(r.pnl) }; });
  return out;
}

/* ---------- Polymarket ---------- */
function indexEvents(evs) {
  evs.forEach(e => (e.markets || []).forEach(m => {
    if (!m.conditionId) return;
    pmMarkets.set(m.conditionId, m);
    const o = parseArr(m.outcomes); if (o.length) names[m.conditionId] = o;
  }));
}
async function pmTrades(evs) {
  const ids = evs.map(e => e.id), chunks = [];
  for (let i = 0; i < ids.length; i += 25) chunks.push(ids.slice(i, i + 25));
  const lists = await pool(chunks, 4, c =>
    getJSON(`${DATA}/trades?eventId=${c.join(",")}&filterType=CASH&filterAmount=${FLOOR}&limit=500&takerOnly=true`).catch(e => { errors.push(e.message); return []; }));
  const seen = new Set(), out = [];
  lists.flat().forEach(t => {
    if (!t || !t.conditionId) return;
    const id = t.transactionHash + t.asset + "|" + t.size;
    if (seen.has(id)) return; seen.add(id);
    const price = Number(t.price), size = Number(t.size), idx = Number(t.outcomeIndex);
    if (!names[t.conditionId]) names[t.conditionId] = [];
    if (!names[t.conditionId][idx]) names[t.conditionId][idx] = t.outcome;
    out.push({ venue: "Polymarket", id, wallet: (t.proxyWallet || "").toLowerCase(), name: t.name || t.pseudonym || "",
      conditionId: t.conditionId, side: t.side, idx, outcome: t.outcome, price, size, usd: price * size,
      timestamp: t.timestamp, title: t.title, eventSlug: t.eventSlug, league: pmLeague(t.eventSlug) });
  });
  return out;
}
async function pmLive() {
  let evs = await getJSON(`${GAMMA}/events?tag_slug=sports&active=true&closed=false&limit=200&order=volume24hr&ascending=false`).catch(e => { errors.push(e.message); return []; });
  evs = Array.isArray(evs) ? evs.filter(e => e && e.id) : [];
  indexEvents(evs);
  return evs.length ? pmTrades(evs.slice(0, 150)) : [];
}

/* ---------- Kalshi ---------- */
async function kalshiLive() {
  const since = now() - 86400;
  const lists = await pool(K_SERIES, 5, s => kget(`/markets?series_ticker=${s}&status=open&limit=200`).then(j => j.markets || []).catch(e => { errors.push("Kalshi " + s + ": " + e.message); return []; }));
  const markets = lists.flat();
  markets.forEach(m => { kMarkets.set(m.ticker, m); names[m.ticker] = kNames(m); });
  const vol = m => Number(m.volume_24h_fp ?? m.volume_24h ?? 0);
  const top = markets.filter(m => vol(m) > 0).sort((a, b) => vol(b) - vol(a)).slice(0, 60);
  const tl = await pool(top, 5, m => kget(`/markets/trades?ticker=${m.ticker}&limit=1000&min_ts=${since}`).then(j => j.trades || []).catch(() => []));
  const out = [];
  tl.flat().forEach(t => {
    const idx = (t.taker_outcome_side || t.taker_side) === "no" ? 1 : 0;
    const price = Number(idx ? (t.no_price_dollars ?? t.no_price / 100) : (t.yes_price_dollars ?? t.yes_price / 100));
    const size = Number(t.count_fp ?? t.count), usd = price * size;
    if (!(usd >= FLOOR) || !(price > 0)) return;
    const m = kMarkets.get(t.ticker);
    out.push({ venue: "Kalshi", id: t.trade_id, wallet: "", name: "", conditionId: t.ticker, side: "BUY", idx,
      outcome: m ? kNames(m)[idx] : (idx ? "No" : "Yes"), price, size, usd, timestamp: Math.floor(Date.parse(t.created_time) / 1000),
      title: (m && m.title) || t.ticker, eventSlug: (m && m.event_ticker) || t.ticker, league: kLeague(t.ticker), block: !!t.is_block_trade });
  });
  return out;
}

/* ---------- scoring (same rules as the page) ---------- */
function buildPositions(trades, S) {
  const isSharp = w => !!(S.MONTH[w] || S.ALL[w]);
  const rankPts = (r, lo, hi) => lo + (hi - lo) * (1 - clamp((r - 1) / 99, 0, 1));
  const m = new Map();
  trades.forEach(t => {
    let idx = t.idx, name = t.outcome, q = t.price;
    if (t.side !== "BUY") { idx = 1 - t.idx; name = (names[t.conditionId] || [])[idx] || "Not " + t.outcome; q = 1 - t.price; }
    const key = (t.wallet || "anon:" + t.id) + "|" + t.conditionId + "|" + idx;
    const p = m.get(key) || { key, venue: t.venue, block: !!t.block, wallet: t.wallet, conditionId: t.conditionId, title: t.title,
      slug: t.eventSlug, league: t.league, idx, name, shares: 0, cost: 0, usd: 0, ts: t.timestamp, buys: 0, sells: 0 };
    p.shares += t.size; p.cost += t.size * q; p.usd += t.usd; p.ts = Math.min(p.ts, t.timestamp);
    t.side === "BUY" ? p.buys++ : p.sells++;
    m.set(key, p);
  });
  const side = new Map();
  m.forEach(p => { if (isSharp(p.wallet)) { const k = p.conditionId + "|" + p.idx; (side.get(k) || side.set(k, new Set()).get(k)).add(p.wallet); } });
  m.forEach(p => {
    p.q = p.shares ? p.cost / p.shares : 0;
    p.entryBuy = p.buys >= p.sells;
    p.sharp = isSharp(p.wallet);
    const mo = S.MONTH[p.wallet], al = S.ALL[p.wallet];
    const trader = (mo ? rankPts(mo.rank, 10, 25) : 0) + (al ? rankPts(al.rank, 8, 20) : 0);
    const size = clamp(20 * (Math.log10(Math.max(p.usd, 1)) - 3) / 2, 0, 20);
    const w = side.get(p.conditionId + "|" + p.idx) || new Set(), a = side.get(p.conditionId + "|" + (1 - p.idx)) || new Set();
    const cons = clamp(6 * (w.size - (w.has(p.wallet) ? 1 : 0)) - 6 * a.size, -15, 20);
    const price = p.q >= .9 ? -10 : p.q >= .8 ? 0 : p.q >= .25 ? 10 : 3;
    const kal = p.venue === "Kalshi";
    const entry = !kal && p.entryBuy ? 5 : 0, block = kal && p.block ? 10 : 0;
    p.score = clamp(Math.round(trader + size + cons + price + entry + block), 0, 100);
  });
  return m;
}

/* ---------- ledger ---------- */
function resolvePM(mk) {
  if (!mk || !mk.closed) return null;
  const px = parseArr(mk.outcomePrices).map(Number);
  const w = px.findIndex(x => x >= 0.99);
  if (w >= 0) return w;
  if (px.length && px.every(x => Math.abs(x - 0.5) < 0.02)) return "push";
  return null;
}
const resolveK = mk => !mk ? null : mk.result === "yes" ? 0 : mk.result === "no" ? 1 : null;
const resolveEntry = e => e.venue === "Kalshi" ? resolveK(kMarkets.get(e.conditionId)) : resolvePM(pmMarkets.get(e.conditionId));
function settle(e, res) {
  if (res === null || res === undefined) return;
  if (res === "push") { Object.assign(e, { result: "P", units: 0, whale: 0 }); return; }
  const won = res === e.idx;
  Object.assign(e, { result: won ? "W" : "L", units: won ? (1 - e.q) / e.q : -1, whale: won ? e.shares * (1 - e.q) : -e.shares * e.q });
}
const r2 = x => Math.round(x * 1e4) / 1e4;
function log(pm, source) {
  pm.forEach(p => {
    const cur = ledger[p.key];
    if (cur && cur.result) return;
    ledger[p.key] = { key: p.key, venue: p.venue, wallet: p.wallet, conditionId: p.conditionId, title: p.title, slug: p.slug, league: p.league,
      idx: p.idx, name: p.name, q: r2(p.q), shares: r2(p.shares), usd: Math.round(p.usd), ts: p.ts,
      score: cur && cur.source === "live" ? Math.max(cur.score, p.score) : p.score,
      sharp: p.sharp, entryBuy: p.entryBuy, source: cur ? cur.source : source, result: null };
    settle(ledger[p.key], resolveEntry(ledger[p.key]));
  });
}
async function settlePending() {
  const open = Object.values(ledger).filter(e => !e.result && now() - e.ts > 3600);
  const kp = [...new Set(open.filter(e => e.venue === "Kalshi").map(e => e.conditionId))];
  const pp = [...new Set(open.filter(e => e.venue !== "Kalshi").map(e => e.conditionId))];
  const kc = []; for (let i = 0; i < kp.length; i += 40) kc.push(kp.slice(i, i + 40));
  await pool(kc, 4, c => kget(`/markets?tickers=${c.join(",")}&limit=100`).then(j => (j.markets || []).forEach(m => kMarkets.set(m.ticker, m))).catch(() => {}));
  const pc = []; for (let i = 0; i < pp.length; i += 20) pc.push(pp.slice(i, i + 20));
  await pool(pc, 4, c => getJSON(`${GAMMA}/markets?limit=50&closed=true&` + c.map(x => "condition_ids=" + x).join("&"))
    .then(ms => (Array.isArray(ms) ? ms : []).forEach(m => m.conditionId && pmMarkets.set(m.conditionId, m))).catch(() => {}));
  Object.values(ledger).forEach(e => { if (!e.result) settle(e, resolveEntry(e)); });
}

/* ---------- run ---------- */
const [WEEK, MONTH, ALL] = await Promise.all(["WEEK", "MONTH", "ALL"].map(sharps));
const S = { WEEK, MONTH, ALL };
const [pm, k] = await Promise.all([pmLive().catch(e => { errors.push(e.message); return []; }), kalshiLive().catch(e => { errors.push(e.message); return []; })]);
const fresh = [...pm, ...k];
log(buildPositions(fresh, S), "live");

const meta = readJSON("data/meta.json", {});
if (!meta.backfilledAt || process.env.BACKFILL === "true") {
  let evs = await getJSON(`${GAMMA}/events?tag_slug=sports&closed=true&limit=150&order=endDate&ascending=false`).catch(() => []);
  evs = Array.isArray(evs) ? evs.filter(e => e && e.id) : [];
  indexEvents(evs);
  const bt = await pmTrades(evs);
  log(buildPositions(bt, S), "backfill");
  meta.backfilledAt = now();
}
await settlePending();

// trim ledger to the newest MAX_LEDGER bets
const keys = Object.keys(ledger);
if (keys.length > MAX_LEDGER) keys.sort((a, b) => ledger[a].ts - ledger[b].ts).slice(0, keys.length - MAX_LEDGER).forEach(k => delete ledger[k]);

// feed = last 24h of bets, merged with the previous run so nothing drops between runs
const cutoff = now() - 86400, byId = new Map();
[...(prevFeed.trades || []), ...fresh].forEach(t => { if (t.timestamp >= cutoff) byId.set(t.id, t); });
const feedTrades = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 4000);
const feedNames = {};
feedTrades.forEach(t => { feedNames[t.conditionId] = names[t.conditionId] || (prevFeed.names || {})[t.conditionId] || []; });

meta.updated = now(); meta.errors = errors.slice(0, 10);
fs.writeFileSync("data/feed.json", JSON.stringify({ updated: meta.updated, sharps: S, names: feedNames, trades: feedTrades }));
fs.writeFileSync("data/ledger.json", JSON.stringify(ledger));
fs.writeFileSync("data/meta.json", JSON.stringify(meta));
console.log(`Polymarket ${pm.length}, Kalshi ${k.length} bets this run. Ledger ${Object.keys(ledger).length}. Errors: ${errors.length}`);
