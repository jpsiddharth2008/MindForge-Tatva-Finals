// Issue #53: the Document record, against a real MongoDB (mongodb-memory-server), so unique indexes are real.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createMongod } = require('./mongo');
const { connectDocuments } = require('../db');
const { DuplicateDocumentError, STATUSES } = require('../documents');
const { scrubString } = require('../logger');
const { fakeS3, start, loginToken, postFile } = require('./helpers');

let mongod;
let documents;

before(async () => {
    mongod = await createMongod();
    documents = await connectDocuments(mongod.getUri());
});
after(async () => {
    await documents.close();
    await mongod.__stopAndClean();
});
beforeEach(async () => { await documents.model.deleteMany({}); });

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n`);
const TX = '0x' + 'ab'.repeat(32);
const ADDR = '0x' + '12'.repeat(20);

const record = (over = {}) => {
    const bytes = pdf(String(Math.random()));
    return { sha256: sha(bytes), byteHash: sha(bytes), s3Key: sha(bytes), originalFileName: 'degree.pdf', mimeType: 'application/pdf',
        size: bytes.length, issuerName: 'registrar', chainId: 80002, contractAddress: ADDR, status: 'STORED', ...over };
};

test('indexes: documentId and sha256 are unique, transactionHash is unique-sparse, status is indexed', async () => {
    const idx = await documents.model.collection.indexes();
    const byKey = Object.fromEntries(idx.map((i) => [Object.keys(i.key).join(','), i]));
    assert.ok(byKey.documentId.unique, 'documentId unique');
    assert.ok(byKey.sha256.unique, 'sha256 unique');
    assert.ok(byKey.transactionHash.unique && byKey.transactionHash.sparse, 'transactionHash unique + sparse');
    assert.ok(byKey.status, 'status indexed');
});

test('an issued document is retrievable by documentId, by sha256 and by transactionHash', async () => {
    const created = await documents.create(record({ status: 'ISSUED', issuedAt: new Date() }));
    await documents.recordTransaction(created.documentId, { transactionHash: TX.toUpperCase().replace('0X', '0x'), blockNumber: 123, chainId: 80002, contractAddress: ADDR });
    const byId = await documents.findByDocumentId(created.documentId);
    const byHash = await documents.findBySha256(created.sha256);
    const byTx = await documents.findByTransactionHash(TX);
    for (const found of [byHash, byTx]) assert.strictEqual(found.documentId, byId.documentId);
    assert.strictEqual(byTx.blockNumber, 123);
    assert.strictEqual(byTx.transactionHash, TX, 'stored lower-case');
    assert.strictEqual(await documents.findByDocumentId('00000000-0000-0000-0000-000000000000'), null);
    assert.strictEqual(await documents.findBySha256(sha('nothing')), null);
});

test('a second record with the same sha256 is refused by the database', async () => {
    const r = record();
    await documents.create(r);
    await assert.rejects(() => documents.create({ ...r }), DuplicateDocumentError);
    assert.strictEqual(await documents.model.countDocuments({ sha256: r.sha256 }), 1);
});

test('ten simultaneous inserts of the same bytes produce exactly one row (race-proof)', async () => {
    const r = record();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => documents.create({ ...r })));
    assert.strictEqual(results.filter((x) => x.status === 'fulfilled').length, 1);
    for (const x of results.filter((y) => y.status === 'rejected')) assert.ok(x.reason instanceof DuplicateDocumentError);
    assert.strictEqual(await documents.model.countDocuments({}), 1);
});

test('two records cannot share a transaction hash', async () => {
    const a = await documents.create(record());
    const b = await documents.create(record());
    await documents.recordTransaction(a.documentId, { transactionHash: TX, blockNumber: 1, chainId: 80002, contractAddress: ADDR });
    await assert.rejects(() => documents.recordTransaction(b.documentId, { transactionHash: TX, blockNumber: 2, chainId: 80002, contractAddress: ADDR }));
});

test('many records without a transaction yet do not collide on the sparse index', async () => {
    for (let i = 0; i < 5; i++) await documents.create(record());
    assert.strictEqual(await documents.model.countDocuments({}), 5);
});

test('invalid values are rejected: bad hash, type, status, transaction hash, address, negative size', async () => {
    const bad = [
        { sha256: 'not-a-hash' }, { sha256: sha('x').toUpperCase() }, { mimeType: 'application/x-msdownload' },
        { status: 'DONE' }, { transactionHash: '0x123' }, { contractAddress: 'nope' }, { size: -1 }, { chainId: 0 }, { s3Key: undefined },
    ];
    for (const over of bad) await assert.rejects(() => documents.create(record(over)), (e) => e.name === 'ValidationError', JSON.stringify(over));
    assert.deepStrictEqual(STATUSES, ['PENDING', 'STORED', 'BLOCKCHAIN_PENDING', 'ISSUED', 'FAILED', 'REVOKED']);
});

test('status defaults to PENDING and a documentId is generated', async () => {
    const { status, ...r } = record();
    const doc = await documents.create(r);
    assert.strictEqual(doc.status, 'PENDING');
    assert.match(doc.documentId, /^[0-9a-f-]{36}$/);
});

test('secrets and unknown fields are never stored (strict schema)', async () => {
    await documents.create({ ...record(), password: 'hunter2', privateKey: '0x' + 'cd'.repeat(32), awsSecret: 'x', mongoUri: 'mongodb://u:p@h/d', fileContents: 'TOP-SECRET' });
    const raw = await documents.model.collection.findOne({});
    const allowed = new Set(['_id', '__v', 'documentId', 'sha256', 'byteHash', 's3Key', 'originalFileName', 'mimeType', 'size', 'issuerUserId',
        'issuerName', 'chainId', 'contractAddress', 'transactionHash', 'blockNumber', 'status', 'issuedAt', 'createdAt', 'updatedAt']);
    for (const key of Object.keys(raw)) assert.ok(allowed.has(key), `unexpected stored field: ${key}`);
    assert.ok(!JSON.stringify(raw).match(/hunter2|TOP-SECRET|mongodb:|cd{64}/));
});

// ---- through the HTTP API ----
const anchor = (api, token, bytes, name = 'degree.pdf') => postFile(`${api.url}/api/anchor`, bytes, { name, token });
const get = (api, token, route) => fetch(`${api.url}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('anchoring records the document: status STORED, key = hash, issuer, size, type, chain', async () => {
    const api = await start(fakeS3(), { documents, chainId: 80002, contractAddress: ADDR });
    try {
        const { token } = await loginToken(api.url);
        const bytes = pdf('Asha Rao degree');
        const body = await (await anchor(api, token, bytes)).json();
        assert.strictEqual(body.duplicate, false);
        const d = body.document;
        assert.deepStrictEqual(
            { sha256: d.sha256, s3Key: d.s3Key, status: d.status, issuerName: d.issuerName, size: d.size, mimeType: d.mimeType, chainId: d.chainId, contractAddress: d.contractAddress, originalFileName: d.originalFileName },
            { sha256: sha(bytes), s3Key: sha(bytes), status: 'STORED', issuerName: 'registrar', size: bytes.length, mimeType: 'application/pdf', chainId: 80002, contractAddress: ADDR, originalFileName: 'degree.pdf' });
        assert.ok(!('_id' in d) && !('__v' in d), 'no Mongo internals leak');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await api.close(); }
});

test('submitting the same document twice: second time writes nothing to S3 or Mongo and returns the same record', async () => {
    const s3 = fakeS3();
    const api = await start(s3, { documents });
    try {
        const { token } = await loginToken(api.url);
        const bytes = pdf('same document');
        const first = await (await anchor(api, token, bytes)).json();
        assert.strictEqual(s3.sent.length, 1);
        const second = await (await anchor(api, token, bytes, 'renamed.pdf')).json();
        assert.strictEqual(second.duplicate, true);
        assert.strictEqual(second.document.documentId, first.document.documentId);
        assert.ok(second.url.includes('X-Amz-Signature'), 'a fresh signed link is still returned');
        assert.strictEqual(s3.sent.length, 1, 'no second S3 write');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await api.close(); }
});

test('simultaneous uploads of the same bytes leave one record and every request succeeds', async () => {
    const api = await start(fakeS3(), { documents });
    try {
        const { token } = await loginToken(api.url);
        const bytes = pdf('race');
        const replies = await Promise.all(Array.from({ length: 6 }, () => anchor(api, token, bytes)));
        assert.ok(replies.every((r) => r.status === 200));
        const bodies = await Promise.all(replies.map((r) => r.json()));
        assert.strictEqual(new Set(bodies.map((b) => b.document.documentId)).size, 1);
        assert.strictEqual(await documents.model.countDocuments({}), 1);
        assert.ok(bodies.filter((b) => !b.duplicate).length >= 1, 'someone did the original write');
    } finally { await api.close(); }
});

test('a FAILED record, or a PENDING one silent for a while, is retried (same documentId, back to STORED), not treated as a duplicate', async () => {
    const api = await start(fakeS3(), { documents });
    try {
        const { token } = await loginToken(api.url);
        for (const status of ['FAILED', 'PENDING']) {
            await documents.model.deleteMany({});
            const bytes = pdf(`retry ${status}`);
            const old = await documents.create(record({ sha256: sha(bytes), s3Key: sha(bytes), status }));
            // a PENDING row is only retried once it has been silent long enough to belong to a crashed request
            await documents.model.collection.updateOne({ documentId: old.documentId }, { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) } });
            const body = await (await anchor(api, token, bytes)).json();
            assert.strictEqual(body.duplicate, false, status);
            assert.strictEqual(body.document.documentId, old.documentId);
            assert.strictEqual(body.document.status, 'STORED');
            assert.strictEqual(await documents.model.countDocuments({}), 1);
        }
    } finally { await api.close(); }
});

test('lookup routes: by documentId, by hash and by transaction hash all return the same record', async () => {
    const api = await start(fakeS3(), { documents });
    try {
        const { token } = await loginToken(api.url);
        const bytes = pdf('lookup');
        const { document } = await (await anchor(api, token, bytes)).json();
        await documents.recordTransaction(document.documentId, { transactionHash: TX, blockNumber: 7, chainId: 80002, contractAddress: ADDR });
        for (const route of [`/api/documents/${document.documentId}`, `/api/documents/by-hash/${sha(bytes)}`, `/api/documents/by-tx/${TX}`]) {
            const res = await get(api, token, route);
            assert.strictEqual(res.status, 200, route);
            assert.strictEqual((await res.json()).document.documentId, document.documentId);
        }
    } finally { await api.close(); }
});

test('lookup routes: login required, unknown is 404, malformed and injection attempts are 400', async () => {
    const api = await start(fakeS3(), { documents });
    try {
        const { token } = await loginToken(api.url);
        assert.strictEqual((await get(api, null, `/api/documents/by-hash/${sha('x')}`)).status, 401);
        assert.strictEqual((await get(api, token, `/api/documents/by-hash/${sha('nobody')}`)).status, 404);
        assert.strictEqual((await get(api, token, `/api/documents/by-tx/${TX}`)).status, 404);
        assert.strictEqual((await get(api, token, '/api/documents/00000000-0000-0000-0000-000000000000')).status, 404);
        for (const route of ['/api/documents/by-hash/short', '/api/documents/by-hash/' + encodeURIComponent('{"$ne":""}'),
            '/api/documents/by-tx/0x123', '/api/documents/' + encodeURIComponent('{"$gt":""}'), `/api/documents/by-hash/${sha('x').toUpperCase()}`]) {
            assert.strictEqual((await get(api, token, route)).status, 400, route);
        }
    } finally { await api.close(); }
});

test('without a database the anchor still works but records nothing, and lookups say 503', async () => {
    const api = await start(fakeS3());
    try {
        const { token } = await loginToken(api.url);
        const body = await (await anchor(api, token, pdf('no db'))).json();
        assert.strictEqual(body.document, null);
        assert.strictEqual((await get(api, token, `/api/documents/by-hash/${sha('x')}`)).status, 503);
        assert.strictEqual((await (await fetch(`${api.url}/api/health`)).json()).components.mongodb, 'not_configured');
    } finally { await api.close(); }
});

test('health reports mongodb ok while connected', async () => {
    const api = await start(fakeS3(), { documents });
    try {
        const body = await (await fetch(`${api.url}/api/health`)).json();
        assert.strictEqual(body.components.mongodb, 'ok');
    } finally { await api.close(); }
});

test('a bad connection string fails fast, and the error text carries no password once scrubbed', async () => {
    const uri = 'mongodb://appuser:Sup3rS3cretPw@127.0.0.1:1/mindforge';
    let message;
    await assert.rejects(() => connectDocuments(uri, { serverSelectionTimeoutMS: 400 }), (e) => { message = e.message; return true; });
    assert.ok(!scrubString(message).includes('Sup3rS3cretPw'), 'password must not survive the logger');
});
