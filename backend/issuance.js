// Issuance touches three systems (S3, MongoDB, the blockchain) with no shared transaction, so the Document record
// is the coordinator. Its status moves PENDING -> STORED -> BLOCKCHAIN_PENDING -> ISSUED, or to FAILED from any step.
//
// Rules that keep a half-finished issuance recoverable instead of invisible:
//   * the record is written PENDING *before* the S3 upload, so a crash leaves a row to find, never a silent orphan;
//   * every move is an atomic compare-and-set, so a double click or two requests cannot both win;
//   * the same bytes issue once: a repeat returns the existing record instead of writing again;
//   * a failure marks the record FAILED with a short reason code. The S3 object is kept: its key is the content
//     hash, so a retry reuses it, and nothing else can reach it.
const { DuplicateDocumentError, DUPLICATE_STATUSES } = require('./documents');

const STALE_PENDING_MS = 60 * 1000;        // a PENDING record silent this long belongs to a crashed request
const STUCK_MS = 10 * 60 * 1000;           // reconcile() looks at records unchanged for this long
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

/** An error with a message that is safe to show the client. */
class IssuanceError extends Error {
    constructor(status, publicMessage) {
        super(publicMessage);
        this.name = 'IssuanceError';
        this.status = status;
        this.publicMessage = publicMessage;
    }
}

function createIssuance({
    documents, storage, chain = null, contractAddress, chainId,
    staleMs = STALE_PENDING_MS, stuckMs = STUCK_MS, now = Date.now,
}) {
    const sameAddress = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

    // Looks the record up and checks that it belongs to this issuer. Someone else's record is reported as not found.
    async function ownedDocument(documentId, issuerName) {
        const doc = await documents.findByDocumentId(documentId);
        if (!doc || doc.issuerName !== issuerName) throw new IssuanceError(404, 'Not found.');
        return doc;
    }

    function checkTx(transactionHash) {
        if (typeof transactionHash !== 'string' || !TX_HASH.test(transactionHash)) throw new IssuanceError(400, 'A valid transactionHash is required.');
        return transactionHash.toLowerCase();
    }

    /**
     * Step 1-2: claim the hash, upload to S3, mark STORED.
     * @returns {{outcome: 'issued'|'duplicate'|'in_progress', document, key, alreadyStored?}}
     */
    async function issue({ hash, buffer, contentType, originalName, size, issuerName }) {
        let doc = await documents.findBySha256(hash);

        if (doc && DUPLICATE_STATUSES.includes(doc.status)) return { outcome: 'duplicate', document: doc, key: doc.s3Key };

        if (doc) {
            // PENDING or FAILED: retry it, unless another request is already working on it
            doc = await documents.claimRetry(doc.documentId, staleMs, now());
            if (!doc) {
                const current = await documents.findBySha256(hash);
                return DUPLICATE_STATUSES.includes(current.status)
                    ? { outcome: 'duplicate', document: current, key: current.s3Key }
                    : { outcome: 'in_progress', document: current, key: current.s3Key };
            }
        } else {
            try {
                doc = await documents.create({
                    sha256: hash, byteHash: hash, s3Key: hash, originalFileName: originalName, mimeType: contentType,
                    size, issuerName, chainId, contractAddress, status: 'PENDING',
                });
            } catch (err) {
                if (!(err instanceof DuplicateDocumentError)) throw err;
                const winner = await documents.findBySha256(hash);          // lost the race to another request
                return DUPLICATE_STATUSES.includes(winner.status)
                    ? { outcome: 'duplicate', document: winner, key: winner.s3Key }
                    : { outcome: 'in_progress', document: winner, key: winner.s3Key };
            }
        }

        let stored;
        try {
            stored = await storage.store({ hash, buffer, contentType, originalName });
        } catch (err) {
            await documents.transition(doc.documentId, ['PENDING'], 'FAILED', { failureReason: 'S3_FAILED' });   // visible and retryable
            throw err;
        }
        const done = await documents.transition(doc.documentId, ['PENDING'], 'STORED', { s3Key: stored.key });
        return { outcome: 'issued', document: done || doc, key: stored.key, alreadyStored: stored.alreadyStored };
    }

    /** The wallet has sent a transaction: STORED -> BLOCKCHAIN_PENDING. Repeating the same call is harmless. */
    async function markChainPending(documentId, issuerName, transactionHash) {
        const tx = checkTx(transactionHash);
        const doc = await ownedDocument(documentId, issuerName);
        if (['BLOCKCHAIN_PENDING', 'ISSUED'].includes(doc.status) && doc.transactionHash === tx) return doc;   // idempotent
        let moved;
        try {
            moved = await documents.transition(documentId, ['STORED'], 'BLOCKCHAIN_PENDING', { transactionHash: tx, chainId, contractAddress });
        } catch (err) {
            if (err && err.code === 11000) throw new IssuanceError(409, 'That transaction is already attached to another document.');
            throw err;
        }
        if (!moved) throw new IssuanceError(409, 'This document is not in a state that can be anchored.');
        return moved;
    }

    /** Looks at the chain and moves BLOCKCHAIN_PENDING to ISSUED or FAILED. Returns {state, document}. */
    async function applyReceipt(doc) {
        const receipt = await chain.getReceipt(doc.transactionHash);
        if (receipt.state === 'not_found') return { state: 'pending', document: doc };
        if (receipt.state === 'reverted') {
            const failed = await documents.transition(doc.documentId, ['BLOCKCHAIN_PENDING'], 'FAILED', { failureReason: 'CHAIN_REVERTED' });
            return { state: 'failed', document: failed || doc };
        }
        if (contractAddress && !sameAddress(receipt.to, contractAddress)) {
            const failed = await documents.transition(doc.documentId, ['BLOCKCHAIN_PENDING'], 'FAILED', { failureReason: 'WRONG_CONTRACT' });
            return { state: 'failed', document: failed || doc };
        }
        const issued = await documents.transition(doc.documentId, ['BLOCKCHAIN_PENDING'], 'ISSUED',
            { blockNumber: receipt.blockNumber, issuedAt: new Date(now()) });
        return { state: 'issued', document: issued || (await documents.findByDocumentId(doc.documentId)) };
    }

    /** BLOCKCHAIN_PENDING -> ISSUED, but only after the chain itself says the transaction succeeded. */
    async function confirmChain(documentId, issuerName, transactionHash) {
        const tx = checkTx(transactionHash);
        if (!chain) throw new IssuanceError(503, 'Blockchain verification is not available.');
        const doc = await ownedDocument(documentId, issuerName);
        if (doc.transactionHash !== tx || !['BLOCKCHAIN_PENDING', 'ISSUED'].includes(doc.status)) {
            throw new IssuanceError(409, 'This transaction does not match the document.');
        }
        if (doc.status === 'ISSUED') return { state: 'issued', document: doc };   // idempotent
        return applyReceipt(doc);
    }

    /** The officer's wallet rejected or failed the transaction: STORED / BLOCKCHAIN_PENDING -> FAILED. */
    async function markChainFailed(documentId, issuerName, reason) {
        const failureReason = reason === 'USER_REJECTED' ? 'USER_REJECTED' : 'CLIENT_ERROR';   // only known codes are stored
        await ownedDocument(documentId, issuerName);
        const failed = await documents.transition(documentId, ['STORED', 'BLOCKCHAIN_PENDING'], 'FAILED', { failureReason });
        if (!failed) throw new IssuanceError(409, 'This document is not in a state that can be marked failed.');
        return failed;
    }

    /**
     * The recovery sweep. Looks at records unchanged for `stuckMs`:
     *   PENDING             a request died mid-issuance        -> FAILED (STUCK_PENDING), retry reuses the stored object
     *   BLOCKCHAIN_PENDING  asks the chain what happened       -> ISSUED, FAILED, or left alone if still not mined
     * STORED is a normal waiting state (the officer has not signed yet) and is only reported, never changed.
     */
    async function reconcile() {
        const report = { checked: 0, failedPending: [], issued: [], failed: [], stillPending: [], unverified: [] };
        const stuck = await documents.findStuck({ statuses: ['PENDING', 'BLOCKCHAIN_PENDING'], olderThanMs: stuckMs, now: now() });
        report.checked = stuck.length;
        for (const doc of stuck) {
            if (doc.status === 'PENDING') {
                const f = await documents.transition(doc.documentId, ['PENDING'], 'FAILED', { failureReason: 'STUCK_PENDING' });
                if (f) report.failedPending.push(doc.documentId);
            } else if (!chain || !doc.transactionHash) {
                report.unverified.push(doc.documentId);
            } else {
                const { state } = await applyReceipt(doc);
                ({ issued: report.issued, failed: report.failed, pending: report.stillPending })[state].push(doc.documentId);
            }
        }
        return report;
    }

    return { issue, markChainPending, confirmChain, markChainFailed, reconcile };
}

module.exports = { createIssuance, IssuanceError, STALE_PENDING_MS, STUCK_MS };
