// Starts a real in-memory MongoDB for a test file and connects the repositories to it.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDatabase } = require('../db');

/** @param {{fastTtl?: boolean, retentionDays?: number}} options  fastTtl makes MongoDB expire TTL documents every second (default: every 60 s) */
async function startMongo({ fastTtl = false, retentionDays, logger } = {}) {
    const args = fastTtl ? ['--setParameter', 'ttlMonitorSleepSecs=1'] : [];
    const mongod = await MongoMemoryServer.create({ instance: { args } });
    const db = await connectDatabase(mongod.getUri(), { retentionDays, logger });
    return { uri: mongod.getUri(), documents: { ...db.documents, close: db.close }, audit: db.audit, stop: async () => { await db.close(); await mongod.stop(); } };
}

module.exports = { startMongo };
