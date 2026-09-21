import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import { weightedPickFromSeed } from "./prng";
import {
  GOLDEN_CHECKS,
  GOLDEN_THRESHOLD,
  HOUSE_CARD_SLOTS,
  NONE,
  attributeMap,
  deriveAttributes,
} from "./traits";
import { ARC_TRAITS_SLOTS, deriveAttributesV2 } from "./traits_v2";

/**
 * HC/2 craft derivation — byte-for-byte TS mirror of `art/hc2.py`.
 *
 * Frozen specification: `HC/2 spec` v1 (§1 childSeed formula, §2 HC/2
 * derivation, §5 vectors/parity). The Python reference (`art/hc2.py`) is the
 * source of truth; `web/scripts/check-hc2.mjs` (`npm run check:hc2`) asserts
 * parity against `art/test_vectors_hc2.json` (75 vectors, 17 checks each).
 *
 * Notes
 * -----
 * * `traits.ts` keeps its `uint16Stream` private, so this module implements a
 *   local `uint16Stream` with identical rejection semantics: the raw word
 *   stream is `keccak256(seed ‖ uint8(slotIndex) ‖ uint16(counter))`, read as
 *   sixteen big-endian uint16 words, counter reset per slot. Wildcard picks go
 *   through the shared `weightedPickFromSeed` (`prng.ts`), so HC/2 wildcards
 *   are identical to a normal mint derivation for the same slot index. No file
 *   outside this module is modified to achieve parity.
 * * The v2 child PRE-seed is `keccak256(abi.encodePacked(...))` over the exact
 *   packed layout of §1; the string literal bytes are produced with viem
 *   `stringToHex("PoA_CRAFT_v2")` (12 bytes, unpadded). The DISPLAY seed fed to
 *   the derivation is `keccak256(preSeed ‖ blockhash(mintBlock + 2))`.
 * * Choice-able slots are 0..11; `legendary` (12) is ALWAYS derived from the
 *   display seed, and `golden`/`bug` conditional rules are evaluated on the FINAL
 *   values (inherited included), fed by display-seed word streams 13/14.
 * * ARC-traits/2 port (`deriveHC2V2`): identical inheritance semantics but over
 *   `ARC_TRAITS_SLOTS` with `deriveAttributesV2` parents. Choice-able slots are
 *   indices 0..11; indices 12/13/14 (quote/lore/hair_color) are always wildcard.
 *   The v2 set has no golden/bug conditional rules, so the result is always
 *   `{ attributes, golden: false }`. The pre-seed formula is trait-set
 *   independent (the choices live in the controller's `Crafted` calldata), so the
 *   §1 formula above is reused verbatim.
 */

export type Hc2Choice = { slot: number; parent: 0 | 1 };

/** Choice-able slot ceiling (spec §2 / RT-3): slots 0..11 inclusive. */
const CHOICEABLE_SLOTS = 11;

const GOLDEN_INDEX = slotByName("golden").index;
const BUG_SLOT = slotByName("bug");

function slotByName(name: string) {
  const slot = HOUSE_CARD_SLOTS.find((candidate) => candidate.name === name);
  if (!slot) throw new Error(`Unknown House Card slot: ${name}`);
  return slot;
}

/**
 * maxChosen = min(6 + 2·boostTier, 12) (spec §2/§4, RT-4).
 * boostTier 0..3 → 6/8/10/12 (tier 4 reserved for season-2 doors).
 */
export function maxChosen(boostTier: number): number {
  return Math.min(6 + 2 * boostTier, 12);
}

/**
 * §1 — child PRE-SEED = keccak256(abi.encodePacked(...)) over the frozen v2 layout:
 *
 *   "PoA_CRAFT_v2"    // 12-byte string, unpadded
 *   seedLow  bytes32   // parent with the SMALLER tokenId (RAW seedOf, as the contract packs it)
 *   seedHigh bytes32   // parent with the LARGER tokenId (RAW seedOf)
 *   uint256  minId     // 32B big-endian
 *   uint256  maxId     // 32B big-endian
 *   uint8    door      // 1B (0 = CRAFT_2_1, the only door in v2)
 *   uint8    boostTier // 1B
 *   uint64   craftNonce// 8B big-endian
 *   bytes32  choicesHash // keccak256(abi.encode(SlotChoice[])) — NO entropy
 *
 * The contract stores this as `seedOf[childId]` (the emitted `Crafted.childSeed`).
 * Post-inclusion entropy is added OFF-CHAIN: the display seed is
 * `keccak256(preSeed ‖ blockhash(mintBlockOf[childId] + 2))` (see
 * `computeDisplaySeed` / `lib/display-seed.ts`). `deriveHC2*` must be fed the
 * DISPLAY seed, never the pre-seed.
 *
 * NOTE: the on-chain pre-seed packs the RAW `seedOf` of both parents (the core
 * `seedOf` mapping), whereas the HC/2 derivation of the PARENTS' attributes uses
 * their display seeds — callers must not mix the two (see `hc2chain.ts`).
 */
export function computeChildSeed(p: {
  seedLow: Hex;
  seedHigh: Hex;
  minId: bigint;
  maxId: bigint;
  door?: number; // default 0 (CRAFT_2_1)
  boostTier: number;
  craftNonce: bigint;
  choices: Hc2Choice[];
}): Hex {
  const door = p.door ?? 0;
  return keccak256(
    concatHex([
      stringToHex("PoA_CRAFT_v2"),
      p.seedLow,
      p.seedHigh,
      toHex(p.minId, { size: 32 }),
      toHex(p.maxId, { size: 32 }),
      toHex(door, { size: 1 }),
      toHex(p.boostTier, { size: 1 }),
      toHex(p.craftNonce, { size: 8 }),
      encodeChoicesHash(p.choices),
    ]),
  );
}

/**
 * Post-inclusion display seed = keccak256(preSeed ‖ entropy), where `entropy`
 * is `blockhash(mintBlockOf[childId] + 2)`. Mirrors the core's off-chain seed
 * derivation (identical to `lib/display-seed.ts::deriveDisplaySeed`).
 */
export function computeDisplaySeed(preSeed: Hex, entropy: Hex): Hex {
  return keccak256(concatHex([preSeed, entropy]));
}

/**
 * keccak256(abi.encode((uint8,uint8)[])) — MUST match the contract's
 * `keccak256(abi.encode(choices))` (CraftingController.reveal). No domain
 * separation (frozen).
 */
export function encodeChoicesHash(choices: Hc2Choice[]): Hex {
  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "slot", type: "uint8" },
          { name: "parent", type: "uint8" },
        ],
      },
    ],
    [choices.map((c) => ({ slot: c.slot, parent: c.parent }))],
  );
  return keccak256(encoded);
}

/**
 * §2 — derive the 15 final HC/2 slots from the DISPLAY seed + parent DISPLAY seeds.
 *
 * `displaySeed` = `computeDisplaySeed(preSeed, blockhash(mintBlock+2))` (v3.4
 * post-inclusion entropy). `seedLow`/`seedHigh` are the parents' DISPLAY seeds
 * (their art attributes were derived from those), NOT the raw `seedOf` the
 * on-chain pre-seed packed.
 *
 * * Choice-able slot (0..11) in `choices`: inherit the chosen parent's value
 *   UNLESS both parents agree, in which case it becomes a wildcard.
 * * Every non-chosen slot AND `legendary` (12) is a wildcard:
 *   `weightedPickFromSeed(childSeed, slotIndex, weights)`.
 * * `golden`/`bug` follow the house-card/1 conditional rules on the FINAL
 *   values, fed by childSeed streams 13 (golden) and 14 (bug).
 */
export function deriveHC2(
  childSeed: Hex,
  seedLow: Hex,
  seedHigh: Hex,
  choices: Hc2Choice[],
): { attributes: Record<string, string>; golden: boolean } {
  const parentA = attributeMap(deriveAttributes(seedLow));
  const parentB = attributeMap(deriveAttributes(seedHigh));

  const chosen = new Map<number, 0 | 1>();
  for (const choice of choices) chosen.set(choice.slot, choice.parent);

  const values: Record<string, string> = {};

  for (const slot of HOUSE_CARD_SLOTS) {
    const name = slot.name;
    if (name === "golden" || name === "bug") continue; // conditional, resolved below

    const index = slot.index;
    if (index <= CHOICEABLE_SLOTS && chosen.has(index)) {
      const parent = chosen.get(index)!;
      const a = parentA[name];
      const b = parentB[name];
      if (a !== b) {
        values[name] = parent === 0 ? a : b;
        continue;
      }
      // Both parents agree -> wildcard (fall through).
    }

    values[name] = slot.values[
      weightedPickFromSeed(childSeed, index, slot.weights!)
    ];
  }

  const legendary = values["legendary"];
  const headwear = values["headwear"];
  const companion = values["companion"];

  // Golden: only when legendary == "None"; sequential 3% short-circuit checks.
  let goldenValue = NONE;
  if (legendary === NONE) {
    const stream = uint16Stream(childSeed, GOLDEN_INDEX);
    for (const check of GOLDEN_CHECKS) {
      const available = check.slot === "headwear" ? headwear : companion;
      if (available !== check.value) continue;
      const word = stream.next().value as number;
      if (word < GOLDEN_THRESHOLD) {
        goldenValue = check.event;
        break;
      }
    }
  }
  values["golden"] = goldenValue;

  // Bug: only when legendary == "None" AND golden missed.
  let bugValue = NONE;
  if (legendary === NONE && goldenValue === NONE) {
    const index = weightedPickFromSeed(childSeed, BUG_SLOT.index, BUG_SLOT.weights!);
    bugValue = BUG_SLOT.values[index];
  }
  values["bug"] = bugValue;

  return { attributes: values, golden: goldenValue !== NONE };
}

/**
 * ARC-traits/2 (§2) — derive the 15 final v2 slots from the DISPLAY seed + parents.
 *
 * `displaySeed` is the post-inclusion seed (§1 pre-seed mixed with the block
 * hash); `seedLow`/`seedHigh` are the parents' DISPLAY seeds.
 *
 * Mirrors `deriveHC2` but over `ARC_TRAITS_SLOTS` with `deriveAttributesV2`
 * parents and no golden/bug logic (the artist set has no such categories):
 *
 * * Choice-able slot (index 0..11) in `choices`: inherit the chosen parent's
 *   value UNLESS both parents agree, in which case it becomes a wildcard — the
 *   exact v1 rule, applied per-slot, `None` values included.
 * * Every non-chosen slot AND indices 12/13/14 (quote/lore/hair_color) are
 *   wildcards: `weightedPickFromSeed(childSeed, slot.index, slot.weights)`.
 *
 * `childSeed` is trait-set independent (the §1 formula is unchanged), so callers
 * reuse `computeChildSeed` / the on-chain child seed as-is.
 */
export function deriveHC2V2(
  childSeed: Hex,
  seedLow: Hex,
  seedHigh: Hex,
  choices: Hc2Choice[],
): { attributes: Record<string, string>; golden: boolean } {
  const parentA = attributeMap(deriveAttributesV2(seedLow));
  const parentB = attributeMap(deriveAttributesV2(seedHigh));

  const chosen = new Map<number, 0 | 1>();
  for (const choice of choices) chosen.set(choice.slot, choice.parent);

  const values: Record<string, string> = {};

  for (const slot of ARC_TRAITS_SLOTS) {
    const name = slot.name;
    const index = slot.index;
    if (index <= CHOICEABLE_SLOTS && chosen.has(index)) {
      const parent = chosen.get(index)!;
      const a = parentA[name];
      const b = parentB[name];
      if (a !== b) {
        values[name] = parent === 0 ? a : b;
        continue;
      }
      // Both parents agree -> wildcard (fall through).
    }

    values[name] = slot.values[
      weightedPickFromSeed(childSeed, index, slot.weights)
    ];
  }

  return { attributes: values, golden: false };
}

/**
 * Local port of the private `uint16Stream` in `traits.ts` (identical
 * rejection/consumption semantics). Each digest yields sixteen big-endian
 * uint16 words; the counter starts at 0 and increments only after a digest is
 * exhausted, so it is implicitly reset for every slot.
 */
function* uint16Stream(seed: Hex, slotIndex: number): Generator<number> {
  for (let counter = 0; counter <= 0xffff; counter++) {
    const slotHex = slotIndex.toString(16).padStart(2, "0");
    const counterHex = counter.toString(16).padStart(4, "0");
    const digest = keccak256(
      concatHex([seed, `0x${slotHex}` as Hex, `0x${counterHex}` as Hex]),
    );

    for (let wordIndex = 0; wordIndex < 16; wordIndex++) {
      const offset = 2 + wordIndex * 4;
      yield Number.parseInt(digest.slice(offset, offset + 4), 16);
    }
  }

  throw new Error("uint16 counter exhausted while deriving an attribute");
}
