/**
 * Exit rules for one position, checked against DIME's reference price (the price closes settle at).
 *
 *   take profit   0.3%    the price 0.3% in your favour
 *                 $2      about $2 paid, after DIME's cut on wins (a move of m bp pays m × m / (m + 3) bp)
 *                 @66000  the price reaches 66,000
 *   stop loss     0.5%    the price 0.5% against you
 *                 $1      about $1 lost
 *                 @63000  the price reaches 63,000
 *   trailing      0.2%    the price falls back 0.2% from the best it reached while watched
 *   max hold      5m      close at the market after this long
 *
 * None of these are orders on DIME: the terminal watches the price and sends the close itself, so they work only while
 * it runs, and the close fills at the next signed price (a second or so later). Liquidation applies regardless.
 */
export type Level = { kind: "pct"; pct: number } | { kind: "usd"; usd: number } | { kind: "price"; price: number };

export interface Pos { isLong: boolean; entry: number; margin: number; leverage: number; liquidation: number }

export interface ExitRules { tp?: Level; sl?: Level; trailPct?: number; maxHoldMs?: number }

export function parseLevel(s: string): Level {
  const t = s.trim();
  if (t.startsWith("@")) {
    const price = Number(t.slice(1).replace(/,/g, ""));
    if (!(price > 0)) throw new Error(`Bad price: ${s}`);
    return { kind: "price", price };
  }
  if (t.startsWith("$")) {
    const usd = Number(t.slice(1));
    if (!(usd > 0)) throw new Error(`Bad amount: ${s}`);
    return { kind: "usd", usd };
  }
  if (t.endsWith("%")) {
    const pct = Number(t.slice(0, -1));
    if (!(pct > 0 && pct < 100)) throw new Error(`Bad percentage: ${s}`);
    return { kind: "pct", pct };
  }
  throw new Error(`Use 0.3%, $2 or @66000 (got ${s}).`);
}

export function parsePct(s: string): number {
  const l = parseLevel(s);
  if (l.kind !== "pct") throw new Error(`Trailing distance is a percentage, e.g. 0.2% (got ${s}).`);
  return l.pct;
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`Use 90s, 5m or 2h (got ${s}).`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

const K = 3; // DIME's win curve: a move of m bp pays m × m / (m + K) bp

/** Move in bp, positive in your favour. */
export const moveBp = (p: Pos, price: number) => ((price - p.entry) / p.entry) * 1e4 * (p.isLong ? 1 : -1);

/** What closing at `price` pays, in dollars: wins after DIME's cut, losses in full, never more than the margin. */
export function pnlAt(p: Pos, price: number): number {
  const m = moveBp(p, price);
  const raw = p.margin * p.leverage * (m / 1e4);
  return m > 0 ? raw * (m / (m + K)) : Math.max(raw, -p.margin);
}

const priceAtMove = (p: Pos, bp: number) => p.entry * (1 + (bp / 1e4) * (p.isLong ? 1 : -1));

/** The price a take-profit level fires at. */
export function tpPrice(p: Pos, l: Level): number {
  if (l.kind === "price") return l.price;
  if (l.kind === "pct") return priceAtMove(p, l.pct * 100);
  // Paid $X: m² / (m + K) = y with y = X × 10⁴ / notional, so m = (y + √(y² + 4Ky)) / 2.
  const y = (l.usd * 1e4) / (p.margin * p.leverage);
  return priceAtMove(p, (y + Math.sqrt(y * y + 4 * K * y)) / 2);
}

/** The price a stop-loss level fires at. */
export function slPrice(p: Pos, l: Level): number {
  if (l.kind === "price") return l.price;
  if (l.kind === "pct") return priceAtMove(p, -l.pct * 100);
  return priceAtMove(p, -(l.usd * 1e4) / (p.margin * p.leverage));
}

/** Checks the levels make sense for this position; returns warnings worth showing (empty when fine). */
export function check(p: Pos, r: ExitRules, now: number): string[] {
  const out: string[] = [];
  const fav = (x: number) => (p.isLong ? x > p.entry : x < p.entry);
  if (r.tp) {
    const t = tpPrice(p, r.tp);
    if (!fav(t)) out.push(`Take profit ${t.toFixed(2)} is on the losing side of entry ${p.entry.toFixed(2)}.`);
    else if (Math.abs(t - now) / now < 0.0001) out.push(`Take profit ${t.toFixed(2)} is within 1 bp of the price: it will fire at once.`);
  }
  if (r.sl) {
    const s = slPrice(p, r.sl);
    if (fav(s)) out.push(`Stop loss ${s.toFixed(2)} is on the winning side of entry ${p.entry.toFixed(2)}.`);
    if (p.isLong ? s <= p.liquidation : s >= p.liquidation) {
      out.push(`Stop loss ${s.toFixed(2)} is past liquidation at ${p.liquidation.toFixed(2)}: liquidation comes first and takes the whole margin.`);
    }
  }
  return out;
}

/** Tracks one watched position: feed it prices, it says when and why to close. */
export class ExitWatch {
  readonly tp: number | null;
  readonly sl: number | null;
  private best: number;
  constructor(readonly pos: Pos, readonly rules: ExitRules, readonly startedAt: number, startPrice: number) {
    this.tp = rules.tp ? tpPrice(pos, rules.tp) : null;
    this.sl = rules.sl ? slPrice(pos, rules.sl) : null;
    this.best = startPrice;
  }

  /** The trailing stop's current price, or null without one. */
  get trail(): number | null {
    if (this.rules.trailPct === undefined) return null;
    const d = this.rules.trailPct / 100;
    return this.pos.isLong ? this.best * (1 - d) : this.best * (1 + d);
  }

  /** Returns the reason to close now, or null. */
  update(price: number, now: number): string | null {
    const L = this.pos.isLong;
    if (L ? price > this.best : price < this.best) this.best = price;
    if (this.tp !== null && (L ? price >= this.tp : price <= this.tp)) return "take profit";
    if (this.sl !== null && (L ? price <= this.sl : price >= this.sl)) return "stop loss";
    const tr = this.trail;
    if (tr !== null && (L ? price <= tr : price >= tr)) return "trailing stop";
    if (this.rules.maxHoldMs !== undefined && now - this.startedAt >= this.rules.maxHoldMs) return "time limit";
    return null;
  }
}
