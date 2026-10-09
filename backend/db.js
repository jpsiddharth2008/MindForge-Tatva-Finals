// Connects to MongoDB and returns the document repository. The URI is a secret: it is never logged or returned.
const mongoose = require('mongoose');
const { buildDocumentModel, createDocuments } = require('./documents');

async function connectDocuments(uri, { serverSelectionTimeoutMS = 5000 } = {}) {
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS }).asPromise();
    const Document = buildDocumentModel(connection);
    await Document.init();                  // build the unique indexes now: duplicate protection must not be lazy
    return { ...createDocuments(Document), close: () => connection.close() };
}

module.exports = { connectDocuments };
