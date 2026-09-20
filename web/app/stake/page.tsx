"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseGwei,
  type Address,
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
import { rpcFetch, humanizeRpcError } from "@/lib/rpc";
import { CORE_CRAFT_ABI, LOCK_WAVES } from "@/lib/craft";
import { CardThumb } from "../card-thumb";
import {
  ERC721_APPROVAL_ABI,
  MAX_DISCOUNT_BITS,
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
  REWARDS_ADDRESS,
  REWARDS_ABI,
  STAKE_TIERS,
  VAULT_ABI,
  VAULT_ADDRESS,
  cardWeightX10,
  formatUnixDate,
  formatUnixDateTime,
  humanizeLockedError,
  isLocked,
  rarityLabel,
  rarityTierClass,
  tierById,
  tierLabel,
  tokenKey,
  unlockAt,
} from "@/lib/staking";

const MIN_FEE_GWEI = Number(
  process.env.NEXT_PUBLIC_MIN_MAX_FEE_GWEI ?? "50",
);
// Arc silently drops txs whose maxFeePerGas < 20 gwei (same rule as /mine).
const FEE_FLOOR_GWEI = Math.max(20, Number.isFinite(MIN_FEE_GWEI) ? MIN_FEE_GWEI : 50);

// WalletConnect is optional: enabled only when the build carries a project id.
const WC_ENABLED = walletConnectEnabled();

// "My cards" scan mirrors the rarity showcase: first SCAN_CAP minted ids,
// bounded concurrency, per-token failures tolerated silently.
const SCAN_CAP = 500;
const SCAN_CONCURRENCY = 4;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

type StakeRow = {
  tokenId: bigint;
  owner: Address;
  tier: number;
  stakedAt: bigint;
  accruedNow: bigint;
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

/** Friendly note when staking a locked free-claim token (staking spec §9).
 *
 * The free/influencer id set is DYNAMIC (commit c51b786: claim takes the next
 * totalMinted), so an `id ≤ N` heuristic is wrong. We ask the core contract the
 * per-token truth instead: a card is un-stakeable only while it is a free token
 * (`isFreeToken(id)`) and the core wave is still below the lock window
 * (`currentWave < LOCK_WAVES`). Any read failure simply drops the hint.
 */
async function freeLockHint(tokenId: bigint): Promise<string> {
  try {
    const [isFree, wave] = await Promise.all([
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CORE_CRAFT_ABI,
        functionName: "isFreeToken",
        args: [tokenId],
      }),
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "currentWave",
      }),
    ]);
    if (isFree && wave < LOCK_WAVES) {
      return `This is a free claim token (influencer slot) — free tokens are non-transferable until wave ${LOCK_WAVES} (core free-token lock), so it cannot be staked yet.`;
    }
  } catch {
    // Read failed — omit the hint rather than guess whether the id is free.
  }
  return "";
}

export default function StakePage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refresh cooldown (seconds): throttles the manual Refresh button so a
  // refresh-spamming user cannot burst the Arc RPC into rate-limiting.
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  // Detected after mount so SSR HTML and first client render agree.
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

  // Vault state
  const [vaultStats, setVaultStats] = useState<{
    stakeCount: bigint;
    paused: boolean;
  } | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);

  // Core PoW discount for the connected wallet.
  const [discountBits, setDiscountBits] = useState<number | null>(null);

  // My stakes
  const [stakes, setStakes] = useState<StakeRow[] | null>(null);
  const [stakesLoading, setStakesLoading] = useState(false);

  // v1.1: attested rarity tier per staked card (tokenId string → tier 0..4).
  const [rarityTiers, setRarityTiers] = useState<Record<string, number>>({});
  // v1.1: vault weightOf(wallet) total (×10), and StakeRewards pendingOf(wallet).
  const [weight, setWeight] = useState<bigint | null>(null);
  const [pending, setPending] = useState<bigint | null>(null);
  const [rewardsError, setRewardsError] = useState<string | null>(null);

  // Wall clock (unix seconds), refreshed on a timer so lock statuses clear live.
  const [nowSec, setNowSec] = useState(0);

  // My cards (lazy scan)
  const [cards, setCards] = useState<number[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);

  // Stake form
  const [tokenIdInput, setTokenIdInput] = useState("");
  const [selectedTier, setSelectedTier] = useState(0);

  const vault = VAULT_ADDRESS;
  const registry = REGISTRY_ADDRESS;
  const rewards = REWARDS_ADDRESS;
  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;

  // -------------------------------------------------------------- reads

  const refreshVault = useCallback(async () => {
    if (!vault) return;
    try {
      const [stakeCount, paused] = await Promise.all([
        publicClient.readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "stakeCount",
        }),
        publicClient.readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "paused",
        }),
      ]);
      setVaultStats({ stakeCount, paused });
      setVaultError(null);
    } catch (e) {
      setVaultError(
        humanizeRpcError(
          e instanceof Error ? e.message : "Failed to read the vault",
        ),
      );
    }
  }, [vault]);

  const refreshDiscount = useCallback(async (who: Address | null) => {
    if (!who) {
      setDiscountBits(null);
      return;
    }
    try {
      const bits = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "stakingDiscountBits",
        args: [who],
      });
      setDiscountBits(Number(bits));
    } catch {
      // v3 deployment has no stakingDiscountBits, or RPC hiccup — stay silent.
      setDiscountBits(null);
    }
  }, []);

  const loadStakes = useCallback(
    async (who: Address) => {
      if (!vault) return;
      setStakesLoading(true);
      try {
        const ids = await publicClient.readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "stakesOf",
          args: [who],
        });
        const rows = (
          await Promise.all(
            ids.map(async (tokenId): Promise<StakeRow | null> => {
              try {
                const info = await publicClient.readContract({
                  address: vault,
                  abi: VAULT_ABI,
                  functionName: "stakeInfo",
                  args: [tokenId],
                });
                // viem returns a struct getter as a readonly tuple:
                // [owner, tier, stakedAt, accrued, lastAccrual].
                let accruedNow = info[3];
                try {
                  accruedNow = await publicClient.readContract({
                    address: vault,
                    abi: VAULT_ABI,
                    functionName: "accruedOf",
                    args: [tokenId],
                  });
                } catch {
                  // keep the stored accrued value
                }
                return {
                  tokenId,
                  owner: info[0],
                  tier: info[1],
                  stakedAt: info[2],
                  accruedNow,
                };
              } catch {
                return null;
              }
            }),
          )
        ).filter((row): row is StakeRow => row !== null);
        setStakes(rows);
      } catch (e) {
        setError(
          humanizeRpcError(
            e instanceof Error ? e.message : "Failed to read your stakes",
          ),
        );
      } finally {
        setStakesLoading(false);
      }
    },
    [vault],
  );

  // v1.1: attested rarity tier per staked card (registry.tierOf(bytes32 key)).
  // Defaults to Standard (0) when the registry is unset or a read fails.
  const loadRarity = useCallback(
    async (rows: StakeRow[]) => {
      if (!registry) {
        setRarityTiers({});
        return;
      }
      const entries = await Promise.all(
        rows.map(async (row): Promise<[string, number]> => {
          try {
            const tier = Number(
              await publicClient.readContract({
                address: registry,
                abi: REGISTRY_ABI,
                functionName: "tierOf",
                args: [tokenKey(row.tokenId)],
              }),
            );
            return [row.tokenId.toString(), Number.isFinite(tier) ? tier : 0];
          } catch {
            return [row.tokenId.toString(), 0];
          }
        }),
      );
      setRarityTiers(Object.fromEntries(entries));
    },
    [registry],
  );

  const loadWeight = useCallback(
    async (who: Address) => {
      if (!vault) return;
      try {
        const w = await publicClient.readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "weightOf",
          args: [who],
        });
        setWeight(w);
      } catch {
        // v1.0 vault (no weightOf) or RPC hiccup — leave the last value.
        setWeight(null);
      }
    },
    [vault],
  );

  const loadPending = useCallback(
    async (who: Address) => {
      if (!rewards) return;
      try {
        const p = await publicClient.readContract({
          address: rewards,
          abi: REWARDS_ABI,
          functionName: "pendingOf",
          args: [who],
        });
        setPending(p);
        setRewardsError(null);
      } catch (e) {
        setPending(null);
        setRewardsError(
          humanizeRpcError(
            e instanceof Error ? e.message : "Failed to read pending rewards",
          ),
        );
      }
    },
    [rewards],
  );

  // Lazy card scan — only fired on user activation (like the rarity showcase).
  const scanMyCards = useCallback(
    async (who: Address) => {
      if (!vault) return;
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
      } catch (e) {
        setError(
          humanizeRpcError(e instanceof Error ? e.message : "Card scan failed"),
        );
      } finally {
        setScanning(false);
        setScanDone(true);
      }
    },
    [vault],
  );

  const refreshAll = useCallback(
    async (who: Address | null) => {
      await Promise.all([
        refreshVault(),
        refreshDiscount(who),
        who ? loadStakes(who) : Promise.resolve(),
        who && vault ? loadWeight(who) : Promise.resolve(),
        who && rewards ? loadPending(who) : Promise.resolve(),
      ]);
    },
    [
      refreshVault,
      refreshDiscount,
      loadStakes,
      loadWeight,
      loadPending,
      vault,
      rewards,
    ],
  );

  // Manual refresh with a 4s cooldown: a burst of clicks is ignored instead of
  // hammering the Arc RPC (the old behaviour surfaced raw rate-limit errors).
  const handleRefresh = useCallback(() => {
    if (refreshCooldown > 0 || busy) return;
    void refreshAll(address);
    setRefreshCooldown(4);
  }, [refreshCooldown, busy, refreshAll, address]);

  useEffect(() => {
    refreshVault();
  }, [refreshVault]);

  useEffect(() => {
    refreshAll(address);
    // Re-scanning is manual; invalidate any previous card list on account change.
    setCards(null);
    setScanDone(false);
  }, [address, refreshAll]);

  // v1.1: resolve rarity tiers whenever the stake list changes.
  useEffect(() => {
    if (stakes) loadRarity(stakes);
  }, [stakes, loadRarity]);

  // v1.1: poll pending rewards ~every 60s while a wallet is connected.
  useEffect(() => {
    if (!address || !rewards) return;
    const handle = setInterval(() => loadPending(address), 60_000);
    return () => clearInterval(handle);
  }, [address, rewards, loadPending]);

  // 30s wall clock so hard-lock statuses ("Locked until …" → unlockable) update
  // live without a manual refresh.
  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
    const handle = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => clearInterval(handle);
  }, []);

  // Tick the refresh cooldown down to 0 once per second.
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const handle = setInterval(
      () => setRefreshCooldown((s) => (s > 0 ? s - 1 : 0)),
      1_000,
    );
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

  // -------------------------------------------------------------- writes

  const afterMutation = useCallback(async () => {
    setCards(null);
    setScanDone(false);
    if (address && vault) {
      await Promise.all([
        refreshVault(),
        refreshDiscount(address),
        loadStakes(address),
        loadWeight(address),
        rewards ? loadPending(address) : Promise.resolve(),
      ]);
    }
  }, [
    address,
    vault,
    rewards,
    refreshVault,
    refreshDiscount,
    loadStakes,
    loadWeight,
    loadPending,
  ]);

  const stake = useCallback(
    async (tokenId: bigint, tierId: number) => {
      setError(null);
      setTxHash(null);
      if (!vault) {
        setError("The staking vault is not deployed yet.");
        return;
      }
      const provider = wcProvider ?? window.ethereum;
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return;
      }
      setBusy(true);
      try {
        const walletClient = createWalletClient({
          chain: arcTestnet,
          transport: custom(provider),
        });

        // 1. Ensure the vault is approved to move the token.
        const approved = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: ERC721_APPROVAL_ABI,
          functionName: "getApproved",
          args: [tokenId],
        });

        if (approved.toLowerCase() !== vault.toLowerCase()) {
          setStatus(`Approving the vault for token #${tokenId}…`);
          const approveFees = await computeFees();
          const approveHash = await walletClient.writeContract({
            account: address,
            address: CONTRACT_ADDRESS,
            abi: ERC721_APPROVAL_ABI,
            functionName: "approve",
            args: [vault, tokenId],
            maxFeePerGas: approveFees.maxFeePerGas,
            maxPriorityFeePerGas: approveFees.maxPriorityFeePerGas,
          });
          setTxHash(approveHash);
          setStatus(`approve(#${tokenId}) submitted. Waiting for receipt…`);
          const approveReceipt = await publicClient.waitForTransactionReceipt({
            hash: approveHash,
            timeout: 120_000,
          });
          if (approveReceipt.status !== "success") {
            throw new Error("approve transaction reverted on-chain.");
          }
          setStatus("Approved. Sending stake…");
        }

        // 2. Stake into the vault.
        const stakeFees = await computeFees();
        const stakeHash = await walletClient.writeContract({
          account: address,
          address: vault,
          abi: VAULT_ABI,
          functionName: "stake",
          args: [tokenId, tierId],
          maxFeePerGas: stakeFees.maxFeePerGas,
          maxPriorityFeePerGas: stakeFees.maxPriorityFeePerGas,
        });
        setTxHash(stakeHash);
        setStatus(`stake(#${tokenId}, ${tierLabel(tierId)}) submitted. Waiting…`);

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: stakeHash,
          timeout: 120_000,
        });
        if (receipt.status === "success") {
          setStatus(
            `Staked #${tokenId} as ${tierLabel(tierId)} (block ${receipt.blockNumber}).`,
          );
          setTokenIdInput("");
        } else {
          setError("stake transaction reverted on-chain.");
          setStatus("");
        }
        await afterMutation();
      } catch (e) {
        const message = e instanceof Error ? e.message : "stake failed";
        const base = humanizeTxError(message);
        const hint = await freeLockHint(tokenId);
        setError(hint ? `${base} — Note: ${hint}` : base);
        setStatus("");
      } finally {
        setBusy(false);
      }
    },
    [address, vault, wcProvider, afterMutation],
  );

  const unstake = useCallback(
    async (tokenId: bigint) => {
      setError(null);
      setTxHash(null);
      if (!vault) {
        setError("The staking vault is not deployed yet.");
        return;
      }
      const provider = wcProvider ?? window.ethereum;
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return;
      }
      setBusy(true);
      setStatus(`unstake(#${tokenId}) — sending…`);
      try {
        const walletClient = createWalletClient({
          chain: arcTestnet,
          transport: custom(provider),
        });
        const fees = await computeFees();
        const hash = await walletClient.writeContract({
          account: address,
          address: vault,
          abi: VAULT_ABI,
          functionName: "unstake",
          args: [tokenId],
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        setTxHash(hash);
        setStatus(`unstake(#${tokenId}) submitted. Waiting…`);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 120_000,
        });
        if (receipt.status === "success") {
          setStatus(`Unstaked #${tokenId} (block ${receipt.blockNumber}).`);
        } else {
          setError("unstake transaction reverted on-chain.");
          setStatus("");
        }
        await afterMutation();
      } catch (e) {
        // Hard lock: surface "Card is locked until DD Mon HH:MM" when we can.
        const locked = humanizeLockedError(e);
        setError(
          locked ?? humanizeTxError(e instanceof Error ? e.message : "unstake failed"),
        );
        setStatus("");
      } finally {
        setBusy(false);
      }
    },
    [address, vault, wcProvider, afterMutation],
  );

  // v1.1: claim accrued USDC rewards (native, fee-floor like every other tx).
  const claim = useCallback(async () => {
    setError(null);
    setTxHash(null);
    if (!rewards) {
      setError("The rewards contract is not deployed yet.");
      return;
    }
    const provider = wcProvider ?? window.ethereum;
    if (!provider || !address) {
      setError("Connect your wallet first.");
      return;
    }
    setBusy(true);
    setStatus("claim() — sending…");
    try {
      const walletClient = createWalletClient({
        chain: arcTestnet,
        transport: custom(provider),
      });
      const fees = await computeFees();
      const hash = await walletClient.writeContract({
        account: address,
        address: rewards,
        abi: REWARDS_ABI,
        functionName: "claim",
        args: [],
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setTxHash(hash);
      setStatus("claim submitted. Waiting…");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
      if (receipt.status === "success") {
        setStatus(`Claimed pending USDC rewards (block ${receipt.blockNumber}).`);
      } else {
        setError("claim transaction reverted on-chain.");
        setStatus("");
      }
      await afterMutation();
    } catch (e) {
      setError(humanizeTxError(e instanceof Error ? e.message : "claim failed"));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [address, rewards, wcProvider, afterMutation]);

  // -------------------------------------------------------------- derive

  const stakedIds = useMemo(
    () => new Set((stakes ?? []).map((row) => Number(row.tokenId))),
    [stakes],
  );
  const availableCards = useMemo(
    () => (cards ?? []).filter((id) => !stakedIds.has(id)),
    [cards, stakedIds],
  );
  const activeTokenId = useMemo(
    () => (/^\d+$/.test(tokenIdInput.trim()) ? BigInt(tokenIdInput.trim()) : null),
    [tokenIdInput],
  );
  const selectedTierInfo = tierById(selectedTier);

  // Wall clock for lock math; falls back to "now" before the ticker has fired.
  const now = nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);

  const discountText = discountBits === null ? "—" : `${discountBits} bits`;

  return (
    <main className="container">
      <h1>Stake Architectors</h1>
      <p className="muted">
        Lock an Architector in the staking vault to gain a PoW discount on mining
        difficulty and a place in the future weights pool. The vault only holds
        the NFT and returns it to the staker. No payments, no rarity weights
        (v1).
      </p>

      {/* --------------------------------------------------------- wallet */}
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
          <span className="k">Vault</span>
          <span className="v small">{vault ?? "not deployed"}</span>
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
                Refresh{refreshCooldown > 0 ? ` (${refreshCooldown}s)` : ""}
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

      {!vault && (
        <div className="banner warn">
          The staking vault is not deployed yet.{" "}
          <span className="mono">NEXT_PUBLIC_VAULT_ADDRESS</span> is unset, so
          stake/unstake is disabled — everything else on this page still works.
        </div>
      )}

      {/* ---------------------------------------------- my cards + stake */}
      {!vault ? null : (
        <div className="panel">
          <h2>Stake a card</h2>

          <p className="muted small">
            Available cards are found by scanning the first {SCAN_CAP} minted
            tokens (lazy, concurrency {SCAN_CONCURRENCY}) for ids you own that
            are not already staked. You can also type a token id directly.
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
                {availableCards.length} available card
                {availableCards.length === 1 ? "" : "s"}
                {scanTotal > 0 ? ` (of ${scanTotal} scanned)` : ""}
              </span>
            )}
          </div>

          {address && availableCards.length > 0 && (
            <div className="card-chips">
              {availableCards.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`chip chip-card${tokenIdInput === String(id) ? " active" : ""}`}
                  onClick={() => setTokenIdInput(String(id))}
                >
                  <CardThumb id={id} size={40} />
                  <span className="chip-card-label">#{id}</span>
                </button>
              ))}
            </div>
          )}

          <div className="field">
            <label className="muted small" htmlFor="stake-token">
              Token id (manual fallback)
            </label>
            <input
              id="stake-token"
              type="text"
              placeholder="e.g. 7"
              value={tokenIdInput}
              onChange={(e) => setTokenIdInput(e.target.value.trim())}
            />
            {activeTokenId !== null && (
              <CardThumb id={activeTokenId} size={40} />
            )}
          </div>

          <h3 className="subtle-head">Tier</h3>
          <table className="tier-table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Lock</th>
                <th>Weight ×10</th>
                <th>Discount</th>
                <th aria-label="select" />
              </tr>
            </thead>
            <tbody>
              {STAKE_TIERS.map((t) => (
                <tr
                  key={t.id}
                  className={selectedTier === t.id ? "active" : undefined}
                >
                  <td className="mono">{t.label}</td>
                  <td className="small muted">
                    {t.lockDays === 0 ? "flexible" : `${t.lockDays}d`}
                  </td>
                  <td className="mono">{t.weightX10}</td>
                  <td className="mono">{t.bits} bits</td>
                  <td>
                    <button
                      type="button"
                      className={`chip${selectedTier === t.id ? " active" : ""}`}
                      onClick={() => setSelectedTier(t.id)}
                    >
                      {selectedTier === t.id ? "selected" : "select"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="muted small" style={{ marginTop: 8 }}>
            Selected tier:{" "}
            <span className="mono">
              {tierLabel(selectedTier)}
              {selectedTierInfo ? ` · weight ×10 ${selectedTierInfo.weightX10} · ${selectedTierInfo.bits} bits discount` : ""}
            </span>
            . Tier is fixed at stake time; changing it requires unstaking after
            the term ends.
          </p>

          <div className="banner warn">
            {selectedTierInfo && selectedTierInfo.lockDays > 0 ? (
              <>
                Hard lock: this stake locks the card for{" "}
                <strong>{selectedTierInfo.lockDays} days</strong>. It cannot be
                withdrawn before the term ends — there is no early exit.
              </>
            ) : (
              <>
                Flexible (tier 0): the card can be unstaked at any time. A
                longer term earns more weight — but it is a hard lock with no
                early exit.
              </>
            )}
          </div>

          <div className="field">
            <button
              className="primary"
              onClick={() => activeTokenId !== null && stake(activeTokenId, selectedTier)}
              disabled={activeTokenId === null || busy || !address || wrongChain}
            >
              {busy
                ? "Working…"
                : activeTokenId !== null
                  ? `Stake #${activeTokenId} (${tierLabel(selectedTier)})`
                  : "Stake"}
            </button>
          </div>

          <p className="muted small" style={{ marginTop: 12 }}>
            Fee floor {FEE_FLOOR_GWEI} gwei; every tx uses{" "}
            <span className="mono">
              maxFeePerGas = max({FEE_FLOOR_GWEI} gwei, 2×baseFee)
            </span>{" "}
            with priority = half. If the vault is not yet approved for the
            card, an <span className="mono">approve()</span> tx is sent first
            and awaited, then <span className="mono">stake()</span>.
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
      )}

      {/* --------------------------------------------------- rewards (v1.1) */}
      {rewards && (
        <div className="panel">
          <h2>Rewards</h2>
          {rewardsError && (
            <div className="banner error">
              Could not read pending rewards: {rewardsError}
            </div>
          )}
          <div className="stat-grid">
            <div className="stat">
              <div className="label">Pending (claimable USDC)</div>
              <div className="value">
                {!address ? "—" : pending === null ? "…" : formatUsdc(pending)}
              </div>
            </div>
            <div className="stat">
              <div className="label">State</div>
              <div className="value">
                {!address
                  ? "not connected"
                  : pending !== null && pending > 0n
                    ? "accruing"
                    : "idle"}
              </div>
            </div>
          </div>
          <div className="field">
            <button
              className="primary"
              onClick={claim}
              disabled={
                !address ||
                wrongChain ||
                busy ||
                pending === null ||
                pending === 0n
              }
            >
              {busy ? "Working…" : "Claim"}
            </button>
            {address && pending === 0n && (
              <span className="muted small">
                Nothing to claim yet — income accrues per second.
              </span>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            Income streams continuously; claim anytime. Pending accrues per
            second from the pool forwarded to{" "}
            <span className="mono">StakeRewards</span>, proportional to your card
            weight. Claim pays native USDC (fee-floor like every other tx).
          </p>
        </div>
      )}

      {/* --------------------------------------------------- PoW discount */}
      <div className="panel">
        <h2>PoW discount</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">PoW discount (your boost)</div>
            <div className="value">{address ? discountText : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Core cap</div>
            <div className="value">{MAX_DISCOUNT_BITS} bits</div>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          Read from{" "}
          <span className="mono">stakingDiscountBits(wallet)</span> on the core
          contract: the max over your active stakes (one high-tier card is
          enough — stacking more cards does not add bits). It shaves up to{" "}
          {MAX_DISCOUNT_BITS} bits off streak and wave penalties while mining,
          but the target never drops below the base &quot;wave-1&quot; floor —
          so at wave 1 the discount protects you against the +2-bit streak
          steps instead of lowering base difficulty. On a v3 core (no staking
          hook) this reads as “—” by design.
        </p>
      </div>

      {!vault ? null : (
        <>
          {/* ----------------------------------------------- vault stats */}
          <div className="panel">
            <h2>Vault</h2>
            {vaultError && (
              <div className="banner error">
                Could not read the vault: {vaultError}
              </div>
            )}
            <div className="stat-grid">
              <div className="stat">
                <div className="label">Total stakes</div>
                <div className="value">
                  {vaultStats ? vaultStats.stakeCount.toString() : "…"}
                </div>
              </div>
              <div className="stat">
                <div className="label">Stake paused</div>
                <div className="value">
                  {vaultStats ? (vaultStats.paused ? "yes" : "no") : "…"}
                </div>
              </div>
              <div className="stat">
                <div className="label">Your weight ×10</div>
                <div className="value">
                  {address && weight !== null ? weight.toString() : "—"}
                </div>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Weight = Σ per card (lock ×10 × rarity bps / 10000), read from{" "}
              <span className="mono">vault.weightOf(wallet)</span>. Rarity bps
              come from the RarityRegistry attestation (×1.0 → ×3.0).
            </p>
            {vaultStats?.paused && (
              <div className="banner warn">
                Staking is currently paused. Unstaking is never blocked.
              </div>
            )}
          </div>

          {/* ----------------------------------------------- my stakes */}
          <div className="panel">
            <h2>My stakes</h2>
            {!address ? (
              <div className="banner">Connect your wallet to see your stakes.</div>
            ) : stakesLoading && stakes === null ? (
              <div className="banner">Loading your stakes…</div>
            ) : stakes && stakes.length > 0 ? (
              <>
                <div className="banner warn">
                  Cards are <strong>hard-locked</strong>: once staked, a card
                  stays in the vault until the end of the chosen term and cannot
                  be withdrawn earlier. Only tier 0 (flexible) cards can be
                  unstaked at any time.
                </div>
                <div className="stake-list">
                  {stakes.map((row) => {
                    const info = tierById(row.tier);
                    const lockDays = info?.lockDays ?? 0;
                    const lockEnd = unlockAt(row.stakedAt, lockDays);
                    const locked = isLocked(row.stakedAt, lockDays, now);
                    const rowRarity = rarityTiers[row.tokenId.toString()] ?? 0;
                    return (
                      <div className="stake-row" key={row.tokenId.toString()}>
                        <div className="stake-row-main">
                          <CardThumb id={row.tokenId} size={56} />
                          <div className="stake-row-body">
                            <div className="stake-row-head">
                              <span className="mono">#{row.tokenId.toString()}</span>
                              <span className="pill">{tierLabel(row.tier)}</span>
                              <span
                                className={`tier-badge ${rarityTierClass(rowRarity)}`}
                                title={
                                  registry
                                    ? "Attested rarity tier (RarityRegistry)"
                                    : "No RarityRegistry configured — shown as Standard"
                                }
                              >
                                {rarityLabel(rowRarity)}
                              </span>
                              <span className={`pill ${locked ? "off" : "ok"}`}>
                                {locked ? "locked" : "flexible"}
                              </span>
                            </div>
                            <div className="row">
                              <span className="k">Staked</span>
                              <span className="v small">
                                {formatUnixDate(row.stakedAt)}
                              </span>
                            </div>
                            <div className="row">
                              <span className="k">Withdrawal</span>
                              <span className="v small">
                                {locked
                                  ? `Locked until ${formatUnixDateTime(lockEnd)}`
                                  : "Flexible — withdraw anytime"}
                              </span>
                            </div>
                            <div className="row">
                              <span className="k">
                                Accrued (weight-seconds, pool v1.1)
                              </span>
                              <span className="v small">
                                {row.accruedNow.toString()}
                              </span>
                            </div>
                            <div className="row">
                              <span className="k">
                                Weight ×10 (this card · {rarityLabel(rowRarity)})
                              </span>
                              <span className="v small">
                                {cardWeightX10(row.tier, rowRarity)}
                              </span>
                            </div>
                            <div className="field">
                              <button
                                className="primary"
                                onClick={() => unstake(row.tokenId)}
                                disabled={busy || wrongChain || locked}
                                title={
                                  locked
                                    ? `Locked until ${formatUnixDateTime(lockEnd)} — no early exit`
                                    : "Withdraw your card"
                                }
                              >
                                Unstake
                              </button>
                              {locked && (
                                <span className="muted small">
                                  Locked until {formatUnixDateTime(lockEnd)}.
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="banner">
                No active stakes. Stake one of your cards above.
              </div>
            )}
          </div>

        </>
      )}
    </main>
  );
}
