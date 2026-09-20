import { concatHex, keccak256, type Hex } from "viem";

/**
 * Rejection-sampled weighted selection using 16-bit values from Keccak output.
 *
 * For each trait slot:
 * - repeatCounter starts at 0.
 * - h = keccak256(seed || uint8(slotIndex) || uint16(repeatCounter)).
 * - h is read as sixteen big-endian uint16 values.
 * - Values outside the largest multiple of totalWeight below 65536 are rejected.
 * - When all 16 values are rejected, repeatCounter increments and a new hash is made.
 *
 * This avoids modulo bias while remaining deterministic.
 */
export function weightedPickFromSeed(
  seed: Hex,
  slotIndex: number,
  weights: readonly number[],
): number {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 255) {
    throw new Error("slotIndex must fit uint8");
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  if (
    totalWeight <= 0 ||
    totalWeight > 65_536 ||
    weights.some((weight) => !Number.isInteger(weight) || weight < 0)
  ) {
    throw new Error("Trait weights must be non-negative integers totaling 1..65536");
  }

  const acceptedRange = Math.floor(65_536 / totalWeight) * totalWeight;

  // repeatCounter is intentionally reset by the caller for every new slot.
  for (let repeatCounter = 0; repeatCounter <= 65_535; repeatCounter++) {
    const slotHex = slotIndex.toString(16).padStart(2, "0");
    const repeatHex = repeatCounter.toString(16).padStart(4, "0");

    const hash = keccak256(
      concatHex([seed, `0x${slotHex}` as Hex, `0x${repeatHex}` as Hex]),
    );

    // A bytes32 hash contains exactly 16 uint16 values.
    for (let wordIndex = 0; wordIndex < 16; wordIndex++) {
      const offset = 2 + wordIndex * 4;
      const candidate = Number.parseInt(hash.slice(offset, offset + 4), 16);

      // Rejection sampling prevents uneven modulo distribution.
      if (candidate >= acceptedRange) continue;

      const roll = candidate % totalWeight;
      let cumulativeWeight = 0;

      for (let traitIndex = 0; traitIndex < weights.length; traitIndex++) {
        cumulativeWeight += weights[traitIndex];

        if (roll < cumulativeWeight) {
          return traitIndex;
        }
      }
    }
  }

  throw new Error("Could not derive a weighted trait value");
}
