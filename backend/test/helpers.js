// Shared test helpers (not a test file: the glob only runs *.test.js).
const bcrypt = require('bcryptjs');
const { Transport } = require('winston');
const { createApp } = require('../app');
const { createLogger } = require('../logger');

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_AUTH = {
    jwtSecret: 'test-secret-test-secret-test-secret-123456',
    adminUsername: 'registrar',
    adminPasswordHash: bcrypt.hashSync(TEST_PASSWORD, 4),   // low cost: tests only
};

/** Fake S3 client that records every command sent to it. */
function fakeS3() {
    const sent = [];
    return { sent, send: async (command) => { sent.push(command); return {}; } };
}

/** A logger that keeps what it would have written, as the final JSON text, so tests can inspect it. */
function memoryLogger() {
    const lines = [];
    class Memory extends Transport {
        log(info, done) { lines.push(info[Symbol.for('message')]); done(); }
    }
    return { lines, logger: createLogger({ logDir: null, silent: true, transports: [new Memory()] }) };
}

/** Stands in for getSignedUrl so route tests need no AWS credentials. */
const fakePresign = async (command, ttl) => `https://signed.test/${command.input.Key}?X-Amz-Expires=${ttl}&X-Amz-Signature=fake`;

/** Starts the app on a random port. Returns the base URL and a close function. */
async function start(s3 = fakeS3(), overrides = {}) {
    const app = createApp({ s3, bucketName: 'test-bucket', region: 'ap-south-1', auth: TEST_AUTH,
        logger: createLogger({ logDir: null, silent: true }), presign: fakePresign, ...overrides });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function loginToken(url, username = TEST_AUTH.adminUsername, password = TEST_PASSWORD) {
    const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return { res, token: (await res.clone().json()).token };
}

function postFile(url, bytes, { name = 'deed.pdf', token, type = 'application/pdf' } = {}) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    return fetch(url, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

module.exports = { TEST_AUTH, TEST_PASSWORD, fakePresign, fakeS3, memoryLogger, start, loginToken, postFile };
