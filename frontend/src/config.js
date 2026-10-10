// The only place that reads build-time settings. Every value here is PUBLIC: Vite copies VITE_* variables into the browser bundle,
// so never put a secret in one. (A contract address and a chain id are public by nature.)
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || '';
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID) || 0;

/**
 * Whether the QR code appears in the interface. Off by default: it is an extra
 * step in a demo, and verification never depends on it — the document is always
 * re-read and its hash recomputed, so a QR adds confirmation, not authority.
 *
 * This hides the UI only. The backend keeps the entire capability and its tests,
 * including the one that matters most: a genuine QR photocopied onto a forgery
 * is still rejected. Turn it back on with VITE_SHOW_QR=true — no code change.
 */
export const SHOW_QR = String(import.meta.env.VITE_SHOW_QR) === 'true';

const EXPLORERS = {
  1: 'https://etherscan.io',
  137: 'https://polygonscan.com',
  80002: 'https://amoy.polygonscan.com',
  11155111: 'https://sepolia.etherscan.io',
};

/** A link to a transaction on a block explorer, or null on a network that has none (a local test chain). */
export function explorerTxUrl(chainId, txHash) {
  const base = EXPLORERS[Number(chainId)];
  return base && /^0x[0-9a-fA-F]{64}$/.test(String(txHash || '')) ? `${base}/tx/${txHash}` : null;
}
