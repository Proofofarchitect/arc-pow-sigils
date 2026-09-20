// miner/load-worker.mjs
// Loads miner-worker.js into the MAIN Node realm via `new Function`, injecting a
// tiny Worker/self shim (postMessage + onmessage). This mirrors the browser
// Web Worker contract but avoids the `vm` realm, whose cross-realm call overhead
// made the Keccak permutation ~15x slower (193us vs 13us per permutation).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{file?:string, onMessage?:(msg:any)=>void}} opts
 * @returns the worker's exported internals + its assigned onmessage handler
 */
export function loadWorker({ file = "miner-worker.js", onMessage = () => {} } = {}) {
  const src = readFileSync(join(__dirname, file), "utf8");
  const factory = new Function(
    "postMessage", "onmessage", "performance", "setTimeout", "clearTimeout", "console",
    src + "\nreturn { keccakF, keccak256, schemeHash, startMining, stopMining, selfTest, onmessage };",
  );
  // `onmessage` is passed as a declared parameter so the worker's strict-mode
  // global assignment binds locally; `postMessage` is our capture callback.
  const api = factory(onMessage, undefined, performance, setTimeout, clearTimeout, console);
  return api;
}

export const CONTRACT = "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b"; // PowMintNFTv3_1 v3.2 (Arc testnet)
export const CHAIN_ID = 5042002;
export const MINER = "0x1111111111111111111111111111111111111111";
