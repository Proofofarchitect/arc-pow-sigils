// smoke.mjs — minimal MCP stdio client for arc-pow-sigils-mcp.
//
// Spawns `node dist/index.js`, performs initialize + tools/list, then calls
// `collection_stats` and `required_bits` against real on-chain data. Exits
// nonzero on any failure. MCP stdio uses newline-delimited JSON-RPC frames.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "dist", "index.js");
const MINER = "0x1111111111111111111111111111111111111111";

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let nextId = 1;
const pending = new Map();
let buf = "";
const stderrChunks = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[client] non-JSON stdout line:", line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => stderrChunks.push(d));

function send(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
    child.stdin.write(JSON.stringify(frame) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function parseText(result) {
  const block = result?.content?.find((c) => c.type === "text");
  if (!block) throw new Error("no text content block in result");
  return JSON.parse(block.text);
}

function fail(msg) {
  console.error("\n[SMOKE] FAIL:", msg);
  try {
    child.kill("SIGKILL");
  } catch {}
  process.exit(1);
}

async function main() {
  // 1) initialize
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "arc-pow-sigils-smoke", version: "0.1.0" },
  });
  if (init.error) return fail("initialize error: " + JSON.stringify(init.error));
  console.log("== initialize ==");
  console.log(JSON.stringify(init.result, null, 2));

  notify("notifications/initialized", {});

  // 2) tools/list
  const list = await send("tools/list", {});
  if (list.error) return fail("tools/list error: " + JSON.stringify(list.error));
  const tools = list.result?.tools ?? [];
  console.log("\n== tools/list ==");
  console.log("tools:", tools.map((t) => t.name).join(", "));
  const expected = [
    "collection_stats",
    "get_token",
    "required_bits",
    "verify_nonce",
    "price_info",
  ];
  for (const name of expected) {
    if (!tools.some((t) => t.name === name)) fail(`missing tool: ${name}`);
  }

  // 3) collection_stats
  const statsMsg = await send("tools/call", {
    name: "collection_stats",
    arguments: {},
  });
  if (statsMsg.error)
    return fail("collection_stats error: " + JSON.stringify(statsMsg.error));
  const stats = parseText(statsMsg.result);
  console.log("\n== collection_stats ==");
  console.log(JSON.stringify(stats, null, 2));
  if (typeof stats.totalMinted !== "number")
    return fail("collection_stats: totalMinted is not a number");
  if (stats.totalMinted < 1)
    return fail(`collection_stats: expected totalMinted >= 1, got ${stats.totalMinted}`);
  if (typeof stats.claimsLeft !== "number" || typeof stats.currentWave !== "number")
    return fail("collection_stats: missing v3 fields (claimsLeft/currentWave)");

  // 4) required_bits
  const bitsMsg = await send("tools/call", {
    name: "required_bits",
    arguments: { miner: MINER },
  });
  if (bitsMsg.error)
    return fail("required_bits error: " + JSON.stringify(bitsMsg.error));
  const bits = parseText(bitsMsg.result);
  console.log("\n== required_bits ==");
  console.log(JSON.stringify(bits, null, 2));
  if (typeof bits.bits !== "number")
    return fail("required_bits: bits is not a number");

  console.log("\n[SMOKE] PASS");
  child.stdin.end();
  setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {}
    process.exit(0);
  }, 100);
}

main().catch((err) => {
  if (stderrChunks.length) console.error("[server stderr]\n" + stderrChunks.join(""));
  fail(err instanceof Error ? err.message : String(err));
});
