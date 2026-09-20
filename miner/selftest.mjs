// miner/selftest.mjs
// Loads the browser worker source and exercises its Keccak-256 / PoW scheme
// logic OUTSIDE a browser using a minimal Worker/self shim (node:vm context +
// postMessage capture). The hash algorithm is used as-is; only the 3 corrupted
// constants in miner-worker.js were repaired (see comments there / E2E_RESULTS.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFile = process.argv[2] || "miner-worker.js";
const workerSrc = readFileSync(join(__dirname, workerFile), "utf8");
console.log(`# selftest loading ${workerFile}\n`);

// --- Minimal worker-hosting shim -------------------------------------------
const inbox = [];
let observer = null;                       // set to observe live progress
const sandbox = {
  postMessage: (msg) => { inbox.push(msg); observer && observer(msg); },
  performance,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
vm.runInContext(workerSrc, sandbox, { filename: workerFile });
const send = (data) => sandbox.onmessage({ data });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

// --- 1. Direct Keccak-256 known vectors ------------------------------------
console.log("=== Direct keccak256() vectors ===");
const VECTORS = [
  ["", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ["The quick brown fox jumps over the lazy dog",
    "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"],
];
for (const [input, expected] of VECTORS) {
  const actual = sandbox.keccak256(new TextEncoder().encode(input));
  check(`keccak256(${JSON.stringify(input)})`, actual.toLowerCase() === expected,
    `\n     expected ${expected}\n     actual   ${actual}`);
}

// --- 2. Worker's own built-in selfTest() -----------------------------------
console.log("\n=== Worker selfTest() (scheme nonce vectors) ===");
inbox.length = 0;
send({ type: "selftest" });
for (const m of inbox) {
  if (m.type === "selftest") {
    console.log(`  ${m.result} ${m.name}\n     expected ${m.expected}\n     actual   ${m.actual}`);
  } else if (m.type === "selftest-summary") {
    check("worker selfTest() summary", m.result === "PASS", `(${m.passed}/${m.total})`);
  }
}

// --- 3. Real PoW search: mine a dummy 12-bit target ------------------------
console.log("\n=== Live PoW search for a dummy 12-bit target ===");
const chainId = 5042002;
const contract = "0x1111111111111111111111111111111111111111";
const miner = "0x2222222222222222222222222222222222222222";
const TARGET_BITS = 12;
let settled = false;
const powResult = await new Promise((resolve) => {
  observer = (msg) => {
    if (settled) return;
    if (msg.type === "progress" && msg.bestBits >= TARGET_BITS) {
      settled = true; send({ type: "stop" });
      resolve({ msg });
    }
  };
  send({ type: "start", chainId, contract, miner, startNonce: 0, keep: 4, batchSize: 8192 });
  setTimeout(() => { if (!settled) { settled = true; send({ type: "stop" }); resolve({ msg: null }); } }, 30000).unref?.();
});
const best = powResult.msg?.best?.[0];
if (best) {
  check(`PoW found ${best.bits}-bit candidate (>= ${TARGET_BITS})`, best.bits >= TARGET_BITS,
    `\n     nonce ${best.nonce}\n     hash  ${best.hash}`);
  const recomputed = sandbox.schemeHash(chainId, contract, miner, BigInt(best.nonce));
  check("mined hash == independently recomputed scheme hash",
    recomputed.toLowerCase() === best.hash.toLowerCase(),
    `\n     mined ${best.hash}\n     again ${recomputed}`);
} else {
  check("PoW search produced a candidate", false);
}

console.log(`\n=== ${failures === 0 ? "ALL SELFTESTS PASSED" : failures + " SELFTEST(S) FAILED"} ===`);
process.exit(failures ? 1 : 0);
