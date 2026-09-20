// miner/crosscheck.mjs
// Computes the PoW preimage hash with the extracted worker code for a given
// nonce and compares it to an expected value (e.g. fetched from seedOf(id)).
//   node miner/crosscheck.mjs <nonce> [expectedHash]
import { loadWorker, CHAIN_ID, CONTRACT, MINER } from "./load-worker.mjs";

const api = loadWorker();
const nonce = BigInt(process.argv[2] ?? "403415");
const expected = process.argv[3];

const hash = api.schemeHash(CHAIN_ID, CONTRACT, MINER, nonce);
console.log(`chainId  ${CHAIN_ID}`);
console.log(`contract ${CONTRACT}`);
console.log(`miner    ${MINER}`);
console.log(`nonce    ${nonce}`);
console.log(`schemeHash = ${hash}`);
if (expected) {
  const ok = hash.toLowerCase() === expected.toLowerCase();
  console.log(`expected   = ${expected}`);
  console.log(ok ? "MATCH" : "MISMATCH");
  process.exit(ok ? 0 : 1);
}
