import assert from "node:assert/strict";
import { test } from "node:test";
import { check, ExitWatch, parseDuration, parseLevel, pnlAt, slPrice, tpPrice, type Pos } from "../src/exits";

const long: Pos = { isLong: true, entry: 100_000, margin: 1, leverage: 100, liquidation: 99_040 };
const short: Pos = { ...long, isLong: false, liquidation: 100_960 };
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("levels parse", () => {
  assert.deepEqual(parseLevel("0.3%"), { kind: "pct", pct: 0.3 });
  assert.deepEqual(parseLevel("$2"), { kind: "usd", usd: 2 });
  assert.deepEqual(parseLevel("@66,000"), { kind: "price", price: 66_000 });
  assert.throws(() => parseLevel("0.3"));
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("30m"), 1_800_000);
});

test("percentage levels, long and short", () => {
  near(tpPrice(long, parseLevel("0.3%")), 100_300);
  near(slPrice(long, parseLevel("0.4%")), 99_600);
  near(tpPrice(short, parseLevel("0.3%")), 99_700);
  near(slPrice(short, parseLevel("0.4%")), 100_400);
});

test("a dollar take profit pays that much after DIME's cut on wins", () => {
  for (const p of [long, short]) near(pnlAt(p, tpPrice(p, parseLevel("$2"))), 2, 1e-9);
  // $100 notional: 30 bp pays 30 × 30 / 33 bp = $0.2727
  near(pnlAt(long, 100_300), 100 * 0.003 * (30 / 33), 1e-9);
});

test("a dollar stop loses that much, never more than the margin", () => {
  near(pnlAt(long, slPrice(long, parseLevel("$0.5"))), -0.5, 1e-9);
  assert.equal(pnlAt(long, 90_000), -1);
});

test("stops past liquidation are flagged", () => {
  assert.equal(check(long, { sl: parseLevel("0.5%") }, 100_000).length, 0);
  assert.match(check(long, { sl: parseLevel("2%") }, 100_000)[0], /past liquidation/);
  assert.match(check(short, { tp: parseLevel("@101000") }, 100_000)[0], /losing side/);
});

test("the watcher fires take profit, stop loss, trailing stop and time limit", () => {
  const tp = new ExitWatch(long, { tp: parseLevel("0.3%"), sl: parseLevel("0.4%") }, 0, 100_000);
  assert.equal(tp.update(100_200, 1), null);
  assert.equal(tp.update(100_300, 2), "take profit");

  const sl = new ExitWatch(short, { sl: parseLevel("0.4%") }, 0, 100_000);
  assert.equal(sl.update(100_399, 1), null);
  assert.equal(sl.update(100_400, 2), "stop loss");

  const tr = new ExitWatch(long, { trailPct: 0.2 }, 0, 100_000);
  assert.equal(tr.update(100_500, 1), null);             // new best: trail moves to 100,299
  near(tr.trail!, 100_500 * 0.998);
  assert.equal(tr.update(100_350, 2), null);
  assert.equal(tr.update(100_290, 3), "trailing stop");

  const trShort = new ExitWatch(short, { trailPct: 0.2 }, 0, 100_000);
  assert.equal(trShort.update(99_500, 1), null);
  assert.equal(trShort.update(99_700, 2), "trailing stop"); // 99,500 × 1.002 = 99,699

  const t = new ExitWatch(long, { maxHoldMs: 60_000 }, 0, 100_000);
  assert.equal(t.update(100_000, 59_999), null);
  assert.equal(t.update(100_000, 60_000), "time limit");
});
