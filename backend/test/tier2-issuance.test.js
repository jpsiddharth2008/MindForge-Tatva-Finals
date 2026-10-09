// Issue #52: Tier 2 at issuance. The officer sends the document's fields; the server derives the content hash,
// checks the printed text agrees, and recognises a re-photographed copy of an issued document as a duplicate.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { startMongo } = require('./mongo');
const { shutdown } = require('../ocr');
const { contentHash, lookupKey } = require('../content-hash');
const c = require('./fixtures/certificate');
const { fakeS3, start, loginToken } = require('./helpers');

let mongo;
let documents;
let audit;
before(async () => { mongo = await startMongo(); documents = mongo.documents; audit = mongo.audit; });
after(async () => { await shutdown(); await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); await audit.model.deleteMany({}); });

const ANCHOR = contentHash(c.DEFAULT_FIELDS);
const pdf = (t) => Buffer.from(`%PDF-1.4\n${t}\n`);

async function api(opts = {}) {
    const server = await start(opts.s3 || fakeS3(), { documents, audit, ...opts });
    const { token } = await loginToken(server.url);
    const send = (bytes, { fields, type = 'image/png', name = 'cert.png' } = {}) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type }), name);
        if (fields !== undefined) form.append('fields', typeof fields === 'string' ? fields : JSON.stringify(fields));
        return fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
    };
    return { ...server, token, send };
}

test('an image with matching details is issued: the content hash is derived, stored, returned, and the printed text is confirmed', async () => {
    const server = await api();
    try {
        const res = await server.send(await c.render(), { fields: c.DEFAULT_FIELDS });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));
        assert.strictEqual(body.contentHash, ANCHOR.hash, 'returned for anchoring alongside the byte hash');
        assert.match(body.hash, /^[a-f0-9]{64}$/);
        assert.notStrictEqual(body.hash, body.contentHash);
        assert.strictEqual(body.document.ocrCheck, 'MATCH');
        const row = await documents.findByContentHash(ANCHOR.hash);
        assert.strictEqual(row.lookupKey, lookupKey(c.DEFAULT_FIELDS));
        assert.deepStrictEqual(row.canonicalRecord, ANCHOR.record, 'the canonical fields are kept so a mismatch can name the field');
        assert.ok(!('canonicalRecord' in body.document), 'personal data is never sent back in the record view');
        assert.strictEqual((await documents.findByLookupKey(lookupKey(c.DEFAULT_FIELDS))).length, 1);
    } finally { await server.close(); }
});

test('details that disagree with the printed document are refused (422), naming the field, and nothing is stored', async () => {
    const s3 = fakeS3();
    const server = await api({ s3 });
    try {
        const typo = c.withFields({}, { dob: '12-04-2003' });                 // officer typed the wrong date of birth
        const res = await server.send(await c.render(), { fields: typo });
        const body = await res.json();
        assert.strictEqual(res.status, 422);
        assert.match(body.error, /payload\.dob \(entered 2003-04-12, printed 2005-04-12\)/);
        assert.strictEqual(s3.sent.length, 0, 'nothing reaches S3');
        assert.strictEqual(await documents.model.countDocuments({}), 0, 'no record is created');
        const ev = await audit.model.findOne({ reason: 'DETAILS_MISMATCH' }).lean();
        assert.ok(ev && ev.outcome === 'FAILED' && ev.actorName === 'registrar');
    } finally { await server.close(); }
});

test('a re-photographed copy of an issued document is recognised as the same document and is not issued again', async () => {
    const s3 = fakeS3();
    const server = await api({ s3 });
    try {
        const first = await (await server.send(await c.render(), { fields: c.DEFAULT_FIELDS })).json();
        assert.strictEqual(first.duplicate, false);
        const copy = await c.pipe(c.shrink(0.6), c.jpeg(60))(await c.render());          // different bytes, same document
        const again = await (await server.send(copy, { fields: c.DEFAULT_FIELDS, type: 'image/jpeg', name: 'photo.jpg' })).json();
        assert.strictEqual(again.duplicate, true);
        assert.strictEqual(again.duplicateOf, 'content');
        assert.strictEqual(again.document.documentId, first.document.documentId);
        assert.strictEqual(again.contentHash, first.contentHash);
        assert.strictEqual(s3.sent.length, 1, 'the second copy is never stored');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});

test('several different copies of one document submitted at once leave exactly one record', async () => {
    const analyse = async () => ({ status: 'READ', contentHash: ANCHOR.hash, record: ANCHOR.record, confidences: {}, weak: [], steps: {} });
    const s3 = fakeS3();
    const server = await api({ s3, analyse });
    try {
        const replies = await Promise.all(Array.from({ length: 5 }, async (_, i) =>
            server.send(Buffer.concat([await c.render(), Buffer.from(`copy ${i}`)]), { fields: c.DEFAULT_FIELDS })));
        assert.ok(replies.every((r) => r.status === 200), (await Promise.all(replies.map((r) => r.status))).join());
        assert.strictEqual(await documents.model.countDocuments({}), 1);
        assert.strictEqual(s3.sent.length, 1);
    } finally { await server.close(); }
});

test('a different person\'s certificate is a different document: issued separately', async () => {
    const server = await api();
    try {
        await server.send(await c.render(), { fields: c.DEFAULT_FIELDS });
        const other = c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' }, { dob: '03-09-2004', cgpa: '7.9' });
        const body = await (await server.send(await c.render(other), { fields: other })).json();
        assert.strictEqual(body.duplicate, false);
        assert.strictEqual(await documents.model.countDocuments({}), 2);
    } finally { await server.close(); }
});

test('a PDF with details is issued with the check marked SKIPPED (PDFs are not read in this version)', async () => {
    const server = await api({ analyse: async () => { throw new Error('must not be called for a PDF'); } });
    try {
        const res = await server.send(pdf('degree'), { fields: c.DEFAULT_FIELDS, type: 'application/pdf', name: 'degree.pdf' });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.document.ocrCheck, 'SKIPPED');
        assert.strictEqual(body.contentHash, ANCHOR.hash);
    } finally { await server.close(); }
});

test('an image too poor to read does not block issuance: it is marked INCONCLUSIVE', async () => {
    const server = await api({ analyse: async () => ({ status: 'UNREADABLE', problems: [{ field: 'holder', problem: 'missing' }], confidences: {}, weak: [], steps: {} }) });
    try {
        const body = await (await server.send(await c.render(), { fields: c.DEFAULT_FIELDS })).json();
        assert.strictEqual(body.document.ocrCheck, 'INCONCLUSIVE');
    } finally { await server.close(); }
});

test('a doubtful read of a differing field does not block issuance either (only a confident disagreement does)', async () => {
    const typo = c.withFields({}, { dob: '12-04-2003' });
    const printed = contentHash(c.DEFAULT_FIELDS);
    const analyse = async () => ({ status: 'READ', contentHash: printed.hash, record: printed.record, confidences: { 'payload.dob': 55 }, weak: [], steps: {} });
    const server = await api({ analyse });
    try {
        const res = await server.send(await c.render(), { fields: typo });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).document.ocrCheck, 'INCONCLUSIVE');
    } finally { await server.close(); }
});

test('bad details are a 400 that names the fields but never repeats the values', async () => {
    const server = await api({ analyse: async () => { throw new Error('should not get this far'); } });
    try {
        const cases = [
            ['not json {', /valid JSON/],
            [JSON.stringify({ ...c.DEFAULT_FIELDS, holder: '' }), /incomplete or unreadable \(holder\)/],
            [JSON.stringify({ ...c.DEFAULT_FIELDS, issuedOn: 'SECRET-31-02-1999' }), /\(issuedOn\)/],
            [JSON.stringify({}), /incomplete or unreadable/],
            [JSON.stringify('a string'), /incomplete or unreadable/],
            [JSON.stringify(null), /incomplete or unreadable/],
        ];
        for (const [fields, pattern] of cases) {
            const res = await server.send(pdf('x'), { fields, type: 'application/pdf', name: 'x.pdf' });
            const body = await res.json();
            assert.strictEqual(res.status, 400, fields);
            assert.match(body.error, pattern);
            assert.ok(!JSON.stringify(body).includes('SECRET'), 'the offending value is not echoed');
        }
        assert.strictEqual(await documents.model.countDocuments({}), 0);
    } finally { await server.close(); }
});

test('an oversized details field is refused', async () => {
    const server = await api();
    try {
        const res = await server.send(pdf('big'), { fields: 'x'.repeat(40 * 1024), type: 'application/pdf', name: 'x.pdf' });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /too long/);
    } finally { await server.close(); }
});

test('without details the upload works exactly as before (Tier 1 only), and no content hash is stored', async () => {
    const server = await api();
    try {
        const body = await (await server.send(pdf('plain'), { type: 'application/pdf', name: 'a.pdf' })).json();
        assert.strictEqual(body.contentHash, undefined);
        assert.strictEqual(body.document.ocrCheck, undefined);
        const row = await documents.findBySha256(body.hash);
        assert.strictEqual(row.contentHash, undefined);
        // two Tier-1-only documents must not collide on the sparse unique index
        await server.send(pdf('plain two'), { type: 'application/pdf', name: 'b.pdf' });
        assert.strictEqual(await documents.model.countDocuments({}), 2);
    } finally { await server.close(); }
});

test('the content hash is unique in the database, so a race cannot create two records for one document', async () => {
    await documents.create({ sha256: 'a'.repeat(64), s3Key: 'a'.repeat(64), status: 'STORED', contentHash: ANCHOR.hash });
    await assert.rejects(() => documents.create({ sha256: 'b'.repeat(64), s3Key: 'b'.repeat(64), status: 'STORED', contentHash: ANCHOR.hash }),
        (e) => e.name === 'DuplicateDocumentError' && e.field === 'contentHash');
    assert.strictEqual(await documents.model.countDocuments({}), 1);
});

test('an unfinished earlier attempt for the same content gives a clear 409 instead of a second record', async () => {
    await documents.create({ sha256: 'c'.repeat(64), s3Key: 'c'.repeat(64), status: 'FAILED', contentHash: ANCHOR.hash, issuerName: 'registrar' });
    const server = await api({ analyse: async () => ({ status: 'READ', contentHash: ANCHOR.hash, record: ANCHOR.record, confidences: {}, weak: [], steps: {} }) });
    try {
        const res = await server.send(await c.render(), { fields: c.DEFAULT_FIELDS });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});

test('a copy arriving while another copy of the same document is being processed is told "in progress" (not an error); once that attempt has gone stale it is a 409', async () => {
    const analyse = async () => ({ status: 'READ', contentHash: ANCHOR.hash, record: ANCHOR.record, confidences: {}, weak: [], steps: {} });
    const server = await api({ analyse });
    try {
        const working = await documents.create({ sha256: 'd'.repeat(64), s3Key: 'd'.repeat(64), status: 'PENDING', contentHash: ANCHOR.hash, issuerName: 'registrar' });
        const fresh = await server.send(await c.render(), { fields: c.DEFAULT_FIELDS });
        const body = await fresh.json();
        assert.strictEqual(fresh.status, 200);
        assert.strictEqual(body.inProgress, true);
        assert.strictEqual(body.document.documentId, working.documentId);
        await documents.model.collection.updateOne({ documentId: working.documentId }, { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) } });
        assert.strictEqual((await server.send(await c.render(), { fields: c.DEFAULT_FIELDS })).status, 409, 'a crashed attempt is not "in progress"');
        assert.strictEqual(await documents.model.countDocuments({}), 1);
    } finally { await server.close(); }
});
