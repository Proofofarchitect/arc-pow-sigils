import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "./arc";
import { rpcFetch } from "./rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "./contract";
import { getOnChainToken } from "./chain";
import { readDisplaySeed } from "./display-seed";
import {
  HOUSE_CARD_SLOTS,
  attributeMap,
  deriveAttributes,
  type DerivedAttributes,
} from "./traits";
import { ARC_TRAITS_SLOTS, deriveAttributesV2 } from "./traits_v2";
import { IS_V2 } from "./traits-set";
import {
  informationContent,
  tierForScore,
  type RarityTier,
} from "./rarity";
import { informationContentV2, tierForScoreV2 } from "./rarity_v2";
import { deriveHC2, deriveHC2V2, type Hc2Choice } from "./hc2";

/**
 * hc2chain.ts — crafted-token (id ≥ FORGE_ID_BASE) resolution for the web API.
 *
 * A crafted token's traits come from HC/2 derivation (§2 of `HC/2 spec`),
 * which needs the `choices` the player committed — these are NOT stored on-chain
 * outside the controller's `Crafted` event. This module recovers them:
 *
 *   1. read `seedOf(tokenId)` from the core — that IS the `childSeed`;
 *   2. scan the CraftingController's `Crafted` logs and match the log whose
 *      `childSeed` equals the token's seed (childSeed is non-indexed, so we
 *      cannot topic-filter — we page `getLogs` in bounded chunks and filter);
 *   3. read the parents' `seedOf` (they are burned, but the core keeps the seed
 *      mapping after `_burn` — verified in `PowMintNFTv3_1.sol` / `ERC721Minimal.sol`);
 *   4. derive the 15 final slots via `deriveHC2(childSeed, seedLow, seedHigh,
 *      choices)` (house-card/1) or `deriveHC2V2(...)` (ARC-traits/2) depending on
 *      the active trait set. `childSeed` (§1) is trait-set independent — the
 *      `choices` are the only trait-set-specific input, and they live only in
 *      the `Crafted` event.
 *
 * Everything is cached in-memory (Map + TTL, `globalThis`-backed like
 * `lib/chain.ts`) so a page/API burst does not re-run the log scan.
 */

/** Forged token ids live in `[FORGE_ID_BASE, …)` (core: `FORGE_ID_BASE`). */
export const FORGE_ID_BASE = 10_000_000n;

/** True when `id` belongs to the forged/crafted namespace. */
export function isCraftedId(id: bigint): boolean {
  return id >= FORGE_ID_BASE;
}

/**
 * CraftingController address. Unset (`NEXT_PUBLIC_CRAFT_ADDRESS` empty) means
 * the controller is not deployed for this build — crafted-token resolution
 * returns `null` and callers use the documented fallback.
 */
export const CRAFT_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_CRAFT_ADDRESS?.trim() as Address | undefined) || null;

/** True when a CraftingController is configured for this build. */
export function craftConfigured(): boolean {
  return CRAFT_ADDRESS !== null;
}

/**
 * Optional lower bound for the `Crafted` log scan (block number as a decimal
 * string). Defaults to 0 (genesis). Set it to the controller's deploy block to
 * keep the scan cheap on a long chain.
 */
const CRAFT_FROM_BLOCK: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_CRAFT_FROM_BLOCK?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
})();

const CACHE_TTL_MS = 60_000;
/** Blocks per `getLogs` page. */
const CHUNK_SIZE = 10_000n;
/** Hard cap on the number of `getLogs` pages per scan (bounded RPC budget). */
const MAX_CHUNKS = 200n;

/** The controller's `Crafted` event — v2 one-shot shape (no commitId / entropy). */
const CRAFTED_EVENT = parseAbiItem(
  "event Crafted(uint256 indexed childId, address indexed player, uint256 cardA, uint256 cardB, bytes32 childSeed, uint8 boostTier, uint256 fee)",
);

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
});

/** One decoded `Crafted` log. `childSeed` here is the v2 PRE-seed (no choices). */
type CraftedRecord = {
  childId: bigint;
  player: Address;
  cardA: bigint;
  cardB: bigint;
  childSeed: Hex;
  boostTier: number;
  fee: bigint;
  /** Tx that forged this child — its `craft(...)` calldata carries `choices`. */
  txHash: Hex;
};

export type CraftedTokenResolution = {
  /** The child's DISPLAY seed (pre-seed mixed with blockhash(mintBlock+2)). */
  childSeed: Hex;
  choices: Hc2Choice[];
  attributes: Record<string, string>;
  golden: boolean;
  /** `[minId, maxId]` — parents canonicalized by tokenId (F-04). */
  parentIds: [bigint, bigint];
  /** Parents' DISPLAY seeds (their art attributes derive from these). */
  seedLow: Hex;
  seedHigh: Hex;
};

// ---------------------------------------------------------------------------
// caches (globalThis-backed so Next.js route hot-reloads keep them)
// ---------------------------------------------------------------------------

type CachedResolution = { expiresAt: number; value: CraftedTokenResolution | null };
type CachedIndex = { expiresAt: number; records: Map<string, CraftedRecord> };

const store = globalThis as typeof globalThis & {
  __arcHc2ResolutionCache?: Map<string, CachedResolution>;
  __arcHc2CraftedIndex?: CachedIndex;
  __arcHc2CraftedIndexPending?: Promise<Map<string, CraftedRecord>>;
};

const resolutionCache =
  store.__arcHc2ResolutionCache ??
  (store.__arcHc2ResolutionCache = new Map<string, CachedResolution>());

async function readRawSeed(id: bigint): Promise<Hex | null> {
  try {
    return await publicClient.readContract({
      address: getAddress(CONTRACT_ADDRESS),
      abi: POW_MINT_NFT_ABI,
      functionName: "seedOf",
      args: [id],
    });
  } catch {
    return null;
  }
}

/**
 * The `craft` calldata ABI (v2 one-shot). Used to recover the player's chosen
 * inherited slots from the forging transaction — the `Crafted` event does not
 * carry them.
 */
const CRAFT_FN_ABI = parseAbi([
  "function craft(uint256 cardA, uint256 cardB, (uint8 slot, uint8 parent)[] choices, uint8 boostTier) payable",
]);

/**
 * Recover the inherited-slot choices for a craft from its transaction calldata.
 * Returns `null` when the tx cannot be fetched/decoded (then HC/2 resolution
 * falls back to a plain derivation of the display seed).
 */
async function readCraftChoices(txHash: Hex): Promise<Hc2Choice[] | null> {
  try {
    const tx = await publicClient.getTransaction({ hash: txHash });
    const decoded = decodeFunctionData({ abi: CRAFT_FN_ABI, data: tx.input });
    if (decoded.functionName !== "craft") return null;
    const rawChoices = decoded.args[2] as readonly { slot: number; parent: number }[];
    return rawChoices.map((choice) => ({
      slot: Number(choice.slot),
      parent: Number(choice.parent) === 1 ? 1 : 0,
    }));
  } catch {
    return null;
  }
}

/**
 * Page the controller's `Crafted` logs (bounded: ≤ `MAX_CHUNKS` × `CHUNK_SIZE`
 * blocks) and index them by lowercased `childSeed`. Individual chunk failures
 * (provider range/limit errors) are tolerated — that chunk is skipped so a
 * partial index still resolves the crafts it did see.
 *
 * Windowing: if `latest − from` exceeds the cap, the scan starts at the newest
 * `MAX_CHUNKS × CHUNK_SIZE` blocks instead of genesis (documented boundary).
 */
async function scanCraftedLogs(): Promise<Map<string, CraftedRecord>> {
  const records = new Map<string, CraftedRecord>();
  if (!CRAFT_ADDRESS) return records;

  const address = getAddress(CRAFT_ADDRESS);
  const latest = await publicClient.getBlockNumber();

  let from = CRAFT_FROM_BLOCK;
  const maxSpan = MAX_CHUNKS * CHUNK_SIZE;
  if (latest > from && latest - from > maxSpan) {
    from = latest - maxSpan + 1n;
  }

  for (
    let start = from, chunks = 0n;
    start <= latest && chunks < MAX_CHUNKS;
    start += CHUNK_SIZE, chunks++
  ) {
    const end = start + CHUNK_SIZE - 1n > latest ? latest : start + CHUNK_SIZE - 1n;

    try {
      const logs = await publicClient.getLogs({
        address,
        event: CRAFTED_EVENT,
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        const args = log.args;
        if (!args || !args.childSeed) continue;
        if (
          args.childId === undefined ||
          args.player === undefined ||
          args.cardA === undefined ||
          args.cardB === undefined ||
          args.boostTier === undefined ||
          args.fee === undefined
        ) {
          continue;
        }

        records.set(args.childSeed.toLowerCase(), {
          childId: args.childId,
          player: args.player,
          cardA: args.cardA,
          cardB: args.cardB,
          childSeed: args.childSeed,
          boostTier: Number(args.boostTier),
          fee: args.fee,
          txHash: log.transactionHash,
        });
      }
    } catch {
      // Tolerate provider limits: skip this chunk, keep the rest of the scan.
    }
  }

  return records;
}

function loadCraftedIndex(): Promise<Map<string, CraftedRecord>> {
  const cached = store.__arcHc2CraftedIndex;
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.records);
  }
  if (store.__arcHc2CraftedIndexPending) {
    return store.__arcHc2CraftedIndexPending;
  }

  const pending = scanCraftedLogs()
    .then((records) => {
      store.__arcHc2CraftedIndex = {
        records,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      store.__arcHc2CraftedIndexPending = undefined;
      return records;
    })
    .catch((error) => {
      store.__arcHc2CraftedIndexPending = undefined;
      throw error;
    });

  store.__arcHc2CraftedIndexPending = pending;
  return pending;
}

/**
 * Resolve a crafted token's HC/2 traits, or `null` when resolution is not
 * possible (controller unset, no matching `Crafted` log, or a parent seed is
 * unavailable). Cached per token for `CACHE_TTL_MS`.
 */
export async function resolveCraftedToken(
  tokenId: bigint,
): Promise<CraftedTokenResolution | null> {
  if (!isCraftedId(tokenId)) return null;
  if (!CRAFT_ADDRESS) return null;

  const cacheKey = tokenId.toString();
  const cached = resolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value: CraftedTokenResolution | null = null;

  try {
    // Match the `Crafted` event by the RAW child pre-seed (`seedOf[childId]`,
    // which is exactly `Crafted.childSeed`). Post-inclusion entropy is added on
    // top to form the DISPLAY seed fed to the derivation.
    const preSeed = await readRawSeed(tokenId);

    if (preSeed && preSeed !== zeroHash) {
      const index = await loadCraftedIndex();
      const record = index.get(preSeed.toLowerCase());

      if (record) {
        // The `Crafted` event carries no choices — recover them from the tx
        // calldata, and read each parent's DISPLAY seed (their art attributes
        // derive from those, not from the raw `seedOf` the pre-seed packed).
        const [child, parentA, parentB, choices] = await Promise.all([
          readDisplaySeed(publicClient, tokenId),
          readDisplaySeed(publicClient, record.cardA),
          readDisplaySeed(publicClient, record.cardB),
          readCraftChoices(record.txHash),
        ]);

        // Parents are burned, but the core keeps `seedOf`/`mintBlockOf` after
        // `_burn`. If a seed is unavailable or any display seed is still
        // pending (mintBlock + 2 not yet mined) we cannot derive → fallback.
        if (
          choices &&
          !child.pending &&
          !parentA.pending &&
          !parentB.pending
        ) {
          const aIsLow = record.cardA < record.cardB;
          const seedLow = aIsLow ? parentA.displaySeed : parentB.displaySeed;
          const seedHigh = aIsLow ? parentB.displaySeed : parentA.displaySeed;
          const parentIds: [bigint, bigint] = aIsLow
            ? [record.cardA, record.cardB]
            : [record.cardB, record.cardA];

          const derived = IS_V2
            ? deriveHC2V2(child.displaySeed, seedLow, seedHigh, choices)
            : deriveHC2(child.displaySeed, seedLow, seedHigh, choices);

          value = {
            childSeed: child.displaySeed,
            choices,
            attributes: derived.attributes,
            golden: derived.golden,
            parentIds,
            seedLow,
            seedHigh,
          };
        }
      }
    }
  } catch {
    value = null;
  }

  resolutionCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return value;
}

/**
 * Build the shared `DerivedAttributes` shape from an HC/2 slot→value record.
 * The slot layout follows the active trait set (house-card/1 vs ARC-traits/2),
 * so the record is mapped onto the matching slot list.
 */
function derivedFromRecord(
  values: Record<string, string>,
  golden: boolean,
): DerivedAttributes {
  const slots = IS_V2 ? ARC_TRAITS_SLOTS : HOUSE_CARD_SLOTS;
  return {
    attributes: slots.map((slot) => ({
      slot: slot.name,
      value: values[slot.name] ?? "None",
    })),
    golden,
  };
}

function rarityForDerived(derived: DerivedAttributes): {
  score: number;
  tier: RarityTier;
} {
  const attrs = attributeMap(derived);
  if (IS_V2) {
    const score = informationContentV2(attrs);
    return { score, tier: tierForScoreV2(score) };
  }
  const score = informationContent(attrs);
  return { score, tier: tierForScore(score) };
}

export type TokenTraits = {
  /** True for ids ≥ FORGE_ID_BASE. */
  crafted: boolean;
  /**
   * `"ok"` when the traits are authoritative for this token (mint derivation or
   * a successful HC/2 resolution); `"unavailable"` when a crafted token's HC/2
   * lookup failed and we fell back to plain house-card/1 derivation of the seed.
   */
  craftedLookup: "ok" | "unavailable";
  seed: Hex;
  derived: DerivedAttributes;
  rarity: { score: number; tier: RarityTier };
};

/**
 * Unified trait resolution for a token id, used by the meta/image routes:
 *
 * * id < FORGE_ID_BASE → the active-set derivation path (`deriveAttributes` for
 *   house-card/1, `deriveAttributesV2` for ARC-traits/2);
 * * id ≥ FORGE_ID_BASE → HC/2 via `resolveCraftedToken` (v1 or v2 derivation
 *   per the active trait set); on failure the documented fallback runs plain
 *   derivation of `childSeed` and the result carries `crafted: true` +
 *   `craftedLookup: "unavailable"` (so callers can flag it) — `crafted: true` +
 *   `craftedLookup: "ok"` on success.
 *
 * Rarity is computed from the derived attributes via `informationContent` +
 * `tierForScore` (works for any trait dict — never `rarityForSeed` for crafted
 * tokens, whose traits are not a plain function of `childSeed`).
 *
 * Reads `seedOf`/`mintBlockOf`/`ownerOf` through `getOnChainToken` (60s cache),
 * so an unminted id still throws and callers map it to a 404 exactly as before.
 */
export async function getTraitsForToken(tokenId: bigint): Promise<TokenTraits> {
  const token = await getOnChainToken(tokenId);

  if (!isCraftedId(tokenId)) {
    const derived = IS_V2
      ? deriveAttributesV2(token.displaySeed)
      : deriveAttributes(token.displaySeed);
    return {
      crafted: false,
      craftedLookup: "ok",
      seed: token.displaySeed,
      derived,
      rarity: rarityForDerived(derived),
    };
  }

  // Crafted ids (both trait sets) resolve via the HC/2 path below; the
  // derivation branch is selected inside `resolveCraftedToken`.
  const resolved = await resolveCraftedToken(tokenId);

  if (resolved) {
    const derived = derivedFromRecord(resolved.attributes, resolved.golden);
    return {
      crafted: true,
      craftedLookup: "ok",
      seed: token.displaySeed,
      derived,
      rarity: rarityForDerived(derived),
    };
  }

  // Documented fallback: HC/2 resolution unavailable (tx calldata undecodable,
  // seed pending, or no matching Crafted log) → deterministic plain derivation
  // of the child's DISPLAY seed under the active trait set (house-card/1 or
  // ARC-traits/2). Traits will NOT match the crafted card;
  // `craftedLookup: "unavailable"` lets the UI/API say so.
  const derived = IS_V2
    ? deriveAttributesV2(token.displaySeed)
    : deriveAttributes(token.displaySeed);
  return {
    crafted: true,
    craftedLookup: "unavailable",
    seed: token.displaySeed,
    derived,
    rarity: rarityForDerived(derived),
  };
}
