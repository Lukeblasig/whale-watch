# Whale Watch auto-bettor

Phase 1 of the handoff: **paper trading only**. There are no keys, no secrets and no order calls anywhere in this folder. Nothing here can place a real bet.

## What runs

`Paper bot` (`.github/workflows/paper-bot.yml`) starts right after every successful `Collect whale bets` run:

1. Reads `bot/config.json` and checks every field. Anything missing or invalid stops the run before anything is placed, and the run shows as failed in GitHub.
2. Reads `index.json`, `feed.json` and `pending.json` from the `data` branch: the same files the site reads.
3. Settles finished paper bets from the collector's own results, at **our** fill price, alongside the whale's price for comparison.
4. Kill switch: if it's on, cancels resting orders and stops.
5. Finds whale bets that fire a Best filter, using `filters.js` (the same file the site now loads), and runs each one through the checks in `bot/lib/limits.mjs`.
6. Writes everything to the `bot-log` branch: `state.json`, `summary.json`, and `decisions/YYYY-MM.jsonl` with one line per order, fill, skip, cancel and settle.

## The checks (in order)

| Check | Rule |
|---|---|
| One bet per pick | Never twice on the same side, never both sides of one market |
| Start-time cutoff | No orders within `startCutoffMinutes` (10) of the start |
| Loss stop | Paused once settled results fall `lossStopUnits` below their high point. To restart, set `lossStopResetAt` to now |
| Daily limit | `maxUnitsPerDay`, counting from midnight Central |
| Open exposure | `maxOpenUnits` across resting and unsettled bets |
| Price | No fresh price means no bet. Limit = whale's price + `maxPriceRiseCents`. Above the limit, the order rests until it fills or hits the cutoff. More than `maxPriceDropCents` below the whale's price means the market moved against the whale, so the bet is skipped |
| Stale data | No new orders if the collector's last save is older than `maxDataAgeMinutes` |

## Kill switch

Either one stops new orders and cancels resting ones:
- `"killSwitch": true` in `bot/config.json`
- Repo variable `WW_KILL` = `true` (Settings → Secrets and variables → Actions → Variables). You can flip this from the GitHub app without editing a file.

## Changing filters

The Best filter rules live only in `/filters.js`. The site and the bot both load it. `bot/test/parity.mjs` checked that it makes the same decision as the old inline rules on all 322,727 saved bets (0 differences).

## Tools

```
node --test bot/test/limits.test.mjs        # the limit tests (also run before every paper run)
node bot/paper.mjs                          # one paper run (log goes to ./botlog)
node bot/report.mjs [data dir]              # every filter's settled record and edge signal
node bot/replay.mjs [data dir]              # replays history through the bot's own checks
  SLIP=2 LAG=15 FROM=2026-11-01             #   slippage in cents, data lag in minutes, start date
```

## Prices

Paper fills use the live best ask from each venue's public market data: the Polymarket order book (the international book the signals come from) or the Kalshi market. If that lookup fails, paper mode falls back to the latest fill in `feed.json`. That fallback is labelled `not a live quote` in the log, and `summary.json` counts how many fills used live quotes.
