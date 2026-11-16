#!/usr/bin/env node
/**
 * DIME MCP server: lets AI agents (Claude, Cursor, any MCP client) read DIME and, if you allow it, trade.
 * Speaks MCP over stdio (newline-delimited JSON-RPC 2.0). No dependencies beyond the DIME SDK.
 *
 * Read-only by default. Trading tools appear only when a session key is configured, and are bounded by
 * DIME_MCP_MAX_MARGIN_USD and DIME_MCP_MAX_LEVERAGE. A session key can open and close, never withdraw.
 *
 * Env:
 *   DIME_API                 https://api-dime.rndm.io (default)
 *   DIME_ACCOUNT             your wallet address (default account for reads; required to trade)
 *   DIME_API_KEY             required to quote or trade
 *   DIME_SESSION_KEY_FILE    file holding a session private key (create with the SDK: createSessionKey)
 *   DIME_MCP_MAX_MARGIN_USD  per-trade margin limit for the agent (default 1)
 *   DIME_MCP_MAX_LEVERAGE    leverage limit for the agent (default 1000)
 *   DIME_VAULT               the junior backstop vault's address (enables the vault tools)
 *   DIME_RPC                 RPC URL of the chain the vault is on (required with DIME_VAULT)
 *
 * Take-profit and stop-loss run inside this process: it watches the price every second and closes with the session
 * key when a level is hit. They last only while the MCP server runs; liquidation on-chain still applies regardless.
 */
import fs from "node:fs";
import readline from "node:readline";
import { createPublicClient, encodeFunctionData, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { ANTH_MARKET, DimeClient, MAX_NOTIONAL, DimeError, fromPrice, fromUsd, maxLeverageFor, NVDA_MARKET, sessionAccount, usd } from "../../sdk/src/index";

const VERSION = "0.1.0";
const env = process.env;
const dime = new DimeClient({ api: env.DIME_API ?? "https://api-dime.rndm.io", apiKey: env.DIME_API_KEY });
const ACCOUNT = env.DIME_ACCOUNT as Address | undefined;
const session = env.DIME_SESSION_KEY_FILE ? sessionAccount(fs.readFileSync(env.DIME_SESSION_KEY_FILE, "utf8").trim() as Hex) : null;
const TRADING = !!(session && ACCOUNT && env.DIME_API_KEY);
const MAX_MARGIN = Number(env.DIME_MCP_MAX_MARGIN_USD ?? 1);
const MAX_LEV = Number(env.DIME_MCP_MAX_LEVERAGE ?? 1000);
const log = (...a: unknown[]) => console.error("[dime-mcp]", ...a); // stdout is the protocol channel
const VAULT = env.DIME_VAULT as Address | undefined;
const chain = VAULT && env.DIME_RPC ? createPublicClient({ transport: http(env.DIME_RPC) }) : null;
const VAULT_ABI = parseAbi([
  "function riskCard() view returns (uint16 capBps, uint32 delay, uint256 assets, uint256 deposits, uint256 backstopNow, uint256 backstopMax, uint256 liquid)",
  "function asset() view returns (address)",
  "function senior() view returns (address)",
  "function gate() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxWithdraw(address holder) view returns (uint256)",
  "function balanceOf(address holder) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function unlockAt(address holder) view returns (uint64)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const readVault = <T,>(functionName: string, args: unknown[] = []) =>
  chain!.readContract({ address: VAULT!, abi: VAULT_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

/* ------------------------------------------------------------------ take-profit / stop-loss */
interface Exit { market: string; positionId: string; side: "LONG" | "SHORT"; entry: number; tpBp?: number; slBp?: number; setAt: string }
const exits = new Map<string, Exit>(); // by market
let watching = false;
async function watchExits() {
  if (watching) return;
  watching = true;
  while (exits.size) {
    for (const [mk, x] of [...exits]) {
      try {
        const p = await dime.price(mk as "BTC-USD");
        if (!p) continue;
        const moveBp = ((p.price - x.entry) / x.entry) * 1e4 * (x.side === "LONG" ? 1 : -1);
        const hit = x.tpBp !== undefined && moveBp >= x.tpBp ? "take-profit" : x.slBp !== undefined && moveBp <= -x.slBp ? "stop-loss" : null;
        if (!hit) continue;
        exits.delete(mk);
        const r = await dime.close({ account: ACCOUNT!, signer: session!, positionId: x.positionId as Hex });
        log(`${hit} hit on ${mk} at ${moveBp.toFixed(2)} bp: closed, tx ${r.txHash}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (/no (open )?position|not open|NotOpen|settled/i.test(msg)) exits.delete(mk); // liquidated or closed elsewhere
        else log(`exit check ${mk}: ${msg}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  watching = false;
}
/**
 * Exits run on the API first: it keeps the signed closes and fires them on its own price feed, so they work while
 * this MCP server is off. Where the API has auto-close switched off (404), they're watched here instead, every second.
 */
async function armExit(x: Exit): Promise<{ where: "server" | "local"; stops?: unknown[] }> {
  const dir = x.side === "LONG" ? 1 : -1;
  const at = (moveBp: number) => x.entry * (1 + (dir * moveBp) / 1e4);
  try {
    await cancelServerExits(x.positionId);
    const stops = [];
    if (x.tpBp) stops.push(await dime.autoClose({ account: ACCOUNT!, signer: session!, positionId: x.positionId as Hex, triggerPrice: at(x.tpBp) }));
    if (x.slBp) stops.push(await dime.autoClose({ account: ACCOUNT!, signer: session!, positionId: x.positionId as Hex, triggerPrice: at(-x.slBp) }));
    exits.delete(x.market);
    return { where: "server", stops };
  } catch (e) {
    if (!(e instanceof DimeError && e.status === 404)) throw e;
    exits.set(x.market, x);
    void watchExits();
    return { where: "local" };
  }
}
const activeServerExits = async () => (await dime.autoCloses(ACCOUNT!).catch(() => [])).filter((s) => s.status === "ACTIVE" || s.status === "FIRING");
async function cancelServerExits(positionId: string) {
  for (const s of await activeServerExits()) if (s.positionId.toLowerCase() === positionId.toLowerCase()) await dime.cancelAutoClose(s.id, session!);
}
const bp = (d: string) => ({ type: "number", exclusiveMinimum: 0, description: d });

type Args = Record<string, unknown>;
interface Tool { name: string; description: string; inputSchema: object; run: (a: Args) => Promise<unknown>; trading?: boolean }

const side = { type: "string", enum: ["LONG", "SHORT"], description: "LONG profits if the price rises, SHORT if it falls" };
const market = {
  type: "string", enum: ["BTC", "NVDA", "ANTH"], default: "BTC",
  description: "BTC (Bitcoin), NVDA (Nvidia, priced 24/7 from Hyperliquid's xyz:NVDA perp) or ANTH (Anthropic, pre-IPO: priced 24/7 from Hyperliquid's io:ANTH mark price)",
};
const BASES = ["BTC", "NVDA", "ANTH"] as const;
const symbol = (a: Record<string, unknown>) => `${BASES.includes(a.market as never) ? a.market : "BTC"}-USD` as "BTC-USD" | "NVDA-USD" | "ANTH-USD";
const baseOf = (hash: string) => (hash === NVDA_MARKET ? "NVDA" : hash === ANTH_MARKET ? "ANTH" : "BTC");
const marginUsd = { type: "number", description: "Margin in USD, e.g. 0.1. margin × leverage may not exceed $5,000." };
const leverage = { type: "integer", minimum: 1, maximum: 1000, description: "Leverage, 1–1000" };
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Wallet address (defaults to DIME_ACCOUNT)" };
const pick = (a: Args) => (a.address as Address | undefined) ?? ACCOUNT ?? (() => { throw new Error("address required (or set DIME_ACCOUNT)"); })();

function describePosition(p: any) {
  if (!p) return null;
  return {
    id: p.id, market: baseOf(String(p.market).toLowerCase()), side: Number(p.side) === 0 ? "LONG" : "SHORT", route: Number(p.route) === 1 ? "HOUSE" : "MATCHED",
    marginUsd: fromUsd(p.collateral), leverage: Number(p.leverage), entry: fromPrice(p.entryPrice), liquidation: fromPrice(p.liquidationPrice),
    openedAt: new Date(Number(p.openedAtMs)).toISOString(),
  };
}

const tools: Tool[] = [
  {
    name: "dime_price", description: "Latest reference price DIME trades at for BTC, NVDA or ANTH (signed and checked on-chain).",
    inputSchema: { type: "object", properties: { market } },
    run: async (a) => dime.price(symbol(a)),
  },
  {
    name: "dime_price_history", description: "BTC, NVDA or ANTH reference price, one point per second, newest last.",
    inputSchema: { type: "object", properties: { market, seconds: { type: "integer", minimum: 2, maximum: 3600, default: 300 } } },
    run: async (a) => (await dime.history(Number(a.seconds ?? 300), symbol(a))).map((p) => ({ t: new Date(p.t).toISOString(), price: fromPrice(p.price) })),
  },
  {
    name: "dime_house", description: "Protocol state, house reserve, free capacity, open interest and live trading limits.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const h = await dime.house();
      const H = h.house as Record<string, string>;
      const K = h.config as Record<string, unknown>;
      return {
        state: h.state, reserveUsd: fromUsd(H.reserve), freeCapacityUsd: fromUsd(H.availableCapacity),
        houseLongUsd: fromUsd(H.houseLongNotional), houseShortUsd: fromUsd(H.houseShortNotional), openHousePositions: Number(H.openHousePositions),
        limits: { minMarginUsd: fromUsd(String(K.minCollateral)), maxMarginUsd: fromUsd(String(K.maxCollateral)), maxLeverage: K.maxLeverage, maxExposureUsd: fromUsd(MAX_NOTIONAL) },
      };
    },
  },
  {
    name: "dime_quote", description: "Quote a trade without placing it: entry, liquidation price, whether the house can take it now.",
    inputSchema: { type: "object", properties: { market, side, margin_usd: marginUsd, leverage }, required: ["side", "margin_usd", "leverage"] },
    run: async (a) => {
      const q = await dime.quote({ side: a.side as "LONG" | "SHORT", margin: Number(a.margin_usd), leverage: Number(a.leverage), market: symbol(a) });
      return { entry: fromPrice(q.indicativeEntry), liquidation: fromPrice(q.liquidationPrice), houseAvailable: q.capacity.houseAvailable, houseReason: q.capacity.houseReason, execution: q.auto.summary, expiresAt: new Date(q.expiresAt).toISOString() };
    },
  },
  {
    name: "dime_account", description: "Free balance, open position and DIME (staked, pending, claimable) for a wallet.",
    inputSchema: { type: "object", properties: { address: addr } },
    run: async (a) => {
      const r = await dime.positions(pick(a));
      const open = r.positions ?? (r.position ? [r.position] : []);
      return { address: r.address, freeBalanceUsd: fromUsd(r.freeBalance), positions: open.map(describePosition), dime: r.dime };
    },
  },
  {
    name: "dime_activity", description: "Recent on-chain activity for a wallet (opens, settlements, deposits).",
    inputSchema: { type: "object", properties: { address: addr } },
    run: async (a) => dime.activity(pick(a)),
  },
  {
    name: "dime_open", trading: true,
    description: `Open a BTC, NVDA or ANTH position for DIME_ACCOUNT with its session key. Real money: you can lose the whole margin. Limits: margin ≤ $${MAX_MARGIN}, leverage ≤ ${MAX_LEV}×, one open position per market.`,
    inputSchema: {
      type: "object", required: ["side", "margin_usd", "leverage"],
      properties: {
        market, side, margin_usd: marginUsd, leverage,
        take_profit_bp: bp("Optional: close when the price has moved this many basis points your way (0.01% = 1 bp)"),
        stop_loss_bp: bp("Optional: close when the price has moved this many bp against you; must be inside the liquidation distance (~6 bp at 1000×) to matter"),
      },
    },
    run: async (a) => {
      const margin = Number(a.margin_usd), lev = Number(a.leverage);
      if (!(margin > 0) || margin > MAX_MARGIN) throw new Error(`margin must be > 0 and ≤ $${MAX_MARGIN} (DIME_MCP_MAX_MARGIN_USD)`);
      if (!(lev >= 1) || lev > MAX_LEV) throw new Error(`leverage must be 1–${MAX_LEV} (DIME_MCP_MAX_LEVERAGE)`);
      if (lev > maxLeverageFor(usd(margin))) throw new Error(`max ${maxLeverageFor(usd(margin))}× at $${margin} margin ($5,000 exposure cap)`);
      const o = await dime.open({ account: ACCOUNT!, signer: session!, side: a.side as "LONG" | "SHORT", margin, leverage: lev, market: symbol(a) });
      const done = await dime.waitForIntent(o.id);
      const tp = a.take_profit_bp === undefined ? undefined : Number(a.take_profit_bp), sl = a.stop_loss_bp === undefined ? undefined : Number(a.stop_loss_bp);
      let exit: (Exit & { where: string }) | null = null;
      if (done.positionId && (tp || sl)) {
        const pos = describePosition(((await dime.positions(ACCOUNT!)).positions ?? []).find((p: any) => p.id === done.positionId));
        if (pos) {
          const x: Exit = { market: symbol(a), positionId: pos.id, side: pos.side as "LONG" | "SHORT", entry: pos.entry, tpBp: tp, slBp: sl, setAt: new Date().toISOString() };
          exit = { ...x, where: (await armExit(x)).where };
        }
      }
      return { request: o.id, status: done.status, reason: done.reason, positionId: done.positionId, txHash: done.txHash, exit };
    },
  },
  {
    name: "dime_close", trading: true, description: "Close DIME_ACCOUNT's open BTC, NVDA or ANTH position at the next signed price.",
    inputSchema: { type: "object", properties: { market } },
    run: async (a) => {
      const r0 = await dime.positions(ACCOUNT!);
      const want = symbol(a).replace("-USD", "");
      const position = (r0.positions ?? (r0.position ? [r0.position] : [])).find((p) => describePosition(p)!.market === want);
      if (!position) return { closed: false, reason: `no open ${want} position` };
      const r = await dime.close({ account: ACCOUNT!, signer: session!, positionId: position.id });
      const after = await dime.positions(ACCOUNT!);
      return { closed: true, txHash: r.txHash, freeBalanceUsd: fromUsd(after.freeBalance) };
    },
  },
  {
    name: "dime_exits", trading: true,
    description: "Show, set or cancel take-profit / stop-loss on DIME_ACCOUNT's open positions. Kept and fired by the DIME API, so they work while this server is off; where the API has auto-close off, checked here every second while this server runs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set", "cancel"], default: "list" }, market,
        take_profit_bp: bp("Close when the price has moved this many bp your way"), stop_loss_bp: bp("Close when the price has moved this many bp against you"),
      },
    },
    run: async (a) => {
      const act = String(a.action ?? "list"), mk = symbol(a);
      const list = async () => ({ server: await activeServerExits(), local: [...exits.values()] });
      if (act === "cancel") {
        const r = await dime.positions(ACCOUNT!);
        const pos = (r.positions ?? (r.position ? [r.position] : [])).map(describePosition).find((p: any) => p.market === mk.replace("-USD", ""));
        if (pos) await cancelServerExits(pos.id);
        exits.delete(mk);
        return { cancelled: true, exits: await list() };
      }
      if (act === "set") {
        const r = await dime.positions(ACCOUNT!);
        const want = mk.replace("-USD", "");
        const pos = (r.positions ?? (r.position ? [r.position] : [])).map(describePosition).find((p: any) => p.market === want);
        if (!pos) return { set: false, reason: `no open ${want} position` };
        const x: Exit = { market: mk, positionId: pos.id, side: pos.side as "LONG" | "SHORT", entry: pos.entry,
          tpBp: a.take_profit_bp === undefined ? undefined : Number(a.take_profit_bp), slBp: a.stop_loss_bp === undefined ? undefined : Number(a.stop_loss_bp), setAt: new Date().toISOString() };
        if (!x.tpBp && !x.slBp) throw new Error("give take_profit_bp, stop_loss_bp or both");
        return { set: true, exit: x, ...(await armExit(x)) };
      }
      return { exits: await list() };
    },
  },
  {
    name: "dime_vault", description: "The DIME backstop vault (junior tranche): its risk card in plain terms, size, and whether a wallet may deposit. Read-only.",
    inputSchema: { type: "object", properties: { address: addr } },
    run: async (a) => {
      if (!chain) throw new Error("set DIME_VAULT and DIME_RPC to use the vault tools");
      const [capBps, delay, assets, deposits, backstop, backstopMax, liquid] = await readVault<readonly [number, number, bigint, bigint, bigint, bigint, bigint]>("riskCard");
      const token = await readVault<Address>("asset");
      const [dec, sym] = await Promise.all([
        chain.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
        chain.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
      ]);
      const f = (x: bigint) => Number(formatUnits(x, dec));
      const who = (a.address as Address | undefined) ?? ACCOUNT;
      const mine = who ? {
        address: who, mayDeposit: (await readVault<bigint>("maxDeposit", [who])) > 0n,
        balance: f(await readVault<bigint>("convertToAssets", [await readVault<bigint>("balanceOf", [who])])),
        withdrawableNow: f(await readVault<bigint>("maxWithdraw", [who])),
        unlockAt: new Date(Number(await readVault<bigint>("unlockAt", [who])) * 1000).toISOString(),
      } : null;
      return {
        vault: VAULT, asset: sym, seniorVault: await readVault<Address>("senior"),
        totalAssets: f(assets), netDeposits: f(deposits), earned: Math.max(0, f(assets) - f(deposits)),
        backstop: { inHouseReserve: f(backstop), max: f(backstopMax), principalCapPct: capBps / 100 },
        maxLoss: capBps === 0
          ? "Deposits can't be lost to the house: only yield already earned ever backs it."
          : `Up to ${capBps / 100}% of the vault's assets, plus yield already earned, can be lost covering house shortfalls.`,
        otherRisks: ["smart-contract bugs (DIME, this vault, Morpho)", "Morpho lending: bad debt or full utilisation delaying exits", `${sym} losing its peg`],
        earns: ["Morpho lending yield via the senior vault", "USDG from staking the vault's DIME (30% of house earnings, pro rata)", "nothing is promised: all of it is variable"],
        withdrawDelaySeconds: delay, liquidNow: f(liquid), you: mine,
      };
    },
  },
  {
    name: "dime_vault_deposit_tx",
    description: "Build (not send) the two transactions to deposit into the DIME backstop vault: approve, then deposit. Your own wallet signs them; this server never holds funds. Check dime_vault first: the wallet must be allowed (terms signed, allowed jurisdiction).",
    inputSchema: { type: "object", properties: { amount: { type: "number", exclusiveMinimum: 0, description: "Amount of the vault's asset (e.g. USDG) to deposit" }, address: addr }, required: ["amount"] },
    run: async (a) => {
      if (!chain) throw new Error("set DIME_VAULT and DIME_RPC to use the vault tools");
      const who = pick(a);
      const token = await readVault<Address>("asset");
      const dec = await chain.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });
      const amt = parseUnits(String(a.amount), dec);
      if ((await readVault<bigint>("maxDeposit", [who])) === 0n) return { ok: false, reason: `${who} is not allowed to deposit (terms not signed, or a restricted jurisdiction)` };
      const shares = await readVault<bigint>("previewDeposit", [amt]);
      return {
        ok: true, from: who, expectedShares: shares.toString(), chainId: await chain.getChainId(),
        transactions: [
          { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [VAULT!, amt] }), value: "0", note: "approve the vault to take the amount" },
          { to: VAULT, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amt, who] }), value: "0", note: "deposit; shares are locked for the withdraw delay" },
        ],
      };
    },
  },
];
const active = tools.filter((t) => (!t.trading || TRADING) && (!t.name.startsWith("dime_vault") || chain));

const INSTRUCTIONS = `DIME is a house-backed trading app on-chain for BTC, NVDA (Nvidia, 24/7) and ANTH (Anthropic pre-IPO, 24/7): long or short from $0.10 up to 1000× leverage, zero trading fees; wins pay m×m/(m+3) bp of a move of m bp, and liquidation is 4 bp before margin runs out. Prices have 8 decimals and USD values are plain numbers. ${
  TRADING ? `Trading is enabled for ${ACCOUNT} with a session key (cannot withdraw), margin ≤ $${MAX_MARGIN}, leverage ≤ ${MAX_LEV}×. Confirm with the user before opening trades unless they told you to trade autonomously.` : "Read-only: set DIME_ACCOUNT, DIME_API_KEY and DIME_SESSION_KEY_FILE to enable trading."
}${chain ? ` The DIME backstop vault (${VAULT}) is available: call dime_vault for its risk card before suggesting a deposit, and say plainly how much can be lost.` : ""} Never present DIME token value or returns as a promise.`;

/* ------------------------------------------------------------------ JSON-RPC over stdio */
const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(m: { id?: unknown; method?: string; params?: any }) {
  if (m.id === undefined) return; // notifications (initialized, cancelled) need no reply
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dime", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: active.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const t = active.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        const out = await t.run(m.params?.arguments ?? {});
        return reply(m.id, { content: [{ type: "text", text: JSON.stringify(out, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
      } catch (e) {
        const msg = e instanceof DimeError ? `${e.code}: ${e.message}` : (e as Error).message;
        return reply(m.id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
  void handle(m).catch((e) => fail(m.id ?? null, -32603, (e as Error).message));
});
log(`v${VERSION} ready (${TRADING ? `trading enabled for ${ACCOUNT}` : "read-only"}) → ${dime.api}`);
