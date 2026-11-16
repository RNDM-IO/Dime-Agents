#!/usr/bin/env node
/**
 * dime: a small trading terminal for DIME with the exits DIME doesn't offer as orders: take profit, stop loss,
 * trailing stop and a time limit. Trades with a session key (opens and closes, never withdraws).
 *
 *   dime setup 0xYourWallet                     once: approve an API key and a session key in your browser wallet
 *   dime price [BTC|NVDA|ANT]
 *   dime positions
 *   dime open BTC long 1 100 --tp 0.3% --sl 0.4% --trail 0.2% --max-hold 30m
 *   dime watch BTC --tp '$2' --sl '$1'          attach exits to a position you opened in the app (or "all")
 *   dime close BTC
 *
 * Exits are watched here, against DIME's signed reference price: they work only while this process runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import { DimeClient, fromPrice, fromUsd, sessionAccount, type MarketSymbol, type Position } from "../../sdk/src/index";
import { check, ExitWatch, moveBp, parseDuration, parseLevel, parsePct, pnlAt, type ExitRules, type Pos } from "./exits";
import { setup } from "./setup";

const DIR = path.join(os.homedir(), ".dime-terminal");
const CONFIG = path.join(DIR, "config.json");
const API = process.env.DIME_API ?? "https://api-dime.rndm.io";
const MAX_MARGIN = Number(process.env.DIME_TERMINAL_MAX_MARGIN ?? 1);

interface Config { account: Address; apiKey: string; sessionKey: Hex; sessionAddress: Address; expiresAt: number }
const load = (): Config => {
  if (!fs.existsSync(CONFIG)) throw new Error("Not set up yet: run `dime setup 0xYourWallet` first.");
  return JSON.parse(fs.readFileSync(CONFIG, "utf8")) as Config;
};
const save = (c: Config) => {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
};

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SYMBOLS: Record<string, MarketSymbol> = { BTC: "BTC-USD", NVDA: "NVDA-USD", ANT: "ANTH-USD", ANTH: "ANTH-USD" };
const symbolOf = (s: string) => {
  const m = SYMBOLS[s.toUpperCase().replace(/-USD$/, "")];
  if (!m) throw new Error(`Unknown market ${s}: use BTC, NVDA or ANT.`);
  return m;
};
const nameOf = (m: MarketSymbol) => (m === "ANTH-USD" ? "ANT" : m.replace("-USD", ""));

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const BOOL = new Set(["--dry-run"]);
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (BOOL.has(a)) flags.set(a, "1");
  else if (a.startsWith("--")) {
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    flags.set(a, v);
  } else rest.push(a);
}
const rules = (): ExitRules => ({
  tp: flags.has("--tp") ? parseLevel(flags.get("--tp")!) : undefined,
  sl: flags.has("--sl") ? parseLevel(flags.get("--sl")!) : undefined,
  trailPct: flags.has("--trail") ? parsePct(flags.get("--trail")!) : undefined,
  maxHoldMs: flags.has("--max-hold") ? parseDuration(flags.get("--max-hold")!) : undefined,
});
const describe = (r: ExitRules) =>
  [r.tp && `tp ${flags.get("--tp")}`, r.sl && `sl ${flags.get("--sl")}`, r.trailPct !== undefined && `trail ${r.trailPct}%`, r.maxHoldMs !== undefined && `max hold ${flags.get("--max-hold")}`]
    .filter(Boolean).join(", ") || "no exits";

/* ------------------------------------------------------------------ prices */
/** Live reference prices for one market: the stream, with a poll if it goes quiet for 5 s. */
function watchPrice(dime: DimeClient, market: MarketSymbol, on: (price: number) => void): () => void {
  let last = 0;
  const stop = dime.subscribe([`price:${market}`], (_ch, d) => {
    const p = d?.reference?.price;
    if (p) { last = Date.now(); on(fromPrice(p)); }
  }, () => {});
  const poll = setInterval(async () => {
    if (Date.now() - last < 5_000) return;
    const p = await dime.price(market).catch(() => null);
    if (p) on(p.price);
  }, 1_000);
  return () => { stop(); clearInterval(poll); };
}

/* ------------------------------------------------------------------ positions */
async function marketHashes(dime: DimeClient) {
  const ms = await dime.markets();
  return new Map(ms.map((m) => [m.hash.toLowerCase(), m.symbol]));
}
const toPos = (p: Position): Pos => ({
  isLong: Number(p.side) === 0, entry: fromPrice(p.entryPrice), margin: fromUsd(p.collateral), leverage: Number(p.leverage), liquidation: fromPrice(p.liquidationPrice),
});
async function openPositions(dime: DimeClient, account: Address) {
  const [r, hashes] = await Promise.all([dime.positions(account), marketHashes(dime)]);
  const list = r.positions ?? (r.position ? [r.position] : []);
  return { free: fromUsd(r.freeBalance), list: list.map((p) => ({ raw: p, market: hashes.get(String(p.market).toLowerCase()) ?? ("BTC-USD" as MarketSymbol), pos: toPos(p) })) };
}

/* ------------------------------------------------------------------ the watcher */
async function watch(dime: DimeClient, c: Config, targets: { id: Hex; market: MarketSymbol; pos: Pos }[], r: ExitRules, dryRun: boolean) {
  const signer = sessionAccount(c.sessionKey);
  const live = new Map<Hex, { w: ExitWatch | null; market: MarketSymbol; pos: Pos; closing: number }>();
  for (const t of targets) live.set(t.id, { w: null, market: t.market, pos: t.pos, closing: 0 });
  const stops: (() => void)[] = [];

  const close = async (id: Hex, why: string, price: number) => {
    const x = live.get(id)!;
    x.closing = Date.now();
    if (Number.isFinite(price)) log(`${why} on ${nameOf(x.market)} at ${px(price)} (${moveBp(x.pos, price).toFixed(1)} bp, about ${usd(pnlAt(x.pos, price))})${dryRun ? ": dry run, not closing" : ": closing"}`);
    if (dryRun) { live.delete(id); return; }
    try {
      const res = await dime.close({ account: c.account, signer, positionId: id });
      log(`close sent: ${res.status}${res.txHash ? ` · tx ${res.txHash}` : ""}`);
    } catch (e) { log(`close failed: ${(e as Error).message}; trying again in 5 s`); x.closing = Date.now() - 15_000; }
  };

  for (const market of new Set(targets.map((t) => t.market))) {
    stops.push(watchPrice(dime, market, (price) => {
      for (const [id, x] of live) {
        if (x.market !== market || x.closing) continue;
        if (!x.w) {
          x.w = new ExitWatch(x.pos, r, Date.now(), price);
          for (const warn of check(x.pos, r, price)) log(`warning: ${warn}`);
          log(`watching ${nameOf(market)} ${x.pos.isLong ? "long" : "short"} $${x.pos.margin} at ${x.pos.leverage}× from ${px(x.pos.entry)}: ` +
            [x.w.tp !== null && `tp ${px(x.w.tp)}`, x.w.sl !== null && `sl ${px(x.w.sl)}`, x.w.trail !== null && `trail ${px(x.w.trail)}`, `liquidation ${px(x.pos.liquidation)}`].filter(Boolean).join(" · "));
        }
        const why = x.w.update(price, Date.now());
        if (why) void close(id, why, price);
      }
    }));
  }

  // Every 5 s: drop positions that are gone (closed, liquidated, closed in the app), resend a close that hasn't landed.
  let lastStatus = Date.now();
  while (live.size) {
    await sleep(5_000);
    const now = await openPositions(dime, c.account).catch(() => null);
    if (!now) continue;
    for (const [id, x] of live) {
      if (!now.list.some((p) => p.raw.id === id)) {
        log(`${nameOf(x.market)} position closed${x.closing ? "" : " (in the app, or liquidated)"}. Free balance $${now.free.toFixed(2)}.`);
        live.delete(id);
      } else if (x.closing && Date.now() - x.closing > 20_000) {
        log(`${nameOf(x.market)} still open 20 s after the close: sending it again`);
        void close(id, "retry", Number.NaN);
      }
    }
    if (Date.now() - lastStatus > 60_000 && live.size) {
      lastStatus = Date.now();
      for (const x of live.values()) if (x.w) log(`${nameOf(x.market)}: still open${x.w.trail !== null ? ` · trail ${px(x.w.trail)}` : ""}`);
    }
  }
  stops.forEach((s) => s());
}

/* ------------------------------------------------------------------ commands */
async function main() {
  const [cmd, ...a] = rest;
  const dime = new DimeClient({ api: API });

  switch (cmd) {
    case "setup": {
      const user = a[0] as Address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(user ?? "")) throw new Error("usage: dime setup 0xYourWallet");
      const m = await dime.manifest();
      const chain = { id: m.chainId, name: String(m.chainName ?? "Robinhood Chain"), rpc: String(m.rpcUrl ?? "https://rpc.mainnet.chain.robinhood.com"), explorer: String(m.explorer ?? "https://robin.etherscan.io") };
      const days = Number(flags.get("--days") ?? 30);
      const k = await setup(dime, user, chain, log, days);
      save({ account: user, ...k });
      log(`Saved to ${CONFIG}. Session key ${k.sessionAddress}, valid until ${new Date(k.expiresAt).toLocaleString()}.`);
      log("Revoke it any time from the account sheet on dime.rndm.io.");
      return;
    }
    case "price": {
      const m = symbolOf(a[0] ?? "BTC");
      const p = await dime.price(m);
      console.log(p ? `${nameOf(m)} ${px(p.price)}` : `${nameOf(m)}: no price`);
      return;
    }
    case "positions": {
      const c = load();
      const { free, list } = await openPositions(dime, c.account);
      console.log(`free balance $${free.toFixed(2)} · session key valid until ${new Date(c.expiresAt).toLocaleString()}`);
      if (!list.length) console.log("no open positions");
      for (const p of list) {
        const now = (await dime.price(p.market))?.price ?? p.pos.entry;
        console.log(`${nameOf(p.market).padEnd(4)} ${p.pos.isLong ? "long " : "short"} $${p.pos.margin} × ${p.pos.leverage}  entry ${px(p.pos.entry)}  now ${px(now)}  liq ${px(p.pos.liquidation)}  ${usd(pnlAt(p.pos, now))}`);
      }
      return;
    }
    case "open": {
      const [mk, sideArg, marginArg, levArg] = a;
      const market = symbolOf(mk ?? "");
      const side = sideArg?.toLowerCase() === "long" ? "LONG" : sideArg?.toLowerCase() === "short" ? "SHORT" : null;
      const margin = Number(marginArg), leverage = Number(levArg);
      if (!side || !(margin > 0) || !(leverage >= 1)) throw new Error("usage: dime open BTC long <margin $> <leverage> [--tp 0.3%] [--sl 0.4%] [--trail 0.2%] [--max-hold 30m] [--dry-run]");
      if (margin > MAX_MARGIN) throw new Error(`Margin $${margin} is over this terminal's limit of $${MAX_MARGIN} (DIME_TERMINAL_MAX_MARGIN).`);
      const c = load();
      dime.setApiKey(c.apiKey);
      const r = rules();
      const q = await dime.quote({ side, margin, leverage, market });
      const pos: Pos = { isLong: side === "LONG", entry: fromPrice(q.indicativeEntry), margin, leverage, liquidation: fromPrice(q.liquidationPrice) };
      const w = new ExitWatch(pos, r, Date.now(), pos.entry);
      log(`${nameOf(market)} ${side.toLowerCase()} $${margin} at ${leverage}×: entry about ${px(pos.entry)}, liquidation ${px(pos.liquidation)}, ${q.auto.summary}`);
      log(`exits: ${describe(r)}${w.tp !== null ? ` · tp ${px(w.tp)} (${usd(pnlAt(pos, w.tp))})` : ""}${w.sl !== null ? ` · sl ${px(w.sl)} (${usd(pnlAt(pos, w.sl))})` : ""}`);
      for (const warn of check(pos, r, pos.entry)) log(`warning: ${warn}`);
      if (!q.capacity.houseAvailable && q.capacity.houseReason) log(`house: ${q.capacity.houseReason}`);
      if (flags.has("--dry-run")) { log("dry run: nothing sent"); return; }
      const o = await dime.open({ account: c.account, signer: sessionAccount(c.sessionKey), side, margin, leverage, market });
      const done = await dime.waitForIntent(o.id, 60_000);
      if (done.status !== "OPENED" || !done.positionId) throw new Error(`Not opened: ${done.status}${done.reason ? ` (${done.reason})` : ""}`);
      const opened = (await openPositions(dime, c.account)).list.find((p) => p.raw.id === done.positionId);
      log(`opened at ${px(opened?.pos.entry ?? pos.entry)}`);
      if (!r.tp && !r.sl && r.trailPct === undefined && r.maxHoldMs === undefined) return;
      await watch(dime, c, [{ id: done.positionId, market, pos: opened?.pos ?? pos }], r, false);
      return;
    }
    case "watch": {
      const c = load();
      dime.setApiKey(c.apiKey);
      const which = (a[0] ?? "").toLowerCase();
      if (!which) throw new Error("usage: dime watch <BTC|NVDA|ANT|all> [--tp …] [--sl …] [--trail …] [--max-hold …] [--dry-run]");
      const r = rules();
      if (!r.tp && !r.sl && r.trailPct === undefined && r.maxHoldMs === undefined) throw new Error("Give at least one of --tp, --sl, --trail, --max-hold.");
      const { list } = await openPositions(dime, c.account);
      const picked = list.filter((p) => which === "all" || p.market === symbolOf(which));
      if (!picked.length) throw new Error("No matching open position.");
      log(`exits: ${describe(r)}`);
      await watch(dime, c, picked.map((p) => ({ id: p.raw.id, market: p.market, pos: p.pos })), r, flags.has("--dry-run"));
      return;
    }
    case "close": {
      const c = load();
      dime.setApiKey(c.apiKey);
      const market = symbolOf(a[0] ?? "");
      const p = (await openPositions(dime, c.account)).list.find((x) => x.market === market);
      if (!p) throw new Error(`No open ${nameOf(market)} position.`);
      const res = await dime.close({ account: c.account, signer: sessionAccount(c.sessionKey), positionId: p.raw.id });
      log(`close sent: ${res.status}${res.txHash ? ` · tx ${res.txHash}` : ""}`);
      return;
    }
    default:
      console.log(`dime: a DIME terminal with take profit, stop loss, trailing stop and time limit

  dime setup 0xYourWallet [--days 30]      approve an API key and a session key (opens and closes, never withdraws)
  dime price [BTC|NVDA|ANT]
  dime positions
  dime open <BTC|NVDA|ANT> <long|short> <margin $> <leverage> [exits] [--dry-run]
  dime watch <BTC|NVDA|ANT|all> <exits> [--dry-run]
  dime close <BTC|NVDA|ANT>

exits:
  --tp 0.3% | '$2' | @66000       take profit: price move, dollars paid after DIME's cut on wins, or a price
  --sl 0.4% | '$1' | @63000       stop loss: price move against you, dollars lost, or a price
  --trail 0.2%                    close when the price falls back this far from the best it reached
  --max-hold 30m                  close at the market after this long (90s, 30m, 2h)

Exits run in this process: keep it running (screen, tmux). Margin is capped at $${MAX_MARGIN} (DIME_TERMINAL_MAX_MARGIN).`);
  }
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopped watching. Open positions stay open (dime positions, dime close).");
  process.exit(0);
});
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
