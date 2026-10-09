// The Document record: the missing link between the file in S3 and the hash on the blockchain.
// Only metadata lives here. Never file contents, keys, tokens or any other secret.
const crypto = require('crypto');
const mongoose = require('mongoose');

const STATUSES = ['PENDING', 'STORED', 'BLOCKCHAIN_PENDING', 'ISSUED', 'FAILED', 'REVOKED'];

// The only moves allowed. PENDING -> PENDING is a takeover of a crashed attempt (see claimRetry).
const TRANSITIONS = {
    PENDING: ['STORED', 'FAILED'],
    STORED: ['BLOCKCHAIN_PENDING', 'FAILED'],
    BLOCKCHAIN_PENDING: ['ISSUED', 'FAILED'],
    ISSUED: ['REVOKED'],
    FAILED: ['PENDING'],
    REVOKED: [],
};

// A record in one of these states already represents a stored document, so a second upload of the same bytes is a duplicate.
const DUPLICATE_STATUSES = ['STORED', 'BLOCKCHAIN_PENDING', 'ISSUED', 'REVOKED'];

// Short codes only: a failure reason is never free text, so it can never carry a secret.
const FAILURE_REASONS = ['S3_FAILED', 'CHAIN_REVERTED', 'WRONG_CONTRACT', 'WRONG_DATA', 'USER_REJECTED', 'CLIENT_ERROR', 'STUCK_PENDING'];

const SHA256 = /^[a-f0-9]{64}$/;
const TX_HASH = /^0x[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

class DuplicateDocumentError extends Error {
    /** @param {string} value the duplicated hash; @param {'sha256'|'contentHash'} field which one collided */
    constructor(value, field = 'sha256') {
        super(field === 'contentHash' ? 'A document with this content hash already exists' : 'A document with this SHA-256 already exists');
        this.name = 'DuplicateDocumentError';
        this.field = field;
        this.sha256 = field === 'sha256' ? value : undefined;
        this.contentHash = field === 'contentHash' ? value : undefined;
    }
}

class IllegalTransitionError extends Error {
    constructor(from, to) {
        super(`Illegal status change ${from} -> ${to}`);
        this.name = 'IllegalTransitionError';
    }
}

function buildDocumentModel(connection = mongoose) {
    const schema = new mongoose.Schema({
        documentId: { type: String, required: true, unique: true, index: true, default: () => crypto.randomUUID() },
        sha256: { type: String, required: true, unique: true, index: true, match: SHA256 },   // the join key: S3 key and on-chain hash
        byteHash: { type: String, match: SHA256 },
        // Tier 2: the hash of what the document SAYS, so a re-photographed copy is recognised as the same document.
        contentHash: { type: String, match: SHA256, unique: true, sparse: true },
        lookupKey: { type: String, match: SHA256, index: true },   // finds "this person's document of this type" even when a field was altered
        // The anchored fields in canonical form. They hold personal data (name, date of birth, ID number) and exist so a
        // mismatch can say WHICH field changed, old against new. Never sent to clients in publicView(); issuers only.
        canonicalRecord: mongoose.Schema.Types.Mixed,
        ocrCheck: { type: String, enum: ['MATCH', 'INCONCLUSIVE', 'SKIPPED'] },   // did the printed text agree with the fields entered?
        // Tier 3: how the document LOOKS (perceptual hashes of the page, its 16 tiles and the photo). Fuzzy values belong here,
        // never on the blockchain. Advisory only: see phash.js. Absent for PDFs and when the picture could not be analysed.
        visual: mongoose.Schema.Types.Mixed,
        s3Key: { type: String, required: true },
        originalFileName: String,                     // sanitised name, metadata only
        mimeType: { type: String, enum: ['application/pdf', 'image/png', 'image/jpeg'] },
        size: { type: Number, min: 0 },
        issuerUserId: mongoose.Schema.Types.ObjectId,
        issuerName: String,
        chainId: { type: Number, min: 1 },
        contractAddress: { type: String, match: ADDRESS },
        transactionHash: { type: String, match: TX_HASH, index: true, unique: true, sparse: true },
        blockNumber: { type: Number, min: 0 },
        status: { type: String, enum: STATUSES, default: 'PENDING', index: true },
        failureReason: { type: String, enum: FAILURE_REASONS },
        issuedAt: Date,
        // Revocation. Mirrors what the chain says: the reason is read from the transaction's calldata and the time from the block.
        revokedAt: Date,
        revocationReason: { type: String, maxlength: 500 },
        revocationTxHash: { type: String, match: TX_HASH },
    }, { timestamps: true, strict: true, strictQuery: true });   // strict: fields not in the schema are dropped, never stored
    return connection.model('Document', schema);
}

/** The fields a client may see. No Mongo internals. */
function publicView(doc) {
    if (!doc) return null;
    const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const { documentId, sha256, contentHash, ocrCheck, s3Key, originalFileName, mimeType, size, issuerName, status, failureReason, chainId,
        contractAddress, transactionHash, blockNumber, issuedAt, revokedAt, revocationReason, revocationTxHash, createdAt, updatedAt } = o;
    return { documentId, sha256, contentHash, ocrCheck, s3Key, originalFileName, mimeType, size, issuerName, status, failureReason, chainId,
        contractAddress, transactionHash, blockNumber, issuedAt, revokedAt, revocationReason, revocationTxHash, createdAt, updatedAt };
}

/** Everything the app does with the collection, so routes and tests never touch the model directly. */
function createDocuments(Document) {
    const lean = (q) => q.lean().exec();

    return {
        model: Document,

        /** Inserts a record. The unique index on sha256 is the real guard: it throws DuplicateDocumentError even in a race. */
        async create(fields) {
            try {
                const doc = await Document.create(fields);
                return doc.toObject();
            } catch (err) {
                if (err && err.code === 11000) {
                    const dup = Object.keys(err.keyPattern || {})[0];
                    if (dup === 'sha256' || dup === undefined) throw new DuplicateDocumentError(fields.sha256);
                    if (dup === 'contentHash') throw new DuplicateDocumentError(fields.contentHash, 'contentHash');
                }
                throw err;
            }
        },

        findByDocumentId: (documentId) => lean(Document.findOne({ documentId: String(documentId) })),
        findBySha256: (sha256) => lean(Document.findOne({ sha256: String(sha256) })),
        findByContentHash: (contentHash) => lean(Document.findOne({ contentHash: String(contentHash) })),
        /** Every document of this issuer / type / ID, newest first (a document can be re-issued). */
        findByLookupKey: (lookupKey) => lean(Document.find({ lookupKey: String(lookupKey) }).sort({ createdAt: -1 })),
        findByTransactionHash: (transactionHash) => lean(Document.findOne({ transactionHash: String(transactionHash).toLowerCase() })),

        /**
         * Atomic status change: succeeds only if the record is currently in one of `from`, and only along an allowed edge.
         * Returns the updated record, or null if the record was not in a `from` state (someone else moved it first).
         */
        async transition(documentId, from, to, extra = {}) {
            for (const f of from) if (!TRANSITIONS[f].includes(to)) throw new IllegalTransitionError(f, to);
            const { failureReason, ...rest } = extra;
            const update = { $set: { ...rest, status: to } };
            if (failureReason) update.$set.failureReason = failureReason;
            else if (to !== 'FAILED') update.$unset = { failureReason: '' };
            return lean(Document.findOneAndUpdate({ documentId, status: { $in: from } }, update, { new: true, runValidators: true }));
        },

        /**
         * Takes over a failed attempt, or a pending one that has been silent for `staleMs` (a crashed request).
         * Atomic: of several simultaneous callers exactly one gets the record back; the rest get null.
         */
        async claimRetry(documentId, staleMs, now = Date.now()) {
            const cutoff = new Date(now - staleMs);
            return lean(Document.findOneAndUpdate(
                { documentId, $or: [{ status: 'FAILED' }, { status: 'PENDING', updatedAt: { $lt: cutoff } }] },
                { $set: { status: 'PENDING', updatedAt: new Date(now) }, $unset: { failureReason: '' } },
                { new: true },
            ));
        },

        /** Records that have sat in one of `statuses` since before now - olderThanMs (stuck issuance). */
        findStuck({ statuses, olderThanMs, now = Date.now() }) {
            return lean(Document.find({ status: { $in: statuses }, updatedAt: { $lt: new Date(now - olderThanMs) } }).sort({ updatedAt: 1 }));
        },

        /**
         * One issuer's documents, newest first, a page at a time. `cursor` is the opaque id of the last item of the previous page.
         * (Paging on the unique, increasing _id, not on a timestamp: two documents created in the same millisecond must not be skipped.)
         */
        listByIssuer(issuerName, { status, limit = 20, cursor } = {}) {
            const q = { issuerName: String(issuerName) };
            if (status) q.status = String(status);
            if (cursor) q._id = { $lt: new mongoose.Types.ObjectId(String(cursor)) };
            return lean(Document.find(q).sort({ _id: -1 }).limit(limit));
        },

        /** How many of one issuer's documents are in each status, e.g. { ISSUED: 12, FAILED: 1 }. */
        async countByStatus(issuerName) {
            const rows = await Document.aggregate([{ $match: { issuerName: String(issuerName) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
            return Object.fromEntries(rows.map((r) => [r._id, r.n]));
        },

        /** Attaches the on-chain transaction to a record so it can be found by transaction hash. */
        async recordTransaction(documentId, { transactionHash, blockNumber, chainId, contractAddress }) {
            return lean(Document.findOneAndUpdate(
                { documentId },
                { $set: { transactionHash: String(transactionHash).toLowerCase(), blockNumber, chainId, contractAddress } },
                { new: true, runValidators: true },
            ));
        },

        /** Used by /api/health. */
        async ping() {
            await Document.db.db.admin().ping();
            return 'ok';
        },
    };
}

module.exports = {
    buildDocumentModel, createDocuments, publicView, DuplicateDocumentError, IllegalTransitionError,
    STATUSES, TRANSITIONS, DUPLICATE_STATUSES, FAILURE_REASONS,
};
