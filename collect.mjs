// Whale Watch collector. Runs on GitHub Actions every ~15 minutes.
// Pulls Polymarket + Kalshi sports whale bets, scores them, settles finished ones,
// and writes data/feed.json (recent bets) and data/ledger.json (every logged bet + result).
import fs from "node:fs";
import { execSync } from "node:child_process";

const DATA = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const KALSHI_HOSTS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const FLOOR = 1000;
const STORE = process.env.STORE || "store";
const PENDING_DAYS = 14;
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
  [/^nfl-/, "NFL"], [/^(cfb|ncaaf)-/, "CFB"], [/^nba-/, "NBA"], [/^wnba-/, "WNBA"], [/^(cbb|ncaab|cwbb|ncaaw)-/, "CBB"],
  [/^mlb-/, "MLB"], [/^(kbo|npb|cpbl)-/, "Intl baseball"], [/^nhl-/, "NHL"], [/^(khl|shl|ahl)-/, "Intl hockey"],
  [/^epl-/, "EPL"], [/^(lal|laliga)-/, "La Liga"], [/^ucl-/, "UCL"], [/^uel-/, "UEL"], [/^(uecl|uefcl)-/, "Conference League"],
  [/^(bun|bundesliga)-/, "Bundesliga"], [/^(sea|seriea)-/, "Serie A"], [/^(fl1|ligue1)-/, "Ligue 1"], [/^mls-/, "MLS"], [/^nwsl-/, "NWSL"],
  [/^(ere|eredivisie|por|primeira|efl|elc|championship|sco|spfl|tur|bel|den|nor|swe|sui|aut|gre|arg|bra|mex|ligamx|col|chi|jpn|j1|kor|k1|aus|aleague|csl|sau|spl|mar|egy|bun2|lal2|sea2|fl2|fifwc|wcq|afcon|copa|euro|unl|concacaf|friendly|intl)-/, "Other soccer"],
  [/^ufc-/, "UFC"], [/^(boxing|box)-/, "Boxing"], [/^(atp|wta|itf|tennis)-/, "Tennis"], [/^(pga|golf|liv|lpga|dpw)-/, "Golf"],
  [/^(f1|formula|nascar|indycar|motogp)/, "Motorsport"], [/^(ipl|cricket|crint|bbl|psl|cpl|t20|odi|test)-/, "Cricket"],
  [/^(cs2|csgo|cs|lol|val|valorant|dota2|dota|r6|cod|rl|ow|esports)-/, "Esports"],
  [/^(nrl|afl|rugby|super-rugby|six-nations|urc)-/, "Rugby/Aussie rules"], [/^(euroleague|nbl|bbl-basket|acb|lnb)-/, "Intl basketball"],
  [/^(darts|snooker|table-tennis|volleyball|handball|mma|pfl|bellator)-/, "Other sports"]
];
const pmLeague = s => { for (const [re, n] of PM_LEAGUES) if (re.test(s || "")) return n; return "Other"; };
// league from Polymarket's own event tags, for slugs the prefix list doesn't recognize
const TAG_LEAGUES = [
  [/^(nfl)$/, "NFL"], [/^(ncaaf|cfb|college-football)$/, "CFB"], [/^(nba)$/, "NBA"], [/^(wnba)$/, "WNBA"],
  [/^(ncaab|cbb|college-basketball|march-madness|ncaaw)$/, "CBB"], [/^(mlb)$/, "MLB"], [/^(nhl)$/, "NHL"],
  [/^(epl|premier-league)$/, "EPL"], [/^(la-liga|laliga)$/, "La Liga"], [/^(ucl|champions-league)$/, "UCL"], [/^(uel|europa-league)$/, "UEL"],
  [/^(bundesliga)$/, "Bundesliga"], [/^(serie-a)$/, "Serie A"], [/^(ligue-1)$/, "Ligue 1"], [/^(mls)$/, "MLS"], [/^(nwsl)$/, "NWSL"],
  [/^(ufc|mma)$/, "UFC"], [/^(boxing)$/, "Boxing"], [/^(tennis|atp|wta)$/, "Tennis"], [/^(golf|pga)$/, "Golf"],
  [/^(f1|formula-1|nascar|motorsport)$/, "Motorsport"], [/^(cricket|ipl)$/, "Cricket"],
  [/^(esports|cs2|counter-strike|league-of-legends|lol|valorant|dota-2|dota2)$/, "Esports"],
  [/^(soccer|football-soccer)$/, "Other soccer"], [/^(baseball)$/, "Intl baseball"], [/^(hockey)$/, "Intl hockey"], [/^(basketball)$/, "Intl basketball"]
];
const GENERIC_TAGS = new Set(["sports", "games", "all", "featured", "trending", "recurring", "hide-from-new", "daily", "weekly", "new", "breaking"]);
function tagsLeague(tags) {
  const slugs = (Array.isArray(tags) ? tags : []).map(t => String(t.slug || t.label || "").toLowerCase().replace(/\s+/g, "-")).filter(s => s && !GENERIC_TAGS.has(s));
  // specific leagues first, then sport-level fallbacks (the last few patterns)
  for (const [re, n] of TAG_LEAGUES.slice(0, -4)) if (slugs.some(s => re.test(s))) return n;
  for (const [re, n] of TAG_LEAGUES.slice(-4)) if (slugs.some(s => re.test(s))) return n;
  return null;
}
const evLeagueBySlug = new Map(), startByCid = new Map();
const parseStart = v => { const t = Date.parse(String(v || "").replace(" ", "T").replace(/\+00$/, "Z")); return isNaN(t) ? null : Math.floor(t / 1000); };
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
// Data lives on a separate "data" branch (checked out into ./store) that is force-pushed each run,
// so it never bloats the repo history. Settled bets are split into one file per month; nothing is ever trimmed.
fs.mkdirSync(STORE, { recursive: true });
const names = {};           // conditionId/ticker -> [outcome0, outcome1]
const pmMarkets = new Map(); // conditionId -> gamma market
const kMarkets = new Map();  // ticker -> kalshi market
const errors = [];

function applyResult(e, r) {
  if (r === "P") return Object.assign(e, { result: "P", units: 0, whale: 0 });
  const won = r === "W";
  return Object.assign(e, { result: r, units: won ? (1 - e.q) / e.q : -1, whale: won ? e.shares * (1 - e.q) : -e.shares * e.q });
}
// keep the best copy of a bet: newest score version first, then the largest position; never lose a result
function mergeEntry(L, e) {
  if (!e || !e.key) return;
  const c = L[e.key];
  if (!c) { L[e.key] = { ...e }; return; }
  const better = (e.sv || 1) !== (c.sv || 1) ? ((e.sv || 1) > (c.sv || 1) ? e : c) : (e.usd > c.usd ? e : c);
  const res = c.result || e.result;
  const out = { ...better };
  if (res) applyResult(out, res); else Object.assign(out, { result: null });
  L[e.key] = out;
}
function recoverHistory(L) {
  try { execSync("git fetch --unshallow --quiet", { stdio: "ignore" }); } catch {}
  let shas = [];
  try { shas = execSync("git log --format=%H -- data/ledger.json", { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return 0; }
  if (shas.length > 60) shas = Array.from({ length: 60 }, (_, i) => shas[Math.floor(i * (shas.length - 1) / 59)]);
  let before = Object.keys(L).length;
  shas.forEach(sha => {
    try { Object.values(JSON.parse(execSync(`git show ${sha}:data/ledger.json`, { encoding: "utf8", maxBuffer: 1 << 29 }))).forEach(e => mergeEntry(L, e)); } catch {}
  });
  return Object.keys(L).length - before;
}
function loadStore() {
  const idx = readJSON(`${STORE}/index.json`, null);
  const L = {};
  if (idx) {
    (idx.months || []).forEach(m => Object.assign(L, readJSON(`${STORE}/settled-${m}.json`, {})));
    Object.assign(L, readJSON(`${STORE}/pending.json`, {}));
    return { L, meta: idx.meta || {}, feed: readJSON(`${STORE}/feed.json`, { trades: [], names: {}, vols: {} }) };
  }
  // Safety: if the data branch exists but didn't load, stop without saving so nothing gets overwritten.
  let remote = "";
  try { remote = execSync("git ls-remote --heads origin data", { encoding: "utf8" }).trim(); } catch {}
  if (remote) { console.error("Saved data exists on the data branch but didn't load. Stopping without saving; the next run will retry."); process.exit(1); }
  // first run on the new layout: import the old ledger from main, plus every bet the old 12k cap trimmed or shrank
  Object.values(readJSON("data/ledger.json", {})).forEach(e => mergeEntry(L, e));
  const recovered = recoverHistory(L);
  console.log(`Migrated ${Object.keys(L).length} bets from the old log (${recovered} recovered from history).`);
  return { L, meta: readJSON("data/meta.json", {}), feed: readJSON("data/feed.json", { trades: [], names: {}, vols: {} }) };
}
const loaded = loadStore();
const ledger = loaded.L, prevFeed = loaded.feed, meta = loaded.meta;
Object.entries(prevFeed.names || {}).forEach(([k, v]) => { if (!names[k]) names[k] = v; });

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
  evs.forEach(e => {
    const lg = tagsLeague(e.tags);
    if (e.slug && lg) evLeagueBySlug.set(e.slug, lg);
  });
  evs.forEach(e => (e.markets || []).forEach(m => {
    if (!m.conditionId) return;
    pmMarkets.set(m.conditionId, m);
    const st = parseStart(m.gameStartTime || e.startTime || m.eventStartTime);
    if (st) startByCid.set(m.conditionId, st);
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
      timestamp: t.timestamp, title: t.title, eventSlug: t.eventSlug, league: pmLeague(t.eventSlug) !== "Other" ? pmLeague(t.eventSlug) : (evLeagueBySlug.get(t.eventSlug) || "Other") });
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
const kDiag = { sportsSeries: 0, events: 0, markets: 0, busy: 0, tradesScanned: 0, bigFills: 0, tradeErrors: 0, errors: [] };
const TITLE_LEAGUES = [[/college football|ncaa ?f/i, "CFB"], [/\bnfl\b|pro football/i, "NFL"], [/\bwnba\b/i, "WNBA"], [/\bnba\b|pro basketball/i, "NBA"],
  [/college basketball|ncaa ?b/i, "CBB"], [/\bmlb\b|baseball/i, "MLB"], [/\bnhl\b|hockey/i, "NHL"], [/premier league|\bepl\b/i, "EPL"],
  [/champions league/i, "UCL"], [/la ?liga/i, "La Liga"], [/serie a/i, "Serie A"], [/bundesliga/i, "Bundesliga"], [/ligue 1/i, "Ligue 1"],
  [/\bmls\b/i, "MLS"], [/\bufc\b|\bmma\b/i, "UFC"], [/tennis|\batp\b|\bwta\b/i, "Tennis"], [/golf|\bpga\b/i, "Golf"], [/formula 1|\bf1\b/i, "F1"]];
const leagueFromTitle = t => { for (const [re, n] of TITLE_LEAGUES) if (re.test(t || "")) return n; return null; };
async function kalshiLive() {
  const since = now() - 86400;
  const kErr = (where, e) => { if (kDiag.errors.length < 8) kDiag.errors.push(where + ": " + e.message); };

  // 1) which series are sports (Kalshi's own category list), plus the ones we know by name
  const sports = new Map(); // series ticker -> league
  try {
    const j = await kget(`/series?category=Sports`);
    (j.series || []).forEach(s => sports.set(s.ticker, leagueFromTitle(s.title) || kLeague(s.ticker)));
  } catch (e) { kErr("series list", e); }
  K_SERIES.forEach(s => { if (!sports.has(s)) sports.set(s, kLeague(s)); });
  kDiag.sportsSeries = sports.size;

  // 2) every open event (with its markets), keeping sports ones
  const events = []; let cursor = "";
  for (let i = 0; i < 40; i++) {
    let j;
    try { j = await kget(`/events?status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`); }
    catch (e) { kErr("events page " + (i + 1), e); break; }
    (j.events || []).forEach(ev => {
      const st = ev.series_ticker || (ev.event_ticker || "").split("-")[0];
      if (/^KXMVE/.test(st)) return;
      if (sports.has(st) || kLeague(st) !== "Other") events.push({ ...ev, _league: sports.get(st) || kLeague(st) });
    });
    cursor = j.cursor; if (!cursor) break;
  }
  // fallback if the events listing failed: query the known series directly
  if (!events.length) {
    const lists = await pool(K_SERIES, 5, s => kget(`/markets?series_ticker=${s}&status=open&limit=200`).then(j => j.markets || []).catch(e => { kErr(s, e); return []; }));
    lists.flat().forEach(m => events.push({ event_ticker: m.event_ticker, title: "", markets: [m], _league: kLeague(m.ticker) }));
  }
  kDiag.events = events.length;

  const markets = [];
  events.forEach(ev => (ev.markets || []).forEach(m => {
    if (!m.ticker) return;
    m.title = m.title || ev.title || m.ticker;
    m._league = ev._league && ev._league !== "Other" ? ev._league : (leagueFromTitle(m.title) || kLeague(m.ticker));
    kMarkets.set(m.ticker, m); names[m.ticker] = kNames(m); markets.push(m);
    const st = parseStart(m.occurrence_datetime || ev.occurrence_datetime || ev.strike_date);
    if (st) startByCid.set(m.ticker, st);
  }));
  kDiag.markets = markets.length;

  // 3) trades from the busiest markets over the last 24h
  const act = m => Number(m.volume_24h_fp ?? m.volume_24h ?? 0) || Number(m.open_interest_fp ?? m.open_interest ?? 0) / 10;
  const top = markets.filter(m => act(m) > 0).sort((a, b) => act(b) - act(a)).slice(0, 80);
  kDiag.busy = top.length;
  const tl = await pool(top, 5, m => kget(`/markets/trades?ticker=${m.ticker}&limit=1000&min_ts=${since}`).then(j => j.trades || [])
    .catch(e => { kDiag.tradeErrors++; kErr("trades " + m.ticker, e); return []; }));
  const out = [];
  tl.flat().forEach(t => {
    kDiag.tradesScanned++;
    const idx = (t.taker_outcome_side || t.taker_side) === "no" ? 1 : 0;
    const price = Number(idx ? (t.no_price_dollars ?? t.no_price / 100) : (t.yes_price_dollars ?? t.yes_price / 100));
    const size = Number(t.count_fp ?? t.count), usd = price * size;
    if (!(usd >= FLOOR) || !(price > 0)) return;
    const m = kMarkets.get(t.ticker);
    out.push({ venue: "Kalshi", id: t.trade_id, wallet: "", name: "", conditionId: t.ticker, side: "BUY", idx,
      outcome: m ? kNames(m)[idx] : (idx ? "No" : "Yes"), price, size, usd, timestamp: Math.floor(Date.parse(t.created_time) / 1000),
      title: (m && m.title) || t.ticker, eventSlug: (m && m.event_ticker) || t.ticker, league: (m && m._league) || kLeague(t.ticker), block: !!t.is_block_trade });
  });
  kDiag.bigFills = out.length;
  return out;
}

/* ---------- score v2 (identical in index.html and collect.mjs) ---------- */
const SCORE_VERSION = 2;
function scorePositions(m, ctx){
  const cl = (x, a, b) => Math.max(a, Math.min(b, x));
  const rankPts = (r, lo, hi) => lo + (hi - lo) * (1 - cl((r - 1) / 99, 0, 1));
  const byMkt = new Map();
  m.forEach(p => { (byMkt.get(p.conditionId) || byMkt.set(p.conditionId, []).get(p.conditionId)).push(p); });
  m.forEach(p => {
    const peers = byMkt.get(p.conditionId).filter(o => o !== p);
    let on = 0, off = 0; peers.forEach(o => { if (o.idx === p.idx) on += o.usd; else off += o.usd; });
    const f = on + off ? (on - off) / (on + off) : 0;
    const flow = cl(Math.round(f * 25 * Math.min(1, peers.length / 3)), -15, 25);
    const abs = cl(15 * (Math.log10(Math.max(p.usd, 1)) - 3) / 2, 0, 15);
    const vol = ctx.volOf(p.conditionId) || 0;
    const rel = vol > 0 ? cl(7.5 * Math.log10((p.usd / vol) / 0.002), 0, 20) : 8;
    const price = p.q >= .9 ? 0 : p.q >= .8 ? 5 : p.q >= .25 ? 15 : 5;
    let edge = 0, edgeWhy = "";
    if (p.venue === "Kalshi"){
      const burst = peers.filter(o => o.idx === p.idx && Math.abs(o.ts - p.ts) <= 7200).length;
      edge = (p.block ? 10 : 0) + Math.min(15, 5 * burst);
      edgeWhy = (p.block ? "block trade, " : "") + burst + " other big fill" + (burst === 1 ? "" : "s") + " on this side within 2h";
    } else {
      const mo = ctx.sharpM(p.wallet), al = ctx.sharpA(p.wallet);
      edge = (mo ? rankPts(mo.rank, 5, 15) : 0) + (al ? rankPts(al.rank, 3, 10) : 0);
      edgeWhy = mo || al ? "sports board: 30-day #" + (mo ? mo.rank : "–") + ", all-time #" + (al ? al.rank : "–") : "not on the sports profit boards";
    }
    const sellPen = p.venue !== "Kalshi" && !p.entryBuy ? -5 : 0;
    p.parts = { abs: Math.round(abs), rel: Math.round(rel), relKnown: vol > 0, flow, n: peers.length, price, edge: Math.round(edge), edgeWhy, sellPen };
    p.score = cl(Math.round(abs + rel + flow + price + edge + sellPen), 0, 100);
    p.sv = SCORE_VERSION;
  });
  return m;
}
function volOf(cid){
  const k = kMarkets.get(cid);
  if (k) return Number(k.volume_24h_fp ?? k.volume_24h ?? 0) * Number(k.last_price_dollars ?? 0.5);
  const pm = pmMarkets.get(cid);
  if (pm) return Number(pm.volume24hr ?? pm.volume24hrClob ?? 0);
  return Number((prevFeed.vols || {})[cid] || 0);
}
function buildPositions(trades, S) {
  const isSharp = w => !!(S.MONTH[w] || S.ALL[w]);
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
  m.forEach(p => { p.q = p.shares ? p.cost / p.shares : 0; p.entryBuy = p.buys >= p.sells; p.sharp = isSharp(p.wallet); });
  return scorePositions(m, { volOf, sharpM: w => S.MONTH[w], sharpA: w => S.ALL[w] });
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
const clobMarkets = new Map(); // conditionId -> CLOB market (fallback when Gamma can't see a market)
function resolveClob(mk, cid) {
  if (!mk || !mk.closed || !Array.isArray(mk.tokens)) return null;
  const w = mk.tokens.findIndex(t => t.winner === true);
  if (w < 0) return null;
  const ix = (names[cid] || []).indexOf(mk.tokens[w].outcome);
  return ix >= 0 ? ix : w;
}
const resolveEntry = e => e.venue === "Kalshi" ? resolveK(kMarkets.get(e.conditionId))
  : (resolvePM(pmMarkets.get(e.conditionId)) ?? resolveClob(clobMarkets.get(e.conditionId), e.conditionId));
function settle(e, res) {
  if (res === null || res === undefined) return;
  if (res === "push") { Object.assign(e, { result: "P", units: 0, whale: 0 }); return; }
  const won = res === e.idx;
  Object.assign(e, { result: won ? "W" : "L", units: won ? (1 - e.q) / e.q : -1, whale: won ? e.shares * (1 - e.q) : -e.shares * e.q });
}
// stamp when a result first lands, so the page can show "last result logged"
function settleStamp(e, res) { const was = e.result; settle(e, res); if (!was && e.result) e.settledAt = now(); }
const r2 = x => Math.round(x * 1e4) / 1e4;
function log(pm, source) {
  pm.forEach(p => {
    const cur = ledger[p.key];
    if (cur && cur.result && cur.sv === SCORE_VERSION) return;
    if (cur && cur.result) { cur.score = p.score; cur.sv = SCORE_VERSION; cur.sharp = p.sharp; return; }
    const keep = cur && cur.sv === SCORE_VERSION && cur.source === "live";
    // never shrink a pending position just because older fills fell out of the API window
    const src = cur && cur.usd > p.usd ? { q: cur.q, shares: cur.shares, usd: cur.usd, ts: Math.min(cur.ts, p.ts) } : { q: r2(p.q), shares: r2(p.shares), usd: Math.round(p.usd), ts: cur ? Math.min(cur.ts, p.ts) : p.ts };
    ledger[p.key] = { key: p.key, venue: p.venue, wallet: p.wallet, conditionId: p.conditionId, title: p.title, slug: p.slug, league: p.league,
      idx: p.idx, name: p.name, q: src.q, shares: src.shares, usd: src.usd, ts: src.ts,
      score: keep ? Math.max(cur.score, p.score) : p.score, sv: SCORE_VERSION,
      sharp: p.sharp, entryBuy: p.entryBuy, source: cur ? cur.source : source, result: null,
      // what went into the score, kept so the page can show which factors actually win
      f: { abs: p.parts.abs, rel: p.parts.rel, relKnown: p.parts.relKnown, flow: p.parts.flow, n: p.parts.n, price: p.parts.price, edge: p.parts.edge },
      block: !!p.block, start: startByCid.get(p.conditionId) || (cur && cur.start) || null };
    settleStamp(ledger[p.key], resolveEntry(ledger[p.key]));
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
  // Gamma misses some markets entirely; ask Polymarket's order-book API for anything still unresolved after 3h
  const stuck = [...new Set(Object.values(ledger).filter(e => !e.result && e.venue !== "Kalshi" && now() - e.ts > 3 * 3600
    && resolvePM(pmMarkets.get(e.conditionId)) === null).map(e => e.conditionId))].slice(0, 120);
  await pool(stuck, 4, cid => getJSON(`https://clob.polymarket.com/markets/${cid}`, 2).then(m => clobMarkets.set(cid, m)).catch(() => {}));
  Object.values(ledger).forEach(e => { if (!e.result) settleStamp(e, resolveEntry(e)); });
}

/* ---------- run ---------- */
const [WEEK, MONTH, ALL] = await Promise.all(["WEEK", "MONTH", "ALL"].map(sharps));
const S = { WEEK, MONTH, ALL };
const [pm, k] = await Promise.all([pmLive().catch(e => { errors.push(e.message); return []; }), kalshiLive().catch(e => { errors.push(e.message); return []; })]);
const fresh = [...pm, ...k];

// last 24h of fills, merged with the previous run; positions are built from this so a wallet's
// earlier fills still count when it adds to a bet later
const cutoff = now() - 86400, byId = new Map();
[...(prevFeed.trades || []), ...fresh].forEach(t => { if (t.timestamp >= cutoff) byId.set(t.id, t); });
const feedTrades = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 6000);
log(buildPositions(feedTrades, S), "live");

if (!meta.backfilledAt || meta.sv !== SCORE_VERSION || process.env.BACKFILL === "true") {
  let evs = await getJSON(`${GAMMA}/events?tag_slug=sports&closed=true&limit=150&order=endDate&ascending=false`).catch(() => []);
  evs = Array.isArray(evs) ? evs.filter(e => e && e.id) : [];
  indexEvents(evs);
  const bt = await pmTrades(evs);
  log(buildPositions(bt, S), "backfill");
  meta.backfilledAt = now(); meta.sv = SCORE_VERSION;
}
await settlePending();

// Re-label bets stuck in "Other": first the prefix list, then Polymarket's own event tags (cached between runs)
const leagueCache = readJSON(`${STORE}/leagues.json`, {});
Object.values(ledger).forEach(e => { if (e.league === "Other" && e.venue !== "Kalshi") { const l = pmLeague(e.slug); if (l !== "Other") e.league = l; } });
const unknown = [...new Set(Object.values(ledger).filter(e => e.league === "Other" && e.venue !== "Kalshi" && e.slug && !(e.slug in leagueCache)).map(e => e.slug))].slice(0, 60);
await pool(unknown, 4, slug => getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, 2)
  .then(j => { const ev = Array.isArray(j) ? j[0] : null; leagueCache[slug] = (ev && tagsLeague(ev.tags)) || "Other"; }).catch(() => {}));
Object.values(ledger).forEach(e => { if (e.league === "Other" && leagueCache[e.slug] && leagueCache[e.slug] !== "Other") e.league = leagueCache[e.slug]; });
fs.writeFileSync(`${STORE}/leagues.json`, JSON.stringify(leagueCache));

// drop bets that never settled after two weeks (voided or delisted markets)
Object.values(ledger).forEach(e => { if (!e.result && now() - e.ts > PENDING_DAYS * 86400) delete ledger[e.key]; });

const feedNames = {}, feedVols = {};
feedTrades.forEach(t => {
  feedNames[t.conditionId] = names[t.conditionId] || [];
  feedVols[t.conditionId] = volOf(t.conditionId) || 0;
});

// write: pending.json + settled-YYYY-MM.json per month + feed.json + index.json
const pending = {}, months = {};
Object.values(ledger).forEach(e => {
  if (!e.result) { pending[e.key] = e; return; }
  const m = new Date(e.ts * 1000).toISOString().slice(0, 7);
  (months[m] ||= {})[e.key] = e;
});
// Safety: settled results should only ever grow. If the count dropped, something went wrong, so don't save.
const prevSettled = Object.values((readJSON(`${STORE}/index.json`, {}) || {}).counts || {}).reduce((a, b) => a + b, 0);
const newSettled = Object.values(months).reduce((a, o) => a + Object.keys(o).length, 0);
if (newSettled < prevSettled) { console.error(`Settled results would drop from ${prevSettled} to ${newSettled}. Stopping without saving.`); process.exit(1); }
fs.readdirSync(STORE).filter(f => /^settled-\d{4}-\d{2}\.json$/.test(f)).forEach(f => fs.unlinkSync(`${STORE}/${f}`));
Object.entries(months).forEach(([m, o]) => fs.writeFileSync(`${STORE}/settled-${m}.json`, JSON.stringify(o)));
fs.writeFileSync(`${STORE}/pending.json`, JSON.stringify(pending));
meta.updated = now(); meta.errors = errors.slice(0, 10); meta.kalshi = kDiag;
fs.writeFileSync(`${STORE}/feed.json`, JSON.stringify({ updated: meta.updated, sharps: S, names: feedNames, vols: feedVols, trades: feedTrades }));
const counts = Object.fromEntries(Object.entries(months).map(([m, o]) => [m, Object.keys(o).length]));
fs.writeFileSync(`${STORE}/index.json`, JSON.stringify({ updated: meta.updated, months: Object.keys(months).sort(), counts, pending: Object.keys(pending).length, meta }));
console.log('Kalshi check:', JSON.stringify(kDiag));
console.log(`Polymarket ${pm.length}, Kalshi ${k.length} fills this run. Settled ${Object.values(counts).reduce((a, b) => a + b, 0)}, pending ${Object.keys(pending).length}. Errors: ${errors.length}`);
