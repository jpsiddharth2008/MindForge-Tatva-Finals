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
    // Strict anchoring: the transaction must have anchored THIS document's two hashes and the registry must now hold them.
    // On by default whenever the chain layer can read calldata (it always can in production; very old test fakes cannot).
    verifyAnchorData = !!(chain && typeof chain.getAnchorCall === 'function'),
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
     * `tier2` (optional): { contentHash, lookupKey, record, ocrCheck } for the document's content. A second file with the same
     * content hash is the SAME document re-captured (a new photo, a scan): it is reported as a duplicate, never issued again.
     * @returns {{outcome: 'issued'|'duplicate'|'in_progress', document, key, alreadyStored?}}
     */
    async function issue({ hash, buffer, contentType, originalName, size, issuerName, tier2, visual }) {
        let doc = await documents.findBySha256(hash);

        if (!doc && tier2) {
            const same = await documents.findByContentHash(tier2.contentHash);
            if (same) {
                if (DUPLICATE_STATUSES.includes(same.status)) return { outcome: 'duplicate', document: same, key: same.s3Key, by: 'content' };
                // another request for this same document is working on it right now (another copy of it, uploaded at once)
                if (same.status === 'PENDING' && now() - new Date(same.updatedAt).getTime() < staleMs) return { outcome: 'in_progress', document: same, key: same.s3Key };
                throw new IssuanceError(409, 'An earlier attempt to issue this document is unfinished. Retry with the original file.');
            }
        }

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
                // Tier 3 look-hash: computed only now that a NEW record is really being created (a duplicate never pays for it).
                // It may be a value or a function returning one; a failure here must never stop the issuance.
                let look;
                if (visual) { try { look = typeof visual === 'function' ? await visual() : visual; } catch { look = undefined; } }
                doc = await documents.create({
                    sha256: hash, byteHash: hash, s3Key: hash, originalFileName: originalName, mimeType: contentType,
                    size, issuerName, chainId, contractAddress, status: 'PENDING',
                    ...(tier2 ? { contentHash: tier2.contentHash, lookupKey: tier2.lookupKey, canonicalRecord: tier2.record, ocrCheck: tier2.ocrCheck } : {}),
                    ...(look ? { visual: look } : {}),
                });
            } catch (err) {
                if (!(err instanceof DuplicateDocumentError)) throw err;
                const winner = await documents.findBySha256(hash)
                    || (err.field === 'contentHash' && await documents.findByContentHash(err.contentHash));   // lost the race to another request
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
        if (verifyAnchorData && !doc.contentHash) {
            // the registry is keyed by the content hash: without one there is nothing it could hold for this document
            throw new IssuanceError(409, 'This document has no content hash, so it cannot be anchored. Upload it again together with its details.');
        }
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

    /**
     * Did the transaction really anchor THIS document? Its calldata must carry this document's content hash and byte hash, and
     * the registry must now hold that content hash with the same byte hash, issued by the wallet that sent the transaction.
     * A successful transaction that anchored something else (or nothing) is not an issuance.
     */
    async function anchoredCorrectly(doc) {
        if (!doc.contentHash) return false;
        const call = await chain.getAnchorCall(doc.transactionHash);
        if (!call || call.contentHash !== doc.contentHash || call.byteHash !== doc.sha256) return false;
        const record = await chain.verify(doc.contentHash);
        return record.exists && !record.revoked && record.byteHash === doc.sha256 && sameAddress(record.issuer, call.from);
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
        if (verifyAnchorData && !(await anchoredCorrectly(doc))) {
            const failed = await documents.transition(doc.documentId, ['BLOCKCHAIN_PENDING'], 'FAILED', { failureReason: 'WRONG_DATA' });
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
     * Revocation. The issuer's wallet sends revoke(contentHash, reason); this checks what happened on chain and only then mirrors it:
     * ISSUED -> REVOKED. The reason is read from the transaction's calldata and the time from the Revoked event's block, so what is
     * shown to verifiers is what the chain says, not what a client claims. A failed or unmined transaction changes nothing.
     * @returns {{state: 'revoked'|'pending'|'failed', document}}
     */
    async function confirmRevocation(documentId, issuerName, transactionHash) {
        const tx = checkTx(transactionHash);
        if (!chain || typeof chain.getRevokeCall !== 'function') throw new IssuanceError(503, 'Blockchain verification is not available.');
        const doc = await ownedDocument(documentId, issuerName);
        if (doc.status === 'REVOKED') {
            if (doc.revocationTxHash === tx) return { state: 'revoked', document: doc };       // idempotent
            throw new IssuanceError(409, 'This document is already revoked.');
        }
        if (doc.status !== 'ISSUED') throw new IssuanceError(409, 'Only an issued document can be revoked.');
        if (!doc.contentHash) throw new IssuanceError(409, 'This document has no content hash, so it was never on the registry.');

        const receipt = await chain.getReceipt(tx);
        if (receipt.state === 'not_found') return { state: 'pending', document: doc };
        if (receipt.state === 'reverted' || (contractAddress && !sameAddress(receipt.to, contractAddress))) return { state: 'failed', document: doc };

        const call = await chain.getRevokeCall(tx);
        if (!call || call.contentHash !== doc.contentHash) throw new IssuanceError(409, 'This transaction does not revoke this document.');
        const record = await chain.verify(doc.contentHash);
        if (!record.exists || !record.revoked) return { state: 'failed', document: doc };      // the registry does not say revoked: believe the registry

        let at = new Date(now());
        try { const rev = await chain.getRevocation(doc.contentHash); if (rev && rev.txHash === tx) at = rev.at; } catch { /* the time is a nicety: the calldata and the registry already agree */ }
        const revoked = await documents.transition(documentId, ['ISSUED'], 'REVOKED', {
            revokedAt: at, revocationReason: String(call.reason).slice(0, 500), revocationTxHash: tx,
        });
        return { state: 'revoked', document: revoked || (await documents.findByDocumentId(documentId)) };
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

    return { issue, markChainPending, confirmChain, markChainFailed, confirmRevocation, reconcile };
}

module.exports = { createIssuance, IssuanceError, STALE_PENDING_MS, STUCK_MS };
