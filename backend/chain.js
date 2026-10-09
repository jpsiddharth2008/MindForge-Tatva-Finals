// Read-only access to the blockchain. The server never signs or sends transactions: the issuing officer signs in their wallet,
// and the server only checks what actually happened on chain and what the registry says about a document.
const { ethers } = require('ethers');
const ABI = require('./abi/CredentialRegistry.json');

const TIMEOUT_MS = 3000;
const IFACE = new ethers.Interface(ABI);
const REVOKED_TOPIC = IFACE.getEvent('Revoked').topicHash;

/** One raw JSON-RPC call (used by /api/health). Throws on network errors, timeouts and RPC errors; the message never includes the URL. */
async function rpc(url, method, params, fetchFn = fetch, timeoutMs = TIMEOUT_MS) {
    const res = await fetchFn(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error || body.result === undefined) throw new Error('rpc error');
    return body.result;
}

const HEX64 = /^[a-f0-9]{64}$/;
/** "abc…" (64 hex, no prefix) -> "0xabc…" for the contract. Anything else is refused: no hash is ever guessed or padded. */
function toBytes32(hash) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error('a 64-character lowercase hex hash is required');
    return `0x${hash}`;
}
const fromBytes32 = (b) => String(b).toLowerCase().replace(/^0x/, '');

/**
 * @param {object} o
 * @param {string} [o.rpcUrl]            JSON-RPC endpoint (ignored if `provider` is given)
 * @param {object} [o.provider]          an ethers-compatible provider (tests use Hardhat's in-process one)
 * @param {number} [o.chainId]           when known, no network detection is attempted
 * @param {string} [o.contractAddress]   the CredentialRegistry
 * @param {number} [o.deployedBlock]     where to start looking for revocation events (default 0; some public RPCs limit log ranges)
 */
function createChain({ rpcUrl, provider, chainId, contractAddress, deployedBlock = 0, timeoutMs = TIMEOUT_MS }) {
    if (!provider) {
        if (!rpcUrl) throw new Error('createChain needs an rpcUrl or a provider');
        const request = new ethers.FetchRequest(rpcUrl);
        request.timeout = timeoutMs;
        provider = new ethers.JsonRpcProvider(request, chainId ? ethers.Network.from(chainId) : undefined, chainId ? { staticNetwork: ethers.Network.from(chainId) } : undefined);
    }
    const needContract = () => {
        if (!contractAddress) throw new Error('no contract address is configured');
        return new ethers.Contract(contractAddress, ABI, provider);
    };

    return {
        provider,

        /** @returns {Promise<{state: 'not_found'} | {state: 'success'|'reverted', blockNumber: number, to: string}>} */
        async getReceipt(txHash) {
            const r = await provider.getTransactionReceipt(txHash);
            if (!r) return { state: 'not_found' };
            return { state: r.status === 1 ? 'success' : 'reverted', blockNumber: r.blockNumber, to: r.to };
        },

        /** What an anchoring transaction actually asked for: the two hashes in its calldata, or null if it is not an anchor() call. */
        async getAnchorCall(txHash) {
            const tx = await provider.getTransaction(txHash);
            if (!tx) return null;
            let parsed;
            try { parsed = IFACE.parseTransaction({ data: tx.data }); } catch { return null; }
            if (!parsed || parsed.name !== 'anchor') return null;
            return { contentHash: fromBytes32(parsed.args[0]), byteHash: fromBytes32(parsed.args[1]), from: tx.from, to: tx.to };
        },

        /** The same for revoke(contentHash, reason): the reason is read from the calldata, so it is the on-chain truth. */
        async getRevokeCall(txHash) {
            const tx = await provider.getTransaction(txHash);
            if (!tx) return null;
            let parsed;
            try { parsed = IFACE.parseTransaction({ data: tx.data }); } catch { return null; }
            if (!parsed || parsed.name !== 'revoke') return null;
            return { contentHash: fromBytes32(parsed.args[0]), reason: parsed.args[1], from: tx.from, to: tx.to };
        },

        /** The registry's record for a content hash (Tier 2): the authority on whether a document is registered or revoked. */
        async verify(contentHash) {
            const [exists, issuer, issuerName, issuedAt, revoked, byteHash] = await needContract().verify(toBytes32(contentHash));
            return { exists, issuer, issuerName, issuedAt: Number(issuedAt), revoked, byteHash: fromBytes32(byteHash) };
        },

        /** The registry's record for an exact file (Tier 1). */
        async verifyByByteHash(byteHash) {
            const [exists, contentHash, issuer, issuerName, issuedAt, revoked] = await needContract().verifyByByteHash(toBytes32(byteHash));
            return { exists, contentHash: exists ? fromBytes32(contentHash) : null, issuer, issuerName, issuedAt: Number(issuedAt), revoked };
        },

        async isIssuer(address) {
            return needContract().isIssuer(address);
        },

        /** Why and when a document was revoked, from the Revoked event (the contract does not store the reason). null if not revoked. */
        async getRevocation(contentHash) {
            const logs = await provider.getLogs({
                address: contractAddress, topics: [REVOKED_TOPIC, toBytes32(contentHash)], fromBlock: deployedBlock, toBlock: 'latest',
            });
            if (!logs.length) return null;
            const log = logs[logs.length - 1];
            const parsed = IFACE.parseLog({ topics: log.topics, data: log.data });
            const block = await provider.getBlock(log.blockNumber);
            return { reason: parsed.args[2], by: parsed.args[1], txHash: log.transactionHash, blockNumber: log.blockNumber, at: new Date(Number(block.timestamp) * 1000) };
        },
    };
}

module.exports = { rpc, createChain, toBytes32, fromBytes32, IFACE, ABI, TIMEOUT_MS };
