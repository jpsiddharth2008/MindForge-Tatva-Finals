// Starts a real in-memory MongoDB for a test file and connects the repositories to it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDatabase } = require('../db');

const remove = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

/**
 * Starts a mongod in a data directory THIS helper owns, and removes that directory when the server stops or fails to start.
 * Why it matters: each mongod writes up to ~300 MB of data files. Directories left behind by failed or interrupted starts filled
 * a disk completely during development, after which every start failed with "fassert() failure" (WiredTiger could not write).
 * A failed start is retried, because a mongod occasionally aborts when many start at once.
 * @returns {Promise<{mongod, stop: function}>}
 */
async function createMongod(options = {}, attempts = 4) {
    let last;
    for (let i = 0; i < attempts; i++) {
        const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-test-'));
        try {
            const mongod = await MongoMemoryServer.create({ ...options, instance: { ...(options.instance || {}), dbPath } });
            mongod.__stopAndClean = async () => { try { await mongod.stop({ doCleanup: true }); } finally { remove(dbPath); } };
            return mongod;
        } catch (err) {
            last = err;
            remove(dbPath);
            await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        }
    }
    throw last;
}

/** @param {{fastTtl?: boolean, retentionDays?: number}} options  fastTtl makes MongoDB expire TTL documents every second (default: every 60 s) */
async function startMongo({ fastTtl = false, retentionDays, logger } = {}) {
    const args = fastTtl ? ['--setParameter', 'ttlMonitorSleepSecs=1'] : [];
    const mongod = await createMongod({ instance: { args } });
    const db = await connectDatabase(mongod.getUri(), { retentionDays, logger });
    return {
        uri: mongod.getUri(), documents: { ...db.documents, close: db.close }, audit: db.audit,
        stop: async () => { await db.close(); await mongod.__stopAndClean(); },
    };
}

module.exports = { startMongo, createMongod };
