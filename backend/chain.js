// Read-only access to the blockchain over JSON-RPC. The server never signs or sends transactions:
// the issuing officer signs in their wallet, and the server only checks what actually happened on chain.

const TIMEOUT_MS = 3000;

/** One JSON-RPC call. Throws on network errors, timeouts and RPC errors; the message never includes the URL. */
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

/**
 * @returns {{getReceipt: function}} getReceipt(txHash) resolves to
 *   { state: 'not_found' }                                  not mined yet (or unknown)
 *   { state: 'success' | 'reverted', blockNumber, to }      mined
 */
function createChain({ rpcUrl, fetchFn = fetch, timeoutMs = TIMEOUT_MS }) {
    return {
        async getReceipt(txHash) {
            const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash], fetchFn, timeoutMs);
            if (!receipt) return { state: 'not_found' };
            return {
                state: receipt.status === '0x1' ? 'success' : 'reverted',
                blockNumber: parseInt(receipt.blockNumber, 16),
                to: receipt.to,
            };
        },
    };
}

module.exports = { rpc, createChain, TIMEOUT_MS };
