/**
 * Example: trade in the direction of strong top-of-book order-flow imbalance, exit fast.
 * Enters only when |5 s OFI| is extreme, takes profit or stops out within a couple of minutes.
 * A starting point for your own ideas, not a recommendation.
 */
import type { Strategy } from "../research/backtest";

const ENTER = Number(process.env.OFI_ENTER ?? 3);       // |ofiL1_5s| threshold (depth-normalised)
const LEV = Number(process.env.LEV ?? 200);
const TP = Number(process.env.TP_BP ?? 6), SL = Number(process.env.SL_BP ?? 8), MAX_HOLD = Number(process.env.MAX_HOLD_S ?? 120);

export default {
  name: `ofi-scalp (|OFI5s|>${ENTER}, ${LEV}×, TP ${TP} / SL ${SL} bp, ≤${MAX_HOLD}s)`,
  onSecond({ f, position, moveBp, heldS }) {
    if (position) return moveBp! >= TP || moveBp! <= -SL || heldS! >= MAX_HOLD ? { close: true } : null;
    const o = f("ofiL1_5s");
    if (!Number.isFinite(o) || Math.abs(o) < ENTER) return null;
    return { open: { side: o > 0 ? "LONG" : "SHORT", leverage: LEV, margin: 100 / LEV } };
  },
} satisfies Strategy;
