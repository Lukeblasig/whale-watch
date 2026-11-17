# Whale Watch auto-bettor

Phase 1 of the handoff: **paper trading only**. There are no keys, no secrets and no order calls anywhere in this folder. Nothing here can place a real bet.

The tracker page is **`tracker.html`** on the site (lukeblasig.github.io/whale-watch/tracker.html). It reads the bot's log from the `bot-log` branch.

## What it trades (paper)

`filters: ["pmSharp3h"]` is the rule set from the Nov 17 P/L audit. It was the only set that held up out of sample: +4.5% after fees on 3,658 bets, +2.4% at 1¢ worse.
- Polymarket only, wallet flagged sharp
- The whale bet 10 minutes to 3 hours before the start
- Only the **first** qualifying alert in each market. Later alerts there, on either side, are ignored, even if the first one was skipped
- Limit order at the whale's price + 1¢, rounded down to a whole cent. Never chases past that

**Shadow rules** (`shadowFilters`) get their own paper records under the same price rules and fees, but no stake limits, and they never use up a trial pick:
- `pmSharp3hML`: the moneyline-only version
- `flowAgree2080s70`: the score + money-flow cut from the Results analysis, tested at the moment it fires
- Four old Best filters. The audit showed their site records count bets placed after the alert, and shadowing them gives an honest forward record

## What runs

`Paper bot` (`.github/workflows/paper-bot.yml`) starts right after every successful `Collect whale bets` run:

1. Runs the limit tests, then reads `bot/config.json` and checks every field. Anything wrong stops the run before anything is placed.
2. Reads `index.json`, `feed.json` and `pending.json` from the `data` branch: the same files the site reads.
3. Settles finished bets from the collector's own results, **net of fees at our own fill price**, alongside the whale's price for comparison.
4. Kill switch: cancels resting orders and stops.
5. Takes one live quote per bet (best bid and ask from the venue's public market data). Every open bet's **closing price** is updated with the latest quote taken before its start.
6. Resting orders fill when the ask comes back under the limit (counted as a maker fill: no fee) or are cancelled at the cutoff.
7. New trial orders go through every check. Then the shadow orders.
8. Writes `state.json`, `summary.json` and `decisions/YYYY-MM.jsonl` to `bot-log`. Once a day it also writes `baseline.json` (every Best filter's site record).

## Closing line value (CLV)

CLV = mid price (halfway between bid and ask) at the bot's last check before the start, minus our fill, in cents. Positive means we beat the close. The bot runs after each collector save, so the "close" is usually taken 10–25 minutes before the start, and each bet records how many minutes. CLV reads much faster than ROI. The audit's first stop rule: if fills don't beat the close on average after 500 bets, stop.

## Fees

The taker fee is rate × P × (1 − P) per contract, which comes to rate × (1 − P) per unit staked: 0.03 on Polymarket, 0.07 on Kalshi (`fees` in the config). It's charged when an order fills on placement. A resting order that fills on a later run is treated as a maker fill, with no fee. That's an approximation: on the real exchange, a resting order can also fill between runs.

## The checks (trial orders, in order)

| Check | Rule |
|---|---|
| One bet per pick | Never twice on the same side, never both sides of one market |
| Start-time cutoff | No orders within `startCutoffMinutes` (10) of the start |
| Loss stop | Paused once settled net results fall `lossStopUnits` below their high point. To restart, set `lossStopResetAt` to now |
| Daily limit | `maxUnitsPerDay`, counting from midnight Central |
| Open exposure | `maxOpenUnits` across resting and unsettled bets |
| Price | No fresh quote means no bet. Above the limit, the order rests. `maxPriceDropCents` (off by default) would skip bets whose price fell below the whale's |
| Stale data | No new orders if the collector's last save is older than `maxDataAgeMinutes` |

The daily, open and loss-stop numbers are **placeholders** sized to the audit (about 83 bets a day, worst drawdown 51u). Luke sets the real ones.

## Stop rules (shown on the tracker, from `trialGates`)

- After 500 bets with a closing price: average CLV must be above 0
- After 1,000 settled bets: net ROI must be at least −2%
- Median fill no more than 1¢ worse than the whale's price
- The trial runs 4 weeks or 1,500 bets

## Kill switch

Either one stops new orders and cancels resting ones:
- `"killSwitch": true` in `bot/config.json`
- Repo variable `WW_KILL` = `true` (Settings → Secrets and variables → Actions → Variables). You can flip this from the GitHub app without editing a file.

## Shared files

- `/filters.js`: the Best filters (used by the site) and the trial rules. `bot/test/parity.mjs` checked that the Best filters make the same decision as the old inline rules on all 322,727 saved bets (0 differences).
- `/bot/stats.js`: the record, CLV, confidence ranges and stop rules. Used by both the bot's `summary.json` and the tracker page, so they always agree.

## Tools

```
node --test bot/test/limits.test.mjs        # limit, fee, CLV and rule tests (also run before every paper run)
node bot/paper.mjs                          # one paper run (log goes to ./botlog)
node bot/report.mjs [data dir]              # every Best filter's site record and edge signal
node bot/baseline.mjs <out file> [data dir] # the same, as baseline.json for the tracker
node bot/replay.mjs [data dir]              # replays history through the bot's own rules, checks and fees
  SLIP=1 LAG=15 FROM=2026-11-01             #   price offset in cents, data lag in minutes, start date
```

The replay has no saved order books: it fills at the whale's price plus `SLIP`. With the +1¢ limit, most `SLIP≥1` bets rest instead of filling, which is how the live bot behaves.

Open `tracker.html?log=<url>/` to point the page at another copy of the log.
