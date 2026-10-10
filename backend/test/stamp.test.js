// Issue #58, the last bullet: the QR embedded in the certificate file itself.
//
// The point of these tests is one property. Stamping must not change the content
// hash, because the hash is what the stamp carries. Everything else follows from
// that: get it wrong and the QR on the paper names a document that no longer
// exists.
const { test, after } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const jsQR = require('jsqr');

const { stampQr, renderQr, StampError, BOX } = require('../stamp');
const { buildQrPayload, parseQrPayload } = require('../qr');
const { analyseImage } = require('../tier2');
const { TEMPLATE } = require('../extract');
const imaging = require('../imaging');
const ph = require('../phash');
const { shutdown } = require('../ocr');
const c = require('./fixtures/certificate');

const CHAIN = { chainId: 11155111, contractAddress: '0x1234567890abcdef1234567890abcdef12345678' };
const payloadFor = (contentHash) => buildQrPayload({ contentHash, ...CHAIN });

/** Decodes the QR out of a PNG the way a scanner would: whole page, no hints about where it is. */
async function readQr(png) {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    return result && result.data;
}

after(() => shutdown());

// ------------------------------------------------------- the property that matters

test('THE INVARIANT: stamping the QR does not change the content hash it carries', { timeout: 180000 }, async () => {
    const plain = await c.renderWithPhoto(11);
    const before = await analyseImage(plain);
    assert.strictEqual(before.status, 'READ', 'the unstamped certificate must read, or this test proves nothing');

    const { buffer: stamped } = await stampQr(plain, payloadFor(before.contentHash));
    const after_ = await analyseImage(stamped);

    assert.strictEqual(after_.status, 'READ', 'the stamped certificate must still read');
    assert.deepStrictEqual(after_.fields, before.fields, 'no field may change');
    assert.strictEqual(after_.contentHash, before.contentHash,
        'the hash printed in the QR must be the hash the stamped document yields');
});

test('the QR is not read as text: no field gains a stray value and no extra claim appears', { timeout: 180000 }, async () => {
    const plain = await c.renderWithPhoto(11);
    const before = await analyseImage(plain);
    const { buffer: stamped } = await stampQr(plain, payloadFor(before.contentHash));
    const after_ = await analyseImage(stamped);

    // An extra labelled line would land in payload and change the hash. The previous test would catch it,
    // but this names the failure if it ever happens.
    assert.deepStrictEqual(
        Object.keys(after_.record.payload).sort(),
        Object.keys(before.record.payload).sort(),
        'the QR must not produce an extra payload field'
    );
    assert.deepStrictEqual(after_.problems ?? [], [], 'the QR must not make the document unreadable');
});

test('stamping does not move the content crop, so every other template region still points where it did', async () => {
    const plain = await c.renderWithPhoto(11);
    const { buffer: stamped } = await stampQr(plain, payloadFor('a'.repeat(64)));

    const a = imaging.cropToContent(await imaging.loadGray(plain));
    const b = imaging.cropToContent(await imaging.loadGray(stamped));

    // The template's regions are fractions of the cropped page. If the crop changed, photoRegion would
    // silently point somewhere else and Tier 3's calibration would be void.
    assert.strictEqual(b.width, a.width, 'the cropped width must not change');
    assert.strictEqual(b.height, a.height, 'the cropped height must not change');
});

test('the ignore region covers the stamped box, and qrRegion matches where stamp.js actually puts it', async () => {
    const plain = await c.renderWithPhoto(11);
    const cropped = imaging.cropToContent(await imaging.loadGray(plain));

    // Re-derive the crop offset from the photo box, whose pixel position and recorded fractions are both known.
    const pr = TEMPLATE.photoRegion;
    const p = { x0: c.PHOTO.x, y0: c.PHOTO.y, x1: c.PHOTO.x + c.PHOTO.w, y1: c.PHOTO.y + c.PHOTO.h };
    const offX = ((p.x0 - pr.x0 * cropped.width) + (p.x1 - pr.x1 * cropped.width)) / 2;
    const offY = ((p.y0 - pr.y0 * cropped.height) + (p.y1 - pr.y1 * cropped.height)) / 2;

    const actual = {
        x0: (BOX.x - offX) / cropped.width, y0: (BOX.y - offY) / cropped.height,
        x1: (BOX.x + BOX.w - offX) / cropped.width, y1: (BOX.y + BOX.h - offY) / cropped.height,
    };
    const q = TEMPLATE.qrRegion;
    for (const k of ['x0', 'y0', 'x1', 'y1']) {
        assert.ok(Math.abs(q[k] - actual[k]) < 0.002, `qrRegion.${k} is ${q[k]}, stamp.js puts it at ${actual[k].toFixed(4)}`);
    }

    // And the ignore region must strictly contain it, with room to spare.
    const ignore = TEMPLATE.ignoreRegions.find((r) => r.name === 'qr');
    assert.ok(ignore, 'the template must list a qr ignore region');
    assert.ok(ignore.x0 < q.x0 && ignore.y0 < q.y0 && ignore.x1 > q.x1 && ignore.y1 > q.y1,
        'the ignore region must contain the stamped box on every side');
});

// ------------------------------------------------------------------- readability

test('the stamped QR decodes back to exactly the payload that went in, and parses as a MindForge code', async () => {
    const plain = await c.renderWithPhoto(11);
    const hash = 'f'.repeat(63) + 'e';
    const payload = payloadFor(hash);

    const { buffer: stamped } = await stampQr(plain, payload);
    const decoded = await readQr(stamped);

    assert.strictEqual(decoded, payload, 'the decoded text must be byte-for-byte what was encoded');
    const parsed = parseQrPayload(decoded);
    assert.strictEqual(parsed.ok, true, parsed.reason);
    assert.strictEqual(parsed.qr.contentHash, hash);
    assert.strictEqual(parsed.qr.chainId, CHAIN.chainId);
});

test('the code is drawn at a whole number of pixels per module, which is what makes it survive resizing', async () => {
    const plain = await c.renderWithPhoto(11);
    const r = await stampQr(plain, payloadFor('b'.repeat(64)));

    assert.strictEqual(r.modules, 61, 'a ~170-character payload at EC level M is 53 modules plus a 4-module quiet zone each side');
    assert.strictEqual(r.scale, 4, 'four pixels per module');
    assert.strictEqual(r.box.w, r.modules * r.scale, 'the drawn size must be an exact multiple of the module size');
    assert.strictEqual(r.box.w, 244);
    assert.ok(r.box.w <= r.slot.w && r.box.h <= r.slot.h, 'the code must fit the reserved slot');
});

test('the QR survives being photocopied and photographed: compression, noise, blur, tilt, dimming, and resize-then-compress', async () => {
    const plain = await c.renderWithPhoto(11);
    const payload = payloadFor('b'.repeat(64));
    const { buffer: stamped } = await stampQr(plain, payload);

    const degradations = [
        ['JPEG q60', c.jpeg(60)],
        ['JPEG q30', c.jpeg(30)],
        ['JPEG q15', c.jpeg(15)],
        ['noise sigma 15', c.noise(15)],
        ['blur 1', c.blur(1)],
        ['blur 2', c.blur(2)],
        ['rotated -4', c.rotated(-4)],
        ['dim x0.6', c.dim(0.6, 0)],
        ['photographed at an angle', c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]])],
        ['WhatsApp-style (70% then q55)', c.pipe(c.shrink(0.7), c.jpeg(55))],
        ['half size then q50', c.pipe(c.shrink(0.5), c.jpeg(50))],
    ];
    for (const [name, damage] of degradations) {
        const decoded = await readQr(await sharp(await damage(stamped)).png().toBuffer());
        assert.strictEqual(decoded, payload, `the QR became unreadable after: ${name}`);
    }
});

test('KNOWN LIMIT, measured: bare resampling of a perfectly crisp render has ratios that defeat a software decoder', async () => {
    // This is recorded rather than asserted away, because it is real but narrow.
    // Measured with jsQR over the stamped synthetic page, resize only, no compression:
    //   90% ok, 80% ok, 75% FAILS, 70% ok, 60% ok, 50% ok, 45% FAILS, 40% ok, 30% FAILS
    // Non-monotonic, so it is not a resolution limit. At those ratios the module
    // grid lands on pixel boundaries such that the resampling kernel's ringing
    // leaves edge pixels mid-grey, and the decoder's binariser splits them the
    // wrong way. ANY low-pass removes it: 70% alone fails in isolation yet 70%
    // followed by JPEG q55 decodes, and so does 50% followed by q50 (both are
    // asserted in the test above). A real camera supplies that low-pass
    // optically, and a real document is not pixel-crisp to begin with.
    //
    // What this means in practice: re-encode rather than resize-only when a
    // stamped page is passed on, and do not treat a single failed decode as
    // evidence about the document. Verification does not depend on the QR at
    // all - it re-reads the fields and recomputes the hash (verification.js).
    const plain = await c.renderWithPhoto(11);
    const payload = payloadFor('b'.repeat(64));
    const { buffer: stamped } = await stampQr(plain, payload);

    const results = {};
    for (const f of [0.9, 0.8, 0.75, 0.7, 0.6, 0.5]) {
        results[f] = (await readQr(await sharp(await c.shrink(f)(stamped)).png().toBuffer())) === payload;
    }
    const ok = Object.values(results).filter(Boolean).length;
    assert.ok(ok >= 5, `resize-only decoding has got worse: ${JSON.stringify(results)}`);
});

// ------------------------------------------------------------- Tier 3 interaction

test('the QR does not destabilise Tier 3: its own tiles move no further under re-capture than the threshold allows', async () => {
    const T = ph.loadThresholds();
    const options = { regions: { photo: TEMPLATE.photoRegion, qr: TEMPLATE.qrRegion } };

    const plain = await c.renderWithPhoto(11);
    const { buffer: stamped } = await stampQr(plain, payloadFor('c'.repeat(64)));
    const anchored = await ph.analyseVisual(stamped, options);

    // A QR is hard-edged, high-contrast content, which is exactly the kind that resampling moves around.
    // If it were unstable, honest re-captures of a genuine document would start reading as changed.
    const recaptures = [
        ['JPEG q60', c.jpeg(60)],
        ['shrink 50%', c.shrink(0.5)],
        ['blur 1', c.blur(1)],
        ['angled + JPEG', c.pipe(c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]]), c.jpeg(60))],
    ];
    const worst = { name: null, cell: -1 };
    for (const [name, damage] of recaptures) {
        const seen = await ph.analyseVisual(await sharp(await damage(stamped)).png().toBuffer(), options);
        const r = ph.compareVisual(anchored, seen, T);
        const largest = Math.max(...r.cells.flat());
        if (largest > worst.cell) Object.assign(worst, { name, cell: largest });
        assert.strictEqual(ph.advice(r), 'CONSISTENT', `a stamped re-capture read as ${ph.advice(r)} after ${name}`);
    }
    assert.ok(worst.cell <= T.cellFar, `largest tile ${worst.cell} (${worst.name}) exceeds cellFar ${T.cellFar}`);
});

// -------------------------------------------------------------------- refusals

test('a PDF is refused rather than mangled', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    await assert.rejects(() => stampQr(pdf, payloadFor('d'.repeat(64))), StampError);
});

test('broken bytes, an empty payload and a document too small for the box are all refused', async () => {
    const page = await c.renderWithPhoto(11);
    await assert.rejects(() => stampQr(Buffer.from('not an image'), payloadFor('e'.repeat(64))), StampError);
    await assert.rejects(() => stampQr(page, ''), StampError);

    // 200x140: the scaled box still fits proportionally, but the QR would be far too small to scan,
    // so renderQr refuses on size.
    const tiny = await sharp({ create: { width: 200, height: 140, channels: 3, background: '#fff' } }).png().toBuffer();
    await assert.rejects(() => stampQr(tiny, payloadFor('e'.repeat(64))), StampError);
});

test('renderQr refuses a payload that is not text and a module size no scanner could read', async () => {
    await assert.rejects(() => renderQr(null), StampError);
    await assert.rejects(() => renderQr('x', 1), StampError);     // one pixel per module is not scannable
    await assert.rejects(() => renderQr('x', 2.5), StampError);   // a fractional module is the aliasing bug
});

// ------------------------------------------------- the endpoint (#58, issuer side)

test('POST /api/documents/:id/certificate returns the stamped page, and only for the real original', { timeout: 180000 }, async (t) => {
    const { startMongo } = require('./mongo');
    const { fakeS3, start, loginToken } = require('./helpers');
    const { fakeChain, mineAnchor, ADDR, tx } = require('./chain-fakes');

    const mongo = await startMongo();
    const chain = fakeChain();
    const server = await start(fakeS3(), {
        documents: mongo.documents, audit: mongo.audit, chain, contractAddress: ADDR, chainId: 80002,
    });
    const { token } = await loginToken(server.url);
    const auth = { Authorization: `Bearer ${token}` };

    try {
        // Issue a document all the way to ISSUED.
        const png = await c.renderWithPhoto(11);
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), 'cert.png');
        form.append('fields', JSON.stringify(c.DEFAULT_FIELDS));
        const up = await (await fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: auth })).json();
        const doc = up.document;
        mineAnchor(chain, doc, tx(1));
        const call = (route, body) => fetch(`${server.url}${route}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await call(`/api/documents/${doc.documentId}/chain-pending`, { transactionHash: tx(1) });
        await call(`/api/documents/${doc.documentId}/chain-confirmed`, { transactionHash: tx(1) });

        const stamp = async (bytes) => {
            const f = new FormData();
            f.append('file', new Blob([bytes], { type: 'image/png' }), 'cert.png');
            return fetch(`${server.url}/api/documents/${doc.documentId}/certificate`, { method: 'POST', body: f, headers: auth });
        };

        // The real original: a stamped PNG comes back as a download.
        const res = await stamp(png);
        assert.strictEqual(res.status, 200, await res.clone().text());
        assert.strictEqual(res.headers.get('content-type'), 'image/png');
        assert.match(res.headers.get('content-disposition'), /attachment; filename="certificate-.*\.png"/);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'a credential must not be cached');
        const stamped = Buffer.from(await res.arrayBuffer());

        // It carries this document's own QR...
        assert.strictEqual(await readQr(stamped), buildQrPayload({ contentHash: doc.contentHash, chainId: 80002, contractAddress: ADDR }));

        // ...and still verifies, through Tier 2, as the same document. Tier 1 does NOT match, by design:
        // the anchored byte hash is the unstamped file's. AUTHENTIC_COPY is the honest verdict.
        const vf = new FormData();
        vf.append('file', new Blob([stamped], { type: 'image/png' }), 'x.png');
        const v = await (await fetch(`${server.url}/api/verify`, { method: 'POST', body: vf })).json();
        assert.strictEqual(v.tiers.content.match, true, 'the stamped file must still read as the same document');
        assert.strictEqual(v.tiers.byte.match, false, 'the stamped file is not the anchored bytes, and must not claim to be');

        // A different file is refused rather than stamped with a code it has no claim to.
        const other = await c.renderWithPhoto(44);
        assert.strictEqual((await stamp(other)).status, 409);
    } finally {
        await server.close();
        await mongo.stop();
    }
});
