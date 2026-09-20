import { formatUnits } from "viem";

/**
 * The native gas token is USDC with 18 decimals, so token "wei" values use the
 * same 18-decimal scale as ETH. These helpers format a uint256 wei amount into a
 * human USDC string and back.
 */

export const USDC_DECIMALS = 18;

export function formatUsdc(wei: bigint, maxFractionDigits = 6): string {
  const raw = formatUnits(wei, USDC_DECIMALS);
  if (!raw.includes(".")) return raw;

  const [whole, fraction] = raw.split(".");
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");

  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

/** Short address: 0x1234…abcd */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
