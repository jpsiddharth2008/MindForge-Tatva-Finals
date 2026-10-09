// The Document record: the missing link between the file in S3 and the hash on the blockchain.
// Only metadata lives here. Never file contents, keys, tokens or any other secret.
const crypto = require('crypto');
const mongoose = require('mongoose');

const STATUSES = ['PENDING', 'STORED', 'BLOCKCHAIN_PENDING', 'ISSUED', 'FAILED', 'REVOKED'];
// A record in one of these states already represents a stored document, so a second upload of the same bytes is a duplicate.
const DUPLICATE_STATUSES = ['STORED', 'BLOCKCHAIN_PENDING', 'ISSUED', 'REVOKED'];

const SHA256 = /^[a-f0-9]{64}$/;
const TX_HASH = /^0x[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

class DuplicateDocumentError extends Error {
    constructor(sha256) {
        super('A document with this SHA-256 already exists');
        this.name = 'DuplicateDocumentError';
        this.sha256 = sha256;
    }
}

function buildDocumentModel(connection = mongoose) {
    const schema = new mongoose.Schema({
        documentId: { type: String, required: true, unique: true, index: true, default: () => crypto.randomUUID() },
        sha256: { type: String, required: true, unique: true, index: true, match: SHA256 },   // the join key: S3 key and on-chain hash
        byteHash: { type: String, match: SHA256 },
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
        issuedAt: Date,
    }, { timestamps: true, strict: true, strictQuery: true });   // strict: fields not in the schema are dropped, never stored
    return connection.model('Document', schema);
}

/** The fields a client may see. No Mongo internals. */
function publicView(doc) {
    if (!doc) return null;
    const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const { documentId, sha256, s3Key, originalFileName, mimeType, size, issuerName, status, chainId, contractAddress,
        transactionHash, blockNumber, issuedAt, createdAt, updatedAt } = o;
    return { documentId, sha256, s3Key, originalFileName, mimeType, size, issuerName, status, chainId, contractAddress,
        transactionHash, blockNumber, issuedAt, createdAt, updatedAt };
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
                }
                throw err;
            }
        },

        findByDocumentId: (documentId) => lean(Document.findOne({ documentId: String(documentId) })),
        findBySha256: (sha256) => lean(Document.findOne({ sha256: String(sha256) })),
        findByTransactionHash: (transactionHash) => lean(Document.findOne({ transactionHash: String(transactionHash).toLowerCase() })),

        /** Marks a failed or pending record as stored again (a retry of the same bytes). */
        async restore(documentId, fields) {
            return lean(Document.findOneAndUpdate({ documentId }, { $set: { ...fields, status: 'STORED' } }, { new: true, runValidators: true }));
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

module.exports = { buildDocumentModel, createDocuments, publicView, DuplicateDocumentError, STATUSES, DUPLICATE_STATUSES };
