// Issue #54: the issuance state machine, compensation, idempotency and the recovery sweep. Real MongoDB.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startMongo } = require('./mongo');
const { createIssuance } = require('../issuance');
const { createStorage } = require('../storage');
const { TRANSITIONS, IllegalTransitionError, STATUSES } = require('../documents');
const { fakeS3, fakePresign, start, loginToken, postFile } = require('./helpers');

let mongo;
let documents;
before(async () => { mongo = await startMongo(); documents = mongo.documents; });
after(async () => { await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); });

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n`);
const ADDR = '0x' + '12'.repeat(20);
const OTHER_ADDR = '0x' + '99'.repeat(20);
const tx = (n) => '0x' + String(n).padStart(2, '0').repeat(32);

/** A chain that answers from a table: tx hash -> receipt. Unknown hashes are "not mined yet". */
function fakeChain(table = {}) {
    return { calls: [], async getReceipt(hash) { this.calls.push(hash); return table[hash] || { state: 'not_found' }; } };
}
const mined = (over = {}) => ({ state: 'success', blockNumber: 4242, to: ADDR, ...over });

const api = async (opts = {}) => {
    const s3 = opts.s3 || fakeS3();
    const server = await start(s3, { documents, contractAddress: ADDR, chainId: 80002, chain: fakeChain(), ...opts });
    const { token } = await loginToken(server.url);
    const call = (method, route, body) => fetch(`${server.url}${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { ...server, s3, token, call, anchor: (bytes, name = 'degree.pdf') => postFile(`${server.url}/api/anchor`, bytes, { name, token }) };
};
const age = (documentId, ms) => documents.model.collection.updateOne({ documentId }, { $set: { updatedAt: new Date(Date.now() - ms) } });

// ---------------------------------------------------------------- the status table
test('the allowed moves are exactly the documented ones', () => {
    assert.deepStrictEqual(TRANSITIONS, {
        PENDING: ['STORED', 'FAILED'], STORED: ['BLOCKCHAIN_PENDING', 'FAILED'], BLOCKCHAIN_PENDING: ['ISSUED', 'FAILED'],
        ISSUED: ['REVOKED'], FAILED: ['PENDING'], REVOKED: [],
    });
    assert.deepStrictEqual(Object.keys(TRANSITIONS).sort(), [...STATUSES].sort());
});

test('transition(): illegal moves throw, a record in the wrong state is left untouched, failure reasons are a fixed list', async () => {
    const d = await documents.create({ sha256: sha('a'), s3Key: sha('a'), status: 'STORED' });
    await assert.rejects(() => documents.transition(d.documentId, ['STORED'], 'ISSUED'), IllegalTransitionError);
    await assert.rejects(() => documents.transition(d.documentId, ['ISSUED'], 'PENDING'), IllegalTransitionError);
    assert.strictEqual(await documents.transition(d.documentId, ['PENDING'], 'STORED'), null, 'it is not PENDING, so nothing happens');
    assert.strictEqual((await documents.findByDocumentId(d.documentId)).status, 'STORED');
    await assert.rejects(() => documents.transition(d.documentId, ['STORED'], 'FAILED', { failureReason: 'my password is hunter2' }), (e) => e.name === 'ValidationError');
    const failed = await documents.transition(d.documentId, ['STORED'], 'FAILED', { failureReason: 'CLIENT_ERROR' });
    assert.strictEqual(failed.failureReason, 'CLIENT_ERROR');
    const retried = await documents.claimRetry(d.documentId, 60000);
    assert.strictEqual(retried.status, 'PENDING');
    assert.strictEqual(retried.failureReason, undefined, 'a retry clears the old failure');
});

test('claimRetry: of many simultaneous callers exactly one gets the record', async () => {
    const d = await documents.create({ sha256: sha('race'), s3Key: sha('race'), status: 'FAILED', failureReason: 'S3_FAILED' });
    const results = await Promise.all(Array.from({ length: 8 }, () => documents.claimRetry(d.documentId, 60000)));
    assert.strictEqual(results.filter(Boolean).length, 1);
});

// ---------------------------------------------------------------- the happy path
test('issue -> chain-pending -> chain-confirmed walks PENDING/STORED -> BLOCKCHAIN_PENDING -> ISSUED, verified against the chain', async () => {
    const chain = fakeChain({ [tx(1)]: mined() });
    const server = await api({ chain });
    try {
        const stored = await (await server.anchor(pdf('happy'))).json();
        assert.strictEqual(stored.document.status, 'STORED');
        const id = stored.document.documentId;

        const pending = await (await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(1) })).json();
        assert.strictEqual(pending.document.status, 'BLOCKCHAIN_PENDING');
        assert.strictEqual(pending.document.transactionHash, tx(1));

        const confirmed = await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(1) })).json();
        assert.strictEqual(confirmed.state, 'issued');
        assert.strictEqual(confirmed.document.status, 'ISSUED');
        assert.strictEqual(confirmed.document.blockNumber, 4242);
        assert.ok(confirmed.document.issuedAt);

        const byTx = await (await server.call('GET', `/api/documents/by-tx/${tx(1)}`)).json();
        assert.strictEqual(byTx.document.documentId, id, 'findable by transaction hash');
    } finally { await server.close(); }
});

test('chain-pending and chain-confirmed are idempotent: repeating them changes nothing and asks the chain at most once', async () => {
    const chain = fakeChain({ [tx(2)]: mined() });
    const server = await api({ chain });
    try {
        const id = (await (await server.anchor(pdf('idem'))).json()).document.documentId;
        for (let i = 0; i < 3; i++) assert.strictEqual((await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(2) })).status, 200);
        for (let i = 0; i < 3; i++) assert.strictEqual((await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(2) })).json()).document.status, 'ISSUED');
        assert.strictEqual(chain.calls.length, 1, 'once ISSUED, no more chain lookups');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});

// ---------------------------------------------------------------- the same document twice: one on-chain write
test('submitting the same document twice never gets a second chain write: the second upload reports the first record', async () => {
    const server = await api({ chain: fakeChain({ [tx(3)]: mined() }) });
    try {
        const bytes = pdf('twice');
        const first = (await (await server.anchor(bytes)).json()).document;
        await server.call('POST', `/api/documents/${first.documentId}/chain-pending`, { transactionHash: tx(3) });
        const dup = await (await server.anchor(bytes)).json();            // e.g. a double click on "Lock on Blockchain"
        assert.strictEqual(dup.duplicate, true);
        assert.strictEqual(dup.document.documentId, first.documentId);
        assert.strictEqual(dup.document.status, 'BLOCKCHAIN_PENDING', 'the client can see a transaction is already in flight');
        // a second, different transaction for the same document is refused
        const second = await server.call('POST', `/api/documents/${first.documentId}/chain-pending`, { transactionHash: tx(4) });
        assert.strictEqual(second.status, 409);
        assert.strictEqual((await documents.findByDocumentId(first.documentId)).transactionHash, tx(3));
    } finally { await server.close(); }
});

test('two simultaneous chain-pending calls with different transactions: exactly one wins', async () => {
    const server = await api();
    try {
        const id = (await (await server.anchor(pdf('double click'))).json()).document.documentId;
        const codes = (await Promise.all([tx(5), tx(6), tx(7), tx(8)].map((t) =>
            server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: t })))).map((r) => r.status);
        assert.strictEqual(codes.filter((c) => c === 200).length, 1);
        assert.strictEqual(codes.filter((c) => c === 409).length, 3);
    } finally { await server.close(); }
});

test('one transaction cannot be attached to two documents', async () => {
    const server = await api();
    try {
        const a = (await (await server.anchor(pdf('doc a'))).json()).document.documentId;
        const b = (await (await server.anchor(pdf('doc b'))).json()).document.documentId;
        assert.strictEqual((await server.call('POST', `/api/documents/${a}/chain-pending`, { transactionHash: tx(9) })).status, 200);
        assert.strictEqual((await server.call('POST', `/api/documents/${b}/chain-pending`, { transactionHash: tx(9) })).status, 409);
        assert.strictEqual((await documents.findByDocumentId(b)).status, 'STORED', 'the loser is left where it was');
    } finally { await server.close(); }
});

test('simultaneous uploads of the same bytes: one S3 write, one row, no errors', async () => {
    const s3 = fakeS3();
    const server = await api({ s3 });
    try {
        const bytes = pdf('crowd');
        const replies = await Promise.all(Array.from({ length: 6 }, () => server.anchor(bytes)));
        assert.ok(replies.every((r) => r.status === 200));
        assert.strictEqual(s3.sent.length, 1, 'only the request that claimed the record uploads');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
        assert.strictEqual((await documents.findBySha256(sha(bytes))).status, 'STORED');
    } finally { await server.close(); }
});

// ---------------------------------------------------------------- failures leave a visible, recoverable record
test('S3 failure: the client gets a generic 500, the record is FAILED (S3_FAILED), and a retry succeeds on the same record', async () => {
    let broken = true;
    const s3 = { sent: [], send: async (c) => { s3.sent.push(c); if (broken) throw new Error('S3 down'); return {}; } };
    const server = await api({ s3 });
    try {
        const bytes = pdf('s3 outage');
        const res = await server.anchor(bytes);
        assert.strictEqual(res.status, 500);
        assert.strictEqual((await res.json()).error, 'Internal server error.');
        const row = await documents.findBySha256(sha(bytes));
        assert.strictEqual(row.status, 'FAILED');
        assert.strictEqual(row.failureReason, 'S3_FAILED');
        broken = false;
        const retry = await (await server.anchor(bytes)).json();
        assert.strictEqual(retry.document.documentId, row.documentId, 'same record, not a second one');
        assert.strictEqual(retry.document.status, 'STORED');
        assert.strictEqual(retry.document.failureReason, undefined);
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});

test('killing the server mid-issuance leaves a PENDING record, which the sweep fails and a retry then recovers', async () => {
    const hangs = { send: () => new Promise(() => {}) };     // the upload never finishes: as if the process died here
    const bytes = pdf('crash');
    const doomed = await api({ s3: hangs });
    try {
        doomed.anchor(bytes).catch(() => {});                // request in flight
        let row = null;
        for (let i = 0; i < 100 && !row; i++) { row = await documents.findBySha256(sha(bytes)); if (!row) await new Promise((r) => setTimeout(r, 20)); }
        assert.ok(row, 'the record exists BEFORE the upload finishes, so a crash cannot leave an invisible orphan');
        assert.strictEqual(row.status, 'PENDING');
    } finally { await doomed.close(); }                       // "kill" the server (the hung request is abandoned)

    const row = await documents.findBySha256(sha(bytes));
    assert.strictEqual(row.status, 'PENDING', 'still recoverable, not lost');

    // while it is fresh another request is told it is in progress; it is not taken over
    const healthy = await api();
    try {
        const fresh = await (await healthy.anchor(bytes)).json();
        assert.strictEqual(fresh.inProgress, true);
        assert.strictEqual(healthy.s3.sent.length, 0);

        await age(row.documentId, 11 * 60 * 1000);
        const issuance = createIssuance({ documents, storage: createStorage({ s3: fakeS3(), bucketName: 'b', presign: fakePresign }) });
        const report = await issuance.reconcile();
        assert.deepStrictEqual(report.failedPending, [row.documentId]);
        const failed = await documents.findByDocumentId(row.documentId);
        assert.deepStrictEqual([failed.status, failed.failureReason], ['FAILED', 'STUCK_PENDING']);

        const recovered = await (await healthy.anchor(bytes)).json();
        assert.strictEqual(recovered.document.documentId, row.documentId);
        assert.strictEqual(recovered.document.status, 'STORED');
    } finally { await healthy.close(); }
});

test('a PENDING record that has gone quiet is taken over directly by the next upload', async () => {
    const bytes = pdf('stale takeover');
    const crashed = await documents.create({ sha256: sha(bytes), s3Key: sha(bytes), status: 'PENDING', issuerName: 'registrar' });
    await age(crashed.documentId, 5 * 60 * 1000);
    const server = await api();
    try {
        const body = await (await server.anchor(bytes)).json();
        assert.strictEqual(body.document.documentId, crashed.documentId);
        assert.strictEqual(body.document.status, 'STORED');
        assert.strictEqual(body.inProgress, undefined);
    } finally { await server.close(); }
});

test('chain-failed (wallet rejected): STORED -> FAILED with a fixed reason; unknown reasons are stored as CLIENT_ERROR; a retry works', async () => {
    const server = await api();
    try {
        const bytes = pdf('rejected');
        const id = (await (await server.anchor(bytes)).json()).document.documentId;
        const a = await (await server.call('POST', `/api/documents/${id}/chain-failed`, { reason: 'USER_REJECTED' })).json();
        assert.deepStrictEqual([a.document.status, a.document.failureReason], ['FAILED', 'USER_REJECTED']);
        const again = await (await server.anchor(bytes)).json();
        assert.strictEqual(again.document.status, 'STORED');
        const b = await (await server.call('POST', `/api/documents/${id}/chain-failed`, { reason: 'my password is hunter2' })).json();
        assert.strictEqual(b.document.failureReason, 'CLIENT_ERROR');
        assert.ok(!JSON.stringify(await documents.model.collection.findOne({ documentId: id })).includes('hunter2'));
        assert.strictEqual((await server.call('POST', `/api/documents/${id}/chain-failed`, { reason: 'x' })).status, 409, 'already FAILED');
    } finally { await server.close(); }
});

test('an ISSUED document cannot be marked failed or re-anchored', async () => {
    const server = await api({ chain: fakeChain({ [tx(10)]: mined() }) });
    try {
        const id = (await (await server.anchor(pdf('final'))).json()).document.documentId;
        await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(10) });
        await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(10) });
        assert.strictEqual((await server.call('POST', `/api/documents/${id}/chain-failed`, { reason: 'USER_REJECTED' })).status, 409);
        assert.strictEqual((await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: tx(11) })).status, 409);
        assert.strictEqual((await documents.findByDocumentId(id)).status, 'ISSUED');
    } finally { await server.close(); }
});

// ---------------------------------------------------------------- the server only believes the chain
const toPending = async (server, bytes, t) => {
    const id = (await (await server.anchor(bytes)).json()).document.documentId;
    await server.call('POST', `/api/documents/${id}/chain-pending`, { transactionHash: t });
    return id;
};

test('a reverted transaction fails the document (CHAIN_REVERTED)', async () => {
    const server = await api({ chain: fakeChain({ [tx(12)]: mined({ state: 'reverted' }) }) });
    try {
        const id = await toPending(server, pdf('reverted'), tx(12));
        const r = await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(12) })).json();
        assert.strictEqual(r.state, 'failed');
        assert.deepStrictEqual([r.document.status, r.document.failureReason], ['FAILED', 'CHAIN_REVERTED']);
    } finally { await server.close(); }
});

test('a transaction sent to some other contract fails the document (WRONG_CONTRACT), whatever the client claims', async () => {
    const server = await api({ chain: fakeChain({ [tx(13)]: mined({ to: OTHER_ADDR }) }) });
    try {
        const id = await toPending(server, pdf('wrong contract'), tx(13));
        const r = await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(13) })).json();
        assert.deepStrictEqual([r.document.status, r.document.failureReason], ['FAILED', 'WRONG_CONTRACT']);
    } finally { await server.close(); }
});

test('contract address comparison ignores letter case', async () => {
    const server = await api({ chain: fakeChain({ [tx(14)]: mined({ to: ADDR.toUpperCase().replace('0X', '0x') }) }) });
    try {
        const id = await toPending(server, pdf('case'), tx(14));
        assert.strictEqual((await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(14) })).json()).state, 'issued');
    } finally { await server.close(); }
});

test('a transaction not mined yet stays BLOCKCHAIN_PENDING and says so', async () => {
    const server = await api({ chain: fakeChain({}) });
    try {
        const id = await toPending(server, pdf('slow'), tx(15));
        const r = await (await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(15) })).json();
        assert.strictEqual(r.state, 'pending');
        assert.strictEqual(r.document.status, 'BLOCKCHAIN_PENDING');
    } finally { await server.close(); }
});

test('without a chain connection a document can never be marked ISSUED (503, stays BLOCKCHAIN_PENDING)', async () => {
    const server = await api({ chain: null });
    try {
        const id = await toPending(server, pdf('no rpc'), tx(16));
        const res = await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(16) });
        assert.strictEqual(res.status, 503);
        assert.strictEqual((await documents.findByDocumentId(id)).status, 'BLOCKCHAIN_PENDING');
    } finally { await server.close(); }
});

test('confirming with a different transaction than the one recorded is refused', async () => {
    const server = await api({ chain: fakeChain({ [tx(17)]: mined(), [tx(18)]: mined() }) });
    try {
        const id = await toPending(server, pdf('mismatch'), tx(17));
        assert.strictEqual((await server.call('POST', `/api/documents/${id}/chain-confirmed`, { transactionHash: tx(18) })).status, 409);
        assert.strictEqual((await documents.findByDocumentId(id)).status, 'BLOCKCHAIN_PENDING');
    } finally { await server.close(); }
});

// ---------------------------------------------------------------- access and input checks
test('another issuer\'s document is reported as not found; bad ids and hashes are 400; no token is 401; no database is 503', async () => {
    const server = await api();
    const bare = await start(fakeS3());
    try {
        const theirs = await documents.create({ sha256: sha('theirs'), s3Key: sha('theirs'), status: 'STORED', issuerName: 'someone-else' });
        const mine = (await (await server.anchor(pdf('mine'))).json()).document.documentId;
        for (const route of ['chain-pending', 'chain-confirmed']) {
            assert.strictEqual((await server.call('POST', `/api/documents/${theirs.documentId}/${route}`, { transactionHash: tx(20) })).status, 404, route);
        }
        assert.strictEqual((await server.call('POST', `/api/documents/${theirs.documentId}/chain-failed`, { reason: 'USER_REJECTED' })).status, 404);
        assert.strictEqual((await documents.findByDocumentId(theirs.documentId)).status, 'STORED', 'untouched');
        assert.strictEqual((await server.call('POST', '/api/documents/not-an-id/chain-pending', { transactionHash: tx(20) })).status, 400);
        for (const bad of [undefined, '0x123', 'x'.repeat(66), { $ne: '' }, 5]) {
            assert.strictEqual((await server.call('POST', `/api/documents/${mine}/chain-pending`, { transactionHash: bad })).status, 400, JSON.stringify(bad));
        }
        assert.strictEqual((await fetch(`${server.url}/api/documents/${mine}/chain-pending`, { method: 'POST' })).status, 401);
        const { token } = await loginToken(bare.url);
        const res = await fetch(`${bare.url}/api/documents/${mine}/chain-pending`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
        assert.strictEqual(res.status, 503);
    } finally { await server.close(); await bare.close(); }
});

// ---------------------------------------------------------------- the recovery sweep
test('reconcile: stuck records are resolved against the chain; fresh, STORED and ISSUED records are left alone', async () => {
    const mk = (name, status, extra = {}) => documents.create({ sha256: sha(name), s3Key: sha(name), status, issuerName: 'registrar', ...extra });
    const pendingOld = await mk('p-old', 'PENDING');
    const pendingFresh = await mk('p-fresh', 'PENDING');
    const stored = await mk('stored', 'STORED');
    const issued = await mk('issued', 'ISSUED', { transactionHash: tx(30) });
    const bcSuccess = await mk('bc-ok', 'BLOCKCHAIN_PENDING', { transactionHash: tx(31) });
    const bcReverted = await mk('bc-rev', 'BLOCKCHAIN_PENDING', { transactionHash: tx(32) });
    const bcWaiting = await mk('bc-wait', 'BLOCKCHAIN_PENDING', { transactionHash: tx(33) });
    for (const d of [pendingOld, stored, issued, bcSuccess, bcReverted, bcWaiting]) await age(d.documentId, 11 * 60 * 1000);

    const chain = fakeChain({ [tx(31)]: mined(), [tx(32)]: mined({ state: 'reverted' }) });
    const issuance = createIssuance({ documents, storage: {}, chain, contractAddress: ADDR });
    const report = await issuance.reconcile();

    assert.deepStrictEqual(report.failedPending, [pendingOld.documentId]);
    assert.deepStrictEqual(report.issued, [bcSuccess.documentId]);
    assert.deepStrictEqual(report.failed, [bcReverted.documentId]);
    assert.deepStrictEqual(report.stillPending, [bcWaiting.documentId]);
    const status = async (d) => (await documents.findByDocumentId(d.documentId)).status;
    assert.deepStrictEqual(await Promise.all([pendingOld, pendingFresh, stored, issued, bcSuccess, bcReverted, bcWaiting].map(status)),
        ['FAILED', 'PENDING', 'STORED', 'ISSUED', 'ISSUED', 'FAILED', 'BLOCKCHAIN_PENDING']);

    const again = await issuance.reconcile();       // running it twice is safe
    assert.deepStrictEqual([again.failedPending, again.issued, again.failed], [[], [], []]);
});

test('reconcile without a chain connection reports BLOCKCHAIN_PENDING records as unverified and changes nothing', async () => {
    const d = await documents.create({ sha256: sha('unv'), s3Key: sha('unv'), status: 'BLOCKCHAIN_PENDING', transactionHash: tx(40) });
    await age(d.documentId, 11 * 60 * 1000);
    const report = await createIssuance({ documents, storage: {}, chain: null }).reconcile();
    assert.deepStrictEqual(report.unverified, [d.documentId]);
    assert.strictEqual((await documents.findByDocumentId(d.documentId)).status, 'BLOCKCHAIN_PENDING');
});
