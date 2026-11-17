// Current price to buy the whale's side, read from each venue's public (no-key) market data.
// Read-only: nothing here can place an order.
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const KALSHI_HOSTS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];

async function getJSON(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const parseArr = x => Array.isArray(x) ? x : (() => { try { return JSON.parse(x || "[]"); } catch { return []; } })();
const now = () => Math.floor(Date.now() / 1000);
// mid = halfway between bid and ask: the fairest single price for closing line value; falls back to the ask
const quote = (ask, bid, depth, source) => ({ ask, bid, mid: bid != null && bid <= ask ? Math.round((ask + bid) / 2 * 1e4) / 1e4 : ask, depth, at: now(), source });

// Polymarket (international book, where the Whale Watch signals come from): lowest ask on the outcome's token
async function polymarketAsk(cid, idx) {
  const ms = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(cid)}&limit=1`);
  const m = Array.isArray(ms) ? ms[0] : null;
  if (!m) throw new Error("market not found");
  if (m.closed || m.acceptingOrders === false) throw new Error("market not accepting orders");
  const token = parseArr(m.clobTokenIds)[idx];
  if (!token) throw new Error("no token for this outcome");
  const book = await getJSON(`${CLOB}/book?token_id=${token}`);
  const asks = (book.asks || []).map(a => ({ p: Number(a.price), s: Number(a.size) })).filter(a => a.p > 0 && a.s > 0);
  if (!asks.length) throw new Error("no asks on the book");
  const best = asks.reduce((a, b) => b.p < a.p ? b : a);
  const bids = (book.bids || []).map(b => Number(b.price)).filter(p => p > 0 && p < 1);
  return quote(best.p, bids.length ? Math.max(...bids) : null, best.s, "polymarket book");
}

// Kalshi: yes/no ask on the market (idx 0 = yes, 1 = no, as the collector records it)
async function kalshiAsk(ticker, idx) {
  let lastErr;
  for (const h of KALSHI_HOSTS) {
    try {
      const j = await getJSON(`${h}/markets/${encodeURIComponent(ticker)}`);
      const m = j.market;
      if (!m) throw new Error("market not found");
      if (m.status && !/^(open|active)$/i.test(m.status)) throw new Error("market " + m.status);
      const dollars = idx === 0 ? (m.yes_ask_dollars ?? (m.yes_ask != null ? m.yes_ask / 100 : null))
        : (m.no_ask_dollars ?? (m.no_ask != null ? m.no_ask / 100 : null));
      const ask = Number(dollars);
      if (!(ask > 0 && ask < 1)) throw new Error("no ask");
      const bidD = idx === 0 ? (m.yes_bid_dollars ?? (m.yes_bid != null ? m.yes_bid / 100 : null)) : (m.no_bid_dollars ?? (m.no_bid != null ? m.no_bid / 100 : null));
      const bid = Number(bidD);
      return quote(ask, bid > 0 && bid < 1 ? bid : null, null, "kalshi market");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Fallback for paper only: the latest fill on this side in feed.json. A past fill, not a live ask, so it's labelled.
export function lastFill(feed, cid, idx) {
  let best = null;
  for (const t of feed.trades || []) {
    if (t.conditionId !== cid) continue;
    const side = t.side === "BUY" ? t.idx : 1 - t.idx, p = t.side === "BUY" ? t.price : 1 - t.price;
    if (side === idx && (!best || t.timestamp > best.at)) best = { ask: p, bid: null, mid: p, depth: null, at: t.timestamp, source: "last fill in feed (not a live quote)" };
  }
  return best;
}

export async function getQuote(sig, { feed, allowFallback }) {
  try {
    return sig.venue === "Kalshi" ? await kalshiAsk(sig.conditionId, sig.idx) : await polymarketAsk(sig.conditionId, sig.idx);
  } catch (e) {
    const fb = allowFallback ? lastFill(feed, sig.conditionId, sig.idx) : null;
    if (fb) return { ...fb, liveError: e.message };
    return null;
  }
}
