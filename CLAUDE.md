# DIME strategy kit

This file is for your coding agent: Claude Code reads it as `CLAUDE.md`; for Codex, copy it to `AGENTS.md`. It tells
the agent how DIME works, what's in this repo and how to test a strategy before it touches real money.

## What DIME is

A house-backed trading protocol for BTC, Nvidia (NVDA) and Anthropic (ANT, `ANTH-USD` in the API). You go long or short;
the house takes the other side straight away.

- Margin $0.10–$10, leverage 1–1000×, **margin × leverage ≤ $5,000**, **one open position per market**.
- **No fees, no funding, no spread.** A winning move of `m` bp pays `m × m / (m + 3)` bp, so at most 3 bp of any win
  is kept (25% paid at 1 bp, 50% at 3 bp, 77% at 10 bp, 97% at 100 bp). Losses pay the move, nothing more.
- **No charge for holding time.** The curve is the same for a 1-second scalp and a 1-day hold.
- **No stop-loss or take-profit orders.** Your code watches the price and closes its own positions (the terminal in
  `terminal/` does this; reuse `terminal/src/exits.ts`).
- **Liquidation** when the adverse move reaches `10,000 / leverage − 4` bp (6 bp at 1000×, 46 bp at 200×). You lose the
  whole margin.
- Orders fill at the **next signed price** after they arrive (about a second), within the price limit you sign.
- Losing against the house earns DIME: 11 × leverage ÷ 1000 per $1 of **net** loss per wallet (boosted in early phases).
  Never treat DIME as having a price.
- Units: collateral 6 decimals, prices 8 decimals.

## Tools

| Tool | Where | Use |
|---|---|---|
| Terminal | `terminal/` (`npm run dime`) | open, watch, close with take profit, stop loss, trailing stop, time limit |
| Exit logic | `terminal/src/exits.ts` | TP / SL / trailing levels and P&L after DIME's cut, tested (`npm test`) |
| SDK (TypeScript) | `sdk/src/index.ts` | quotes, orders, closes, session keys, live streams |
| MCP server | `mcp/src/server.ts` (`npm run mcp`) | read prices and the house, and trade within limits the user sets |
| REST + WebSocket | `https://api-dime.rndm.io` | any language |
| Backtester | `research/backtest.ts` (`npm run backtest`) | replay recorded Hyperliquid BTC data under DIME's payout and liquidation rules |
| Recorder | `research/recorder.mjs` (`npm run record`) | record the Hyperliquid BTC order book, trades and BBO to `data/ofi/` |
| Example strategies | `strategies/` | `ofi-scalp.ts`, `momentum-hold.ts` |

Full API reference: `docs/DEVELOPERS.md`. The repo has no recorded data: run the recorder for a few hours first.

## Strategy interface (backtester)

```ts
import type { Strategy } from "../research/backtest";
export default {
  name: "my idea",
  warmup: 300,                      // seconds of data before the first decision
  onSecond({ t, mid, f, position, moveBp, heldS }) {
    // f(name): "ofiL1_1s" | "ofiL1_5s" | "ofiL1_30s" | "ofiL5_5s" | "ofiL5_30s"
    //          | "tradeImb_5s" | "tradeImb_30s" | "ret_30s" | "ret_300s"
    if (position) return moveBp! >= 6 || moveBp! <= -8 || heldS! >= 120 ? { close: true } : null;
    const o = f("ofiL1_5s");
    return Math.abs(o) > 3 ? { open: { side: o > 0 ? "LONG" : "SHORT", leverage: 200, margin: 0.5 } } : null;
  },
} satisfies Strategy;
```

```sh
npm run backtest -- strategies/my-idea.ts data/ofi --venue dime        # or --venue papertrade to compare
npm run backtest -- strategies/my-idea.ts data/ofi --latency 2          # stress the fill delay
```

The report splits **price-move P&L** (what the market gave you) from **paid P&L** (after the cut on wins and
liquidations). If price-move P&L is positive but paid P&L isn't, the edge is real but smaller than the costs: hold for
bigger moves or trade less often.

## Going live, in order

1. **Backtest** on at least a few days of data, with `--latency 2`, and on a stretch the strategy never saw.
2. **Create a session key** and an **API key**: `npm run dime -- setup 0xWallet` asks the user's browser wallet for
   them (no gas). Give the bot only the session key: it can open and close but never withdraw.
3. **Start at $0.10–$0.50 margin** with a hard daily loss limit in your code.
4. **Log every decision** with the signal value, so live results can be compared with the backtest.
5. Revoke the session key when you stop.

```ts
import { DimeClient, sessionAccount } from "./sdk/src/index";
const dime = new DimeClient({ api: "https://api-dime.rndm.io", apiKey: process.env.DIME_API_KEY });
const signer = sessionAccount(process.env.DIME_SESSION_KEY as `0x${string}`);
const o = await dime.open({ account: WALLET, signer, side: "LONG", margin: 0.5, leverage: 200 });
await dime.waitForIntent(o.id);
```

## What we already know (so the agent doesn't rediscover it)

- Top-of-book order-flow imbalance (OFI) on Hyperliquid predicts the next 1–10 s of BTC moves (correlation about 0.26
  at 1 s, 0.18 at 10 s, fading by 60 s). The gross edge is about 0.2–0.7 bp per trade.
- That edge is smaller than the cost of tiny wins on any zero-fee venue. In a 26-hour backtest the example OFI scalp won
  57% of 653 trades and made money on price moves, but lost slightly after DIME's cut (and more after papertrade's).
- A real test account showed the same: trades held under 5 minutes at 200–250× were profitable; trades held for
  20 minutes to hours, and most 1000× trades, lost, mostly to liquidations.
- Ideas worth testing: entering only on extreme OFI *and* holding for larger moves (the cut is capped at 3 bp, so
  bigger wins keep more), combining OFI with 5-minute momentum, avoiding thin weekend and off-hours books.

## Rules for the agent

- Never ask for, print, store or commit a wallet private key. Use the session key only.
- Never raise margin, leverage or the daily loss limit without the user's explicit instruction.
- Confirm with the user before switching from backtest to live trading.
- Treat backtests as filters, not forecasts. Leverage up to 1000× can lose the whole margin in seconds.
- DIME is not available in the US, the UK, Canada or the other places listed in the Terms of Use.
