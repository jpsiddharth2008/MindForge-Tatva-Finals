// Connects to MongoDB and returns the repositories. The URI is a secret: it is never logged or returned.
const mongoose = require('mongoose');
const { buildDocumentModel, createDocuments } = require('./documents');
const { buildAuditModel, createAudit } = require('./audit');

/** @returns {{documents, audit, close}} */
async function connectDatabase(uri, { serverSelectionTimeoutMS = 5000, logger, retentionDays } = {}) {
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS }).asPromise();
    const Document = buildDocumentModel(connection);
    const AuditEvent = buildAuditModel(connection, retentionDays ? { retentionDays } : undefined);
    await Document.init();                  // build the unique indexes now: duplicate protection must not be lazy
    await AuditEvent.init();                // ... and the TTL index: an audit trail without expiry fills the database
    return { documents: createDocuments(Document), audit: createAudit(AuditEvent, { logger }), close: () => connection.close() };
}

/** Documents only (what earlier code and tests use). */
async function connectDocuments(uri, options) {
    const db = await connectDatabase(uri, options);
    return { ...db.documents, close: db.close };
}

module.exports = { connectDatabase, connectDocuments };
