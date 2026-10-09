// The only place that reads build-time settings. Every value here is PUBLIC: Vite copies VITE_* variables into the browser bundle,
// so never put a secret in one. (A contract address and a chain id are public by nature.)
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || '';
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID) || 0;

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
