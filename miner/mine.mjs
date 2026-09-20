// miner/mine.mjs
// Drives the extracted worker's PoW search in Node until it finds a nonce whose
// work-hash has >= <target> leading zero bits, using the REAL contract params.
//   node miner/mine.mjs <targetBits> <startNonce>
import { loadWorker, CHAIN_ID, CONTRACT, MINER } from "./load-worker.mjs";

const target = Number(process.argv[2] ?? 22);
const startNonce = BigInt(process.argv[3] ?? 0);
const batchSize = Number(process.argv[4] ?? 65536);

let found = null;
let observer = null;
const api = loadWorker({ onMessage: (m) => observer && observer(m) });

console.log(`# mining chainId=${CHAIN_ID} contract=${CONTRACT}`);
console.log(`# miner=${MINER} targetBits=${target} startNonce=${startNonce} batchSize=${batchSize}`);
const t0 = Date.now();

await new Promise((resolve) => {
  observer = (m) => {
    if (m.type === "error") { console.error("worker error:", m.message); resolve(); }
    if (m.type === "progress") {
      const c = (m.best || []).find((x) => x.bits >= target);
      if (c) { found = c; api.onmessage({ data: { type: "stop" } }); resolve(); }
      else {
        const secs = (Date.now() - t0) / 1000;
        process.stderr.write(`\r  ${BigInt(m.attempts).toLocaleString()} hashes | ` +
          `${Math.round(m.hashesPerSecond).toLocaleString()} H/s | bestBits=${m.bestBits} | ${secs.toFixed(0)}s   `);
      }
    }
    if (m.type === "done" && !found) resolve();
  };
  api.onmessage({ data: { type: "start", chainId: CHAIN_ID, contract: CONTRACT, miner: MINER, startNonce, keep: 8, batchSize } });
});
process.stderr.write("\n");

if (!found) { console.error("no candidate found"); process.exit(1); }

const nonce = BigInt(found.nonce);
const verify = api.schemeHash(CHAIN_ID, CONTRACT, MINER, nonce);
console.log(JSON.stringify({
  nonce: nonce.toString(),
  nonceHex: found.nonce,
  bits: found.bits,
  workerHash: found.hash,
  schemeHash: verify,
  hashMatches: verify.toLowerCase() === found.hash.toLowerCase(),
  elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
}, null, 2));
