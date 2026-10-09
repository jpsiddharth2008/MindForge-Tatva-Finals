/**
 * Blockchain service — all chain interaction lives here.
 *
 * The private key never leaves this module. It is not returned by any API, not
 * logged, and not exposed to the frontend. Public verification is a read-only
 * call requiring no wallet, no gas, and no browser extension.
 */
const { ethers } = require("ethers");
const { state } = require("../config/blockchain");

/** Application-level error carrying a safe client message. */
class ChainError extends Error {
  constructor(code, message, { retryable = false, cause = null } = {}) {
    super(message);
    this.name = "ChainError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * Maps contract custom errors and node/provider failures onto stable
 * application codes with messages safe to show a user.
 *
 * Never let a raw ethers error reach the client — they embed RPC URLs and
 * sometimes credentials.
 */
const CONTRACT_ERRORS = {
  NotAuthorisedIssuer: ["NOT_AUTHORISED_ISSUER", "This wallet is not a registered issuing authority."],
  NotIssuingAuthority: ["NOT_ISSUING_AUTHORITY", "Only the institution that issued this document may revoke it."],
  AlreadyAnchored:     ["ALREADY_ANCHORED",      "This document has already been anchored."],
  NotAnchored:         ["NOT_ANCHORED",          "This document has not been anchored."],
  AlreadyRevoked:      ["ALREADY_REVOKED",       "This document is already revoked."],
  NotAdmin:            ["NOT_ADMIN",             "Administrator privileges are required."],
  ZeroHash:            ["INVALID_HASH",          "Document hash is missing or invalid."],
  ZeroAddress:         ["INVALID_ADDRESS",       "Address is invalid."],
  EmptyName:           ["INVALID_NAME",          "Issuer name cannot be empty."],
};

function translate(err) {
  // Decoded custom error from the contract ABI
  const name = err?.revert?.name ?? err?.errorName;
  if (name && CONTRACT_ERRORS[name]) {
    const [code, message] = CONTRACT_ERRORS[name];
    return new ChainError(code, message, { cause: err });
  }

  switch (err?.code) {
    case "INSUFFICIENT_FUNDS":
      return new ChainError("INSUFFICIENT_GAS",
        "The issuing wallet has insufficient funds for gas.", { cause: err });
    case "NETWORK_ERROR":
    case "SERVER_ERROR":
    case "TIMEOUT":
      return new ChainError("CHAIN_UNAVAILABLE",
        "The blockchain network is temporarily unreachable. Please retry.",
        { retryable: true, cause: err });
    case "NONCE_EXPIRED":
    case "REPLACEMENT_UNDERPRICED":
      return new ChainError("TX_CONFLICT",
        "A conflicting transaction is in flight. Please retry.",
        { retryable: true, cause: err });
    case "CALL_EXCEPTION":
      return new ChainError("CALL_FAILED",
        "The contract rejected this call.", { cause: err });
    default:
      return new ChainError("CHAIN_ERROR",
        "A blockchain error occurred.", { cause: err });
  }
}

/**
 * Serialises write transactions. A single signer cannot safely send concurrent
 * transactions: both would read the same pending nonce and the second reverts
 * with NONCE_EXPIRED. NonceManager handles allocation; this queue guarantees
 * ordering and lets a failure reset cleanly.
 */
let txQueue = Promise.resolve();
function serialise(fn) {
  const run = txQueue.then(fn, fn);
  // Keep the chain alive regardless of outcome, but do not swallow the result.
  txQueue = run.then(() => undefined, () => undefined);
  return run;
}

function requireReady({ write = false } = {}) {
  if (!state.ready) {
    throw new ChainError("CHAIN_UNAVAILABLE",
      "Blockchain service is unavailable.", { retryable: true });
  }
  if (write && !state.contract) {
    throw new ChainError("NO_SIGNER",
      "Issuance is unavailable: no signing key is configured.");
  }
}

/** Accepts 0x-prefixed or bare 64-char hex and normalises to bytes32. */
function toBytes32(hash, label) {
  if (typeof hash !== "string") {
    throw new ChainError("INVALID_HASH", `${label} must be a hex string.`);
  }
  const h = hash.startsWith("0x") ? hash : `0x${hash}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new ChainError("INVALID_HASH", `${label} must be a 32-byte hex hash.`);
  }
  return h.toLowerCase();
}

// ---------------------------------------------------------------- write path

/**
 * Anchor a document on-chain. Server-signed — the browser is never involved.
 *
 * @param {string} contentHash Tier 2 — canonical hash of extracted fields
 * @param {string} byteHash    Tier 1 — SHA-256 of the original file
 * @param {object} [opts]
 * @param {number} [opts.confirmations=1]
 * @returns {Promise<{transactionHash,blockNumber,gasUsed,issuer,chainId,explorerUrl}>}
 */
async function anchorDocument(contentHash, byteHash, { confirmations = 1 } = {}) {
  requireReady({ write: true });
  const ch = toBytes32(contentHash, "contentHash");
  const bh = toBytes32(byteHash, "byteHash");

  return serialise(async () => {
  try {
    // Simulate first. Catches NotAuthorisedIssuer / AlreadyAnchored before we
    // spend gas, and surfaces a clean error instead of a failed transaction.
    await state.contract.anchor.staticCall(ch, bh);

    const tx = await state.contract.anchor(ch, bh);
    const receipt = await tx.wait(confirmations);

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      issuer: state.signerAddress,
      chainId: state.chainId,
      explorerUrl: explorerTxUrl(receipt.hash),
    };
  } catch (err) {
    if (err?.code === "NONCE_EXPIRED") state.signer?.reset?.();
    throw translate(err);
  }
  });
}

/** Revoke a document. Only the original issuing authority may do this. */
async function revokeDocument(contentHash, reason, { confirmations = 1 } = {}) {
  requireReady({ write: true });
  const ch = toBytes32(contentHash, "contentHash");
  if (!reason || !String(reason).trim()) {
    throw new ChainError("INVALID_REASON", "A revocation reason is required.");
  }

  return serialise(async () => {
  try {
    await state.contract.revoke.staticCall(ch, reason);
    const tx = await state.contract.revoke(ch, reason);
    const receipt = await tx.wait(confirmations);
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      explorerUrl: explorerTxUrl(receipt.hash),
    };
  } catch (err) {
    if (err?.code === "NONCE_EXPIRED") state.signer?.reset?.();
    throw translate(err);
  }
  });
}

// ----------------------------------------------------------------- read path

/**
 * Resilient verification — by content hash. Resolves for a scan, photograph or
 * recompressed copy of a genuine document.
 */
async function verifyByContentHash(contentHash) {
  requireReady();
  const ch = toBytes32(contentHash, "contentHash");

  try {
    const [exists, issuer, issuerName, issuedAt, revoked, byteHash] =
      await state.readContract.verify(ch);

    if (!exists) return { exists: false };
    return {
      exists: true,
      issuer,
      issuerName,
      issuedAt: new Date(Number(issuedAt) * 1000).toISOString(),
      revoked,
      anchoredByteHash: byteHash,
      chainId: state.chainId,
    };
  } catch (err) {
    throw translate(err);
  }
}

/**
 * Strict verification — by file hash. A hit means the caller holds the
 * untouched original, not merely a faithful copy.
 */
async function verifyByByteHash(byteHash) {
  requireReady();
  const bh = toBytes32(byteHash, "byteHash");

  try {
    const [exists, contentHash, issuer, issuerName, issuedAt, revoked] =
      await state.readContract.verifyByByteHash(bh);

    if (!exists) return { exists: false };
    return {
      exists: true,
      contentHash,
      issuer,
      issuerName,
      issuedAt: new Date(Number(issuedAt) * 1000).toISOString(),
      revoked,
      chainId: state.chainId,
    };
  } catch (err) {
    throw translate(err);
  }
}

async function isIssuer(address) {
  requireReady();
  if (!ethers.isAddress(address)) {
    throw new ChainError("INVALID_ADDRESS", "Address is invalid.");
  }
  try {
    return await state.readContract.isIssuer(address);
  } catch (err) {
    throw translate(err);
  }
}

// ------------------------------------------------------------------- helpers

const EXPLORERS = {
  80002: "https://amoy.polygonscan.com",
  137: "https://polygonscan.com",
  11155111: "https://sepolia.etherscan.io",
};

function explorerTxUrl(txHash) {
  const base = EXPLORERS[state.chainId];
  return base ? `${base}/tx/${txHash}` : null;
}

/** Health snapshot. Must never include the key, the RPC URL, or credentials. */
async function health() {
  if (!state.ready) {
    return { status: "down", error: state.error };
  }
  try {
    const blockNumber = await state.provider.getBlockNumber();
    const balance = state.signerAddress
      ? ethers.formatEther(await state.provider.getBalance(state.signerAddress))
      : null;

    return {
      status: "up",
      chainId: state.chainId,
      blockNumber,
      signer: state.signerAddress,
      signerBalance: balance,
      canIssue: Boolean(state.contract) && state.isIssuer,
      isRegisteredIssuer: state.isIssuer,
    };
  } catch (err) {
    return { status: "degraded", error: translate(err).message };
  }
}

module.exports = {
  anchorDocument,
  revokeDocument,
  verifyByContentHash,
  verifyByByteHash,
  isIssuer,
  health,
  ChainError,
  toBytes32,
};
