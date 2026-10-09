// Issue #50: verification must never persist the suspect file.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { fakeS3, start, loginToken, postFile } = require('./helpers');

const post = (url, bytes, name = 'deed.pdf', token) => postFile(url, bytes, { name, token });

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
        const { token } = await loginToken(api.url);
        const res = await post(`${api.url}/api/anchor`, FILE, 'deed.pdf', token);
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
        const { token } = await loginToken(api.url);
        for (const route of ['/api/hash', '/api/anchor']) {
            const res = await fetch(`${api.url}${route}`, { method: 'POST', body: new FormData(),
                headers: { Authorization: `Bearer ${token}` } });
            assert.strictEqual(res.status, 400);
        }
        assert.strictEqual(s3.sent.length, 0);
    } finally {
        await api.close();
    }
});
