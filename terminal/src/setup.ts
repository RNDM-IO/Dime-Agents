/**
 * One-time setup without your wallet's private key ever touching the terminal. Serves a page on 127.0.0.1 that asks
 * your browser wallet (MetaMask, Rabby…) for up to three signatures, the same ones the SDK documents:
 *   1. the Terms of Use, if this wallet hasn't accepted them yet
 *   2. an API key ("DIME API key" message): identifies the terminal for rate limits, can't move funds
 *   3. a session key (EIP-712 SessionKey): opens and closes for this account, never withdraws; 30 days
 * Nothing else is signed. The keys are saved in ~/.dime-terminal/config.json, readable only by you.
 */
import { createServer } from "node:http";
import type { Address, Hex } from "viem";
import type { DimeClient, Signer } from "../../sdk/src/index";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
type Ask = { kind: "message"; message: string; label: string } | { kind: "typed"; data: unknown; label: string };

/** A Signer whose signatures come from the browser page. */
function browserWallet(user: Address, chain: { id: number; name: string; rpc: string; explorer: string }, port: number) {
  let pending: { ask: Ask; resolve(sig: Hex): void; reject(e: Error): void } | null = null;
  let finished = false;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(user, chain));
    } else if (req.method === "GET" && req.url === "/next") {
      res.writeHead(200, { "content-type": "application/json" }).end(json(pending ? pending.ask : { kind: finished ? "done" : "wait" }));
    } else if (req.method === "POST" && req.url === "/signature") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { signature, error } = JSON.parse(body || "{}") as { signature?: Hex; error?: string };
        const p = pending;
        pending = null;
        if (p && signature) p.resolve(signature);
        else if (p) p.reject(new Error(error ?? "The wallet did not sign."));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    } else res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  const ask = (a: Ask) => new Promise<Hex>((resolve, reject) => { pending = { ask: a, resolve, reject }; });

  const signer: Signer = {
    address: user,
    signMessage: ({ message }) => ask({ kind: "message", message, label: message.split("\n")[0] }),
    signTypedData: (args: { domain: unknown; types: Record<string, unknown>; primaryType: string; message: unknown }) =>
      ask({
        kind: "typed", label: args.primaryType,
        data: {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" }, { name: "version", type: "string" },
              { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
            ],
            ...args.types,
          },
          domain: args.domain, primaryType: args.primaryType, message: args.message,
        },
      }),
  };
  return { signer, close: () => { finished = true; setTimeout(() => server.close(), 3_000); } };
}

export async function setup(dime: DimeClient, user: Address, chain: { id: number; name: string; rpc: string; explorer: string }, log: (m: string) => void, ttlDays = 30) {
  const port = Number(process.env.DIME_TERMINAL_PORT ?? 8790);
  const w = browserWallet(user, chain, port);
  log(`Open http://127.0.0.1:${port} in the browser that has the wallet ${user}, and approve each signature there.`);
  try {
    const terms = await dime.terms(user);
    if (!terms.accepted) {
      log(`1/3 Terms of Use (${terms.url}): read them before you sign.`);
      await dime.acceptTerms(w.signer, terms.message);
    }
    log("2/3 API key");
    const key = await dime.createApiKey(w.signer, "dime-terminal");
    log("3/3 session key");
    const session = await dime.createSessionKey(w.signer, ttlDays * 86_400);
    return { apiKey: key.key, sessionKey: session.privateKey, sessionAddress: session.address, expiresAt: session.expiresAt };
  } finally {
    w.close();
  }
}

const PAGE = (user: Address, chain: { id: number; name: string; rpc: string; explorer: string }) => `<!doctype html><meta charset="utf-8"><title>DIME terminal setup</title>
<body style="font:16px system-ui;max-width:600px;margin:48px auto;line-height:1.5;padding:0 16px">
<h2>DIME terminal setup</h2>
<p>Your wallet <code>${user}</code> will be asked for up to three signatures: the Terms of Use (if not yet accepted),
an API key, and a <b>session key</b> that can open and close DIME trades for 30 days. <b>It can't withdraw.</b>
No gas, nothing else.</p>
<button id="go" style="font-size:16px;padding:10px 18px">Start</button>
<pre id="out" style="white-space:pre-wrap"></pre>
<script>
const out = (m) => (document.getElementById("out").textContent += m + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHAIN = "0x" + (${chain.id}).toString(16);
document.getElementById("go").onclick = async () => {
  try {
    if (!window.ethereum) throw new Error("No browser wallet found on this page.");
    const [acct] = await ethereum.request({ method: "eth_requestAccounts" });
    if (acct.toLowerCase() !== "${user.toLowerCase()}") throw new Error("Switch your wallet to ${user} and try again (it's on " + acct + ").");
    try { await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN, chainName: ${JSON.stringify(chain.name)},
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [${JSON.stringify(chain.rpc)}], blockExplorerUrls: [${JSON.stringify(chain.explorer)}] }] });
    }
    for (let idle = 0; idle < 40; ) {
      const a = await (await fetch("/next")).json();
      if (a.kind === "done") { out("All set. You can close this tab; the terminal shows the rest."); return; }
      if (a.kind === "wait") { idle++; await sleep(500); continue; }
      idle = 0;
      out("Sign: " + a.label);
      let signature;
      try {
        signature = a.kind === "message"
          ? await ethereum.request({ method: "personal_sign", params: [a.message, acct] })
          : await ethereum.request({ method: "eth_signTypedData_v4", params: [acct, JSON.stringify(a.data)] });
      } catch (e) {
        await fetch("/signature", { method: "POST", body: JSON.stringify({ error: e.message || String(e) }) });
        throw e;
      }
      await fetch("/signature", { method: "POST", body: JSON.stringify({ signature }) });
    }
    out("Nothing more to sign. Check the terminal.");
  } catch (e) { out(e.message || String(e)); }
};
</script>`;
