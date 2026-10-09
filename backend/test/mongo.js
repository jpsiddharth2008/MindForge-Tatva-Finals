// Starts a real in-memory MongoDB for a test file and connects the document repository to it.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDocuments } = require('../db');

async function startMongo() {
    const mongod = await MongoMemoryServer.create();
    const documents = await connectDocuments(mongod.getUri());
    return { documents, stop: async () => { await documents.close(); await mongod.stop(); } };
}

module.exports = { startMongo };
