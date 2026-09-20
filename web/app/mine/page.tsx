"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseGwei,
  type Address,
} from "viem";
import { arcTestnet, ARC_RPC_URL, explorerUrl } from "@/lib/arc";
import Link from "next/link";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI, ARC_CHAIN_ID } from "@/lib/contract";
import type { Eip1193Provider } from "@/lib/ethereum";
import { formatUsdc, shortAddress } from "@/lib/format";
import { rpcFetch, humanizeRpcError } from "@/lib/rpc";
import { computeWork, leadingZeroBits } from "@/lib/pow";
import {
  disconnectWalletConnect,
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";
import { useWalletRestore } from "@/lib/useWalletRestore";
import {
  PowMiner,
  WORKER_PATH,
  GPU_WORKER_PATH,
  detectWebGPU,
  formatAttempts,
  formatRate,
  type MinerCandidate,
} from "@/lib/miner-client";

const MIN_FEE_GWEI = Number(
  process.env.NEXT_PUBLIC_MIN_MAX_FEE_GWEI ?? "50",
);
// Arc silently drops txs whose maxFeePerGas < 20 gwei. Enforce a real floor and
// in practice send max(floor, 2 * latest baseFee) so the tx is not under-priced.
const FEE_FLOOR_GWEI = Math.max(20, Number.isFinite(MIN_FEE_GWEI) ? MIN_FEE_GWEI : 50);

// WalletConnect is optional: enabled only when the build carries a project id.
const WC_ENABLED = walletConnectEnabled();

// Minimal local ABI fragment (kept out of the shared ABI module on purpose:
// that file is under active edit by the rooms work). `nonceUsed(miner, nonce)`
// is the contract's replay guard — used to skip already-mined candidates.
const NONCE_USED_ABI = [
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Random 64-bit start nonce: a restarted session must never rescan from 0. */
function randomStartNonce(): bigint {
  const words = new Uint32Array(2);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(words);
  } else {
    words[0] = Date.now() >>> 0;
    words[1] = (Math.random() * 0xffffffff) >>> 0;
  }
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

type Stats = {
  price: bigint;
  totalMinted: bigint;
  maxSupply: bigint;
  freeClaims: bigint;
  claimsLeft: bigint;
  wave: bigint;
  requiredBits: number;
  paused: boolean;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export default function MinePage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Mine and keep going": every accepted nonce opens the wallet prompt by
  // itself; after a confirmed mint the grinder restarts automatically.
  // `userStoppedRef` respects an explicit Stop click, `autoMintedRef` makes
  // sure one found nonce opens the wallet exactly once.
  const [resumeTick, setResumeTick] = useState(0);
  const userStoppedRef = useRef(false);
  const engineRef = useRef<"cpu" | "gpu">("cpu");
  const autoMintedRef = useRef<string | null>(null);

  // PoW-boost from the staking vault (core v3.1 only). Read-only indicator;
  // silently stays "—" when the core has no hook or the RPC hiccups.
  const [discountBits, setDiscountBits] = useState<number | null>(null);

  const [workerAvailable, setWorkerAvailable] = useState<boolean | null>(null);
  const [gpuWorkerAvailable, setGpuWorkerAvailable] = useState<boolean | null>(
    null,
  );
  // Where to compute: the JS worker (processor cores) or the WebGPU worker
  // (graphics card). The GPU option only appears when an adapter is available.
  const [engine, setEngine] = useState<"cpu" | "gpu">("cpu");
  const [gpuSupport, setGpuSupport] = useState<{
    checked: boolean;
    available: boolean;
    name: string | null;
  }>({ checked: false, available: false, name: null });
  const [mining, setMining] = useState(false);
  const [attempts, setAttempts] = useState<string>("0");
  const [hashesPerSecond, setHashesPerSecond] = useState(0);
  const [bestBits, setBestBits] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [foundNonce, setFoundNonce] = useState<bigint | null>(null);
  const [manualNonce, setManualNonce] = useState("");

  const minerRef = useRef<PowMiner | null>(null);
  const startedAtRef = useRef<number>(0);
  // Last on-chain difficulty we read successfully. Keeps the GPU→CPU fallback
  // and auto-resume starting immediately even if the stats state lags.
  const lastBitsRef = useRef<number | null>(null);
  // Pending auto-retry timer used by "read difficulty, then start".
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `Refresh` cooldown (seconds). A single tap starts the countdown so an
  // impatient user cannot hammer the RPC into rate-limiting.
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  // Detected after mount (not during render) so the SSR HTML and the first
  // client render agree — otherwise a browser with an injected wallet triggers
  // a hydration mismatch.
  const [hasInjected, setHasInjected] = useState(false);
  const [wcProvider, setWcProvider] = useState<Eip1193Provider | null>(null);

  // Restore an already-authorized wallet on load (no popups) so the page never
  // asks to connect again while the header already shows the account.
  useWalletRestore(
    (provider, restoredAddress, restoredChain) => {
      if (provider) setWcProvider(provider);
      setAddress(restoredAddress);
      setChainId(restoredChain);
    },
    {
      onAccountsChanged: (next) => {
        setAddress(next);
        if (!next) setWcProvider(null);
      },
      onChainChanged: (next) => setChainId(next),
      onDisconnect: () => {
        setWcProvider(null);
        setAddress(null);
        setChainId(null);
      },
    },
  );

  useEffect(() => {
    setHasInjected(!!window.ethereum);
  }, []);

  // Live per-wallet difficulty numbers (required bits + staking boost),
  // re-read silently around the loud `refreshStats` path.
  //
  // Why: the worker grinds against a SNAPSHOT of `requiredBits` taken when the
  // session starts, while the page filter compares candidates to the CURRENT
  // state value. Without a periodic re-read, a target that DECREASES on-chain
  // (streak cooldown expired, staking boost applied, regulator loosened) is
  // never pulled in — the session keeps grinding at a stale, harder bar until
  // a manual Refresh or a page reload (the "difficulty never cools down /
  // boost only works after restart" report). Poll pulls the value both ways.
  const pollDifficulty = useCallback(async (miner: Address) => {
    try {
      const [need, boost] = await Promise.all([
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "requiredBits",
          args: [miner],
        }),
        // v3 core has no staking hook: keep the indicator blank, not the poll dead.
        publicClient
          .readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "stakingDiscountBits",
            args: [miner],
          })
          .then((v) => Number(v))
          .catch(() => null),
      ]);
      const bits = Number(need);
      lastBitsRef.current = bits;
      setStats((prev) =>
        prev && prev.requiredBits !== bits
          ? { ...prev, requiredBits: bits }
          : prev,
      );
      setDiscountBits(boost);
    } catch {
      // Silent by design — the manual Refresh keeps the loud error handling.
    }
  }, []);

  // Initial read on (re)connect.
  useEffect(() => {
    if (!address) {
      setDiscountBits(null);
      return;
    }
    void pollDifficulty(address);
  }, [address, pollDifficulty]);

  // Periodic keeper: every 15 s and whenever the tab becomes visible again.
  // Cheap (two view calls) and idempotent — state moves only on real changes.
  useEffect(() => {
    if (!address) return;
    const kick = () => void pollDifficulty(address);
    const id = setInterval(kick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [address, pollDifficulty]);

  const refreshStats = useCallback(
    async (miner: Address | null): Promise<Stats | null> => {
      try {
        const [
          price,
          totalMinted,
          maxSupply,
          freeClaims,
          claimsLeft,
          wave,
          paused,
        ] = await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "currentPrice",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "totalMinted",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "maxSupply",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "freeClaims",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "claimsLeft",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "currentWave",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "mintPaused",
          }),
        ]);

        const requiredBits = miner
          ? Number(
              await publicClient.readContract({
                address: CONTRACT_ADDRESS,
                abi: POW_MINT_NFT_ABI,
                functionName: "requiredBits",
                args: [miner],
              }),
            )
          : 0;

        const next: Stats = {
          price,
          totalMinted,
          maxSupply,
          freeClaims,
          claimsLeft,
          wave,
          requiredBits,
          paused,
        };
        setStats(next);
        // Feed the freshest value to the resume/fallback spawn paths at once
        // (they start from `lastBitsRef` without waiting for a re-render).
        if (miner && requiredBits > 0) lastBitsRef.current = requiredBits;
        return next;
      } catch (e) {
        setError(
          humanizeRpcError(
            e instanceof Error ? e.message : "Failed to read contract",
          ),
        );
        return null;
      }
    },
    [],
  );

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError(
        "No injected wallet found. Install a browser wallet or use WalletConnect.",
      );
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const idHex = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      setAddress(accounts[0] ?? null);
      setChainId(Number.parseInt(idHex, 16));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection rejected");
    }
  }, []);

  /** Pair a mobile wallet through WalletConnect (QR modal from the SDK). */
  const connectWalletConnect = useCallback(async () => {
    setError(null);
    if (!WC_ENABLED) {
      setError(
        "WalletConnect is not configured in this build (missing project id).",
      );
      return;
    }
    setStatus("Opening WalletConnect…");
    try {
      const provider = await getWalletConnectProvider();
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const idHex = (await provider.request({
        method: "eth_chainId",
      })) as string;

      // WalletConnect sessions are revocable from the wallet side: keep the UI
      // in sync with the remote session.
      provider.on?.("accountsChanged", (accountsChanged) => {
        const list = accountsChanged as string[];
        setAddress((list?.[0] as Address | undefined) ?? null);
        if (!list?.length) setWcProvider(null);
      });
      provider.on?.("chainChanged", (nextChainId) => {
        setChainId(Number.parseInt(String(nextChainId), 16));
      });
      provider.on?.("disconnect", () => {
        setWcProvider(null);
        setAddress(null);
        setChainId(null);
      });

      setWcProvider(provider);
      setAddress(accounts[0] ?? null);
      setChainId(Number.parseInt(idHex, 16));
      setStatus("Connected via WalletConnect.");
    } catch (e) {
      setStatus("");
      setError(
        e instanceof Error ? e.message : "WalletConnect connection failed",
      );
    }
  }, []);

  const disconnectWc = useCallback(async () => {
    await disconnectWalletConnect();
    setWcProvider(null);
    setAddress(null);
    setChainId(null);
    setStatus("WalletConnect session closed.");
  }, []);

  const switchToArc = useCallback(async () => {
    const provider = wcProvider ?? window.ethereum;
    if (!provider) return;
    setError(null);
    const hexId = `0x${ARC_CHAIN_ID.toString(16)}`;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexId }],
      });
    } catch {
      // 4902 = unknown chain; try to add it.
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexId,
              chainName: arcTestnet.name,
              nativeCurrency: arcTestnet.nativeCurrency,
              rpcUrls: [ARC_RPC_URL],
              blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
            },
          ],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add Arc network");
      }
    }
    const idHex = (await provider.request({
      method: "eth_chainId",
    })) as string;
    setChainId(Number.parseInt(idHex, 16));
  }, [wcProvider]);

  useEffect(() => {
    refreshStats(address);
  }, [address, refreshStats]);

  // Probe the worker asset so the UI can explain a 404 instead of crashing.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const res = await fetch(WORKER_PATH, { method: "HEAD", cache: "no-store" });
        if (!cancelled) setWorkerAvailable(res.ok);
      } catch {
        if (!cancelled) setWorkerAvailable(false);
      }
    }
    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  // WebGPU capability probe — adapter name for the toggle; software renderers
  // are detected but not offered for mining (same policy as the GPU worker).
  useEffect(() => {
    let cancelled = false;
    detectWebGPU().then((support) => {
      if (cancelled) return;
      setGpuSupport({
        checked: true,
        available: support.available,
        name: support.name,
      });
      try {
        const saved = window.localStorage.getItem("poa:miner-engine");
        if (saved === "gpu" && support.available) setEngine("gpu");
      } catch {
        // localStorage can be blocked; the CPU default stays.
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe the GPU worker asset too, so the toggle can explain a 404.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const res = await fetch(GPU_WORKER_PATH, { method: "HEAD", cache: "no-store" });
        if (!cancelled) setGpuWorkerAvailable(res.ok);
      } catch {
        if (!cancelled) setGpuWorkerAvailable(false);
      }
    }
    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectEngine = useCallback((next: "cpu" | "gpu") => {
    setEngine(next);
    try {
      window.localStorage.setItem("poa:miner-engine", next);
    } catch {
      // localStorage can be blocked; the in-memory choice still applies.
    }
  }, []);

  // Live elapsed-time ticker while mining.
  useEffect(() => {
    if (!mining) return;
    const handle = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(handle);
  }, [mining]);

  // Tear the worker down on unmount.
  useEffect(() => {
    return () => {
      minerRef.current?.terminate();
      minerRef.current = null;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const teardownWorker = useCallback(() => {
    minerRef.current?.terminate();
    minerRef.current = null;
    setMining(false);
  }, []);

  const requiredBits = stats?.requiredBits ?? null;
  const activeWorkerPath = engine === "gpu" ? GPU_WORKER_PATH : WORKER_PATH;
  const activeWorkerAvailable =
    engine === "gpu" ? gpuWorkerAvailable : workerAvailable;

  /**
   * Inspect the worker's best list, verify the top candidate locally, then
   * gate it against the LIVE contract (current difficulty + replay guard)
   * before surfacing it for minting. A candidate that fails the gate is
   * skipped and the worker keeps grinding.
   */
  // Candidates already mined by this wallet — skipped for the rest of the session.
  const rejectedNoncesRef = useRef<Set<string>>(new Set());
  // One on-chain acceptance check at a time.
  const acceptingRef = useRef(false);

  const consumeCandidates = useCallback(
    (best: MinerCandidate[]) => {
      if (acceptingRef.current) return;
      const needed = requiredBits;
      if (needed === null || needed <= 0) return;
      // `best` is sorted by bits descending; pick the strongest that clears.
      const winner = best.find(
        (c) => c.bits >= needed && !rejectedNoncesRef.current.has(c.nonce),
      );
      if (!winner || !address) return;

      let nonce: bigint;
      try {
        nonce = BigInt(winner.nonce);
      } catch {
        return;
      }

      // Never trust the worker blind — re-derive workFor() locally.
      const work = computeWork(address, nonce);
      const bits = leadingZeroBits(work);
      if (bits < needed) return; // worker artifact/bug; keep grinding

      // On-chain gate: fresh difficulty + nonceUsed(). Without this, a
      // restarted session that rescans the same space can re-found and
      // re-submit an already-mined nonce — the contract reverts NonceUsed()
      // and the wallet burns gas for nothing.
      acceptingRef.current = true;
      void (async () => {
        try {
          const [freshNeed, used] = await Promise.all([
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: POW_MINT_NFT_ABI,
              functionName: "requiredBits",
              args: [address],
            }),
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: NONCE_USED_ABI,
              functionName: "nonceUsed",
              args: [address, nonce],
            }),
          ]);

          if (used) {
            rejectedNoncesRef.current.add(winner.nonce);
            return;
          }

          const needNow = Number(freshNeed);
          if (bits < needNow) {
            if (needNow !== needed) await refreshStats(address);
            return;
          }

          setFoundNonce(nonce);
          setBestBits((prev) => (prev === null ? bits : Math.max(prev, bits)));
          setStatus(
            `Found nonce ${nonce} (${bits} bits ≥ ${needNow}). Ready to mint.`,
          );
          teardownWorker();
        } catch {
          // RPC hiccup — retry on the next progress tick.
        } finally {
          acceptingRef.current = false;
        }
      })();
    },
    [address, requiredBits, teardownWorker, refreshStats],
  );

  /** Spawn the miner for one engine; a dying GPU path falls back to CPU. */
  const spawnMinerRef = useRef<
    (choice: "cpu" | "gpu", bitsOverride?: number) => void
  >(() => {});
  const spawnMiner = useCallback(
    (choice: "cpu" | "gpu", bitsOverride?: number) => {
      const workerPath = choice === "gpu" ? GPU_WORKER_PATH : WORKER_PATH;
      const workerOk = choice === "gpu" ? gpuWorkerAvailable : workerAvailable;

      setError(null);
      setFoundNonce(null);
      setBestBits(null);
      setAttempts("0");
      setHashesPerSecond(0);

      if (!address) {
        setError("Connect your wallet first.");
        return;
      }

      const bits = bitsOverride ?? requiredBits;
      if (bits === null) {
        // No on-chain difficulty yet: the stats load may have been rate-limited
        // (dead-end fix). Instead of refusing to start, read it now and start
        // automatically once known. The retry path is not recursive: the resumed
        // spawnMiner call carries bitsOverride, so it takes the normal branch.
        setStatus("Reading on-chain difficulty…");
        const read = () => {
          void refreshStats(address).then((s) => {
            if (s) {
              lastBitsRef.current = s.requiredBits;
              spawnMinerRef.current(choice, s.requiredBits);
              return;
            }
            setError(
              "Could not read on-chain difficulty (RPC busy) — retrying…",
            );
            retryTimerRef.current = setTimeout(read, 3000);
          });
        };
        read();
        return;
      }
      lastBitsRef.current = bits;

      if (workerOk === false) {
        setError(`Miner worker not found at ${workerPath}.`);
        return;
      }

      let miner: PowMiner;
      try {
        miner = new PowMiner(workerPath);
      } catch {
        if (choice === "gpu") setGpuWorkerAvailable(false);
        else setWorkerAvailable(false);
        setError("Could not spawn the miner worker (blocked or CSP). See console.");
        return;
      }
      minerRef.current = miner;

      miner.onStarted = () => {
        startedAtRef.current = Date.now();
        setMining(true);
        setStatus(
          choice === "gpu" ? "Grinding nonce on GPU…" : "Grinding nonce…",
        );
      };
      miner.onProgress = (msg) => {
        setAttempts(msg.attempts);
        setHashesPerSecond(msg.hashesPerSecond);
        setBestBits(msg.bestBits);
        consumeCandidates(msg.best);
      };
      miner.onDone = (msg) => {
        setMining(false);
        setAttempts(msg.attempts);
        if (msg.best?.length) consumeCandidates(msg.best);
      };
      miner.onError = (msg) => {
        setMining(false);
        minerRef.current = null;
        if (choice === "gpu") {
          // WebGPU failed (device lost, driver hiccup, no adapter at run time):
          // flip the toggle and restart on the proven CPU worker, reusing the
          // difficulty we already resolved.
          selectEngine("cpu");
          spawnMinerRef.current("cpu", lastBitsRef.current ?? undefined);
          setError(
            `GPU miner stopped (${msg.message}) — switched to CPU mining.`,
          );
        } else {
          setWorkerAvailable(false);
          setError(msg.message || `Miner worker failed (missing ${workerPath}?).`);
        }
      };

      miner.start({
        chainId: ARC_CHAIN_ID,
        contract: CONTRACT_ADDRESS,
        miner: address,
        keep: 16,
        batchSize: 4096,
        requiredBits: bits,
        // Random start: never rescan the space from zero after a restart
        // (that re-finds this wallet's already-mined nonces).
        startNonce: randomStartNonce(),
      });
    },
    [
      address,
      requiredBits,
      workerAvailable,
      gpuWorkerAvailable,
      consumeCandidates,
      selectEngine,
      refreshStats,
    ],
  );

  useEffect(() => {
    spawnMinerRef.current = spawnMiner;
  }, [spawnMiner]);

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const startMining = useCallback(() => {
    userStoppedRef.current = false;
    spawnMiner(engine);
  }, [spawnMiner, engine]);

  const stopMining = useCallback(() => {
    userStoppedRef.current = true;
    teardownWorker();
    setStatus("Stopped.");
  }, [teardownWorker]);

  /**
   * Manual `Refresh`: guarded by a 4s cooldown (and the busy flag) so a rapid
   * tap cannot spam the RPC into rate-limiting.
   */
  const manualRefresh = useCallback(() => {
    if (refreshCooldown > 0 || busy) return;
    void refreshStats(address);
    setRefreshCooldown(4);
  }, [refreshCooldown, busy, refreshStats, address]);

  // Tick the Refresh cooldown down once per second.
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const handle = setInterval(() => {
      setRefreshCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(handle);
  }, [refreshCooldown]);

  // ---------------------------------------------------------------------
  // Worker/UI found nonce -> on-chain mint.
  // ---------------------------------------------------------------------
  const mint = useCallback(
    async (nonce: bigint) => {
      setError(null);
      setTxHash(null);
      const provider = wcProvider ?? window.ethereum;
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return;
      }
      setBusy(true);
      setStatus(`Sending mint(${nonce})…`);

      try {
        // Re-read the exact due right before sending so msg.value == currentMintDue().due
        // (base wave price + the 2.5% mint fee; v3.2 core).
        const [freshDue] = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "currentMintDue",
        });

        // max(floor, 2 * latest baseFee) — Arc drops txs under 20 gwei.
        let maxFeePerGas = parseGwei(String(FEE_FLOOR_GWEI));
        try {
          const block = await publicClient.getBlock({ blockTag: "latest" });
          const baseFee = block.baseFeePerGas ?? 0n;
          const twice = baseFee * 2n;
          if (twice > maxFeePerGas) maxFeePerGas = twice;
        } catch {
          // keep the floor
        }
        const maxPriorityFeePerGas = maxFeePerGas / 2n;

        const walletClient = createWalletClient({
          chain: arcTestnet,
          transport: custom(provider),
        });

        const hash = await walletClient.writeContract({
          account: address,
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "mint",
          args: [nonce],
          value: freshDue, // must equal currentMintDue().due exactly (price + 2.5% fee)
          maxFeePerGas,
          maxPriorityFeePerGas,
        });

        setTxHash(hash);
        setFoundNonce(null);
        setStatus(`Mint submitted (nonce ${nonce}). Waiting for receipt…`);

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 120_000,
        });
        if (receipt.status === "success") {
          setStatus(`Mint confirmed in block ${receipt.blockNumber} (nonce ${nonce}).`);
        } else {
          setError("Mint transaction reverted on-chain.");
          setStatus("");
        }
        await refreshStats(address);
        // Mine-and-keep-going: restart the grinder for the next nonce unless
        // the user explicitly pressed Stop.
        if (!userStoppedRef.current) setResumeTick((t) => t + 1);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Mint failed";
        setError(
          /user rejected|denied|User rejected/i.test(message)
            ? "Transaction rejected in wallet."
            : message,
        );
        setStatus("");
      } finally {
        setBusy(false);
      }
    },
    [address, refreshStats, wcProvider],
  );

  // Auto-mint: a verified, gate-passed nonce opens the wallet prompt by
  // itself (one popup per nonce). The wallet confirmation is still required —
  // that is the single step a page cannot skip for a self-custody wallet.
  useEffect(() => {
    if (foundNonce === null) return;
    const key = foundNonce.toString();
    if (autoMintedRef.current === key) return;
    if (busy || !address) return;
    autoMintedRef.current = key;
    void mint(foundNonce);
  }, [foundNonce, busy, address, mint]);

  // Auto-resume: after a confirmed mint (resumeTick bump) start the next
  // grinding session, unless the user pressed Stop.
  useEffect(() => {
    if (resumeTick === 0) return;
    if (userStoppedRef.current) return;
    if (!address) return;
    spawnMinerRef.current(engineRef.current, lastBitsRef.current ?? undefined);
  }, [resumeTick, address]);

  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;
  const activeNonce = useMemo(
    () => foundNonce ?? (/^\d+$/.test(manualNonce) ? BigInt(manualNonce) : null),
    [foundNonce, manualNonce],
  );

  const miningStatusText = mining
    ? `Grinding${engine === "gpu" ? " on GPU" : ""}… ${formatAttempts(attempts)} attempts`
    : activeWorkerAvailable === null
      ? "checking worker…"
      : activeWorkerAvailable
        ? engine === "gpu"
          ? "GPU worker ready"
          : "worker ready"
        : "worker unavailable";

  return (
    <>
      <div className="view-divider">
        Mining / Wave {stats ? stats.wave.toString() : "…"} — browser
        proof-of-work
      </div>
      <section className="console">
        <div className="container">
          <span className="console-kicker">Mining console</span>
          <h1>Mine a Proof of Architect</h1>
          <p className="muted">
            Grind a nonce whose <span className="mono">work</span> hash has
            enough leading zero bits for your address, then send{" "}
            <span className="mono">mint(nonce)</span>. Gas is paid in USDC.
          </p>

          {!hasInjected && (
            <div className="banner warn">
              No injected wallet detected (
              <span className="mono">window.ethereum</span>).{" "}
              {WC_ENABLED
                ? "Use WalletConnect (QR) below to pair a mobile wallet, or install a browser wallet."
                : "Install a browser wallet to connect, mine and mint."}
            </div>
          )}

          <div className="mine-shell">
            <div className="wallet-row">
              <div className="wallet-cell">
                <span className="k">Wallet</span>
                <span className="v">
                  {address ? shortAddress(address) : "not connected"}
                </span>
              </div>
              <div className="wallet-cell">
                <span className="k">Chain</span>
                <span className="v">
                  {chainId ?? "—"}
                  {wrongChain ? " (wrong)" : ""}
                </span>
              </div>
              <div className="wallet-cell">
                <span className="k">Contract</span>
                <span className="v">{CONTRACT_ADDRESS}</span>
              </div>
              <div className="wallet-cell">
                <span className="k">Price (+2.5% fee)</span>
                <span className="v">
                  {stats
                    ? stats.price === 0n
                      ? "FREE"
                      : `${formatUsdc(stats.price + stats.price / 40n)} USDC`
                    : "…"}
                </span>
              </div>
            </div>

            <div className="mine-main">
              <div className="field" style={{ marginTop: 0 }}>
                {!address ? (
                  <>
                    <button
                      className={hasInjected ? "primary" : "ghost"}
                      onClick={connect}
                      title={
                        hasInjected
                          ? undefined
                          : "No browser wallet detected — click for details, or use WalletConnect"
                      }
                    >
                      Connect wallet
                    </button>
                    <button
                      className={hasInjected ? "ghost" : "primary"}
                      onClick={connectWalletConnect}
                      disabled={!WC_ENABLED}
                      title={
                        WC_ENABLED
                          ? "Pair a mobile wallet by QR (WalletConnect)"
                          : "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable WalletConnect"
                      }
                    >
                      WalletConnect (QR)
                    </button>
                  </>
                ) : wrongChain ? (
                  <button className="primary" onClick={switchToArc}>
                    Switch to Arc
                  </button>
                ) : (
                  <>
                    <button
                      className="ghost"
                      onClick={manualRefresh}
                      disabled={refreshCooldown > 0}
                    >
                      {refreshCooldown > 0
                        ? `Refresh (${refreshCooldown}s)`
                        : "Refresh"}
                    </button>
                    {wcProvider && (
                      <button className="ghost" onClick={disconnectWc}>
                        Disconnect
                      </button>
                    )}
                  </>
                )}
              </div>

              {wrongChain && (
                <div className="banner warn">
                  Wrong network: connected to chain {chainId}. Arc is{" "}
                  {ARC_CHAIN_ID}.{" "}
                  <button className="link-btn" onClick={switchToArc}>
                    switch/add chain
                  </button>
                </div>
              )}

              <div className="panel">
                <h2>Difficulty &amp; economy</h2>
                <div className="stat-grid">
                  <div className="stat">
                    <div className="label">Your required bits</div>
                    <div className="value">
                      {address ? (requiredBits ?? "…") : "—"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="label">Your PoW boost</div>
                    <div className="value">
                      {!address || discountBits === null
                        ? "—"
                        : `${discountBits} bits`}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="label">Price at mint (+2.5% fee)</div>
                    <div className="value">
                      {stats
                        ? stats.price === 0n
                          ? "FREE"
                          : `${formatUsdc(stats.price + stats.price / 40n)}`
                        : "…"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="label">Minted</div>
                    <div className="value">
                      {stats ? `${stats.totalMinted} / ${stats.maxSupply}` : "…"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="label">Wave</div>
                    <div className="value">{stats?.wave.toString() ?? "…"}</div>
                  </div>
                  <div className="stat">
                    <div className="label">Claims left</div>
                    <div className="value">
                      {stats
                        ? `${stats.claimsLeft.toString()} / ${stats.freeClaims.toString()}`
                        : "…"}
                    </div>
                  </div>
                </div>
                <p className="muted small" style={{ marginTop: 10 }}>
                  Have a free claim code?{" "}
                  <Link href="/claim">Redeem it on the claim page →</Link>
                </p>
                <p className="muted small" style={{ marginTop: 10 }}>
                  Difficulty rises +2 bits per wave and +2 per quick consecutive
                  mint; the streak resets after a pause (60 s × wave without a
                  mint). Your staking boost (up to 6 bits) offsets those penalty
                  bits and can&rsquo;t push the target below the base floor — at
                  wave 1 a calm wallet still mines at base bits. Both values
                  re-read automatically; the running grinder always compares
                  candidates against the live target.
                </p>
                {stats?.paused && (
                  <div className="banner warn">Minting is currently paused.</div>
                )}
              </div>

      <div className="panel">
        <h2>Proof-of-work</h2>
        {activeWorkerAvailable === false && (
          <div className="banner warn">
            Miner worker not found at <span className="mono">{activeWorkerPath}</span>.
            Ensure <span className="mono">public/miner/</span> is served. You can
            still mint manually with a nonce produced elsewhere.
          </div>
        )}

        <div className="chip-row" role="group" aria-label="Where to compute">
          <button
            type="button"
            className={engine === "cpu" ? "chip active" : "chip"}
            onClick={() => selectEngine("cpu")}
            title="Processor cores of this machine"
          >
            CPU — cores
          </button>
          <button
            type="button"
            className={engine === "gpu" ? "chip active" : "chip"}
            onClick={() => selectEngine("gpu")}
            disabled={!gpuSupport.available}
            title={
              gpuSupport.available
                ? `WebGPU — dozens of times faster than cores${
                    gpuSupport.name ? ` (${gpuSupport.name})` : ""
                  }`
                : gpuSupport.checked
                  ? "WebGPU is not available in this browser"
                  : "Checking WebGPU…"
            }
          >
            GPU — WebGPU
            {gpuSupport.available && gpuSupport.name
              ? ` (${gpuSupport.name})`
              : ""}
          </button>
        </div>
        <div className="chip-row" role="group" aria-label="Mining rigs">
          <a
            className="chip"
            href="https://proofofarchitect.gitbook.io/proof-of-architect/mining/proof-of-work-mining"
            target="_blank"
            rel="noopener noreferrer"
            title="External GPU (CUDA) miner — see the mining docs"
          >
            GPU (CUDA) — docs
          </a>
          <span
            className="chip"
            aria-disabled="true"
            title="Proof of space ships with Season 2"
          >
            HDD (proof of space) — Season 2
          </span>
        </div>
        {engine === "gpu" && (
          <p className="muted small" style={{ marginTop: 6 }}>
            WebGPU mining keeps your graphics card busy while this tab stays
            open — everything stays local, nothing is sent anywhere. On laptops,
            keep the machine plugged in.
          </p>
        )}

        <div className="field">
          {!mining ? (
            <button
              className="primary"
              onClick={startMining}
              disabled={!address || wrongChain || activeWorkerAvailable !== true}
            >
              Start mining
            </button>
          ) : (
            <button onClick={stopMining}>Stop</button>
          )}
          <span className="muted small">{miningStatusText}</span>
        </div>
        {!mining && !address && (
          <p className="muted small" style={{ marginTop: 6 }}>
            Connect your wallet to enable mining.
          </p>
        )}
        {!mining && address && wrongChain && (
          <p className="muted small" style={{ marginTop: 6 }}>
            Switch to Arc to enable mining.
          </p>
        )}

        <div className="stat-grid" style={{ marginTop: 14 }}>
          <div className="stat">
            <div className="label">Hashes</div>
            <div className="value">{formatAttempts(attempts)}</div>
          </div>
          <div className="stat">
            <div className="label">Rate</div>
            <div className="value">{formatRate(hashesPerSecond)}</div>
          </div>
          <div className="stat">
            <div className="label">Elapsed</div>
            <div className="value">{mining ? formatElapsed(elapsedMs) : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Best bits</div>
            <div className="value">
              {bestBits === null ? "—" : `${bestBits} / ${requiredBits ?? "?"}`}
            </div>
          </div>
        </div>

        {foundNonce !== null && (
          <div className="banner ok" style={{ marginTop: 14 }}>
            Valid nonce found: <span className="mono">{foundNonce.toString()}</span>{" "}
            <span className="pill ok">worker nonce verified locally</span>
          </div>
        )}

        <div className="field">
          <label className="muted small" htmlFor="manual-nonce">
            Manual nonce
          </label>
          <input
            id="manual-nonce"
            type="text"
            placeholder="e.g. 4242"
            value={manualNonce}
            onChange={(e) => setManualNonce(e.target.value.trim())}
          />
        </div>

        <div className="field">
          <button
            className="primary"
            onClick={() => activeNonce !== null && mint(activeNonce)}
            disabled={activeNonce === null || busy || !address || wrongChain}
          >
            {busy ? "Minting…" : activeNonce !== null ? `Mint (nonce ${activeNonce})` : "Mint"}
          </button>
          {foundNonce !== null && <span className="pill ok">ready</span>}
        </div>

        {status && !error && <div className="banner ok">{status}</div>}
        {error && <div className="banner error">{error}</div>}
        {txHash && (
          <div className="banner">
            tx:{" "}
            <a
              href={explorerUrl(`tx/${txHash}`)}
              target="_blank"
              rel="noreferrer"
              className="mono"
            >
              {txHash}
            </a>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 12 }}>
          Fee floor {FEE_FLOOR_GWEI} gwei; the tx is sent with{" "}
          <span className="mono">maxFeePerGas = max({FEE_FLOOR_GWEI} gwei, 2×baseFee)</span>{" "}
          because Arc drops txs below 20 gwei. The exact amount is re-read right
          before sending so <span className="mono">msg.value</span> equals{" "}
          <span className="mono">currentMintDue()</span> exactly (base wave price
          + a 2.5% mint fee).
        </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Staged payload for the Twelve Rooms (see hunt spec §2) —
          visible via view-source / curl only. */}
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html:
            "<!-- the first stone is spoken here: write DOORWAY exactly (one word, uppercase), hash it with keccak-256, keep the first six hex characters. -->",
        }}
      />
    </>
  );
}
