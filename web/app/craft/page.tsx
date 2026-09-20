"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEventLogs,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, ARC_RPC_URL, explorerUrl } from "@/lib/arc";
import {
  CONTRACT_ADDRESS,
  POW_MINT_NFT_ABI,
  ARC_CHAIN_ID,
} from "@/lib/contract";
import type { Eip1193Provider } from "@/lib/ethereum";
import { formatUsdc, shortAddress } from "@/lib/format";
import {
  disconnectWalletConnect,
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";
import { useWalletRestore } from "@/lib/useWalletRestore";
import { ERC721_APPROVAL_ABI } from "@/lib/staking";
import { deriveHC2, maxChosen, type Hc2Choice } from "@/lib/hc2";
import { CardThumb } from "../card-thumb";
import { rpcFetch } from "@/lib/rpc";
import {
  BURNPOINTS_ABI,
  CHOICE_SLOT_NAMES,
  CONTROLLER_ABI,
  CORE_CRAFT_ABI,
  CRAFT_ADDRESS,
  CRAFT_TIERS,
  LOCK_WAVES,
  MAX_BOOST_TIER,
  POINTS_ADDRESS,
  REVEAL_WINDOW,
  encodeChoicesHash,
  isSalt,
  loadCommit,
  randomSalt,
  revealWindowState,
  saveCommit,
  slotLabel,
  tierById,
  tierLabel,
  type CommitPhase,
  type OnChainCommit,
  type SlotChoice,
  type StoredCommit,
} from "@/lib/craft";

const MIN_FEE_GWEI = Number(process.env.NEXT_PUBLIC_MIN_MAX_FEE_GWEI ?? "50");
// Arc silently drops txs whose maxFeePerGas < 20 gwei (same rule as /mine, /stake).
const FEE_FLOOR_GWEI = Math.max(
  20,
  Number.isFinite(MIN_FEE_GWEI) ? MIN_FEE_GWEI : 50,
);

const WC_ENABLED = walletConnectEnabled();

// "My cards" scan mirrors /stake + the rarity showcase: first SCAN_CAP minted
// ids, bounded concurrency, per-token failures tolerated silently.
const SCAN_CAP = 500;
const SCAN_CONCURRENCY = 4;

// Commit scan: lastCommitId() down to 1, capped (bounded concurrency).
const COMMIT_SCAN_CAP = 500;
const COMMIT_SCAN_CONCURRENCY = 4;

const publicClient = createPublicClient({
  chain: arcTestnet,
  // rpcFetch() retries the Arc RPC's rate-limit bursts (HTTP 429/5xx + 200-OK
  // rate-limit bodies) with backoff — same resilience as /mine and /stake.
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

type ChoiceRow = { include: boolean; parent: 0 | 1 };

function emptyRows(): ChoiceRow[] {
  return Array.from({ length: 12 }, () => ({ include: false, parent: 0 as 0 | 1 }));
}

type CommitRow = { id: bigint; c: OnChainCommit; stored: StoredCommit | null };

type RevealedInfo = {
  tokenId: bigint;
  seed: Hex;
  attributes: Record<string, string> | null;
  golden: boolean | null;
};

/** max(floor, 2×baseFee); priority = half — identical to the /mine fee rule. */
async function computeFees(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  let maxFeePerGas = parseGwei(String(FEE_FLOOR_GWEI));
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 0n;
    const twice = baseFee * 2n;
    if (twice > maxFeePerGas) maxFeePerGas = twice;
  } catch {
    // keep the floor
  }
  return { maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas / 2n };
}

function humanizeTxError(message: string): string {
  return /user rejected|denied|User rejected/i.test(message)
    ? "Transaction rejected in wallet."
    : message;
}

/** Build the sorted-by-slot choice list the contract requires (ascending). */
function chosenChoices(rows: ChoiceRow[]): Hc2Choice[] {
  const list: Hc2Choice[] = [];
  rows.forEach((row, slot) => {
    if (row.include) list.push({ slot, parent: row.parent });
  });
  list.sort((a, b) => a.slot - b.slot);
  return list;
}

export default function CraftPage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `Refresh` cooldown (seconds). A single tap starts the countdown so an
  // impatient user cannot hammer the RPC into rate-limiting (same pattern as /mine).
  const [refreshCooldown, setRefreshCooldown] = useState(0);

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

  // Controller state
  const [corePaused, setCorePaused] = useState(false);
  const [coreForgePaused, setCoreForgePaused] = useState(false);
  const [craftFee, setCraftFee] = useState<bigint | null>(null);
  const [feeForTier, setFeeForTier] = useState<bigint | null>(null);
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [wave, setWave] = useState<bigint | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number>(0);

  // My cards (lazy scan)
  const [cards, setCards] = useState<number[] | null>(null);
  // Per-card free-claim flags — the on-chain truth `isFreeToken(id)`. The
  // contract assigns free-claim ids dynamically in `claim()` (`++totalMinted`),
  // so the lock is per-token and NOT an id range (a paid mint can hold any id).
  const [freeFlags, setFreeFlags] = useState<Record<number, boolean>>({});
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [manualCard, setManualCard] = useState("");

  // Choices + tier
  const [rows, setRows] = useState<ChoiceRow[]>(emptyRows);
  const [tier, setTier] = useState(0);

  // My commits
  const [commits, setCommits] = useState<CommitRow[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, RevealedInfo>>({});

  // Gacha-style modal shown once after a successful reveal — the child preview
  // (art + traits) in a popup, so the user sees WHAT they forged, not just "#id".
  const [gacha, setGacha] = useState<RevealedInfo | null>(null);

  // W3-01: the salt of the most recent commit, surfaced for backup after commit.
  const [saltBackup, setSaltBackup] = useState<{ id: string; salt: Hex } | null>(
    null,
  );

  // v1.1: BurnPoints — integer points accrued when this wallet's cards burned.
  const [points, setPoints] = useState<bigint | null>(null);

  const controller = CRAFT_ADDRESS;
  const pointsAddr = POINTS_ADDRESS;
  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;

  const cap = maxChosen(tier);
  const chosenCount = rows.filter((r) => r.include).length;
  const overCap = chosenCount > cap;

  // Free-claim lock window is active below wave LOCK_WAVES; the per-card
  // isFreeToken flag (freeFlags) decides which cards are actually affected.
  const lockActive = wave !== null && wave < LOCK_WAVES;

  // -------------------------------------------------------------- reads

  const refreshController = useCallback(async () => {
    if (!controller) return;
    try {
      const [paused, fee, w] = await Promise.all([
        publicClient.readContract({
          address: controller,
          abi: CONTROLLER_ABI,
          functionName: "paused",
        }),
        publicClient.readContract({
          address: controller,
          abi: CONTROLLER_ABI,
          functionName: "craftFee",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "currentWave",
        }),
      ]);
      setCorePaused(paused);
      setCraftFee(fee);
      setWave(w);
      setControllerError(null);
    } catch (e) {
      setControllerError(
        e instanceof Error ? e.message : "Failed to read the controller",
      );
    }
  }, [controller]);

  const refreshFee = useCallback(
    async (whichTier: number) => {
      if (!controller) return;
      try {
        const fee = await publicClient.readContract({
          address: controller,
          abi: CONTROLLER_ABI,
          functionName: "feeFor",
          args: [whichTier],
        });
        setFeeForTier(fee);
      } catch {
        setFeeForTier(null);
      }
    },
    [controller],
  );

  const refreshCorePause = useCallback(async () => {
    try {
      const fp = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CORE_CRAFT_ABI,
        functionName: "forgePaused",
      });
      setCoreForgePaused(fp);
    } catch {
      setCoreForgePaused(false);
    }
  }, []);

  const loadCommits = useCallback(async (who: Address) => {
    if (!controller) return;
    setCommitsLoading(true);
    try {
      const last = await publicClient.readContract({
        address: controller,
        abi: CONTROLLER_ABI,
        functionName: "lastCommitId",
      });
      const n = Number(last);
      const start = n > COMMIT_SCAN_CAP ? n - COMMIT_SCAN_CAP + 1 : 1;
      const ids: number[] = [];
      for (let id = n; id >= start; id--) ids.push(id);

      const found: CommitRow[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= ids.length) return;
          const id = ids[index];
          try {
            const c = await publicClient.readContract({
              address: controller,
              abi: CONTROLLER_ABI,
              functionName: "commits",
              args: [BigInt(id)],
            });
            // viem returns the struct getter as a labelled tuple:
            // [player, cardA, cardB, choicesHash, boostTier, nonce, commitBlock, fee, revealed, refunded].
            const commit: OnChainCommit = {
              player: c[0],
              cardA: c[1],
              cardB: c[2],
              choicesHash: c[3],
              boostTier: c[4],
              nonce: c[5],
              commitBlock: c[6],
              fee: c[7],
              revealed: c[8],
              refunded: c[9],
            };
            if (commit.player.toLowerCase() === who.toLowerCase()) {
              found.push({
                id: BigInt(id),
                c: commit,
                stored: loadCommit(BigInt(id)),
              });
            }
          } catch {
            // tolerate per-commit failures silently
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(COMMIT_SCAN_CONCURRENCY, ids.length) },
          worker,
        ),
      );
      found.sort((a, b) => Number(b.id - a.id));
      setCommits(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read your commits");
    } finally {
      setCommitsLoading(false);
    }
  }, [controller]);

  // v1.1: burn points for the connected wallet (BurnPoints.pointsOf).
  const loadPoints = useCallback(
    async (who: Address) => {
      if (!pointsAddr) return;
      try {
        const p = await publicClient.readContract({
          address: pointsAddr,
          abi: BURNPOINTS_ABI,
          functionName: "pointsOf",
          args: [who],
        });
        setPoints(p);
      } catch {
        // points=0 (controller not wired) or RPC hiccup — leave as is.
        setPoints(null);
      }
    },
    [pointsAddr],
  );

  const scanMyCards = useCallback(
    async (who: Address) => {
      if (!controller) return;
      setScanning(true);
      setScanDone(false);
      setScanProgress(0);
      setScanTotal(0);
      setCards(null);
      try {
        const totalMinted = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "totalMinted",
        });
        const upper = Math.min(Number(totalMinted), SCAN_CAP);
        const targets = Array.from({ length: upper }, (_, i) => i + 1);
        setScanTotal(targets.length);

        const owned: number[] = [];
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (true) {
            const index = next++;
            if (index >= targets.length) return;
            const id = targets[index];
            try {
              const owner = await publicClient.readContract({
                address: CONTRACT_ADDRESS,
                abi: POW_MINT_NFT_ABI,
                functionName: "ownerOf",
                args: [BigInt(id)],
              });
              if (owner.toLowerCase() === who.toLowerCase()) owned.push(id);
            } catch {
              // tolerate per-token failures silently
            }
            done += 1;
            setScanProgress(done);
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(SCAN_CONCURRENCY, targets.length) },
            worker,
          ),
        );
        owned.sort((a, b) => a - b);
        setCards(owned);

        // On-chain free-claim truth for the owned cards (`isFreeToken(id)`),
        // bounded by SCAN_CAP — same concurrency pattern as the ownership scan.
        const flags: Record<number, boolean> = {};
        let fnext = 0;
        const flagWorker = async () => {
          while (true) {
            const index = fnext++;
            if (index >= owned.length) return;
            const id = owned[index];
            try {
              flags[id] = await publicClient.readContract({
                address: CONTRACT_ADDRESS,
                abi: CORE_CRAFT_ABI,
                functionName: "isFreeToken",
                args: [BigInt(id)],
              });
            } catch {
              flags[id] = false;
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(SCAN_CONCURRENCY, owned.length) },
            flagWorker,
          ),
        );
        setFreeFlags(flags);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Card scan failed");
      } finally {
        setScanning(false);
        setScanDone(true);
      }
    },
    [controller],
  );

  // -------------------------------------------------------------- effects

  useEffect(() => {
    refreshController();
    refreshCorePause();
  }, [refreshController, refreshCorePause]);

  useEffect(() => {
    refreshFee(tier);
  }, [tier, refreshFee]);

  useEffect(() => {
    if (!controller) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const bn = await publicClient.getBlockNumber();
        if (!cancelled) setCurrentBlock(Number(bn));
      } catch {
        // keep the last block
      }
    };
    tick();
    const handle = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [controller]);

  useEffect(() => {
    if (address && controller) {
      loadCommits(address);
      refreshCorePause();
    } else {
      setCommits(null);
    }
    if (address && pointsAddr) {
      loadPoints(address);
    } else {
      setPoints(null);
    }
    // Re-scan cards is manual; invalidate any previous list on account change.
    setCards(null);
    setFreeFlags({});
    setScanDone(false);
    setSelected([]);
  }, [address, controller, pointsAddr, loadCommits, refreshCorePause, loadPoints]);

  // Close the gacha modal on Escape while it is open.
  useEffect(() => {
    if (!gacha) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGacha(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gacha]);

  /**
   * Manual `Refresh`: guarded by a 4s cooldown (and the busy flag) so a rapid
   * tap cannot spam the RPC into rate-limiting.
   */
  const handleRefresh = useCallback(() => {
    if (refreshCooldown > 0 || busy) return;
    refreshController();
    refreshCorePause();
    refreshFee(tier);
    if (address) loadCommits(address);
    setRefreshCooldown(4);
  }, [
    refreshCooldown,
    busy,
    refreshController,
    refreshCorePause,
    refreshFee,
    tier,
    address,
    loadCommits,
  ]);

  // Tick the Refresh cooldown down once per second.
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const handle = setInterval(() => {
      setRefreshCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(handle);
  }, [refreshCooldown]);

  // -------------------------------------------------------------- wallet

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

  // -------------------------------------------------------------- selection

  const toggleCard = useCallback((id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }, []);

  const addManualCard = useCallback(
    async (who: Address) => {
      setError(null);
      const trimmed = manualCard.trim();
      if (!/^\d+$/.test(trimmed)) {
        setError("Token id must be an unsigned integer.");
        return;
      }
      const id = Number(trimmed);
      if (selected.includes(id)) {
        setError(`Card #${id} is already selected.`);
        return;
      }
      if (selected.length >= 2) {
        setError("Two cards are already selected — deselect one first.");
        return;
      }
      if (lockActive) {
        // Per-token on-chain check — free-claim ids are dynamic (claim() takes
        // the next totalMinted id), so an id-range guess would be wrong.
        try {
          const isFree = await publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: CORE_CRAFT_ABI,
            functionName: "isFreeToken",
            args: [BigInt(id)],
          });
          if (isFree) {
            setError(
              `Card #${id} is a free-claim token and cannot be crafted until wave ${LOCK_WAVES.toString()}.`,
            );
            return;
          }
        } catch {
          // Unknown id — the ownerOf check below reports it precisely.
        }
      }
      try {
        const owner = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(id)],
        });
        if (owner.toLowerCase() !== who.toLowerCase()) {
          setError(
            `You do not own card #${id} (owner ${shortAddress(owner)}). Staked cards are held by the vault and cannot be crafted.`,
          );
          return;
        }
      } catch {
        setError(`Card #${id} does not exist (ownerOf reverted).`);
        return;
      }
      setSelected((prev) => [...prev, id]);
      setManualCard("");
    },
    [manualCard, selected, lockActive],
  );

  // -------------------------------------------------------------- writes

  const afterMutation = useCallback(async () => {
    setCards(null);
    setFreeFlags({});
    setScanDone(false);
    setSelected([]);
    // Clear the inherited-slot checkboxes and the manual id after a commit —
    // the previous craft's ticks must not carry into the next one.
    setRows(emptyRows());
    setManualCard("");
    if (address && controller) {
      await Promise.all([
        refreshController(),
        refreshFee(tier),
        loadCommits(address),
        pointsAddr ? loadPoints(address) : Promise.resolve(),
      ]);
    }
  }, [
    address,
    controller,
    pointsAddr,
    refreshController,
    refreshFee,
    loadCommits,
    loadPoints,
    tier,
  ]);

  const commit = useCallback(async () => {
    setError(null);
    setTxHash(null);
    if (!controller) {
      setError("The crafting controller is not deployed yet.");
      return;
    }
    const provider = wcProvider ?? window.ethereum;
    if (!provider || !address) {
      setError("Connect your wallet first.");
      return;
    }
    if (selected.length !== 2) {
      setError("Select exactly two different cards.");
      return;
    }
    if (selected[0] === selected[1]) {
      setError("The two cards must differ.");
      return;
    }
    const choices = chosenChoices(rows);
    if (choices.length > cap) {
      setError(
        `Too many choices: ${choices.length} > maxChosen(${tier})=${cap}.`,
      );
      return;
    }
    if (corePaused) {
      setError("Crafting is paused — commits are disabled.");
      return;
    }

    const [cardA, cardB] = selected;
    const minId = Math.min(cardA, cardB);
    const maxId = Math.max(cardA, cardB);

    setBusy(true);
    try {
      const walletClient = createWalletClient({
        chain: arcTestnet,
        transport: custom(provider),
      });

      // 0. Capture both parent seeds BEFORE the cards enter escrow/burn — the
      //    child preview after reveal needs the canonical (seedLow, seedHigh).
      setStatus("Reading parent seeds…");
      const seedA = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "seedOf",
        args: [BigInt(cardA)],
      });
      const seedB = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "seedOf",
        args: [BigInt(cardB)],
      });
      const seedLow = cardA === minId ? seedA : seedB;
      const seedHigh = cardA === maxId ? seedA : seedB;

      // 1. One operator approval covers BOTH cards (and every future craft):
      //    setApprovalForAll(controller, true). If it is already set we skip the
      //    tx entirely — no per-card approve(), no second wallet popup.
      const alreadyApproved = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: ERC721_APPROVAL_ABI,
        functionName: "isApprovedForAll",
        args: [address, controller],
      });
      if (!alreadyApproved) {
        setStatus("Approving the controller for all your cards (single tx)…");
        const approveFees = await computeFees();
        const approveHash = await walletClient.writeContract({
          account: address,
          address: CONTRACT_ADDRESS,
          abi: ERC721_APPROVAL_ABI,
          functionName: "setApprovalForAll",
          args: [controller, true],
          maxFeePerGas: approveFees.maxFeePerGas,
          maxPriorityFeePerGas: approveFees.maxPriorityFeePerGas,
        });
        setTxHash(approveHash);
        setStatus("setApprovalForAll submitted. Waiting for receipt…");
        const approveReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveHash,
          timeout: 120_000,
        });
        if (approveReceipt.status !== "success") {
          throw new Error("setApprovalForAll reverted on-chain.");
        }
        setStatus("Approved. Sending commit…");
      }

      // 2. Re-read the exact fee right before sending. W3-01: generate the
      //    client-side secret and mix it into the committed hash (never sent
      //    in the commit tx itself — only the resulting hash is public).
      const salt = randomSalt();
      const hashHex = encodeChoicesHash(choices as SlotChoice[], salt);
      const fee = await publicClient.readContract({
        address: controller,
        abi: CONTROLLER_ABI,
        functionName: "feeFor",
        args: [tier],
      });

      setStatus(`Sending commit(${cardA}, ${cardB}, tier ${tier})…`);
      const fees = await computeFees();
      const commitHash = await walletClient.writeContract({
        account: address,
        address: controller,
        abi: CONTROLLER_ABI,
        functionName: "commit",
        args: [BigInt(cardA), BigInt(cardB), hashHex, tier],
        value: fee,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setTxHash(commitHash);
      setStatus("commit submitted. Waiting for receipt…");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: commitHash,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        setError("commit transaction reverted on-chain.");
        setStatus("");
        return;
      }

      // 3. Parse the Committed event for the commitId, then persist the choices
      //    (localStorage, keyed by commitId) so reveal works from THIS browser.
      const [committed] = parseEventLogs({
        abi: CONTROLLER_ABI,
        eventName: "Committed",
        logs: receipt.logs,
      });
      const commitId = committed?.args.commitId;
      if (commitId === undefined) {
        setError(
          "commit succeeded but the Committed event could not be parsed — check the explorer.",
        );
        await afterMutation();
        return;
      }
      saveCommit({
        commitId: commitId.toString(),
        player: address,
        cardA: String(cardA),
        cardB: String(cardB),
        tier,
        choices: choices as SlotChoice[],
        salt,
        seedLow,
        seedHigh,
      });
      setSaltBackup({ id: commitId.toString(), salt });
      setStatus(
        `Committed as #${commitId.toString()} (block ${receipt.blockNumber}). Reveal is possible after +2 blocks (~seconds). Back up the salt below.`,
      );
      await afterMutation();
    } catch (e) {
      setError(humanizeTxError(e instanceof Error ? e.message : "commit failed"));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [
    controller,
    wcProvider,
    address,
    selected,
    rows,
    cap,
    tier,
    corePaused,
    afterMutation,
  ]);

  const reveal = useCallback(
    async (row: CommitRow) => {
      setError(null);
      setTxHash(null);
      if (!controller) return;
      const provider = wcProvider ?? window.ethereum;
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return;
      }
      const stored = row.stored;
      if (!stored || !isSalt(stored.salt)) {
        setError(
          "Salt not found on this device — the craft can only be refunded (refund) after the window; it cannot be revealed.",
        );
        return;
      }
      const salt = stored.salt;
      setBusy(true);
      setStatus(`Revealing commit #${row.id.toString()}…`);
      try {
        const walletClient = createWalletClient({
          chain: arcTestnet,
          transport: custom(provider),
        });
        const choices = stored.choices.map((c) => ({
          slot: c.slot,
          parent: c.parent,
        }));
        const fees = await computeFees();
        const hash = await walletClient.writeContract({
          account: address,
          address: controller,
          abi: CONTROLLER_ABI,
          functionName: "reveal",
          args: [row.id, choices, salt],
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        setTxHash(hash);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 120_000,
        });
        if (receipt.status !== "success") {
          setError("reveal transaction reverted on-chain.");
          setStatus("");
          return;
        }

        const [forged] = parseEventLogs({
          abi: POW_MINT_NFT_ABI,
          eventName: "Forged",
          logs: receipt.logs,
        });
        const [crafted] = parseEventLogs({
          abi: CONTROLLER_ABI,
          eventName: "Crafted",
          logs: receipt.logs,
        });

        const tokenId = forged?.args.tokenId;
        const seed = forged?.args.seed;

        if (tokenId !== undefined && seed !== undefined) {
          const onChainChoices: Hc2Choice[] =
            crafted?.args.choices.map((c) => ({
              slot: c.slot,
              parent: c.parent as 0 | 1,
            })) ?? (stored.choices as Hc2Choice[]);
          let attributes: Record<string, string> | null = null;
          let golden: boolean | null = null;
          try {
            const derived = deriveHC2(
              seed,
              stored.seedLow,
              stored.seedHigh,
              onChainChoices,
            );
            attributes = derived.attributes;
            golden = derived.golden;
          } catch {
            // preview is best-effort; the on-chain result is authoritative
          }
          setRevealed((prev) => ({
            ...prev,
            [row.id.toString()]: { tokenId, seed, attributes, golden },
          }));
          // Gacha popup: "here is your child" — art + traits right after reveal.
          setGacha({ tokenId, seed, attributes, golden });
          saveCommit({
            ...stored,
            childId: tokenId.toString(),
            childSeed: seed,
          });
          setStatus(
            `Revealed — child #${tokenId.toString()} forged. Parents burned; fees kept.`,
          );
        } else {
          setStatus("Revealed. (Forged event not parsed — check the explorer.)");
        }
        await Promise.all([
          loadCommits(address),
          pointsAddr ? loadPoints(address) : Promise.resolve(),
        ]);
      } catch (e) {
        setError(humanizeTxError(e instanceof Error ? e.message : "reveal failed"));
        setStatus("");
      } finally {
        setBusy(false);
      }
    },
    [controller, wcProvider, address, pointsAddr, loadCommits, loadPoints],
  );

  const refund = useCallback(
    async (row: CommitRow) => {
      setError(null);
      setTxHash(null);
      if (!controller) return;
      const provider = wcProvider ?? window.ethereum;
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return;
      }
      setBusy(true);
      const fullRefund = coreForgePaused;
      setStatus(`Refunding commit #${row.id.toString()}…`);
      try {
        const walletClient = createWalletClient({
          chain: arcTestnet,
          transport: custom(provider),
        });
        const fees = await computeFees();
        const hash = await walletClient.writeContract({
          account: address,
          address: controller,
          abi: CONTROLLER_ABI,
          functionName: "refund",
          args: [row.id],
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        setTxHash(hash);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 120_000,
        });
        if (receipt.status !== "success") {
          setError("refund transaction reverted on-chain.");
          setStatus("");
          return;
        }
        setStatus(
          fullRefund
            ? `Refunded #${row.id.toString()} — cards returned AND full fee refunded (forge was paused: protocol fault).`
            : `Refunded #${row.id.toString()} — cards returned; fees were kept (anti-grind premium).`,
        );
        await afterMutation();
      } catch (e) {
        setError(humanizeTxError(e instanceof Error ? e.message : "refund failed"));
        setStatus("");
      } finally {
        setBusy(false);
      }
    },
    [controller, wcProvider, address, coreForgePaused, afterMutation],
  );

  // --------------------------------------------------------- salt backup (W3-01)

  const copySalt = useCallback(async () => {
    if (!saltBackup) return;
    try {
      await navigator.clipboard.writeText(saltBackup.salt);
      setError(null);
      setStatus("Salt copied to the clipboard — store it somewhere safe.");
    } catch {
      setError("Clipboard unavailable — select and copy the hex manually.");
    }
  }, [saltBackup]);

  const downloadSalt = useCallback(() => {
    if (!saltBackup) return;
    const body = [
      `Proof-of-AI · craft commit #${saltBackup.id}`,
      "",
      `salt (bytes32): ${saltBackup.salt}`,
      "",
      "This secret is mixed into the committed hash and is required to reveal",
      "the craft. If it is lost, the commit can only be refunded after the",
      "reveal window closes — it cannot be revealed.",
      "",
    ].join("\n");
    try {
      const blob = new Blob([body], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `poa-craft-salt-${saltBackup.id}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setError(null);
      setStatus("Salt file downloaded — keep it safe until you reveal.");
    } catch {
      setError("Could not create the download — copy the hex manually.");
    }
  }, [saltBackup]);

  // -------------------------------------------------------------- derive

  const availableCards = useMemo(() => cards ?? [], [cards]);
  const selectedInfo = useMemo(() => {
    if (selected.length !== 2) return null;
    const minId = Math.min(selected[0], selected[1]);
    const maxId = Math.max(selected[0], selected[1]);
    return { minId, maxId };
  }, [selected]);

  const feeText =
    feeForTier === null
      ? "…"
      : craftFee === null
        ? `${formatUsdc(feeForTier)} USDC`
        : `${formatUsdc(feeForTier)} USDC (base ${formatUsdc(craftFee)} + boost ${formatUsdc(feeForTier - craftFee)})`;

  const phaseLabels: Record<CommitPhase, string> = {
    waiting: "waiting for entropy",
    reveal: "reveal available",
    closed: "window closed",
    settled: "settled",
  };

  return (
    <main className="container">
      <h1>Craft an Architector</h1>
      <p className="muted">
        Burn two Architectors into one forged child. Commit a slot-choice hash
        plus a boost tier, then reveal after a short entropy window. The child
        seed mixes both parents' seeds with future block entropy, so the result
        can be verified afterwards but never predicted before commit.
      </p>

      {!controller && (
        <div className="banner warn">
          The crafting controller is not deployed yet.{" "}
          <span className="mono">NEXT_PUBLIC_CRAFT_ADDRESS</span> is unset, so
          commit/reveal/refund are disabled — everything else on this page still
          works.
        </div>
      )}

      <div className="panel">
        <div className="row">
          <span className="k">Wallet</span>
          <span className="v">
            {address ? (
              <>
                {shortAddress(address)}{" "}
                <span className={`pill ${!wrongChain ? "ok" : "off"}`}>
                  chain {chainId ?? "?"}
                </span>
              </>
            ) : (
              "not connected"
            )}
          </span>
        </div>
        <div className="row">
          <span className="k">Core contract</span>
          <span className="v small">{CONTRACT_ADDRESS}</span>
        </div>
        <div className="row">
          <span className="k">Crafting controller</span>
          <span className="v small">{controller ?? "not deployed"}</span>
        </div>
        {controller && (
          <div className="row">
            <span className="k">Current block</span>
            <span className="v small">{currentBlock || "…"}</span>
          </div>
        )}

        <div className="field">
          {!address ? (
            <>
              <button
                className={hasInjected ? "primary" : "ghost"}
                onClick={connect}
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
                onClick={handleRefresh}
                disabled={refreshCooldown > 0 || busy}
              >
                {refreshCooldown > 0 ? `Refresh (${refreshCooldown}s)` : "Refresh"}
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
      </div>

      {controller && corePaused && (
        <div className="banner warn">
          Crafting is <strong>paused</strong> by the controller — commits and
          reveals are disabled. Refunds are never blocked.
        </div>
      )}
      {controller && coreForgePaused && (
        <div className="banner warn">
          The core's forge is <strong>paused</strong>. New reveals will revert;
          if you refund now the full fee is returned (protocol fault, RT-5).
        </div>
      )}
      {controllerError && (
        <div className="banner error">
          Could not read the controller: {controllerError}
        </div>
      )}

      {!controller ? null : (
        <>
          {/* ------------------------------------------------ my cards */}
          <div className="panel">
            <h2>1 · Pick two cards</h2>
            <p className="muted small">
              Available cards are found by scanning the first {SCAN_CAP} minted
              tokens (lazy, concurrency {SCAN_CONCURRENCY}) for ids you own. You
              can also type a token id directly. Staked cards are held by the
              vault and cannot be crafted.
            </p>

            <div className="field">
              <button
                className="ghost"
                onClick={() => address && scanMyCards(address)}
                disabled={!address || scanning || wrongChain}
              >
                {scanning
                  ? `Scanning… ${scanProgress}/${scanTotal}`
                  : "Scan my cards"}
              </button>
              {scanDone && (
                <span className="muted small">
                  {availableCards.length} card
                  {availableCards.length === 1 ? "" : "s"} found
                  {scanTotal > 0 ? ` (of ${scanTotal} scanned)` : ""}
                </span>
              )}
            </div>

            {address && availableCards.length > 0 && (
              <div className="card-chips">
                {availableCards.map((id) => {
                  const isFree = lockActive && freeFlags[id] === true;
                  const isSel = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`chip chip-card${isSel ? " active" : ""}${
                        isFree ? " chip-locked" : ""
                      }`}
                      onClick={() => !isFree && toggleCard(id)}
                      disabled={isFree}
                      title={
                        isFree
                          ? `Free-claim token — locked until wave ${LOCK_WAVES.toString()}`
                          : `Select card #${id}`
                      }
                    >
                      <CardThumb id={id} size={40} />
                      <span className="chip-card-label">#{id}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="field">
              <label className="muted small" htmlFor="craft-token">
                Token id (manual fallback)
              </label>
              <input
                id="craft-token"
                type="text"
                placeholder="e.g. 7"
                value={manualCard}
                onChange={(e) => setManualCard(e.target.value.trim())}
              />
              <button
                className="ghost"
                onClick={() => address && addManualCard(address)}
                disabled={!address || wrongChain || !manualCard}
              >
                Add card
              </button>
            </div>

            {lockActive && (
              <p className="muted small">
                Free-claim tokens are non-transferable and cannot be crafted
                until wave {LOCK_WAVES.toString()} (core lock, RT-2).
              </p>
            )}

            <div className="field">
              <span className="k">Selected</span>
              <span className="v">
                {selected.length === 0 ? (
                  "none"
                ) : (
                  selected.map((id, i) => (
                    <button
                      key={id}
                      type="button"
                      className="chip chip-card active"
                      onClick={() => toggleCard(id)}
                      title="Remove"
                    >
                      <CardThumb id={id} size={28} />
                      {i === 0 ? "cardA" : "cardB"} #{id} ✕
                    </button>
                  ))
                )}
              </span>
            </div>
            {selectedInfo && (
              <p className="muted small">
                Parent <span className="mono">0</span> = card #
                {selectedInfo.minId} (smaller tokenId); parent{" "}
                <span className="mono">1</span> = card #{selectedInfo.maxId}{" "}
                (larger tokenId). The contract canonicalizes by id, so the order
                you pick does not matter.
              </p>
            )}
          </div>

          {/* ------------------------------------------------ choices */}
          <div className="panel">
            <h2>2 · Inherited slots</h2>
            <p className="muted small">
              Choose up to <span className="mono">{cap}</span> slots to inherit
              from a parent (tier {tier} → maxChosen = {cap}). Legendary, golden
              and bug are <em>always</em> rolled from the child seed. A slot
              where both parents agree becomes a wildcard anyway.
            </p>

            <div
              className={`banner ${overCap ? "error" : "ok"}`}
              style={{ marginTop: 4 }}
            >
              chosen <span className="mono">{chosenCount} / {cap}</span>
              {overCap ? " — too many; lower the tier or unselect slots." : ""}
            </div>

            <div className="choice-grid">
              {rows.map((row, slot) => (
                <div
                  key={slot}
                  className={`choice-row${row.include ? " on" : ""}`}
                >
                  <label className="choice-head">
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(e) =>
                        setRows((prev) => {
                          const next = prev.slice();
                          next[slot] = { ...next[slot], include: e.target.checked };
                          return next;
                        })
                      }
                    />
                    <span className="choice-name">
                      <span className="mono">{slot}</span> {slotLabel(slot)}
                    </span>
                  </label>
                  <div className="parent-toggle">
                    <button
                      type="button"
                      className={`chip${row.parent === 0 ? " active" : ""}`}
                      onClick={() =>
                        setRows((prev) => {
                          const next = prev.slice();
                          next[slot] = { ...next[slot], parent: 0 };
                          return next;
                        })
                      }
                      title={`inherit from card #${selectedInfo?.minId ?? "?"} (smaller id)`}
                    >
                      0 · smaller id
                    </button>
                    <button
                      type="button"
                      className={`chip${row.parent === 1 ? " active" : ""}`}
                      onClick={() =>
                        setRows((prev) => {
                          const next = prev.slice();
                          next[slot] = { ...next[slot], parent: 1 };
                          return next;
                        })
                      }
                      title={`inherit from card #${selectedInfo?.maxId ?? "?"} (larger id)`}
                    >
                      1 · larger id
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ------------------------------------------------ tier + fee */}
          <div className="panel">
            <h2>3 · Boost tier &amp; fee</h2>
            <table className="tier-table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Slots</th>
                  <th>Boost</th>
                  <th aria-label="select" />
                </tr>
              </thead>
              <tbody>
                {CRAFT_TIERS.map((t) => (
                  <tr key={t.id} className={tier === t.id ? "active" : undefined}>
                    <td className="mono">{t.label}</td>
                    <td className="mono">{t.maxChosen}</td>
                    <td className="small muted">{t.boostNote}</td>
                    <td>
                      <button
                        type="button"
                        className={`chip${tier === t.id ? " active" : ""}`}
                        onClick={() => setTier(t.id)}
                      >
                        {tier === t.id ? "selected" : "select"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="stat-grid" style={{ marginTop: 14 }}>
              <div className="stat">
                <div className="label">Base craftFee</div>
                <div className="value">
                  {craftFee === null ? "…" : `${formatUsdc(craftFee)}`}
                </div>
              </div>
              <div className="stat">
                <div className="label">Total for {tierLabel(tier)}</div>
                <div className="value">
                  {feeForTier === null ? "…" : formatUsdc(feeForTier)}
                </div>
              </div>
              <div className="stat">
                <div className="label">Tier</div>
                <div className="value">{tierById(tier)?.name ?? tier}</div>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              {feeText} — read live from{" "}
              <span className="mono">feeFor(tier)</span> (18-dec USDC). Tier 0 is
              no boost. Boost sells <em>control</em> (inherited slots), never
              rarity.
            </p>

            <div className="field">
              <button
                className="primary"
                onClick={commit}
                disabled={
                  !address ||
                  wrongChain ||
                  busy ||
                  selected.length !== 2 ||
                  overCap ||
                  corePaused
                }
              >
                {busy
                  ? "Working…"
                  : selected.length !== 2
                    ? "Select two cards"
                    : `Commit (${tierLabel(tier)}, fee ${feeForTier === null ? "…" : formatUsdc(feeForTier)})`}
              </button>
            </div>

            <div className="banner warn">
              Your choices <em>and</em> the secret salt are stored{" "}
              <strong>locally in this browser</strong> (keyed by commit id) so
              you can reveal later. If this browser&apos;s storage is cleared
              before reveal, the commit can only be refunded after the window —
              any wallet can reveal, but it needs the choices + salt, which only
              live in this browser.
            </div>

            {saltBackup && (
              <div className="banner" style={{ marginTop: 10 }}>
                <h3 className="subtle-head" style={{ marginTop: 0 }}>
                  Back up your salt — commit #{saltBackup.id}
                </h3>
                <p className="muted small">
                  This 32-byte secret was mixed into the committed hash. It is{" "}
                  <strong>required</strong> to reveal. Losing it means the commit
                  can only be refunded (after the window) — it can never be
                  revealed.
                </p>
                <div
                  className="mono small"
                  style={{ wordBreak: "break-all", marginBottom: 8 }}
                >
                  {saltBackup.salt}
                </div>
                <div className="field">
                  <button className="ghost" type="button" onClick={copySalt}>
                    Copy salt
                  </button>
                  <button className="ghost" type="button" onClick={downloadSalt}>
                    Download .txt
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => setSaltBackup(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <p className="muted small" style={{ marginTop: 12 }}>
              Fee floor {FEE_FLOOR_GWEI} gwei; every tx uses{" "}
              <span className="mono">
                maxFeePerGas = max({FEE_FLOOR_GWEI} gwei, 2×baseFee)
              </span>{" "}
              with priority = half. One{" "}
              <span className="mono">setApprovalForAll(controller, true)</span>{" "}
              tx covers both cards and every future craft (skipped entirely when
              already approved).
            </p>

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
          </div>

          {/* ------------------------------------------------ my commits */}
          <div className="panel">
            <h2>My commits</h2>
            {pointsAddr && (
              <>
                <div className="stat-grid">
                  <div className="stat">
                    <div className="label">Burn points</div>
                    <div className="value">
                      {!address
                        ? "—"
                        : points === null
                          ? "…"
                          : points.toString()}
                    </div>
                  </div>
                </div>
                <p className="muted small" style={{ marginTop: 8 }}>
                  Points are earned when cards are burned in crafting
                  (rarity-weighted: 10–30 per parent by rarity tier). They are
                  not money — they track progress toward future doors/perks.
                </p>
              </>
            )}
            {!address ? (
              <div className="banner">
                Connect your wallet to see your commits.
              </div>
            ) : commitsLoading && commits === null ? (
              <div className="banner">Loading your commits…</div>
            ) : commits && commits.length > 0 ? (
              <div className="commit-list">
                {commits.map((row) => {
                  const settled = row.c.revealed || row.c.refunded;
                  const phase = revealWindowState(
                    row.c.commitBlock,
                    BigInt(currentBlock),
                    settled,
                  );
                  const info = revealed[row.id.toString()];
                  const childId = info?.tokenId ?? (
                    row.stored?.childId ? BigInt(row.stored.childId) : null
                  );
                  const blocksToReveal =
                    row.c.commitBlock + 3n - BigInt(currentBlock);
                  const blocksLeft =
                    row.c.commitBlock + REVEAL_WINDOW - BigInt(currentBlock);
                  return (
                    <div className="commit-row" key={row.id.toString()}>
                      <div className="commit-row-head">
                        <span className="mono">commit #{row.id.toString()}</span>
                        <span className="pill">{tierLabel(row.c.boostTier)}</span>
                        {row.c.revealed && <span className="pill ok">revealed</span>}
                        {row.c.refunded && <span className="pill off">refunded</span>}
                        {!settled && (
                          <span
                            className={`pill ${phase === "reveal" ? "ok" : "off"}`}
                          >
                            {phaseLabels[phase]}
                          </span>
                        )}
                      </div>
                      <div className="row">
                        <span className="k">Cards (escrowed)</span>
                        <span
                          className="v small"
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <CardThumb id={row.c.cardA} size={36} />
                          <CardThumb id={row.c.cardB} size={36} />
                          #{row.c.cardA.toString()} + #{row.c.cardB.toString()}
                        </span>
                      </div>
                      <div className="row">
                        <span className="k">Commit block</span>
                        <span className="v small">{row.c.commitBlock.toString()}</span>
                      </div>
                      <div className="row">
                        <span className="k">Fee paid</span>
                        <span className="v small">{formatUsdc(row.c.fee)} USDC</span>
                      </div>

                      {!settled && phase === "waiting" && (
                        <p className="muted small">
                          Waiting for entropy — reveal opens in{" "}
                          {blocksToReveal > 0n ? blocksToReveal.toString() : "0"}{" "}
                          block(s) (entropy = blockhash(commit + 2)).
                        </p>
                      )}

                      {!settled && phase === "reveal" && (
                        <div className="field">
                          <button
                            className="primary"
                            onClick={() => reveal(row)}
                            disabled={
                              busy ||
                              wrongChain ||
                              !row.stored ||
                              !isSalt(row.stored.salt)
                            }
                          >
                            Reveal
                          </button>
                          {(!row.stored || !isSalt(row.stored.salt)) && (
                            <span className="muted small">
                              salt not found on this device — this craft can only
                              be refunded (refund) after the window; it cannot be
                              revealed.
                            </span>
                          )}
                          <span className="muted small">
                            {blocksLeft > 0n
                              ? `${blocksLeft.toString()} block(s) left before the window closes.`
                              : "window closing."}
                          </span>
                        </div>
                      )}

                      {!settled && phase === "closed" && (
                        <div className="field">
                          <button
                            className="primary"
                            onClick={() => refund(row)}
                            disabled={busy || wrongChain}
                          >
                            Refund
                          </button>
                          <span className="muted small">
                            Cards return to you; fees are kept (anti-grind
                            premium).{coreForgePaused
                              ? " Forge is paused — full fee is returned."
                              : ""}
                          </span>
                        </div>
                      )}

                      {row.c.revealed && (
                        <div className="banner ok" style={{ marginTop: 10 }}>
                          <div className="commit-row-main">
                            {childId !== null && (
                              <CardThumb id={childId} size={48} />
                            )}
                            <div className="commit-row-body">
                              Child forged
                              {childId !== null ? (
                                <>
                                  :{" "}
                                  <Link href={`/token/${childId.toString()}`}>
                                    <span className="mono">
                                      #{childId.toString()}
                                    </span>
                                  </Link>{" "}
                                  ·{" "}
                                  <a
                                    href={`/api/image/${childId.toString()}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    image
                                  </a>
                                </>
                              ) : (
                                " (open from the browser that committed to preview the child)."
                              )}
                              {info?.seed && (
                                <div
                                  className="small mono"
                                  style={{ marginTop: 6 }}
                                >
                                  seed {info.seed}
                                </div>
                              )}
                              {info?.attributes && (
                                <div style={{ marginTop: 8 }}>
                                  {info.golden && (
                                    <span
                                      className="pill ok"
                                      style={{ marginRight: 8 }}
                                    >
                                      golden
                                    </span>
                                  )}
                                  {CHOICE_SLOT_NAMES.concat([
                                    "legendary",
                                    "golden",
                                    "bug",
                                  ]).map((name) => (
                                    <span key={name} className="trait-chip">
                                      <span className="k">{name}</span>{" "}
                                      <span className="mono">
                                        {info.attributes?.[name]}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {row.c.refunded && (
                        <p className="muted small">
                          Refunded — the two cards were returned to you.
                          {coreForgePaused ? " Full fee was refunded (RT-5)." : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="banner">
                No commits found for this wallet. Commit a pair above to start.
              </div>
            )}
            <p className="muted small" style={{ marginTop: 10 }}>
              Scanning <span className="mono">lastCommitId()</span> →{" "}
              <span className="mono">commits(id)</span> (cap {COMMIT_SCAN_CAP}).
              Reveal window is{" "}
              <span className="mono">[commit+3, commit+258]</span>; after that
              only <span className="mono">refund</span> remains.
            </p>
          </div>
        </>
      )}

      {/* keep the frozen on-chain bounds visible in one place */}
      <p className="muted small" style={{ marginTop: 18 }}>
        Bounds: slot ≤ 11, parent ∈ {"{0,1}"}, boost tier ≤ {MAX_BOOST_TIER},
        choices strictly increasing by slot. Committed hash ={" "}
        <span className="mono">
          keccak256(abi.encode((uint8,uint8)[], bytes32 salt))
        </span>
        .
      </p>

      {/* gacha-style reveal popup — shown right after a successful reveal */}
      {gacha && (
        <div className="gacha-overlay" onClick={() => setGacha(null)}>
          <div
            className="gacha-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Child forged: Architect #${gacha.tokenId.toString()}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gacha-eyebrow">Child forged</div>
            <h2 className="gacha-title">
              Architect #{gacha.tokenId.toString()}
            </h2>
            <div className="gacha-art">
              <CardThumb id={gacha.tokenId} size={220} />
            </div>
            {gacha.golden && (
              <p style={{ margin: "0 0 10px" }}>
                <span className="pill ok">golden</span>
              </p>
            )}
            <div className="gacha-traits">
              {CHOICE_SLOT_NAMES.concat([
                "legendary",
                "golden",
                "bug",
              ]).map((name) => (
                <span key={name} className="trait-chip">
                  <span className="k">{name}</span>{" "}
                  <span className="mono">{gacha.attributes?.[name] ?? "—"}</span>
                </span>
              ))}
            </div>
            <div className="gacha-actions">
              <Link
                className="button button-primary button-sm"
                href={`/token/${gacha.tokenId.toString()}`}
              >
                Open card page →
              </Link>
              <button className="ghost" onClick={() => setGacha(null)}>
                Keep crafting
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
