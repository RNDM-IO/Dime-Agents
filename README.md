# DIME Agents

Build your own trading tools for [DIME](https://dime.rndm.io): long or short BTC, Nvidia and Anthropic up to 1000×, no
trading fees. This kit gives you, or your coding agent (Claude Code, Codex), everything needed:

| | Where | What it does |
|---|---|---|
| **Terminal** | `terminal/` | open, watch and close from the command line with **take profit, stop loss, trailing stop and a time limit** |
| **SDK** | `sdk/` | TypeScript client: quotes, orders, closes, session keys, live prices |
| **MCP server** | `mcp/` | lets Claude or any MCP client read DIME and trade within limits you set |
| **Backtester** | `research/backtest.ts` | replays recorded Hyperliquid BTC data under DIME's payout and liquidation rules |
| **Recorder** | `research/recorder.mjs` | records the BTC order book and trades for the backtester |
| **Example strategies** | `strategies/` | two starting points for your own |
| **API reference** | `docs/DEVELOPERS.md` | REST, WebSocket, EIP-712 types, limits |
| **Agent guide** | `CLAUDE.md` (copy to `AGENTS.md` for Codex) | DIME's rules and what's already been learned, for your coding agent |

Needs Node 22 or newer.

```sh
git clone https://github.com/RNDM-IO/Dime-Agents.git && cd Dime-Agents
npm install
```

## Terminal: take profit and stop loss

DIME has no stop or take-profit orders. The terminal watches DIME's signed reference price (the price closes settle
at) and closes your position with a session key when a level is hit.

```sh
npm run dime -- setup 0xYourWallet                         # once (below)
npm run dime -- price BTC
npm run dime -- open BTC long 1 100 --tp 0.3% --sl 0.4% --dry-run    # see the levels, send nothing
npm run dime -- open BTC long 1 100 --tp 0.3% --sl 0.4% --trail 0.2% --max-hold 30m
npm run dime -- watch BTC --tp '$2' --sl '$1'              # a position you opened in the app
npm run dime -- watch all --trail 0.25%
npm run dime -- positions
npm run dime -- close BTC
```

| Exit | Forms | Meaning |
|---|---|---|
| `--tp` | `0.3%` · `'$2'` · `@66000` | price 0.3% in your favour · about $2 paid after DIME's cut on wins · a price |
| `--sl` | `0.4%` · `'$1'` · `@63000` | price 0.4% against you · about $1 lost · a price |
| `--trail` | `0.2%` | close once the price falls back 0.2% from the best it reached |
| `--max-hold` | `90s` · `30m` · `2h` | close at the market after this long |

What to expect:

- **Exits run in the terminal process.** Keep it running (`screen`, `tmux`, a small server). If it stops, the
  position stays open with no exits.
- A close fills at the next signed price, usually a second or so after the trigger, so the fill can be a little
  better or worse than the level. If the position is still open 20 s later, the terminal sends the close again.
- **Liquidation applies regardless**: at 100× it's about 0.96% against you, at 1000× about 0.06%. The terminal warns
  if a stop is past liquidation, because liquidation would come first and take the whole margin.
- Margin is capped at $1 a trade by default. Raise it with `DIME_TERMINAL_MAX_MARGIN` (DIME's own limit is $10).

### Setup: one approval in your browser wallet

```sh
npm run dime -- setup 0xYourWallet
```

It prints a local link (`http://127.0.0.1:8790`). Open it in the browser that has the wallet you trade DIME with
(MetaMask, Rabby…) and approve up to three signatures: the Terms of Use if you haven't accepted them, an API key, and a
**session key**. A session key can open and close your positions for 30 days. **It can't withdraw, stake or create other
keys.** Your wallet's private key never touches the terminal. The keys are saved in `~/.dime-terminal/config.json`,
readable only by you. Revoke the session key any time from the account sheet on dime.rndm.io.

Accounts signed in with email or Google don't have a browser wallet to sign with, so they can't use the terminal yet.

## MCP server: let Claude trade

```json
{
  "mcpServers": {
    "dime": {
      "command": "npx",
      "args": ["tsx", "/path/to/Dime-Agents/mcp/src/server.ts"],
      "env": {
        "DIME_ACCOUNT": "0xYourWallet",
        "DIME_API_KEY": "dime_…",
        "DIME_SESSION_KEY_FILE": "/path/to/session.key",
        "DIME_MCP_MAX_MARGIN_USD": "1",
        "DIME_MCP_MAX_LEVERAGE": "100"
      }
    }
  }
}
```

Leave out the last four for read-only (prices, house, quotes, any account). With a session key the agent can open and
close, with optional take profit and stop loss, inside your margin and leverage limits. Details in
[docs/DEVELOPERS.md](docs/DEVELOPERS.md#mcp-server).

## Build your own

```ts
import { DimeClient, sessionAccount } from "./sdk/src/index";

const dime = new DimeClient({ api: "https://api-dime.rndm.io", apiKey: process.env.DIME_API_KEY });
const signer = sessionAccount(process.env.DIME_SESSION_KEY as `0x${string}`);
const order = await dime.open({ account: WALLET, signer, market: "BTC-USD", side: "LONG", margin: 1, leverage: 100 });
await dime.waitForIntent(order.id);
const stop = dime.subscribe(["price:BTC-USD"], (_ch, d) => console.log(Number(d.reference.price) / 1e8));
```

`terminal/src/exits.ts` is a self-contained module for take-profit, stop-loss and trailing logic (with tests:
`npm test`); reuse it in your own bot or UI.

## Backtest an idea

There's no recorded data in the repo: record your own.

```sh
npm run record                                             # leave it running for a few hours; writes data/ofi/
npm run backtest -- strategies/ofi-scalp.ts                # DIME's payout and liquidation rules
npm run backtest -- strategies/ofi-scalp.ts data/ofi --latency 2
```

The report splits price-move P&L from what DIME would have paid. Treat results as a filter for ideas, not a forecast.

## Rules worth knowing

- Margin $0.10 to $10, leverage up to 1000×, margin × leverage up to $5,000. One open position per market.
- No fees to open, close or lose, and no funding. A winning move of `m` bp pays `m × m / (m + 3)` bp.
- Liquidation 4 bp before the margin runs out; you lose the whole margin.
- DIME is not available in the US, the UK, Canada or the other places listed in the Terms. Read the [Terms of Use](https://dime.rndm.io/terms) first.
- Leverage up to 1000× can lose the whole margin in seconds. Start small, set a daily loss limit in your code, and
  never put a wallet private key in a bot, a repo or a prompt.

Apache-2.0. Not investment advice.
