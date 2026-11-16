#!/usr/bin/env node
/**
 * Standalone Hyperliquid BTC recorder for servers: no npm install, no repo checkout.
 * Needs Node 22+ (built-in WebSocket). Same record format as ofi-recorder.ts.
 *
 * Small footprint: each finished hour is gzipped (about 10x smaller, ~0.3 MB/h), files older than
 * OFI_KEEP_DAYS (default 14) are deleted, and recording pauses if the disk has less than
 * OFI_MIN_FREE_MB (default 2048) free.
 *
 *   node research/recorder.mjs                       # writes data/ofi/ (OFI_DIR to change)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

const COIN = process.env.OFI_COIN ?? "BTC";
const DIR = path.resolve(process.env.OFI_DIR ?? "data/ofi");
const KEEP_DAYS = Number(process.env.OFI_KEEP_DAYS ?? 14);
const MIN_FREE_MB = Number(process.env.OFI_MIN_FREE_MB ?? 2048);
const URL = "wss://api.hyperliquid.xyz/ws";
const LEVELS = 10;
fs.mkdirSync(DIR, { recursive: true });

let out = null, hour = "", file = "", paused = false;
const counts = { bbo: 0, l2: 0, tr: 0, reconnects: 0, skipped: 0 };

async function finish(f) {
  if (!f || !fs.existsSync(f)) return;
  await pipeline(fs.createReadStream(f), zlib.createGzip({ level: 9 }), fs.createWriteStream(f + ".gz"));
  fs.unlinkSync(f);
}

function housekeeping() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    if (f.endsWith(".gz") && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    // A plain file from an earlier hour (e.g. after a crash) gets compressed.
    if (f.endsWith(".ndjson") && p !== file) finish(p).catch(() => {});
  }
  const st = fs.statfsSync(DIR);
  const freeMb = (st.bavail * st.bsize) / 2 ** 20;
  paused = freeMb < MIN_FREE_MB;
  if (paused) console.log(`[ofi] paused: only ${freeMb.toFixed(0)} MB free (< ${MIN_FREE_MB})`);
}

function write(rec) {
  if (paused) { counts.skipped++; return; }
  const h = new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");
  if (h !== hour) {
    const prev = file, prevOut = out;
    hour = h;
    file = path.join(DIR, `${COIN}-${h}.ndjson`);
    out = fs.createWriteStream(file, { flags: "a" });
    if (prevOut) prevOut.end(() => finish(prev).catch((e) => console.log(`[ofi] gzip failed: ${e.message}`)));
    housekeeping();
  }
  out.write(JSON.stringify(rec) + "\n");
}

const lv = (l) => [Number(l.px), Number(l.sz)];

function connect(attempt = 0) {
  const ws = new WebSocket(URL);
  let ping;
  ws.addEventListener("open", () => {
    attempt = 0;
    for (const type of ["bbo", "l2Book", "trades"]) ws.send(JSON.stringify({ method: "subscribe", subscription: { type, coin: COIN } }));
    ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: "ping" })), 20_000);
    console.log(`[ofi] connected, recording ${COIN} to ${DIR}`);
  });
  ws.addEventListener("message", (ev) => {
    const recv = Date.now();
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.channel === "bbo" && m.data?.bbo?.[0] && m.data.bbo[1]) {
      counts.bbo++;
      write({ t: "bbo", ts: m.data.time, recv, b: lv(m.data.bbo[0]), a: lv(m.data.bbo[1]) });
    } else if (m.channel === "l2Book" && m.data?.levels) {
      counts.l2++;
      const [bids, asks] = m.data.levels;
      write({ t: "l2", ts: m.data.time, recv, b: bids.slice(0, LEVELS).map(lv), a: asks.slice(0, LEVELS).map(lv) });
    } else if (m.channel === "trades" && Array.isArray(m.data)) {
      for (const t of m.data) { counts.tr++; write({ t: "tr", ts: t.time, recv, px: Number(t.px), sz: Number(t.sz), s: t.side === "B" ? 1 : -1 }); }
    }
  });
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    clearInterval(ping);
    counts.reconnects++;
    const wait = Math.min(30_000, 500 * 2 ** attempt);
    console.log(`[ofi] disconnected, reconnecting in ${wait} ms`);
    setTimeout(() => connect(attempt + 1), wait);
  };
  ws.addEventListener("close", retry);
  ws.addEventListener("error", () => { try { ws.close(); } catch {} retry(); });
}

setInterval(() => console.log(`[ofi] ${new Date().toISOString()} bbo ${counts.bbo} l2 ${counts.l2} trades ${counts.tr} reconnects ${counts.reconnects} skipped ${counts.skipped}`), 10 * 60_000);
setInterval(housekeeping, 60 * 60_000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (out ? out.end(() => process.exit(0)) : process.exit(0)));
housekeeping();
connect();
