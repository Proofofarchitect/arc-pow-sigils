/**
 * Typed main-thread wrapper around the PoW web worker.
 *
 * The worker itself is served as a static asset from `/miner/miner-worker.js`
 * (a byte-identical copy of the verified `miner/miner-worker.js`). This module
 * mirrors the logic of `miner/miner.js` but adds exact TypeScript types for the
 * *real* worker protocol, which differs from the placeholder contract that used
 * to live in `public/miner/README.md`:
 *
 *   page -> worker
 *     { type:"start", chainId, contract, miner, startNonce?, keep?, batchSize? }
 *     { type:"stop" }
 *     { type:"selftest" }
 *
 *   worker -> page
 *     { type:"started",           startNonce }
 *     { type:"progress",          attempts, hashesPerSecond, bestBits, best, candidates }
 *     { type:"done",              reason, attempts, best }
 *     { type:"error",             message }
 *     { type:"selftest",          result, name, expected, actual }
 *     { type:"selftest-summary",  result, passed, total }
 *
 * NOTE: the worker does NOT know `requiredBits`. It continuously tracks the
 * `keep` best candidates by leading-zero-bit count and streams them in
 * `progress.best` (sorted descending by `bits`). The caller decides when a
 * candidate clears the on-chain threshold and then stops the worker.
 */

/** Path of the worker asset, served from `public/miner/miner-worker.js`. */
export const WORKER_PATH = "/miner/miner-worker.js";

/** Path of the WebGPU worker — same message protocol as WORKER_PATH. */
export const GPU_WORKER_PATH = "/miner/miner-gpu-worker.js";

/** A candidate nonce reported by the worker. */
export type MinerCandidate = {
  /** Nonce as a 0x-prefixed 32-byte hex string. */
  nonce: string;
  /** workFor(miner, nonce) digest as 0x-prefixed 32-byte hex. */
  hash: string;
  /** Leading zero bits of `hash`. */
  bits: number;
};

export type StartOptions = {
  chainId: number | bigint | string;
  contract: string;
  miner: string;
  startNonce?: number | bigint | string;
  keep?: number;
  batchSize?: number;
  /** Current on-chain difficulty (used by the GPU worker for candidate pre-filtering). */
  requiredBits?: number;
};

export type StartedMessage = { type: "started"; startNonce: string };

export type ProgressMessage = {
  type: "progress";
  /** Total attempts as a decimal string — the worker counts in BigInt. */
  attempts: string;
  hashesPerSecond: number;
  bestBits: number;
  /** Best `keep` candidates, sorted by bits descending. */
  best: MinerCandidate[];
  /** Candidates that (re)entered the best list during this batch. */
  candidates: MinerCandidate[];
};

export type DoneMessage = {
  type: "done";
  reason: string;
  attempts: string;
  best: MinerCandidate[];
};

export type WorkerErrorMessage = { type: "error"; message: string };

export type SelfTestMessage = {
  type: "selftest";
  result: "PASS" | "FAIL";
  name: string;
  expected: string;
  actual: string;
};

export type SelfTestSummaryMessage = {
  type: "selftest-summary";
  result: "PASS" | "FAIL";
  passed: number;
  total: number;
};

export class PowMiner {
  readonly worker: Worker;
  running = false;

  onStarted: ((msg: StartedMessage) => void) | null = null;
  onProgress: ((msg: ProgressMessage) => void) | null = null;
  onCandidate: ((candidate: MinerCandidate, msg: ProgressMessage) => void) | null =
    null;
  onDone: ((msg: DoneMessage) => void) | null = null;
  onError: ((msg: WorkerErrorMessage) => void) | null = null;
  onSelfTest: ((msg: SelfTestMessage) => void) | null = null;
  onSelfTestSummary: ((msg: SelfTestSummaryMessage) => void) | null = null;

  constructor(workerUrl: string = WORKER_PATH) {
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (event: MessageEvent) => this.handle(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      this.running = false;
      this.onError?.({ type: "error", message: event.message || "worker crashed" });
    };
  }

  start({
    chainId,
    contract,
    miner,
    startNonce = 0,
    keep = 16,
    batchSize = 4096,
    requiredBits,
  }: StartOptions): void {
    this.worker.postMessage({
      type: "start",
      chainId,
      contract,
      miner,
      startNonce,
      keep,
      batchSize,
      requiredBits,
    });
  }

  stop(): void {
    this.worker.postMessage({ type: "stop" });
  }

  selfTest(): void {
    this.worker.postMessage({ type: "selftest" });
  }

  terminate(): void {
    this.running = false;
    this.worker.terminate();
  }

  private handle(data: unknown): void {
    const msg = data as { type?: string };
    switch (msg.type) {
      case "started":
        this.running = true;
        this.onStarted?.(data as StartedMessage);
        break;
      case "progress": {
        const progress = data as ProgressMessage;
        for (const candidate of progress.candidates ?? []) {
          this.onCandidate?.(candidate, progress);
        }
        this.onProgress?.(progress);
        break;
      }
      case "done":
        this.running = false;
        this.onDone?.(data as DoneMessage);
        break;
      case "error":
        this.running = false;
        this.onError?.(data as WorkerErrorMessage);
        break;
      case "selftest":
        this.onSelfTest?.(data as SelfTestMessage);
        break;
      case "selftest-summary":
        this.onSelfTestSummary?.(data as SelfTestSummaryMessage);
        break;
      default:
        break;
    }
  }
}

/** Human-readable hash rate, e.g. "1.24 MH/s". */
export function formatRate(hashesPerSecond: number): string {
  if (!Number.isFinite(hashesPerSecond)) return "— H/s";
  if (hashesPerSecond >= 1e6) return `${(hashesPerSecond / 1e6).toFixed(2)} MH/s`;
  if (hashesPerSecond >= 1e3) return `${(hashesPerSecond / 1e3).toFixed(2)} kH/s`;
  return `${Math.round(hashesPerSecond)} H/s`;
}

/** Thousands-separated attempt counter from a decimal string. */
export function formatAttempts(attempts: string | bigint): string {
  try {
    return BigInt(attempts).toLocaleString("en-US");
  } catch {
    return String(attempts);
  }
}

/** Result of the page-side WebGPU capability probe (drives the CPU/GPU toggle). */
export type WebGpuSupport = {
  available: boolean;
  name: string | null;
  /** True when the only adapter found is a software renderer (SwiftShader etc.). */
  software: boolean;
};

type GpuAdapterLike = {
  info?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  };
  isFallbackAdapter?: boolean;
};

type GpuLike = {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
  }): Promise<GpuAdapterLike | null>;
};

const SOFTWARE_ADAPTER_RE =
  /swiftshader|llvmpipe|lavapipe|software|basic render|warp/i;

/**
 * Probe WebGPU from the page: adapter availability + a human-readable name for
 * the toggle. Software renderers are reported but not offered (the GPU worker
 * enforces the same policy; the self-test page can opt out with ?sw=1).
 */
export async function detectWebGPU(): Promise<WebGpuSupport> {
  try {
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!gpu) return { available: false, name: null, software: false };

    const adapter =
      (await gpu.requestAdapter({ powerPreference: "high-performance" })) ??
      (await gpu.requestAdapter());
    if (!adapter) return { available: false, name: null, software: false };

    const info = adapter.info;
    const desc = [info?.vendor, info?.architecture, info?.device, info?.description]
      .filter(Boolean)
      .join(" ")
      .trim();
    const software =
      adapter.isFallbackAdapter === true || SOFTWARE_ADAPTER_RE.test(desc);

    return { available: !software, name: desc || null, software };
  } catch {
    return { available: false, name: null, software: false };
  }
}
