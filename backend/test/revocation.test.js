// Issue #59 and strict anchoring (#52/#62): the server believes the chain, and only the chain.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { startMongo } = require('./mongo');
const c = require('./fixtures/certificate');
const { fakeS3, start, loginToken } = require('./helpers');

let mongo;
let documents;
let audit;
before(async () => { mongo = await startMongo(); documents = mongo.documents; audit = mongo.audit; });
after(async () => { await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); await audit.model.deleteMany({}); });

const ADDR = '0x' + '12'.repeat(20);
const OTHER = '0x' + '99'.repeat(20);
const ISSUER = '0x' + 'aa'.repeat(20);
const STRANGER = '0x' + 'bb'.repeat(20);
const tx = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const NONE = '0'.repeat(64);

/** A chain that knows exactly what the tests tell it, and offers the same questions as backend/chain.js. */
function fakeChain() {
    return {
        receipts: {}, anchorCalls: {}, revokeCalls: {}, registry: {}, revocations: {},
        async getReceipt(h) { return this.receipts[h] || { state: 'not_found' }; },
        async getAnchorCall(h) { return this.anchorCalls[h] || null; },
        async getRevokeCall(h) { return this.revokeCalls[h] || null; },
        async verify(ch) { return this.registry[ch] || { exists: false, issuer: '0x' + '0'.repeat(40), issuerName: '', issuedAt: 0, revoked: false, byteHash: NONE }; },
        async getRevocation(ch) { return this.revocations[ch] || null; },
    };
}

/** What the chain would hold after a correct anchoring transaction for `doc`. Pass overrides to break one thing at a time. */
function mineAnchor(chain, doc, txHash, o = {}) {
    chain.receipts[txHash] = { state: 'success', blockNumber: 5, to: ADDR, ...(o.receipt || {}) };
    chain.anchorCalls[txHash] = o.call === null ? null : { contentHash: doc.contentHash, byteHash: doc.sha256, from: ISSUER, to: ADDR, ...(o.call || {}) };
    chain.registry[doc.contentHash] = { exists: true, issuer: ISSUER, issuerName: 'Testland Registrar', issuedAt: 1_800_000_000, revoked: false, byteHash: doc.sha256, ...(o.registry || {}) };
}

let counter = 0;
async function api(chain, opts = {}) {
    const server = await start(fakeS3(), { documents, audit, contractAddress: ADDR, chainId: 80002, chain, ...opts });
    const { token } = await loginToken(server.url);
    const call = (method, route, body) => fetch(`${server.url}${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    // a distinct PDF with its own details, so each document has its own content hash
    const issue = async (withDetails = true) => {
        counter += 1;
        const fields = c.withFields({ idNumber: `B2100${counter}CS` });
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(`%PDF-1.4\ndocument ${counter} ${Math.random()}\n`)], { type: 'application/pdf' }), 'd.pdf');
        if (withDetails) form.append('fields', JSON.stringify(fields));
        const res = await fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
        return (await res.json()).document;
    };
    return { ...server, token, call, issue };
}

/** Takes a document all the way to ISSUED against the fake chain. */
async function issued(server, chain, n) {
    const doc = await server.issue();
    mineAnchor(chain, doc, tx(n));
    await server.call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(n) });
    const r = await (await server.call('POST', `/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: tx(n) })).json();
    assert.strictEqual(r.document.status, 'ISSUED', JSON.stringify(r));
    return r.document;
}

// ---------------------------------------------------------------- strict anchoring
test('a transaction that anchored exactly this document\'s two hashes, held by the registry, makes it ISSUED', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await server.issue();
        assert.match(doc.contentHash, /^[a-f0-9]{64}$/);
        mineAnchor(chain, doc, tx(1));
        await server.call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(1) });
        const r = await (await server.call('POST', `/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: tx(1) })).json();
        assert.strictEqual(r.state, 'issued');
    } finally { await server.close(); }
});

const breakages = [
    ['anchored a different content hash', { call: { contentHash: 'f'.repeat(64) } }],
    ['anchored a different byte hash', { call: { byteHash: 'e'.repeat(64) } }],
    ['was not an anchor() call at all', { call: null }],
    ['succeeded, but the registry does not hold the document', { registry: { exists: false } }],
    ['the registry holds it under a different byte hash', { registry: { byteHash: 'd'.repeat(64) } }],
    ['the registry says it was issued by someone other than the sender', { registry: { issuer: STRANGER } }],
    ['the registry already shows it revoked', { registry: { revoked: true } }],
];
for (const [name, overrides] of breakages) {
    test(`a successful transaction that is NOT this document's issuance fails it (WRONG_DATA): ${name}`, async () => {
        const chain = fakeChain();
        const server = await api(chain);
        try {
            const doc = await server.issue();
            mineAnchor(chain, doc, tx(2), overrides);
            await server.call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(2) });
            const r = await (await server.call('POST', `/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: tx(2) })).json();
            assert.strictEqual(r.state, 'failed');
            assert.deepStrictEqual([r.document.status, r.document.failureReason], ['FAILED', 'WRONG_DATA']);
            const ev = await audit.model.findOne({ reason: 'WRONG_DATA' }).lean();
            assert.ok(ev && ev.outcome === 'FAILED');
        } finally { await server.close(); }
    });
}

test('a document uploaded without its details has no content hash, so it cannot be sent for anchoring (409, with a clear instruction)', async () => {
    const server = await api(fakeChain());
    try {
        const doc = await server.issue(false);
        assert.strictEqual(doc.contentHash, undefined);
        const res = await server.call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(3) });
        assert.strictEqual(res.status, 409);
        assert.match((await res.json()).error, /no content hash.*details/);
        assert.strictEqual((await documents.findByDocumentId(doc.documentId)).status, 'STORED');
    } finally { await server.close(); }
});

// ---------------------------------------------------------------- revocation
function mineRevoke(chain, doc, txHash, { reason = 'Issued in error', at = new Date('2026-10-10T09:30:00Z'), receipt = {}, call = {}, registry = {} } = {}) {
    chain.receipts[txHash] = { state: 'success', blockNumber: 9, to: ADDR, ...receipt };
    chain.revokeCalls[txHash] = call === null ? null : { contentHash: doc.contentHash, reason, from: ISSUER, to: ADDR, ...call };
    chain.registry[doc.contentHash] = { ...chain.registry[doc.contentHash], revoked: true, ...registry };
    chain.revocations[doc.contentHash] = { reason, by: ISSUER, txHash, blockNumber: 9, at };
}

test('revocation: after the chain confirms revoke(), the record becomes REVOKED with the chain\'s reason and time; verifiers can see both', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await issued(server, chain, 10);
        mineRevoke(chain, doc, tx(11), { reason: 'Degree withdrawn after inquiry', at: new Date('2026-10-10T09:30:00Z') });
        const res = await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(11) });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'revoked');
        assert.strictEqual(body.document.status, 'REVOKED');
        assert.strictEqual(body.document.revocationReason, 'Degree withdrawn after inquiry');
        assert.strictEqual(new Date(body.document.revokedAt).toISOString(), '2026-10-10T09:30:00.000Z', 'the time is the block time, not "now"');
        assert.strictEqual(body.document.revocationTxHash, tx(11));
        const ev = await audit.model.findOne({ action: 'REVOKE' }).lean();
        assert.deepStrictEqual([ev.outcome, ev.actorName, ev.documentId], ['SUCCESS', 'registrar', doc.documentId]);
        const row = await documents.findByDocumentId(doc.documentId);
        assert.strictEqual(row.status, 'REVOKED');
    } finally { await server.close(); }
});

test('the reason comes from the chain: a client cannot supply or change it', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await issued(server, chain, 12);
        mineRevoke(chain, doc, tx(13), { reason: 'The real reason' });
        const body = await (await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(13), reason: 'A made-up reason', revocationReason: 'also made up' })).json();
        assert.strictEqual(body.document.revocationReason, 'The real reason');
    } finally { await server.close(); }
});

test('repeating a confirmed revocation is harmless; a different transaction for an already-revoked document is refused', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await issued(server, chain, 14);
        mineRevoke(chain, doc, tx(15));
        for (let i = 0; i < 3; i++) assert.strictEqual((await (await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(15) })).json()).state, 'revoked');
        mineRevoke(chain, doc, tx(16));
        assert.strictEqual((await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(16) })).status, 409);
        assert.strictEqual((await documents.findByDocumentId(doc.documentId)).revocationTxHash, tx(15));
    } finally { await server.close(); }
});

test('revocation that is not mined yet changes nothing and says "pending"', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await issued(server, chain, 17);
        const body = await (await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(18) })).json();
        assert.strictEqual(body.state, 'pending');
        assert.strictEqual((await documents.findByDocumentId(doc.documentId)).status, 'ISSUED');
    } finally { await server.close(); }
});

const refusals = [
    ['the transaction reverted', { receipt: { state: 'reverted' } }, 'failed'],
    ['it was sent to some other contract', { receipt: { to: OTHER } }, 'failed'],
    ['it succeeded but the registry does not say revoked', { registry: { revoked: false } }, 'failed'],
];
for (const [name, overrides, expected] of refusals) {
    test(`a revocation that did not really revoke is not mirrored: ${name}`, async () => {
        const chain = fakeChain();
        const server = await api(chain);
        try {
            const doc = await issued(server, chain, 20);
            mineRevoke(chain, doc, tx(21), overrides);
            const body = await (await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(21) })).json();
            assert.strictEqual(body.state, expected);
            assert.strictEqual((await documents.findByDocumentId(doc.documentId)).status, 'ISSUED', 'still issued');
            assert.ok(await audit.model.findOne({ action: 'REVOKE', outcome: 'FAILED' }));
        } finally { await server.close(); }
    });
}

test('a transaction that revokes a DIFFERENT document is refused (409), and so is one that is not a revoke call', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const a = await issued(server, chain, 22);
        const b = await issued(server, chain, 23);
        mineRevoke(chain, b, tx(24));
        assert.strictEqual((await server.call('POST', `/api/documents/${a.documentId}/revoke`, { transactionHash: tx(24) })).status, 409);
        mineRevoke(chain, a, tx(25), { call: null });
        assert.strictEqual((await server.call('POST', `/api/documents/${a.documentId}/revoke`, { transactionHash: tx(25) })).status, 409);
        assert.strictEqual((await documents.findByDocumentId(a.documentId)).status, 'ISSUED');
    } finally { await server.close(); }
});

test('only an ISSUED document can be revoked, only by its own issuer, and only with a chain connection and a login', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    const noChain = await api(null);
    try {
        const stored = await server.issue();
        assert.strictEqual((await server.call('POST', `/api/documents/${stored.documentId}/revoke`, { transactionHash: tx(30) })).status, 409, 'STORED');
        const theirs = await documents.create({ sha256: 'a'.repeat(64), s3Key: 'a'.repeat(64), status: 'ISSUED', contentHash: 'b'.repeat(64), issuerName: 'someone-else' });
        assert.strictEqual((await server.call('POST', `/api/documents/${theirs.documentId}/revoke`, { transactionHash: tx(31) })).status, 404, 'not yours');
        assert.strictEqual((await fetch(`${server.url}/api/documents/${stored.documentId}/revoke`, { method: 'POST' })).status, 401);
        const mine = await issued(server, chain, 32);
        assert.strictEqual((await noChain.call('POST', `/api/documents/${mine.documentId}/revoke`, { transactionHash: tx(33) })).status, 503);
        for (const bad of [undefined, '0x12', 5, { $ne: 1 }]) {
            assert.strictEqual((await server.call('POST', `/api/documents/${mine.documentId}/revoke`, { transactionHash: bad })).status, 400, JSON.stringify(bad));
        }
        assert.strictEqual((await server.call('POST', '/api/documents/not-an-id/revoke', { transactionHash: tx(34) })).status, 400);
    } finally { await server.close(); await noChain.close(); }
});

test('a very long reason is cut to 500 characters rather than refused', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const doc = await issued(server, chain, 40);
        mineRevoke(chain, doc, tx(41), { reason: 'x'.repeat(2000) });
        const body = await (await server.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(41) })).json();
        assert.strictEqual(body.document.revocationReason.length, 500);
    } finally { await server.close(); }
});

test('a revoked document uploaded again is reported as the existing REVOKED record: it is never issued anew', async () => {
    const chain = fakeChain();
    const server = await api(chain);
    try {
        const bytes = Buffer.from('%PDF-1.4 the same file twice');
        const fields = c.withFields({ idNumber: 'B2109999CS' });
        const upload = async () => {
            const form = new FormData();
            form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'd.pdf');
            form.append('fields', JSON.stringify(fields));
            return (await fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${server.token}` } })).json();
        };
        const first = (await upload()).document;
        mineAnchor(chain, first, tx(50));
        await server.call('POST', `/api/documents/${first.documentId}/chain-pending`, { transactionHash: tx(50) });
        await server.call('POST', `/api/documents/${first.documentId}/chain-confirmed`, { transactionHash: tx(50) });
        mineRevoke(chain, first, tx(51));
        await server.call('POST', `/api/documents/${first.documentId}/revoke`, { transactionHash: tx(51) });

        const again = await upload();
        assert.strictEqual(again.duplicate, true);
        assert.strictEqual(again.document.documentId, first.documentId);
        assert.strictEqual(again.document.status, 'REVOKED');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});
