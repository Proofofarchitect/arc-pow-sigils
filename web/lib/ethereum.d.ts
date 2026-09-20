/**
 * Minimal EIP-1193 provider typing for `window.ethereum`.
 * Kept dependency-light (no wagmi / walletconnect) — the mine page talks to the
 * injected provider directly.
 */
export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: unknown[] | object;
  }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}
