// Issue #66 (and the verification half of #58 and #59): the public verification endpoint, end to end. Real images, real OCR, real
// perceptual hashing, a real MongoDB. The chain is a scripted registry; the real chain layer is tested against a real EVM elsewhere.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { startMongo } = require('./mongo');
const { shutdown } = require('../ocr');
const { buildQrPayload } = require('../qr');
const c = require('./fixtures/certificate');
const { fakeS3, memoryLogger, start, loginToken } = require('./helpers');
const { fakeChain, mineAnchor, mineRevoke, ADDR, tx } = require('./chain-fakes');

let mongo;
let documents;
let audit;
before(async () => { mongo = await startMongo(); documents = mongo.documents; audit = mongo.audit; });
after(async () => { await shutdown(); await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); await audit.model.deleteMany({}); });

const CHAIN_ID = 80002;
const PHOTO_A = 11;       // the issued photo
const PHOTO_B = 44;       // somebody else's

async function api(chain, opts = {}) {
    const s3 = fakeS3();
    const server = await start(s3, { documents, audit, chain, contractAddress: ADDR, chainId: CHAIN_ID, ...opts });
    const { token } = await loginToken(server.url);
    const call = (method, route, body) => fetch(`${server.url}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

    /** Issues an image document all the way to ISSUED against the scripted chain. */
    let n = 0;
    const issue = async (png, fields, txNumber) => {
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), 'cert.png');
        form.append('fields', JSON.stringify(fields));
        const up = await (await fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } })).json();
        const doc = up.document;
        mineAnchor(chain, doc, tx(txNumber || (n += 1)));
        const t = tx(txNumber || n);
        await call('POST', `/api/documents/${doc.documentId}/chain-pending`, { transactionHash: t });
        const r = await (await call('POST', `/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: t })).json();
        assert.strictEqual(r.document.status, 'ISSUED', JSON.stringify(r));
        return r.document;
    };

    /** Verifies a picture the way a member of the public would. withToken: as the issuer. */
    const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : 'application/pdf');   // label a file by what it really is
    const verify = async (bytes, { qr, type = sniff(bytes), withToken = false, name = 'x.png' } = {}) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type }), name);
        if (qr !== undefined) form.append('qr', typeof qr === 'string' ? qr : JSON.stringify(qr));
        const res = await fetch(`${server.url}/api/verify`, { method: 'POST', body: form, headers: withToken ? { Authorization: `Bearer ${token}` } : {} });
        return { status: res.status, body: await res.json() };
    };
    return { ...server, s3, token, call, issue, verify };
}

const original = (seed = PHOTO_A, fields = c.DEFAULT_FIELDS) => c.renderWithPhoto(seed, fields);
const qrFor = (doc) => buildQrPayload({ contentHash: doc.contentHash, chainId: CHAIN_ID, contractAddress: ADDR });

// ======================================================================== the issue's seven adversarial cases
test('1. a genuine original is AUTHENTIC_ORIGINAL', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    try {
        const png = await original();
        await s.issue(png, c.DEFAULT_FIELDS);
        const { body } = await s.verify(png);
        assert.strictEqual(body.verdict, 'AUTHENTIC_ORIGINAL');
        assert.strictEqual(body.confidence, 'HIGH');
        assert.strictEqual(body.tiers.byte.match, true);
        assert.strictEqual(body.anchor.issuer, 'Testland Registrar');
        assert.strictEqual(body.chainChecked, true);
    } finally { await s.close(); }
});

test('2. the same document after a WhatsApp round trip (recompressed, shrunk) is AUTHENTIC_COPY', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const copy = await c.pipe(c.shrink(0.6), c.jpeg(65))(await original());
        const { body } = await s.verify(copy, { type: 'image/jpeg', name: 'wa.jpg' });
        assert.strictEqual(body.verdict, 'AUTHENTIC_COPY', JSON.stringify(body.tiers.visual));
        assert.strictEqual(body.tiers.byte.match, false);
        assert.strictEqual(body.tiers.content.match, true);
    } finally { await s.close(); }
});

test('3. a photograph of a printout, taken at an angle with blur and noise, is AUTHENTIC_COPY', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const photo = await c.pipe(c.angled([[170, 120], [1020, 150], [930, 790], [130, 730]]), c.blur(0.8), c.noise(15, 3), c.jpeg(50))(await original());
        const { body } = await s.verify(photo, { type: 'image/jpeg', name: 'photo.jpg' });
        assert.strictEqual(body.verdict, 'AUTHENTIC_COPY', JSON.stringify(body));
    } finally { await s.close(); }
});

test('4. one field edited in an image editor is TAMPERED_CONTENT and the right field is named', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const forged = await c.paintOver(await original(), 'dob', 'DOB: 12-04-2003');
        const { body } = await s.verify(forged);
        assert.strictEqual(body.verdict, 'TAMPERED_CONTENT');
        assert.strictEqual(body.confidence, 'HIGH');
        assert.deepStrictEqual(body.tiers.content.fieldDiffs.map((d) => [d.field, d.presented]), [['payload.dob', '2003-04-12']]);
        assert.match(body.reason, /payload\.dob/);
    } finally { await s.close(); }
});

test('5. a replaced photo is TAMPERED_VISUAL, and the photo region is what is flagged', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(PHOTO_A), c.DEFAULT_FIELDS);
        const { body } = await s.verify(await original(PHOTO_B));
        assert.strictEqual(body.verdict, 'TAMPERED_VISUAL', JSON.stringify(body));
        assert.strictEqual(body.tiers.content.match, true, 'the text is identical');
        assert.deepStrictEqual(body.tiers.visual.changedRegions, ['photo']);
        assert.deepStrictEqual(body.tiers.visual.divergedCells.map((x) => x.join()), ['1,3'], 'exactly the photo tile is boxed');
        assert.strictEqual(body.tiers.visual.regions.length, 4, 'the 4x4 grid of distances is returned for a heatmap');
        assert.strictEqual(body.tiers.visual.advice, 'REVIEW');
    } finally { await s.close(); }
});

test('6. a different person\'s card on the same template is NOT_REGISTERED: a matching photo and layout never rescue it', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(PHOTO_A), c.DEFAULT_FIELDS);
        // same template, SAME photo (so the picture is as similar as it can be), different person who was never issued anything
        const other = c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' }, { dob: '03-09-2004', cgpa: '7.9' });
        const { body } = await s.verify(await original(PHOTO_A, other));
        assert.strictEqual(body.verdict, 'NOT_REGISTERED');
        assert.strictEqual(body.anchor, null);
    } finally { await s.close(); }
});

test('7. a blurred capture is INCONCLUSIVE, not a false verdict', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const { body } = await s.verify(await c.blur(4)(await original()));
        assert.strictEqual(body.verdict, 'INCONCLUSIVE', body.reason);
        assert.strictEqual(body.confidence, 'LOW');
        assert.match(body.reason, /could not be read reliably/);
    } finally { await s.close(); }
});

test('7b. however badly a GENUINE document is captured, the answer is "authentic copy" or "inconclusive": never tampered, never "not registered"', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const outcomes = {};
        for (const [name, make] of [['very dark', c.dim(0.08, 0)], ['tiny', c.shrink(0.12)], ['blur 3', c.blur(3)], ['rotated 25', c.rotated(25)],
            ['JPEG q8', c.jpeg(8)], ['heavy noise', c.noise(30, 2)], ['washed out', c.dim(0.3, 150)]]) {
            outcomes[name] = (await s.verify(await make(await original()))).body.verdict;
        }
        for (const [name, verdict] of Object.entries(outcomes)) assert.ok(['AUTHENTIC_COPY', 'INCONCLUSIVE'].includes(verdict), `${name}: ${verdict}`);
        assert.ok(Object.values(outcomes).includes('INCONCLUSIVE'), 'at least one of these is genuinely unreadable');
    } finally { await s.close(); }
});

// ======================================================================== revocation, seen by a verifier (#59)
test('a revoked document is REVOKED, with the reason and time, for the original and for a copy; revocation outranks authenticity', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    try {
        const png = await original();
        const doc = await s.issue(png, c.DEFAULT_FIELDS);
        assert.strictEqual((await s.verify(png)).body.verdict, 'AUTHENTIC_ORIGINAL');                          // 1: genuine
        mineRevoke(chain, doc, tx(90), { reason: 'Degree withdrawn after inquiry', at: new Date('2026-10-10T09:30:00Z') });
        await s.call('POST', `/api/documents/${doc.documentId}/revoke`, { transactionHash: tx(90) });
        for (const [bytes, type] of [[png, 'image/png'], [await c.jpeg(60)(png), 'image/jpeg']]) {
            const { body } = await s.verify(bytes, { type });
            assert.strictEqual(body.verdict, 'REVOKED');                                                          // 3: revoked, whatever it looks like
            assert.strictEqual(body.revocation.reason, 'Degree withdrawn after inquiry');
            assert.strictEqual(body.revocation.at, '2026-10-10T09:30:00.000Z');
        }
    } finally { await s.close(); }
});

test('the chain is the authority: a document the database calls ISSUED but the registry does not hold is NOT_REGISTERED; one the registry says revoked is REVOKED', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    try {
        const png = await original();
        const doc = await s.issue(png, c.DEFAULT_FIELDS);
        chain.registry[doc.contentHash] = { ...chain.registry[doc.contentHash], exists: false };
        assert.strictEqual((await s.verify(png)).body.verdict, 'NOT_REGISTERED');
        chain.registry[doc.contentHash] = { ...chain.registry[doc.contentHash], exists: true, revoked: true };           // revoked on chain, database not yet updated
        assert.strictEqual((await documents.findByDocumentId(doc.documentId)).status, 'ISSUED');
        assert.strictEqual((await s.verify(png)).body.verdict, 'REVOKED');
    } finally { await s.close(); }
});

test('a document that was uploaded but never anchored is NOT_REGISTERED', async () => {
    const s = await api(fakeChain());
    try {
        const png = await original();
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), 'c.png');
        form.append('fields', JSON.stringify(c.DEFAULT_FIELDS));
        await fetch(`${s.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${s.token}` } });
        assert.strictEqual((await documents.model.countDocuments({ status: 'STORED' })), 1);
        assert.strictEqual((await s.verify(png)).body.verdict, 'NOT_REGISTERED');
    } finally { await s.close(); }
});

test('without a chain connection the database record is used, and the answer says it was not checked on chain', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    const bare = await api(null);
    try {
        const png = await original();
        await s.issue(png, c.DEFAULT_FIELDS);
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
        const res = await (await fetch(`${bare.url}/api/verify`, { method: 'POST', body: form })).json();
        assert.strictEqual(res.verdict, 'AUTHENTIC_ORIGINAL');
        assert.strictEqual(res.chainChecked, false);
    } finally { await s.close(); await bare.close(); }
});

// ======================================================================== QR binding (#58)
test('QR: a genuine copy with its own QR code is accepted and the QR is reported as matching', async () => {
    const s = await api(fakeChain());
    try {
        const png = await original();
        const doc = await s.issue(png, c.DEFAULT_FIELDS);
        const copy = await c.jpeg(60)(png);
        const { body } = await s.verify(copy, { type: 'image/jpeg', qr: qrFor(doc) });
        assert.strictEqual(body.verdict, 'AUTHENTIC_COPY');
        assert.deepStrictEqual(body.qr, { checked: true, pointsHere: true, matches: true });
    } finally { await s.close(); }
});

test('QR: a genuine QR transplanted onto a different, genuinely issued document is rejected ("QR does not match this document")', async () => {
    const s = await api(fakeChain());
    try {
        const docA = await s.issue(await original(PHOTO_A, c.DEFAULT_FIELDS), c.DEFAULT_FIELDS);
        const fieldsB = c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' });
        const pngB = await original(PHOTO_B, fieldsB);
        await s.issue(pngB, fieldsB);
        // document B is entirely genuine, but it carries document A's QR code
        const { body } = await s.verify(pngB, { qr: qrFor(docA) });
        assert.strictEqual(body.verdict, 'QR_MISMATCH');
        assert.match(body.reason, /QR code does not match this document/);
        assert.strictEqual(body.qr.matches, false);
    } finally { await s.close(); }
});

test('QR: a real QR photocopied onto a forgery is rejected, even though the QR itself points at a registered document', async () => {
    const s = await api(fakeChain());
    try {
        const doc = await s.issue(await original(), c.DEFAULT_FIELDS);
        const forged = await c.paintOver(await original(), 'dob', 'DOB: 12-04-2003');
        const { body } = await s.verify(forged, { qr: qrFor(doc) });
        assert.strictEqual(body.verdict, 'QR_MISMATCH');
    } finally { await s.close(); }
});

test('QR: a QR with an unreadable document proves nothing (INCONCLUSIVE), never an approval', async () => {
    const s = await api(fakeChain());
    try {
        const doc = await s.issue(await original(), c.DEFAULT_FIELDS);
        const { body } = await s.verify(await c.blur(4)(await original()), { qr: qrFor(doc) });
        assert.strictEqual(body.verdict, 'INCONCLUSIVE');
        assert.match(body.reason, /QR code on its own proves nothing/);
    } finally { await s.close(); }
});

test('QR: a code for another chain or contract is rejected; malformed codes and codes with extra content are 422', async () => {
    const s = await api(fakeChain());
    try {
        const png = await original();
        const doc = await s.issue(png, c.DEFAULT_FIELDS);
        const other = buildQrPayload({ contentHash: doc.contentHash, chainId: 1, contractAddress: ADDR });
        assert.strictEqual((await s.verify(png, { qr: other })).body.verdict, 'QR_MISMATCH');
        const elsewhere = buildQrPayload({ contentHash: doc.contentHash, chainId: CHAIN_ID, contractAddress: '0x' + '77'.repeat(20) });
        assert.strictEqual((await s.verify(png, { qr: elsewhere })).body.verdict, 'QR_MISMATCH');
        const bad = [
            'not json', '{}', '[]', 'null', JSON.stringify({ v: 2, contentHash: doc.contentHash, chainId: CHAIN_ID, contractAddress: ADDR }),
            JSON.stringify({ v: 1, contentHash: 'abc', chainId: CHAIN_ID, contractAddress: ADDR }),
            JSON.stringify({ v: 1, contentHash: doc.contentHash, chainId: CHAIN_ID, contractAddress: ADDR, holder: 'Asha Rao' }),   // personal data cannot ride in the code
            'x'.repeat(400),
        ];
        for (const qr of bad) {
            const r = await s.verify(png, { qr });
            assert.strictEqual(r.status, 422, qr.slice(0, 40));
            assert.ok(!JSON.stringify(r.body).includes('Asha'), 'the offending content is not echoed');
        }
    } finally { await s.close(); }
});

// ======================================================================== PDFs
test('PDFs: the exact registered file is AUTHENTIC_ORIGINAL; any other PDF is NOT_REGISTERED and the answer explains why', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    try {
        const bytes = Buffer.from('%PDF-1.4 a registered pdf');
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'a.pdf');
        form.append('fields', JSON.stringify(c.DEFAULT_FIELDS));
        const up = await (await fetch(`${s.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${s.token}` } })).json();
        mineAnchor(chain, up.document, tx(71));
        await s.call('POST', `/api/documents/${up.document.documentId}/chain-pending`, { transactionHash: tx(71) });
        await s.call('POST', `/api/documents/${up.document.documentId}/chain-confirmed`, { transactionHash: tx(71) });

        assert.strictEqual((await s.verify(bytes, { type: 'application/pdf', name: 'a.pdf' })).body.verdict, 'AUTHENTIC_ORIGINAL');
        const qr = qrFor(up.document);
        const withQr = await s.verify(bytes, { type: 'application/pdf', name: 'a.pdf', qr });
        assert.strictEqual(withQr.body.verdict, 'AUTHENTIC_ORIGINAL');
        assert.strictEqual(withQr.body.qr.matches, true);
        const resaved = await s.verify(Buffer.from('%PDF-1.4 a registered pdf, re-saved'), { type: 'application/pdf', name: 'b.pdf' });
        assert.strictEqual(resaved.body.verdict, 'NOT_REGISTERED');
        assert.match(resaved.body.reason, /re-saved copy of a registered PDF cannot be recognised/);
        assert.strictEqual((await s.verify(Buffer.from('%PDF-1.4 other'), { type: 'application/pdf', name: 'c.pdf', qr })).body.verdict, 'INCONCLUSIVE', 'a QR with an unreadable PDF proves nothing');
    } finally { await s.close(); }
});

// ======================================================================== privacy, safety, audit
test('privacy: the public is told WHICH field differs but not the anchored (true) value; a signed-in issuer sees both', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const forged = await c.paintOver(await original(), 'dob', 'DOB: 12-04-2003');
        const publicView = (await s.verify(forged)).body.tiers.content.fieldDiffs[0];
        assert.deepStrictEqual(publicView, { field: 'payload.dob', anchored: null, presented: '2003-04-12', anchoredWithheld: true });
        const issuerView = (await s.verify(forged, { withToken: true })).body.tiers.content.fieldDiffs[0];
        assert.deepStrictEqual([issuerView.field, issuerView.anchored, issuerView.presented], ['payload.dob', '2005-04-12', '2003-04-12']);
    } finally { await s.close(); }
});

test('the verified file is never stored, and the public response carries no record id, file hash, name or ID number', async () => {
    const s = await api(fakeChain());
    try {
        const png = await original();
        await s.issue(png, c.DEFAULT_FIELDS);
        const writesBefore = s.s3.sent.length;
        const res = await s.verify(png);
        assert.strictEqual(s.s3.sent.length, writesBefore, 'verification wrote nothing to S3');
        const text = JSON.stringify(res.body);
        for (const secret of ['Asha Rao', 'ASHA RAO', 'B210123CS', 'documentId', c.sha256(png)]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
        assert.ok(!('documentId' in res.body));
    } finally { await s.close(); }
});

test('every verification is audited with its verdict and, when a record exists, the document; the audit holds no content', async () => {
    const s = await api(fakeChain());
    try {
        const png = await original();
        const doc = await s.issue(png, c.DEFAULT_FIELDS);
        await audit.model.deleteMany({});
        await s.verify(png);
        await s.verify(await c.paintOver(png, 'dob', 'DOB: 12-04-2003'));
        await s.verify(await original(PHOTO_A, c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' })));
        await s.verify(await c.blur(4)(png));
        const events = (await audit.model.find({ action: 'VERIFY' }).sort({ createdAt: 1, _id: 1 }).lean());
        assert.deepStrictEqual(events.map((e) => `${e.outcome}:${e.reason}`), ['SUCCESS:MATCH', 'FAILED:TAMPERED_CONTENT', 'FAILED:NO_MATCH', 'FAILED:INCONCLUSIVE']);
        assert.strictEqual(events[0].documentId, doc.documentId);
        assert.strictEqual(events[1].documentId, doc.documentId, 'a tampered copy is linked to the document it claims to be');
        assert.strictEqual(events[2].documentId, undefined);
        assert.ok(events.every((e) => e.actorName === undefined));
        assert.ok(!JSON.stringify(events).match(/Asha|B210123|2003|2005/));
    } finally { await s.close(); }
});

test('verification is rate-limited separately (OCR is expensive), refuses a missing file, and says 503 without a database', async () => {
    const s = await api(fakeChain(), { rateLimits: { verify: { windowMs: 60000, limit: 2 } } });
    const bare = await start(fakeS3());
    try {
        const png = await original();
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await s.verify(png)).status);
        assert.deepStrictEqual(codes, [200, 200, 429, 429]);
        const another = await api(fakeChain());
        try { assert.strictEqual((await fetch(`${another.url}/api/verify`, { method: 'POST', body: new FormData() })).status, 400); } finally { await another.close(); }
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
        assert.strictEqual((await fetch(`${bare.url}/api/verify`, { method: 'POST', body: form })).status, 503);
    } finally { await s.close(); await bare.close(); }
});

test('a failing chain does not become a verdict: it is an error, never "authentic" or "not registered"', async () => {
    const chain = fakeChain();
    const s = await api(chain);
    try {
        const png = await original();
        await s.issue(png, c.DEFAULT_FIELDS);
        chain.verify = async () => { throw new Error('rpc down'); };
        const { status, body } = await s.verify(png);
        assert.strictEqual(status, 500);
        assert.strictEqual(body.error, 'Internal server error.');
        assert.ok(!body.verdict);
    } finally { await s.close(); }
});

// ======================================================================== a flat graphic where the photo goes
// Found by driving the real UI: a certificate whose photo box holds a flat, hard-edged graphic (a cartoon portrait, a seal) is
// not hashable. Its region hash moves 28-30 bits under an ordinary JPEG/half-size copy, as far as a different picture would, so
// judging it falsely accused a legitimate copy of being altered. Such a region is now reported as unchecked instead.
test('a recompressed copy of a certificate with a FLAT graphic in the photo box is AUTHENTIC_COPY, and says the photo was not checked', async () => {
    const s = await api(fakeChain());
    try {
        const flat = await c.render(c.DEFAULT_FIELDS);                        // the placeholder portrait: two tones, hard edges
        await s.issue(flat, c.DEFAULT_FIELDS);
        for (const make of [c.jpeg(70), c.jpeg(50), c.pipe(c.shrink(0.7), c.jpeg(70))]) {
            const { body } = await s.verify(await make(flat), { type: 'image/jpeg', name: 'copy.jpg' });
            assert.strictEqual(body.verdict, 'AUTHENTIC_COPY', JSON.stringify(body.tiers.visual));
            assert.deepStrictEqual(body.tiers.visual.unreliableRegions, ['photo']);
            assert.deepStrictEqual(body.tiers.visual.changedRegions, []);
            assert.match(body.reason, /photo area is too plain to compare reliably, so it was not checked/);
        }
    } finally { await s.close(); }
});

test('a textured photograph is still checked: a swapped photo is flagged and nothing is reported as unchecked', async () => {
    const s = await api(fakeChain());
    try {
        await s.issue(await original(), c.DEFAULT_FIELDS);
        const { body } = await s.verify(await original(PHOTO_B), { type: 'image/png' });
        assert.strictEqual(body.verdict, 'TAMPERED_VISUAL');
        assert.deepStrictEqual(body.tiers.visual.changedRegions, ['photo']);
        assert.deepStrictEqual(body.tiers.visual.unreliableRegions, []);
        const ok = await s.verify(await c.jpeg(60)(await original()), { type: 'image/jpeg' });
        assert.strictEqual(ok.body.verdict, 'AUTHENTIC_COPY');
        assert.deepStrictEqual(ok.body.tiers.visual.unreliableRegions, []);
    } finally { await s.close(); }
});
