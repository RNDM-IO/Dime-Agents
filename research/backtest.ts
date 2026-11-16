/**
 * Backtest a DIME strategy on recorded Hyperliquid BTC data, under DIME's own rules:
 *   - fills at the next second's price after the signal (DIME fills at the next signed price; default 1 s latency)
 *   - a win of m bp pays m × m / (m + 3) bp at any holding time; losses pay the move; no fees, no funding
 *   - liquidation 4 bp before margin runs out (adverse move ≥ 10,000 / leverage − 4 bp) loses the whole margin
 *   - one open position at a time; margin $0.10–$10 and margin × leverage ≤ $5,000
 * Optional --venue papertrade applies papertrade's published launch haircut (0.2 bp deadband, impact curve, 2% win fee)
 * and its ~4.6 bp liquidation buffer instead, for comparison.
 *
 * Run: npx tsx research/backtest.ts <strategy.ts> [data/ofi] [--venue dime|papertrade] [--latency 1]
 * A strategy module default-exports { name, warmup?, onSecond(ctx) } (see strategies/ for examples).
 *
 * Limits: one-second resolution (liquidations inside a second are checked on the per-second mid only), one
 * venue's prices, no house capacity or queue modelling. Treat results as a filter for ideas, not a forecast.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDataset, type Dataset, type FeatureName } from "./dataset";

export interface Position { side: 1 | -1; leverage: number; margin: number; entry: number; openedAt: number }
export interface Context {
  i: number;
  /** Unix seconds. */
  t: number;
  mid: number;
  f: (name: FeatureName) => number;
  /** Move of the open position in bp, positive = in your favour. */
  moveBp: number | null;
  heldS: number | null;
  position: Position | null;
}
export type Action = { open: { side: "LONG" | "SHORT"; leverage: number; margin: number } } | { close: true } | null | void;
export interface Strategy { name: string; warmup?: number; onSecond: (ctx: Context) => Action }

export interface Fill { openT: number; closeT: number; side: 1 | -1; leverage: number; margin: number; moveBp: number; raw: number; paid: number; liquidated: boolean }

/** DIME's curve as deployed on alpha-dime: k = 3 at any holding time. DIME_SHORT_K / DIME_SHORT_S model a short-hold k (0 s = off). */
const envNum = (k: string, d: number) => { const v = process.env[k]; return v === undefined || v === "" ? d : Number(v); };
const K = envNum("DIME_K", 3), SHORT_K = envNum("DIME_SHORT_K", 8), SHORT_S = envNum("DIME_SHORT_S", 0);
const keepDime = (m: number, holdS = Infinity) => { const k = holdS < SHORT_S ? SHORT_K : K; return m / (m + k); };
function keepPapertrade(m: number, _holdS?: number) {
  const me = m - 0.2;
  if (me <= 0) return 0;
  const move = me / 1e4;
  const scale = 0.9 / (1 + 1 / (move * 15000) + 100000 / (1e6 * move * 814.598));
  return (me / m) * scale * 0.98;
}

export function run(ds: Dataset, s: Strategy, opts: { venue?: "dime" | "papertrade"; latency?: number } = {}) {
  const venue = opts.venue ?? "dime", latency = opts.latency ?? 1;
  const liqBuffer = venue === "dime" ? 4 : 4.6;
  const keep = venue === "dime" ? keepDime : keepPapertrade;
  const fills: Fill[] = [];
  let pos: Position | null = null;
  let pending: { at: number; action: NonNullable<Action> } | null = null;
  const settle = (i: number, price: number, liquidated: boolean) => {
    const p = pos!;
    const moveBp = ((price - p.entry) / p.entry) * 1e4 * p.side;
    const raw = p.margin * p.leverage * (moveBp / 1e4);
    const paid = liquidated ? -p.margin : moveBp > 0 ? raw * keep(moveBp, i - p.openedAt) : Math.max(raw, -p.margin);
    fills.push({ openT: p.openedAt, closeT: i, side: p.side, leverage: p.leverage, margin: p.margin, moveBp, raw, paid, liquidated });
    pos = null;
  };
  for (let i = s.warmup ?? 300; i < ds.n; i++) {
    const mid = ds.mid[i];
    if (!(mid > 0)) continue;
    // Liquidation check first: it doesn't wait for the strategy.
    if (pos) {
      const adverse = -((mid - pos.entry) / pos.entry) * 1e4 * pos.side;
      if (adverse >= 1e4 / pos.leverage - liqBuffer) { settle(i, mid, true); pending = null; }
    }
    // Orders placed earlier fill now, at this second's price.
    if (pending && pending.at <= i) {
      const a = pending.action; pending = null;
      if ("close" in a && pos) settle(i, mid, false);
      else if ("open" in a && !pos) {
        const lev = Math.max(1, Math.min(1000, Math.floor(a.open.leverage)));
        const margin = Math.min(a.open.margin, 10, 5000 / lev);
        pos = { side: a.open.side === "LONG" ? 1 : -1, leverage: lev, margin, entry: mid, openedAt: i };
      }
    }
    const action = s.onSecond({
      i, t: ds.t0 + i, mid, f: (name) => ds.feature(name, i),
      moveBp: pos ? ((mid - pos.entry) / pos.entry) * 1e4 * pos.side : null, heldS: pos ? i - pos.openedAt : null, position: pos,
    });
    if (action && !pending) pending = { at: i + latency, action };
  }
  return { venue, fills, summary: summarise(fills) };
}

export function summarise(fills: Fill[]) {
  const n = fills.length;
  const sum = (f: (x: Fill) => number) => fills.reduce((a, x) => a + f(x), 0);
  const wins = fills.filter((x) => x.paid > 0).length, liq = fills.filter((x) => x.liquidated).length;
  const raw = sum((x) => x.raw), paid = sum((x) => x.paid), margin = sum((x) => x.margin);
  const winCut = sum((x) => (x.raw > 0 && !x.liquidated ? x.raw - x.paid : 0));
  const liqShortfall = sum((x) => (x.liquidated ? x.raw - x.paid : 0));
  // DIME earned at the base rate (11 × leverage ÷ 1000 per $1 of net loss), before phases and boosts.
  const dime = sum((x) => (x.paid < 0 ? -x.paid * 11 * Math.min(1, x.leverage / 1000) : 0));
  const holds = fills.map((x) => x.closeT - x.openT).sort((a, b) => a - b);
  return {
    trades: n, winRate: n ? wins / n : 0, liquidations: liq, medianHoldS: holds.length ? holds[holds.length >> 1] : 0,
    rawPnl: raw, paidPnl: paid, costOfWins: winCut, liquidationShortfall: liqShortfall, marginTraded: margin,
    returnOnMargin: margin ? paid / margin : 0, dimeAtBaseRate: dime,
  };
}

/* ------------------------------------------------------------------ CLI */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const venue = (flag("--venue") ?? "dime") as "dime" | "papertrade";
  const latency = Number(flag("--latency") ?? 1);
  const [stratFile, dir] = args;
  if (!stratFile) { console.log("usage: tsx research/backtest.ts <strategy.ts> [data dir] [--venue dime|papertrade] [--latency s]"); process.exit(1); }
  const strat = (await import(pathToFileURL(path.resolve(stratFile)).href)).default as Strategy;
  const dataDir = path.resolve(dir ?? "data/ofi");
  if (!fs.existsSync(dataDir)) { console.log(`No recorded data in ${dataDir}. Record some first: npm run record (leave it running for a few hours).`); process.exit(1); }
  const ds = await loadDataset(dataDir);
  const r = run(ds, strat, { venue, latency });
  const S = r.summary;
  console.log(`${strat.name} on ${venue}, ${((ds.n) / 3600).toFixed(1)} h of data from ${new Date(ds.t0 * 1000).toISOString()}, latency ${latency}s`);
  console.log(`trades ${S.trades}  win ${(S.winRate * 100).toFixed(0)}%  liquidations ${S.liquidations}  median hold ${S.medianHoldS}s`);
  console.log(`price-move P&L $${S.rawPnl.toFixed(2)}  →  paid $${S.paidPnl.toFixed(2)}  (cost of wins $${S.costOfWins.toFixed(2)}, liquidation shortfall $${S.liquidationShortfall.toFixed(2)})`);
  console.log(`margin traded $${S.marginTraded.toFixed(0)}  return on margin ${(S.returnOnMargin * 100).toFixed(2)}%  DIME at base rate ${S.dimeAtBaseRate.toFixed(1)}`);
}
