// Issue #60 (backend half) and the QR payload route of #58: your documents, paged and counted; the text for a document's QR code.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startMongo } = require('./mongo');
const { parseQrPayload } = require('../qr');
const { fakeS3, start, loginToken } = require('./helpers');
const { ADDR } = require('./chain-fakes');

let mongo;
let documents;
before(async () => { mongo = await startMongo(); documents = mongo.documents; });
after(async () => { await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); });

const sha = (n) => crypto.createHash('sha256').update(String(n)).digest('hex');
let n = 0;
const make = (over = {}) => { n += 1; return documents.create({ sha256: sha(n), s3Key: sha(n), status: 'STORED', issuerName: 'registrar', originalFileName: `d${n}.pdf`, ...over }); };

async function api(opts = {}) {
    const server = await start(fakeS3(), { documents, ...opts });
    const { token } = await loginToken(server.url);
    const get = (route, withToken = true) => fetch(`${server.url}${route}`, { headers: withToken ? { Authorization: `Bearer ${token}` } : {} });
    return { ...server, token, get };
}

test('GET /api/documents needs a login and returns only your own documents, newest first, as the safe record view', async () => {
    const s = await api();
    try {
        await make({ status: 'ISSUED' });
        await make({ issuerName: 'someone-else' });
        await make({ canonicalRecord: { holder: 'ASHA RAO' }, visual: { phash: { h: 'x' } }, contentHash: sha('c') });
        assert.strictEqual((await s.get('/api/documents', false)).status, 401);
        const body = await (await s.get('/api/documents')).json();
        assert.strictEqual(body.documents.length, 2, 'the other issuer\'s document is not listed');
        assert.ok(body.documents.every((d) => d.issuerName === 'registrar'));
        assert.ok(new Date(body.documents[0].createdAt) >= new Date(body.documents[1].createdAt), 'newest first');
        const text = JSON.stringify(body);
        for (const secret of ['ASHA RAO', 'phash', '_id', '__v', 'canonicalRecord', 'visual']) assert.ok(!text.includes(secret), `leaked: ${secret}`);
    } finally { await s.close(); }
});

test('paging walks every document exactly once, with no skips and no repeats, even when they were created in the same millisecond', async () => {
    const s = await api();
    try {
        const made = await Promise.all(Array.from({ length: 11 }, () => make()));         // created together: timestamps collide
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const body = await (await s.get(`/api/documents?limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json();
            seen.push(...body.documents.map((d) => d.documentId));
            cursor = body.nextCursor;
            pages += 1;
        } while (cursor && pages < 10);
        assert.strictEqual(pages, 3);
        assert.strictEqual(seen.length, 11);
        assert.strictEqual(new Set(seen).size, 11, 'no repeats');
        assert.deepStrictEqual([...seen].sort(), made.map((d) => d.documentId).sort(), 'no skips');
        const last = await (await s.get(`/api/documents?limit=11`)).json();
        assert.strictEqual(last.nextCursor, null, 'a page that holds everything has no next page');
    } finally { await s.close(); }
});

test('counts per status are for your documents only, and the status filter works', async () => {
    const s = await api();
    try {
        for (const status of ['ISSUED', 'ISSUED', 'ISSUED', 'FAILED', 'REVOKED', 'STORED']) await make({ status });
        await make({ status: 'ISSUED', issuerName: 'someone-else' });
        const body = await (await s.get('/api/documents')).json();
        assert.deepStrictEqual(body.counts, { ISSUED: 3, FAILED: 1, REVOKED: 1, STORED: 1 });
        const failed = await (await s.get('/api/documents?status=FAILED')).json();
        assert.deepStrictEqual(failed.documents.map((d) => d.status), ['FAILED']);
        assert.deepStrictEqual(failed.counts, body.counts, 'counts do not change with the filter');
        const none = await (await s.get('/api/documents?status=PENDING')).json();
        assert.deepStrictEqual([none.documents.length, none.nextCursor], [0, null]);
    } finally { await s.close(); }
});

test('junk parameters are 400: bad limit, status, cursor, and unknown or bracketed keys', async () => {
    const s = await api();
    try {
        for (const q of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'status=NUKED', 'cursor=nope', `cursor=${'g'.repeat(24)}`, 'cursor[$gt]=', 'owner=someone-else', 'status[$ne]=x']) {
            assert.strictEqual((await s.get(`/api/documents?${q}`)).status, 400, q);
        }
    } finally { await s.close(); }
});

test('without a database the list says 503', async () => {
    const server = await start(fakeS3());
    try {
        const { token } = await loginToken(server.url);
        assert.strictEqual((await fetch(`${server.url}/api/documents`, { headers: { Authorization: `Bearer ${token}` } })).status, 503);
    } finally { await server.close(); }
});

// ---- the text for a QR code
test('GET /api/documents/:id/qr gives the pointer text for an ISSUED document: content hash, chain, contract, nothing else', async () => {
    const s = await api({ chainId: 80002, contractAddress: ADDR });
    try {
        const doc = await make({ status: 'ISSUED', contentHash: sha('content'), canonicalRecord: { holder: 'ASHA RAO' } });
        const body = await (await s.get(`/api/documents/${doc.documentId}/qr`)).json();
        const parsed = parseQrPayload(body.payload);
        assert.deepStrictEqual(parsed, { ok: true, qr: { v: 1, contentHash: sha('content'), chainId: 80002, contractAddress: ADDR } });
        assert.ok(!body.payload.includes('ASHA'));
    } finally { await s.close(); }
});

test('the QR route refuses what has no meaningful code: not issued, no content hash, not yours, not configured, not logged in', async () => {
    const s = await api({ chainId: 80002, contractAddress: ADDR });
    const unconfigured = await api();
    try {
        const stored = await make({ status: 'STORED', contentHash: sha('s') });
        const noHash = await make({ status: 'ISSUED' });
        const theirs = await make({ status: 'ISSUED', contentHash: sha('t'), issuerName: 'someone-else' });
        const ok = await make({ status: 'ISSUED', contentHash: sha('ok') });
        assert.strictEqual((await s.get(`/api/documents/${stored.documentId}/qr`)).status, 409);
        assert.strictEqual((await s.get(`/api/documents/${noHash.documentId}/qr`)).status, 409);
        assert.strictEqual((await s.get(`/api/documents/${theirs.documentId}/qr`)).status, 404);
        assert.strictEqual((await s.get('/api/documents/not-an-id/qr')).status, 400);
        assert.strictEqual((await s.get(`/api/documents/${ok.documentId}/qr`, false)).status, 401);
        assert.strictEqual((await unconfigured.get(`/api/documents/${ok.documentId}/qr`)).status, 503);
    } finally { await s.close(); await unconfigured.close(); }
});
