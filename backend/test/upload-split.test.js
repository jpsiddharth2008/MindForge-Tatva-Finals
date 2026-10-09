// Issue #50: verification must never persist the suspect file.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../app');

/** Fake S3 client that records every command sent to it. */
function fakeS3() {
    const sent = [];
    return { sent, send: async (command) => { sent.push(command); return {}; } };
}

/** Starts the app on a random port and returns its base URL plus a close function. */
async function start(s3) {
    const app = createApp({ s3, bucketName: 'test-bucket', region: 'ap-south-1' });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function post(url, bytes, name = 'deed.pdf') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    return fetch(url, { method: 'POST', body: form });
}

const FILE = Buffer.from('%PDF-1.4 genuine land deed #4471');
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');

test('POST /api/hash returns the SHA-256 and writes nothing to S3', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const res = await post(`${api.url}/api/hash`, FILE);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { success: true, hash: SHA });
        assert.strictEqual(s3.sent.length, 0, 'verification must produce zero S3 writes');
    } finally {
        await api.close();
    }
});

test('verifying many files, including a forged copy with the same name, writes nothing', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        for (const body of [FILE, Buffer.from('%PDF-1.4 FORGED deed'), Buffer.alloc(0x4000, 7)]) {
            const res = await post(`${api.url}/api/hash`, body, 'deed.pdf');
            assert.strictEqual(res.status, 200);
        }
        assert.strictEqual(s3.sent.length, 0);
    } finally {
        await api.close();
    }
});

test('POST /api/anchor stores the file once and returns the same hash as /api/hash', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const res = await post(`${api.url}/api/anchor`, FILE);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.hash, SHA);
        assert.strictEqual(s3.sent.length, 1);
        const input = s3.sent[0].input;
        assert.strictEqual(input.Bucket, 'test-bucket');
        assert.ok(Buffer.from(input.Body).equals(FILE));
    } finally {
        await api.close();
    }
});

test('the old /upload route is gone', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const res = await post(`${api.url}/upload`, FILE);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(s3.sent.length, 0);
    } finally {
        await api.close();
    }
});

test('both routes reject a request with no file and write nothing', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        for (const route of ['/api/hash', '/api/anchor']) {
            const res = await fetch(`${api.url}${route}`, { method: 'POST', body: new FormData() });
            assert.strictEqual(res.status, 400);
        }
        assert.strictEqual(s3.sent.length, 0);
    } finally {
        await api.close();
    }
});
