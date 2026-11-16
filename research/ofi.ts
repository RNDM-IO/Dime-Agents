/**
 * Order-flow-imbalance research helpers (pure, no I/O).
 *
 * OFI follows Cont, Kukanov and Stoikov (2014): between two book states, the bid side contributes
 * +new size if the bid rose, the size change if it held, and -old size if it fell; the ask side mirrors
 * it with the opposite sign. Summed over a window and divided by depth, it is the signed pressure on mid.
 */

export interface Level { px: number; sz: number }

/** e_n for one price level between two consecutive states. Positive = buying pressure. */
export function levelOfi(prevBid: Level, bid: Level, prevAsk: Level, ask: Level): number {
  const b = bid.px > prevBid.px ? bid.sz : bid.px === prevBid.px ? bid.sz - prevBid.sz : -prevBid.sz;
  const a = ask.px < prevAsk.px ? ask.sz : ask.px === prevAsk.px ? ask.sz - prevAsk.sz : -prevAsk.sz;
  return b - a;
}

/** Multi-level OFI between two snapshots, summed over the first `levels` levels present in both. */
export function multiLevelOfi(prev: { b: Level[]; a: Level[] }, cur: { b: Level[]; a: Level[] }, levels = 5): number {
  const n = Math.min(levels, prev.b.length, prev.a.length, cur.b.length, cur.a.length);
  let e = 0;
  for (let i = 0; i < n; i++) e += levelOfi(prev.b[i], cur.b[i], prev.a[i], cur.a[i]);
  return e;
}

export const depth = (book: { b: Level[]; a: Level[] }, levels = 5) => {
  let d = 0;
  for (let i = 0; i < Math.min(levels, book.b.length); i++) d += book.b[i].sz;
  for (let i = 0; i < Math.min(levels, book.a.length); i++) d += book.a[i].sz;
  return d / 2;
};

/** Net result in bp of notional for a signed gross move r (bp), under each venue's published cost model. */
export const VENUE_NET: Record<string, (r: number) => number> = {
  gross: (r) => r,
  /** Cardboard: 0.2 bp deadband on wins, 2% of the adjusted gain, 0.5 bp close fee on every trade. */
  cardboard: (r) => (r > 0 ? Math.max(r - 0.2, 0) * 0.98 : r) - 0.5,
  /** DIME chosen launch model: zero fees, a win of m bp pays m × m/(m + 3). */
  dimeZero: (r) => (r > 0 ? (r * r) / (r + 3) : r),
  /** papertrade, fitted: a win of m bp pays about m × m/(m + 3.9); losses free. */
  papertrade: (r) => (r > 0 ? (r * r) / (r + 3.9) : r),
  /** DIME today: 25% of the gain on wins, nothing on losses. */
  dime25: (r) => (r > 0 ? r * 0.75 : r),
  /** DIME with the proposed taper at <=100x: 15% of the gain. */
  dime15: (r) => (r > 0 ? r * 0.85 : r),
  /** Hyperliquid taker both ways at the base tier (about 4.5 bp per side; check your tier). */
  hlTaker: (r) => r - 9,
};

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Value at quantile q of a sorted copy. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}
