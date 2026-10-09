// The multi-step actions that involve the officer's wallet, as plain functions so they can be tested without a browser.
// Each reports progress through onStatus, throws a FlowError whose message is meant to be shown as it is, and records a wallet
// refusal with the server so the document is not left looking half-issued.
import { anchorOnChain, revokeOnChain, isUserRejection, WalletError } from './chain';
import { chainPending, chainConfirmed, chainFailed, confirmRevocation, errorMessage, isUnauthorized } from './api';

export class FlowError extends Error {
  constructor(message, { unauthorized = false, rejected = false } = {}) {
    super(message);
    this.name = 'FlowError';
    this.unauthorized = unauthorized;
    this.rejected = rejected;
  }
}

function asFlowError(err) {
  if (err instanceof FlowError) return err;
  if (isUnauthorized(err)) return new FlowError('Your session has ended. Please log in again.', { unauthorized: true });
  if (err instanceof WalletError) return new FlowError(err.message);
  // ethers puts the readable reason in shortMessage (message is long and carries raw call data)
  if (!err?.response && err?.shortMessage) return new FlowError(err.shortMessage);
  return new FlowError(errorMessage(err));
}

/**
 * Anchor an uploaded document on the blockchain: wallet signs, the server is told, the network confirms, the server checks the chain.
 * @param {{documentId: string, contentHash: string, sha256: string}} doc
 * @returns {Promise<{state: 'issued'|'pending'|'failed', document: object}>}
 */
export async function runAnchorFlow(doc, onStatus = () => {}) {
  if (!doc.contentHash) throw new FlowError('This document has no content hash, so it cannot be anchored. Upload it again together with its details.');
  let tx;
  try {
    onStatus('Waiting for your wallet to sign…');
    tx = await anchorOnChain({ contentHash: doc.contentHash, byteHash: doc.sha256 });
  } catch (err) {
    // nothing was sent: say so, so the record is not left looking half-issued
    const rejected = isUserRejection(err);
    await chainFailed(doc.documentId, rejected ? 'USER_REJECTED' : 'CLIENT_ERROR').catch(() => {});
    throw rejected ? new FlowError('Signature rejected in the wallet.', { rejected: true }) : asFlowError(err);
  }
  try {
    onStatus('Recording the transaction…');
    await chainPending(doc.documentId, tx.hash);
    onStatus('Waiting for the network to confirm…');
    await tx.wait();
    onStatus('Checking it on the blockchain…');
    return await chainConfirmed(doc.documentId, tx.hash);
  } catch (err) {
    throw asFlowError(err);
  }
}

/**
 * Revoke an issued document: the wallet sends revoke(), the server reads the chain and only then records it.
 * @returns {Promise<{state: 'revoked'|'pending'|'failed', document: object}>}
 */
export async function runRevokeFlow(doc, reason, onStatus = () => {}) {
  let tx;
  try {
    onStatus('Waiting for your wallet to sign…');
    tx = await revokeOnChain({ contentHash: doc.contentHash, reason });
  } catch (err) {
    throw isUserRejection(err) ? new FlowError('Signature rejected in the wallet.', { rejected: true }) : asFlowError(err);
  }
  try {
    onStatus('Waiting for the network to confirm…');
    await tx.wait();
    onStatus('Checking it on the blockchain…');
    return await confirmRevocation(doc.documentId, tx.hash);
  } catch (err) {
    throw asFlowError(err);
  }
}
