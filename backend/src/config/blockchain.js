/**
 * Blockchain connection setup.
 *
 * Deliberately does NOT throw on startup failure. An unreachable RPC must
 * degrade the service (issuance unavailable, verification unavailable) rather
 * than prevent the whole API from booting — the health endpoint reports the
 * real state instead.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ABI_PATHS = [
  path.join(__dirname, "../../../blockchain/abi/CredentialRegistry.json"),
  path.join(__dirname, "../abi/CredentialRegistry.json"),
];

function loadAbi() {
  for (const p of ABI_PATHS) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(
    "CredentialRegistry ABI not found. Run `npm run build` in blockchain/, " +
      "or deploy to generate blockchain/abi/CredentialRegistry.json"
  );
}

const state = {
  ready: false,
  provider: null,
  signer: null,
  wallet: null,
  contract: null,
  readContract: null,
  chainId: null,
  signerAddress: null,
  isIssuer: false,
  error: null,
};

async function initBlockchain({ logger = console } = {}) {
  const {
    POLYGON_RPC_URL: rpcUrl,
    POLYGON_CHAIN_ID: expectedChainId,
    CONTRACT_ADDRESS: contractAddress,
    PRIVATE_KEY: rawKey,
  } = process.env;

  try {
    if (!rpcUrl) throw new Error("POLYGON_RPC_URL is not set");
    if (!contractAddress) throw new Error("CONTRACT_ADDRESS is not set");
    if (!ethers.isAddress(contractAddress)) {
      throw new Error(`CONTRACT_ADDRESS is not a valid address: ${contractAddress}`);
    }

    const abi = loadAbi();
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    // Catches the exact misconfiguration we hit: an address deployed on Sepolia
    // while the config pointed at Amoy. Every call would have silently failed.
    if (expectedChainId && chainId !== Number(expectedChainId)) {
      throw new Error(
        `Chain mismatch — RPC reports ${chainId}, POLYGON_CHAIN_ID says ${expectedChainId}`
      );
    }

    const code = await provider.getCode(contractAddress);
    if (code === "0x") {
      throw new Error(
        `No contract deployed at ${contractAddress} on chain ${chainId}. ` +
          `Check that CONTRACT_ADDRESS and POLYGON_CHAIN_ID refer to the same network.`
      );
    }

    state.readContract = new ethers.Contract(contractAddress, abi, provider);

    // A signer is optional: verification works read-only. Only issuance needs it.
    if (rawKey) {
      const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
      const wallet = new ethers.Wallet(key, provider);

      // A single server-side signer serialises all issuance. Without a nonce
      // manager, two concurrent requests both read the same pending nonce and
      // the second reverts with NONCE_EXPIRED.
      const signer = new ethers.NonceManager(wallet);

      state.signer = signer;
      state.wallet = wallet;
      state.signerAddress = wallet.address;
      state.contract = new ethers.Contract(contractAddress, abi, signer);

      const balance = await provider.getBalance(wallet.address);
      if (balance === 0n) {
        logger.warn?.("Signer has zero balance — issuance will fail until funded");
      }

      try {
        state.isIssuer = await state.readContract.isIssuer(wallet.address);
        if (!state.isIssuer) {
          logger.warn?.(
            `Signer ${wallet.address} is not a registered issuer — anchoring will revert`
          );
        }
      } catch {
        /* older contract without isIssuer; ignore */
      }
    } else {
      logger.warn?.("PRIVATE_KEY not set — running in read-only mode");
    }

    state.provider = provider;
    state.chainId = chainId;
    state.ready = true;
    state.error = null;

    logger.info?.(
      `Blockchain ready — chain ${chainId}, contract ${contractAddress}` +
        (state.signerAddress ? `, signer ${state.signerAddress}` : " (read-only)")
    );
  } catch (err) {
    state.ready = false;
    state.error = err.message;
    // Degrade, don't crash.
    logger.error?.(`Blockchain init failed: ${err.message}`);
  }

  return state;
}

module.exports = { initBlockchain, state };
