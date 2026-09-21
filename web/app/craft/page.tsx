"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbiItem,
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
import type { Hc2Choice } from "@/lib/hc2";
import { IS_V2 } from "@/lib/traits-set";
import { CardThumb } from "../card-thumb";
import { rpcFetch } from "@/lib/rpc";
import {
  BURNPOINTS_ABI,
  CRAFTED_SLOT_NAMES,
  CONTROLLER_ABI,
  CORE_CRAFT_ABI,
  CRAFT_ADDRESS,
  CRAFT_TIERS,
  LOCK_WAVES,
  MAX_BOOST_TIER,
  POINTS_ADDRESS,
  slotLabel,
  tierById,
  tierLabel,
  tierMaxChosen,
  type SlotChoice,
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

// "My crafts" log scan: Crafted events filtered by player (childId/player are
// indexed), windowed to the most recent MAX_CRAFT_SPAN blocks.
const MAX_CRAFT_SPAN = 200_000n;

/** The controller's `Crafted` event (v2 one-shot shape). */
const CRAFTED_EVENT = parseAbiItem(
  "event Crafted(uint256 indexed childId, address indexed player, uint256 cardA, uint256 cardB, bytes32 childSeed, uint8 boostTier, uint256 fee)",
);

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

type CraftRow = {
  childId: bigint;
  cardA: bigint;
  cardB: bigint;
  childSeed: Hex;
  boostTier: number;
  fee: bigint;
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

  // Restore an already-authorized wallet on load (no popups).
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
  const [controllerPaused, setControllerPaused] = useState(false);
  const [coreForgePaused, setCoreForgePaused] = useState(false);
  const [craftFee, setCraftFee] = useState<bigint | null>(null);
  const [feeForTier, setFeeForTier] = useState<bigint | null>(null);
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [wave, setWave] = useState<bigint | null>(null);

  // My cards (lazy scan)
  const [cards, setCards] = useState<number[] | null>(null);
  // Per-card free-claim flags — the on-chain truth `isFreeToken(id)`.
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

  // My crafts (Crafted events filtered by player)
  const [crafts, setCrafts] = useState<CraftRow[] | null>(null);
  const [craftsLoading, setCraftsLoading] = useState(false);

  // Gacha-style modal shown once after a successful craft — the child link.
  const [gacha, setGacha] = useState<CraftRow | null>(null);

  // v1.1: BurnPoints — integer points accrued when this wallet's cards burned.
  const [points, setPoints] = useState<bigint | null>(null);

  const controller = CRAFT_ADDRESS;
  const pointsAddr = POINTS_ADDRESS;
  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;

  const cap = tierMaxChosen(tier);
  const chosenCount = rows.filter((r) => r.include).length;
  const overCap = chosenCount > cap;

  // Free-claim lock window is active below wave LOCK_WAVES.
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
      setControllerPaused(paused);
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

  const loadMyCrafts = useCallback(
    async (who: Address) => {
      if (!controller) return;
      setCraftsLoading(true);
      try {
        const latest = await publicClient.getBlockNumber();
        const from = latest > MAX_CRAFT_SPAN ? latest - MAX_CRAFT_SPAN + 1n : 0n;
        const logs = await publicClient.getLogs({
          address: controller,
          event: CRAFTED_EVENT,
          args: { player: who },
          fromBlock: from,
          toBlock: latest,
        });
        const found: CraftRow[] = [];
        for (const log of logs) {
          const args = log.args;
          if (
            args.childId === undefined ||
            args.cardA === undefined ||
            args.cardB === undefined ||
            args.childSeed === undefined ||
            args.boostTier === undefined ||
            args.fee === undefined
          ) {
            continue;
          }
          found.push({
            childId: args.childId,
            cardA: args.cardA,
            cardB: args.cardB,
            childSeed: args.childSeed,
            boostTier: Number(args.boostTier),
            fee: args.fee,
          });
        }
        found.sort((a, b) => Number(b.childId - a.childId));
        setCrafts(found);
      } catch {
        // Provider range limits / RPC hiccup — show the session crafts only.
        setCrafts((prev) => prev ?? []);
      } finally {
        setCraftsLoading(false);
      }
    },
    [controller],
  );

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

        // On-chain free-claim truth for the owned cards (`isFreeToken(id)`).
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
    if (address && controller) {
      loadMyCrafts(address);
      refreshCorePause();
    } else {
      setCrafts(null);
    }
    if (address && pointsAddr) {
      loadPoints(address);
    } else {
      setPoints(null);
    }
    setCards(null);
    setFreeFlags({});
    setScanDone(false);
    setSelected([]);
  }, [
    address,
    controller,
    pointsAddr,
    loadMyCrafts,
    refreshCorePause,
    loadPoints,
  ]);

  // Close the gacha modal on Escape while it is open.
  useEffect(() => {
    if (!gacha) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGacha(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gacha]);

  const handleRefresh = useCallback(() => {
    if (refreshCooldown > 0 || busy) return;
    refreshController();
    refreshCorePause();
    refreshFee(tier);
    if (address) loadMyCrafts(address);
    setRefreshCooldown(4);
  }, [
    refreshCooldown,
    busy,
    refreshController,
    refreshCorePause,
    refreshFee,
    tier,
    address,
    loadMyCrafts,
  ]);

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
    setRows(emptyRows());
    setManualCard("");
    if (address && controller) {
      await Promise.all([
        refreshController(),
        refreshFee(tier),
        loadMyCrafts(address),
        pointsAddr ? loadPoints(address) : Promise.resolve(),
      ]);
    }
  }, [
    address,
    controller,
    pointsAddr,
    refreshController,
    refreshFee,
    loadMyCrafts,
    loadPoints,
    tier,
  ]);

  const craft = useCallback(async () => {
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
    if (controllerPaused) {
      setError("Crafting is paused.");
      return;
    }

    const [cardA, cardB] = selected;

    setBusy(true);
    try {
      const walletClient = createWalletClient({
        chain: arcTestnet,
        transport: custom(provider),
      });

      // One operator approval covers BOTH cards (and every future craft):
      // setApprovalForAll(controller, true). Skipped when already set.
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
        setStatus("Approved. Sending craft…");
      }

      // Re-read the exact fee right before sending so msg.value == feeFor(tier).
      const fee = await publicClient.readContract({
        address: controller,
        abi: CONTROLLER_ABI,
        functionName: "feeFor",
        args: [tier],
      });

      setStatus(`Sending craft(${cardA}, ${cardB}, tier ${tier})…`);
      const fees = await computeFees();
      const craftHash = await walletClient.writeContract({
        account: address,
        address: controller,
        abi: CONTROLLER_ABI,
        functionName: "craft",
        args: [
          BigInt(cardA),
          BigInt(cardB),
          choices as SlotChoice[],
          tier,
        ],
        value: fee,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setTxHash(craftHash);
      setStatus("craft submitted. Waiting for receipt…");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: craftHash,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        setError("craft transaction reverted on-chain.");
        setStatus("");
        return;
      }

      // Parse the Crafted event for the child id + pre-seed (the child art is
      // only final after ~2 more blocks — post-inclusion entropy).
      const [crafted] = parseEventLogs({
        abi: CONTROLLER_ABI,
        eventName: "Crafted",
        logs: receipt.logs,
      });
      if (crafted) {
        const row: CraftRow = {
          childId: crafted.args.childId,
          cardA: crafted.args.cardA,
          cardB: crafted.args.cardB,
          childSeed: crafted.args.childSeed,
          boostTier: Number(crafted.args.boostTier),
          fee: crafted.args.fee,
        };
        setGacha(row);
        setStatus(
          `Crafted — child #${row.childId.toString()} forged (block ${receipt.blockNumber}). Art finalizes in ~2 blocks.`,
        );
      } else {
        setStatus(
          "Craft confirmed. (Crafted event not parsed — check the explorer.)",
        );
      }
      await afterMutation();
    } catch (e) {
      setError(humanizeTxError(e instanceof Error ? e.message : "craft failed"));
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
    controllerPaused,
    afterMutation,
  ]);

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

  return (
    <main className="container">
      <h1>Craft an Architector</h1>
      <p className="muted">
        Burn two Architectors into one forged child in a single transaction. Pick
        which slots to inherit and a boost tier; the two cards are escrowed and
        burned and the child is forged atomically — crafted is taken, there is no
        back-out. The child seed mixes both parents&apos; seeds with a block hash
        that does not exist yet, so the result is verifiable afterwards but never
        predictable before you commit.
      </p>

      {!controller && (
        <div className="banner warn">
          The crafting controller is not deployed yet.{" "}
          <span className="mono">NEXT_PUBLIC_CRAFT_ADDRESS</span> is unset, so
          crafting is disabled — everything else on this page still works.
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

      {controller && controllerPaused && (
        <div className="banner warn">
          Crafting is <strong>paused</strong> by the controller.
        </div>
      )}
      {controller && coreForgePaused && (
        <div className="banner warn">
          The core&apos;s forge is <strong>paused</strong>. New crafts will
          revert until it is unpaused.
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
                until wave {LOCK_WAVES.toString()} (core lock).
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
              from a parent (tier {tier} → maxChosen = {cap}).{" "}
              {IS_V2 ? (
                <>
                  Quote, lore and hair color are <em>always</em> rolled from the
                  child seed.
                </>
              ) : (
                <>
                  Legendary, golden and bug are <em>always</em> rolled from the
                  child seed.
                </>
              )}{" "}
              A slot where both parents agree becomes a wildcard anyway.
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
                onClick={craft}
                disabled={
                  !address ||
                  wrongChain ||
                  busy ||
                  selected.length !== 2 ||
                  overCap ||
                  controllerPaused
                }
              >
                {busy
                  ? "Working…"
                  : selected.length !== 2
                    ? "Select two cards"
                    : overCap
                      ? "Too many slots chosen"
                      : `Craft (${tierLabel(tier)}, fee ${feeForTier === null ? "…" : formatUsdc(feeForTier)})`}
              </button>
            </div>

            <div className="banner warn">
              Crafting is <strong>one-shot and irreversible</strong>: the moment
              the transaction lands both cards are burned and the child is
              forged. There is no commit/reveal step, no refund, and the child&apos;s
              art is only final after the next two blocks (post-inclusion
              entropy).
            </div>

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

          {/* ------------------------------------------------ my crafts */}
          <div className="panel">
            <h2>My crafts</h2>
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
                Connect your wallet to see your crafted children.
              </div>
            ) : craftsLoading && crafts === null ? (
              <div className="banner">Loading your crafts…</div>
            ) : crafts && crafts.length > 0 ? (
              <div className="commit-list">
                {crafts.map((row) => (
                  <div className="commit-row" key={row.childId.toString()}>
                    <div className="commit-row-head">
                      <span className="mono">
                        child #{row.childId.toString()}
                      </span>
                      <span className="pill">{tierLabel(row.boostTier)}</span>
                    </div>
                    <div className="row">
                      <span className="k">Parents (burned)</span>
                      <span
                        className="v small"
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <CardThumb id={row.cardA} size={36} />
                        <CardThumb id={row.cardB} size={36} />#
                        {row.cardA.toString()} + #{row.cardB.toString()}
                      </span>
                    </div>
                    <div className="row">
                      <span className="k">Fee paid</span>
                      <span className="v small">
                        {formatUsdc(row.fee)} USDC
                      </span>
                    </div>
                    <div className="banner ok" style={{ marginTop: 10 }}>
                      <div className="commit-row-main">
                        <CardThumb id={row.childId} size={48} />
                        <div className="commit-row-body">
                          Child forged:{" "}
                          <Link href={`/token/${row.childId.toString()}`}>
                            <span className="mono">
                              #{row.childId.toString()}
                            </span>
                          </Link>{" "}
                          ·{" "}
                          <a
                            href={`/api/image/${row.childId.toString()}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            image
                          </a>
                          <div
                            className="small mono"
                            style={{ marginTop: 6, wordBreak: "break-all" }}
                          >
                            pre-seed {row.childSeed}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="banner">
                No crafted children found for this wallet yet. Craft a pair above
                to start.
              </div>
            )}
            <p className="muted small" style={{ marginTop: 10 }}>
              Scanning the controller&apos;s{" "}
              <span className="mono">Crafted</span> events (indexed by player,
              most recent {Number(MAX_CRAFT_SPAN).toLocaleString("en-US")}{" "}
              blocks). Traits resolve server-side from the child&apos;s
              post-inclusion seed.
            </p>
          </div>
        </>
      )}

      {/* keep the frozen on-chain bounds visible in one place */}
      <p className="muted small" style={{ marginTop: 18 }}>
        Bounds: slot ≤ 11, parent ∈ {"{0,1}"}, boost tier ≤ {MAX_BOOST_TIER},
        choices strictly increasing by slot. Child pre-seed ={" "}
        <span className="mono">
          keccak256(&quot;PoA_CRAFT_v2&quot; ‖ seedLow ‖ seedHigh ‖ minId ‖ maxId ‖
          door ‖ tier ‖ nonce ‖ keccak256(abi.encode(choices)))
        </span>{" "}
        — the display seed adds blockhash(childMintBlock + 2).
      </p>

      {/* gacha-style popup — shown right after a successful craft */}
      {gacha && (
        <div className="gacha-overlay" onClick={() => setGacha(null)}>
          <div
            className="gacha-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Child forged: Architect #${gacha.childId.toString()}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gacha-eyebrow">Child forged</div>
            <h2 className="gacha-title">
              Architect #{gacha.childId.toString()}
            </h2>
            <div className="gacha-art">
              <CardThumb id={gacha.childId} size={220} />
            </div>
            <p className="muted small" style={{ margin: "0 0 10px" }}>
              Art finalizes in ~2 blocks (post-inclusion entropy).
            </p>
            <div className="gacha-traits">
              {CRAFTED_SLOT_NAMES.map((name) => (
                <span key={name} className="trait-chip">
                  <span className="k">{name}</span>{" "}
                  <span className="mono">—</span>
                </span>
              ))}
            </div>
            <div className="gacha-actions">
              <Link
                className="button button-primary button-sm"
                href={`/token/${gacha.childId.toString()}`}
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
