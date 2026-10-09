// A chain that knows exactly what a test tells it, offering the same questions as backend/chain.js. (The real chain layer is
// tested against a real EVM in blockchain/test; this is for the many scenarios that need a particular registry state quickly.)
const ADDR = '0x' + '12'.repeat(20);
const ISSUER = '0x' + 'aa'.repeat(20);
const NONE = '0'.repeat(64);
const tx = (n) => '0x' + String(n).padStart(2, '0').repeat(32);

function fakeChain() {
    return {
        receipts: {}, anchorCalls: {}, revokeCalls: {}, registry: {}, revocations: {},
        async getReceipt(h) { return this.receipts[h] || { state: 'not_found' }; },
        async getAnchorCall(h) { return this.anchorCalls[h] || null; },
        async getRevokeCall(h) { return this.revokeCalls[h] || null; },
        async verify(ch) { return this.registry[ch] || { exists: false, issuer: '0x' + '0'.repeat(40), issuerName: '', issuedAt: 0, revoked: false, byteHash: NONE }; },
        async verifyByByteHash(bh) {
            const hit = Object.entries(this.registry).find(([, r]) => r.byteHash === bh);
            return hit ? { exists: true, contentHash: hit[0], issuer: hit[1].issuer, issuerName: hit[1].issuerName, issuedAt: hit[1].issuedAt, revoked: hit[1].revoked } : { exists: false, contentHash: null };
        },
        async getRevocation(ch) { return this.revocations[ch] || null; },
    };
}

/** What the chain holds after a correct anchoring transaction for `doc`. */
function mineAnchor(chain, doc, txHash, o = {}) {
    chain.receipts[txHash] = { state: 'success', blockNumber: 5, to: ADDR, ...(o.receipt || {}) };
    chain.anchorCalls[txHash] = { contentHash: doc.contentHash, byteHash: doc.sha256, from: ISSUER, to: ADDR };
    chain.registry[doc.contentHash] = { exists: true, issuer: ISSUER, issuerName: 'Testland Registrar', issuedAt: 1_800_000_000, revoked: false, byteHash: doc.sha256, ...(o.registry || {}) };
}

/** What the chain holds after the issuer revokes `doc`. */
function mineRevoke(chain, doc, txHash, { reason = 'Issued in error', at = new Date('2026-10-10T09:30:00Z') } = {}) {
    chain.receipts[txHash] = { state: 'success', blockNumber: 9, to: ADDR };
    chain.revokeCalls[txHash] = { contentHash: doc.contentHash, reason, from: ISSUER, to: ADDR };
    chain.registry[doc.contentHash] = { ...chain.registry[doc.contentHash], revoked: true };
    chain.revocations[doc.contentHash] = { reason, by: ISSUER, txHash, blockNumber: 9, at };
}

module.exports = { fakeChain, mineAnchor, mineRevoke, ADDR, ISSUER, tx, NONE };
