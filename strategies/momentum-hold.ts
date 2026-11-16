/**
 * Example: follow 5-minute momentum and hold up to 30 minutes, the "longer hold" variant.
 * A starting point for your own ideas, not a recommendation.
 */
import type { Strategy } from "../research/backtest";

const ENTER = Number(process.env.RET_BP ?? 15), LEV = Number(process.env.LEV ?? 100);
const TP = Number(process.env.TP_BP ?? 25), SL = Number(process.env.SL_BP ?? 25), MAX_HOLD = Number(process.env.MAX_HOLD_S ?? 1800);

export default {
  name: `momentum-hold (|ret5m|>${ENTER} bp, ${LEV}×, TP ${TP} / SL ${SL} bp, ≤${MAX_HOLD}s)`,
  onSecond({ f, position, moveBp, heldS }) {
    if (position) return moveBp! >= TP || moveBp! <= -SL || heldS! >= MAX_HOLD ? { close: true } : null;
    const r = f("ret_300s");
    if (!Number.isFinite(r) || Math.abs(r) < ENTER) return null;
    return { open: { side: r > 0 ? "LONG" : "SHORT", leverage: LEV, margin: 100 / LEV } };
  },
} satisfies Strategy;
