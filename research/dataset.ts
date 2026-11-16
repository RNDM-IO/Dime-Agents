/**
 * Loads recorded Hyperliquid BTC data (ofi-recorder output: bbo, l2 and trade lines, .ndjson or .ndjson.gz)
 * into a dense one-second grid with order-flow features. Shared by the OFI analysis, the trade join and the backtester.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { depth, levelOfi, multiLevelOfi, type Level } from "./ofi";

export interface Dataset {
  /** Unix seconds of index 0. */
  t0: number;
  n: number;
  /** Mid price per second (carried forward through quiet seconds). */
  mid: Float64Array;
  /** Features at second i use data up to and including i only. */
  feature: (name: FeatureName, i: number) => number;
}

export type FeatureName =
  | "ofiL1_1s" | "ofiL1_5s" | "ofiL1_30s" | "ofiL5_5s" | "ofiL5_30s" | "tradeImb_5s" | "tradeImb_30s" | "ret_30s" | "ret_300s";

export async function loadDataset(dir: string): Promise<Dataset> {
  interface Sec { mid: number; ofi1: number; ofiMl: number; dep: number; depN: number; buy: number; sell: number }
  const secs = new Map<number, Sec>();
  const sec = (s: number) => { let x = secs.get(s); if (!x) secs.set(s, (x = { mid: NaN, ofi1: 0, ofiMl: 0, dep: 0, depN: 0, buy: 0, sell: 0 })); return x; };
  const toBook = (r: { b: number[][]; a: number[][] }) => ({ b: r.b.map(([px, sz]): Level => ({ px, sz })), a: r.a.map(([px, sz]): Level => ({ px, sz })) });
  let prevBbo: { b: Level; a: Level } | null = null, prevL2: ReturnType<typeof toBook> | null = null;
  const files = fs.readdirSync(dir).filter((f) => /\.ndjson(\.gz)?$/.test(f)).sort();
  if (!files.length) throw new Error(`no .ndjson files in ${dir}`);
  for (const f of files) {
    const raw = fs.createReadStream(path.join(dir, f));
    const input = f.endsWith(".gz") ? raw.pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })) : raw;
    for await (const line of readline.createInterface({ input })) {
      let r: any; try { r = JSON.parse(line); } catch { continue; }
      const s = sec(Math.floor(r.ts / 1000));
      if (r.t === "bbo") {
        const cur = { b: { px: r.b[0], sz: r.b[1] }, a: { px: r.a[0], sz: r.a[1] } };
        if (prevBbo) s.ofi1 += levelOfi(prevBbo.b, cur.b, prevBbo.a, cur.a);
        s.mid = (cur.b.px + cur.a.px) / 2; prevBbo = cur;
      } else if (r.t === "l2") {
        const cur = toBook(r); if (prevL2) s.ofiMl += multiLevelOfi(prevL2, cur, 5);
        s.dep += depth(cur, 5); s.depN++; prevL2 = cur;
      } else if (r.t === "tr") { if (r.s > 0) s.buy += r.sz; else s.sell += r.sz; }
    }
  }
  const keys = [...secs.keys()].sort((a, b) => a - b);
  const t0 = keys[0], n = keys.at(-1)! - t0 + 1;
  const mid = new Float64Array(n), o1 = new Float64Array(n), oM = new Float64Array(n), dep = new Float64Array(n), buy = new Float64Array(n), sell = new Float64Array(n);
  let m = NaN, d = NaN;
  for (let i = 0; i < n; i++) {
    const x = secs.get(t0 + i);
    if (x) { if (!Number.isNaN(x.mid)) m = x.mid; if (x.depN) d = x.dep / x.depN; o1[i] = x.ofi1; oM[i] = x.ofiMl; buy[i] = x.buy; sell[i] = x.sell; }
    mid[i] = m; dep[i] = d;
  }
  const pre = (a: Float64Array) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + a[i]; return p; };
  const P1 = pre(o1), PM = pre(oM), PB = pre(buy), PS = pre(sell);
  const sum = (p: Float64Array, i: number, w: number) => p[i + 1] - p[Math.max(0, i - w + 1)];
  const imb = (i: number, w: number) => { const b = sum(PB, i, w), s = sum(PS, i, w); return b + s ? (b - s) / (b + s) : 0; };
  const ret = (i: number, w: number) => (i >= w && mid[i - w] > 0 ? ((mid[i] - mid[i - w]) / mid[i - w]) * 1e4 : NaN);
  const feature = (name: FeatureName, i: number): number => {
    switch (name) {
      case "ofiL1_1s": return sum(P1, i, 1) / dep[i];
      case "ofiL1_5s": return sum(P1, i, 5) / dep[i];
      case "ofiL1_30s": return sum(P1, i, 30) / dep[i];
      case "ofiL5_5s": return sum(PM, i, 5) / dep[i];
      case "ofiL5_30s": return sum(PM, i, 30) / dep[i];
      case "tradeImb_5s": return imb(i, 5);
      case "tradeImb_30s": return imb(i, 30);
      case "ret_30s": return ret(i, 30);
      case "ret_300s": return ret(i, 300);
    }
  };
  return { t0, n, mid, feature };
}
