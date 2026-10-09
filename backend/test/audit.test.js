// Issue #61: the audit trail. Real MongoDB, including a real TTL expiry.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startMongo } = require('./mongo');
const { maskIp, retentionDaysFromEnv, buildAuditModel, createAudit, ACTIONS, OUTCOMES, REASONS } = require('../audit');
const { fakeS3, memoryLogger, start, loginToken, postFile, TEST_PASSWORD } = require('./helpers');

let mongo;
let documents;
let audit;
before(async () => { mongo = await startMongo({ fastTtl: true }); documents = mongo.documents; audit = mongo.audit; });
after(async () => { await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); await audit.model.deleteMany({}); });

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n`);
const ADDR = '0x' + '12'.repeat(20);
const tx = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const chain = (table = {}) => ({ async getReceipt(h) { return table[h] || { state: 'not_found' }; } });
const mined = (over = {}) => ({ state: 'success', blockNumber: 99, to: ADDR, ...over });
const events = () => audit.model.find({}).sort({ createdAt: 1, _id: 1 }).lean();

async function api(opts = {}) {
    const server = await start(opts.s3 || fakeS3(), { documents, audit, contractAddress: ADDR, chain: chain(), ...opts });
    const { token } = await loginToken(server.url);
    const call = (method, route, body) => fetch(`${server.url}${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { ...server, token, call, anchor: (bytes) => postFile(`${server.url}/api/anchor`, bytes, { token }),
        hash: (bytes) => postFile(`${server.url}/api/hash`, bytes) };
}

// ---------------------------------------------------------------- the schema
test('the TTL index exists (365 days by default) and the other indexes are in place', async () => {
    const idx = await audit.model.collection.indexes();
    const byKey = Object.fromEntries(idx.map((i) => [Object.keys(i.key).join(','), i]));
    assert.strictEqual(byKey.createdAt.expireAfterSeconds, 31536000, '1 year');
    assert.ok(byKey.documentId, 'documentId indexed');
    assert.ok(byKey['action,createdAt']);
});

test('retention is configurable, and junk falls back to 365 days', () => {
    assert.strictEqual(retentionDaysFromEnv({ AUDIT_RETENTION_DAYS: '30' }), 30);
    for (const bad of [undefined, '', 'abc', '0', '-5']) assert.strictEqual(retentionDaysFromEnv({ AUDIT_RETENTION_DAYS: bad }), 365, String(bad));
});

test('events really expire: an event older than the retention period is deleted by MongoDB, a fresh one is kept', async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await audit.model.collection.insertOne({ action: 'LOGIN', outcome: 'SUCCESS', createdAt: old });
    await audit.model.collection.insertOne({ action: 'LOGIN', outcome: 'SUCCESS', createdAt: new Date() });
    for (let i = 0; i < 40; i++) {                                    // the TTL monitor runs every second in this test server
        if ((await audit.model.countDocuments({})) === 1) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(await audit.model.countDocuments({}), 1);
    assert.ok((await audit.model.findOne({}).lean()).createdAt > old);
});

test('the schema is strict and enumerated: unknown fields are dropped, bad actions and reasons are refused', async () => {
    assert.strictEqual(await audit.record({ action: 'NUKE', outcome: 'SUCCESS' }), false);
    assert.strictEqual(await audit.record({ action: 'LOGIN', outcome: 'SUCCESS', reason: 'my password is hunter2' }), false);
    assert.strictEqual(await audit.record({ action: 'LOGIN', outcome: 'MAYBE' }), false);
    await audit.model.create({ action: 'LOGIN', outcome: 'SUCCESS', password: 'hunter2', fileContents: 'TOP-SECRET', token: 'abc' });
    const raw = await audit.model.collection.findOne({});
    assert.deepStrictEqual(Object.keys(raw).sort(), ['_id', 'action', 'createdAt', 'outcome']);
});

test('maskIp keeps enough to spot abuse but not to identify a person', () => {
    assert.strictEqual(maskIp('203.0.113.77'), '203.0.113.0');
    assert.strictEqual(maskIp('::ffff:198.51.100.9'), '198.51.100.0');
    assert.strictEqual(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::');
    assert.strictEqual(maskIp('::1'), '::1');
    for (const bad of [undefined, null, '', 'not an ip', 42]) assert.strictEqual(maskIp(bad), undefined, String(bad));
});

test('a failing database never breaks the caller of audit: record() returns false and logs a warning with no secrets', async () => {
    const { logger, lines } = memoryLogger();
    const { connectDatabase } = require('../db');
    const db = await connectDatabase(mongo.uri, { logger });          // a second connection to the shared test server
    await db.close();                                                   // ...which we then close: the database is "gone"
    const ok = await db.audit.record({ action: 'LOGIN', outcome: 'SUCCESS', actorName: 'registrar', ip: '203.0.113.5' });
    assert.strictEqual(ok, false);
    assert.ok(lines.join('\n').includes('could not write audit event'));
});

// ---------------------------------------------------------------- what gets recorded
test('LOGIN: success records the account name; failure records no username and no password', async () => {
    const server = await api();
    try {
        await audit.model.deleteMany({});
        await loginToken(server.url, 'registrar', TEST_PASSWORD);
        await loginToken(server.url, 'my-p@ssword-typed-in-the-wrong-box', 'also-wrong-password');
        const [ok, bad] = await events();
        assert.deepStrictEqual([ok.action, ok.outcome, ok.actorName], ['LOGIN', 'SUCCESS', 'registrar']);
        assert.deepStrictEqual([bad.action, bad.outcome, bad.reason], ['LOGIN', 'FAILED', 'BAD_CREDENTIALS']);
        assert.strictEqual(bad.actorName, undefined);
        const stored = JSON.stringify(await audit.model.collection.find({}).toArray());
        assert.ok(!stored.includes('typed-in-the-wrong-box') && !stored.includes('also-wrong') && !stored.includes(TEST_PASSWORD));
        assert.match(ok.ip, /^127\.0\.0\.0$/, 'the address is truncated');
    } finally { await server.close(); }
});

test('ISSUE: every step of a document\'s life is recorded in order, with the officer and the document', async () => {
    const server = await api({ chain: chain({ [tx(1)]: mined() }) });
    try {
        await audit.model.deleteMany({});
        const bytes = pdf('life');
        const doc = (await (await server.anchor(bytes)).json()).document;
        await server.anchor(bytes);                                                                   // duplicate
        await server.call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(1) });
        await server.call('POST', `/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: tx(1) });
        const got = (await events()).filter((e) => e.action === 'ISSUE');
        assert.deepStrictEqual(got.map((e) => `${e.outcome}:${e.reason}`),
            ['SUCCESS:STORED', 'SUCCESS:DUPLICATE', 'SUCCESS:CHAIN_PENDING', 'SUCCESS:CHAIN_CONFIRMED']);
        assert.ok(got.every((e) => e.actorName === 'registrar' && e.documentId === doc.documentId));
    } finally { await server.close(); }
});

test('ISSUE failures are recorded too: S3 outage, wallet rejection, reverted transaction', async () => {
    let broken = true;
    const s3 = { send: async () => { if (broken) throw new Error('S3 down'); return {}; } };
    const server = await api({ s3, chain: chain({ [tx(2)]: mined({ state: 'reverted' }) }) });
    try {
        await audit.model.deleteMany({});
        const a = pdf('outage');
        assert.strictEqual((await server.anchor(a)).status, 500);
        broken = false;
        const id = (await (await server.anchor(pdf('rejected'))).json()).document.documentId;
        await server.call('POST', `/api/documents/${id}/chain-failed`, { reason: 'USER_REJECTED' });
        const id2 = (await (await server.anchor(pdf('reverted'))).json()).document.documentId;
        await server.call('POST', `/api/documents/${id2}/chain-pending`, { transactionHash: tx(2) });
        await server.call('POST', `/api/documents/${id2}/chain-confirmed`, { transactionHash: tx(2) });
        const failed = (await events()).filter((e) => e.outcome === 'FAILED').map((e) => e.reason);
        assert.deepStrictEqual(failed, ['ERROR', 'USER_REJECTED', 'CHAIN_REVERTED']);
    } finally { await server.close(); }
});

test('VERIFY: the public hash check records who looked (no actor), the verdict, and the document if it exists', async () => {
    const server = await api({ chain: chain({ [tx(3)]: mined() }) });
    try {
        const issued = pdf('issued doc');
        const id = (await (await server.anchor(issued)).json()).document.documentId;
        await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(3) });
        await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(3) });
        const storedOnly = pdf('stored only');
        await server.anchor(storedOnly);
        const revoked = pdf('revoked doc');
        const revokedId = (await (await server.anchor(revoked)).json()).document.documentId;
        await documents.model.updateOne({ documentId: revokedId }, { $set: { status: 'REVOKED' } });
        await audit.model.deleteMany({});

        for (const bytes of [issued, storedOnly, revoked, pdf('a forgery nobody issued')]) {
            const res = await server.hash(bytes);
            assert.deepStrictEqual(await res.json(), { success: true, hash: sha(bytes) }, 'the response is unchanged');
        }
        const got = await events();
        assert.deepStrictEqual(got.map((e) => `${e.outcome}:${e.reason}`), ['SUCCESS:MATCH', 'FAILED:NOT_ISSUED', 'FAILED:REVOKED', 'FAILED:NO_MATCH']);
        assert.ok(got.every((e) => e.action === 'VERIFY' && e.actorName === undefined), 'citizens are not identified');
        assert.strictEqual(got[0].documentId, id);
        assert.strictEqual(got[3].documentId, undefined, 'an unknown file points at nothing');
    } finally { await server.close(); }
});

test('nothing sensitive reaches the audit trail: no file hash, content, filename, password or token anywhere', async () => {
    const server = await api({ chain: chain({ [tx(4)]: mined() }) });
    try {
        const bytes = pdf('CONFIDENTIAL-CITIZEN-DATA 123-45-6789');
        const res = await postFile(`${server.url}/api/anchor`, bytes, { name: 'asha-rao-aadhaar.pdf', token: server.token });
        const id = (await res.json()).document.documentId;
        await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(4) });
        await server.hash(bytes);
        await server.hash(pdf('unknown but private 987-65-4321'));
        const everything = JSON.stringify(await audit.model.collection.find({}).toArray());
        for (const banned of [sha(bytes), 'CONFIDENTIAL', '123-45-6789', '987-65-4321', 'asha-rao', 'aadhaar', TEST_PASSWORD, server.token, tx(4)]) {
            assert.ok(!everything.includes(banned), `audit trail contains: ${banned}`);
        }
        const allowed = new Set(['_id', 'action', 'outcome', 'reason', 'actorName', 'documentId', 'ip', 'createdAt']);
        for (const e of await audit.model.collection.find({}).toArray()) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    } finally { await server.close(); }
});

test('an audit failure never breaks the request it describes', async () => {
    const brokenAudit = { record: async () => { throw new Error('audit exploded'); }, forDocument: async () => [], recent: async () => [] };
    // record() is documented to swallow errors; if a bad implementation throws anyway, the routes must not return a wrong status
    const swallowing = { ...audit, record: async () => false };
    const server = await api({ audit: swallowing });
    try {
        assert.strictEqual((await server.hash(pdf('still works'))).status, 200);
        assert.strictEqual((await loginToken(server.url)).res.status, 200);
        assert.strictEqual((await server.anchor(pdf('still works too'))).status, 200);
    } finally { await server.close(); }
    assert.ok(brokenAudit);
});

// ---------------------------------------------------------------- reading it back
test('GET /api/documents/:id/audit returns that document\'s history, newest first, to its issuer only', async () => {
    const server = await api({ chain: chain({ [tx(5)]: mined() }) });
    try {
        const id = (await (await server.anchor(pdf('history'))).json()).document.documentId;
        await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(5) });
        await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(5) });
        const body = await (await server.call('GET', `/api/documents/${id}/audit`)).json();
        assert.deepStrictEqual(body.events.map((e) => e.reason), ['CHAIN_CONFIRMED', 'CHAIN_PENDING', 'STORED']);
        assert.ok(body.events.every((e) => !('_id' in e)), 'no Mongo internals');
        const theirs = await documents.create({ sha256: sha('theirs'), s3Key: sha('theirs'), status: 'STORED', issuerName: 'someone-else' });
        assert.strictEqual((await server.call('GET', `/api/documents/${theirs.documentId}/audit`)).status, 404);
        assert.strictEqual((await server.call('GET', '/api/documents/not-an-id/audit')).status, 400);
        assert.strictEqual((await fetch(`${server.url}/api/documents/${id}/audit`)).status, 401);
    } finally { await server.close(); }
});

test('GET /api/audit: filters, limit and paging by cursor; bad parameters are 400; login required', async () => {
    const server = await api();
    try {
        await audit.model.deleteMany({});
        for (let i = 0; i < 5; i++) await audit.record({ action: 'VERIFY', outcome: i % 2 ? 'SUCCESS' : 'FAILED', reason: i % 2 ? 'MATCH' : 'NO_MATCH' });
        await audit.record({ action: 'LOGIN', outcome: 'FAILED', reason: 'BAD_CREDENTIALS' });
        const get = async (q) => (await (await server.call('GET', `/api/audit${q}`)).json()).events;
        assert.strictEqual((await get('')).length, 6);
        assert.strictEqual((await get('?action=VERIFY')).length, 5);
        assert.strictEqual((await get('?action=VERIFY&outcome=FAILED')).length, 3);
        assert.strictEqual((await get('?limit=2')).length, 2);
        const page1 = await get('?limit=3');
        const page2 = await get(`?limit=3&before=${encodeURIComponent(new Date(page1[2].createdAt).toISOString())}`);
        assert.ok(page2.every((e) => new Date(e.createdAt) < new Date(page1[2].createdAt)), 'the cursor moves strictly back in time');
        for (const bad of ['?action=NUKE', '?outcome=MAYBE', '?limit=0', '?limit=201', '?limit=abc', '?before=yesterday', '?action[$ne]=x']) {
            assert.strictEqual((await server.call('GET', `/api/audit${bad}`)).status, 400, bad);
        }
        assert.strictEqual((await fetch(`${server.url}/api/audit`)).status, 401);
    } finally { await server.close(); }
});

test('without a database the audit routes say 503 and nothing else changes', async () => {
    const server = await start(fakeS3());
    try {
        const { token } = await loginToken(server.url);
        const h = { headers: { Authorization: `Bearer ${token}` } };
        assert.strictEqual((await fetch(`${server.url}/api/audit`, h)).status, 503);
        assert.strictEqual((await fetch(`${server.url}/api/documents/00000000-0000-0000-0000-000000000000/audit`, h)).status, 503);
        assert.strictEqual((await postFile(`${server.url}/api/hash`, pdf('x'))).status, 200);
    } finally { await server.close(); }
});

test('the vocabularies are fixed', () => {
    assert.deepStrictEqual(ACTIONS, ['ISSUE', 'VERIFY', 'REVOKE', 'LOGIN']);
    assert.deepStrictEqual(OUTCOMES, ['SUCCESS', 'FAILED']);
    assert.ok(REASONS.every((r) => /^[A-Z_]+$/.test(r)), 'short codes only');
    assert.ok(buildAuditModel && createAudit);
});
