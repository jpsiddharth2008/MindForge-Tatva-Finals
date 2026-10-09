// The officer's wallet talking to the CredentialRegistry. The browser never sees a private key: the wallet signs.
// The server separately checks, from the chain itself, what each transaction really did.
import { ethers } from 'ethers';
import ABI from './abi/CredentialRegistry.json';
import { CONTRACT_ADDRESS, CHAIN_ID } from './config';

/** An error whose message is meant to be shown to the officer as it is. */
export class WalletError extends Error {
  constructor(message) { super(message); this.name = 'WalletError'; }
}

export const chainConfigured = () => !!CONTRACT_ADDRESS;

/** The wallet saying "no" is a normal outcome, not a failure of the system. */
export const isUserRejection = (err) => err?.code === 'ACTION_REJECTED' || err?.code === 4001 || err?.info?.error?.code === 4001;

/** 64 lowercase hex characters (as the server sends them) become the 0x-prefixed bytes32 the contract wants. Anything else is refused. */
export function toBytes32(hex) {
  if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/.test(hex)) throw new WalletError('A document fingerprint is missing or malformed.');
  return `0x${hex}`;
}

async function contract(ethereum) {
  if (!CONTRACT_ADDRESS) throw new WalletError('The registry contract address is not configured (VITE_CONTRACT_ADDRESS).');
  if (!ethereum) throw new WalletError('No wallet found. Install a wallet such as MetaMask to sign.');
  const provider = new ethers.BrowserProvider(ethereum);
  const network = await provider.getNetwork();
  if (CHAIN_ID && Number(network.chainId) !== CHAIN_ID) {
    throw new WalletError(`Your wallet is connected to network ${network.chainId}. Switch it to network ${CHAIN_ID} and try again.`);
  }
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, await provider.getSigner());
}

/** Asks the wallet to send anchor(contentHash, byteHash). Resolves as soon as the transaction is sent; call .wait() to await mining. */
export async function anchorOnChain({ contentHash, byteHash }, ethereum = window.ethereum) {
  const registry = await contract(ethereum);
  return registry.anchor(toBytes32(contentHash), toBytes32(byteHash));
}

/** Asks the wallet to send revoke(contentHash, reason). Only the institution that issued the document can do this on chain. */
export async function revokeOnChain({ contentHash, reason }, ethereum = window.ethereum) {
  if (!reason || !reason.trim()) throw new WalletError('Give a reason for the revocation.');
  const registry = await contract(ethereum);
  return registry.revoke(toBytes32(contentHash), reason.trim().slice(0, 500));
}
