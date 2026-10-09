// Issue #52: Tier 2 end to end. Part 1 uses hand-built analyses (fast). Part 2 runs real Tesseract on rendered certificates.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { analyseImage, compareToAnchor, MISMATCH_CONFIDENCE } = require('../tier2');
const { contentHash, lookupKey, canonicalRecord } = require('../content-hash');
const { shutdown, LANG_PATH } = require('../ocr');
const c = require('./fixtures/certificate');
const { runRobustness, verdict, toMarkdown } = require('../scripts/robustness');

after(async () => { await shutdown(); });

const ANCHOR = contentHash(c.DEFAULT_FIELDS);

// ---------------------------------------------------------------- compareToAnchor on hand-built analyses
const readOf = (fields, confidences = {}) => {
    const { hash, record } = contentHash(fields);
    return { status: 'READ', fields, record, contentHash: hash, lookupKey: lookupKey(record), confidences, weak: [], steps: {} };
};
const confidentEverywhere = (fields) => {
    const r = canonicalRecord(fields);
    const conf = Object.fromEntries(['issuer', 'docType', 'holder', 'idNumber', 'issuedOn', ...Object.keys(r.payload).map((k) => `payload.${k}`)].map((k) => [k, 96]));
    return readOf(fields, conf);
};

test('a match is accepted whatever the confidence: equal hashes prove the read was right', () => {
    const lowEverywhere = readOf(c.DEFAULT_FIELDS, Object.fromEntries(['issuer', 'holder', 'idNumber'].map((k) => [k, 12])));
    assert.deepStrictEqual(compareToAnchor(ANCHOR.record, ANCHOR.hash, lowEverywhere), { status: 'MATCH', fieldDiffs: [] });
});

test('a mismatch is declared only when every differing field was read confidently, and it names the fields (old and new)', () => {
    const forged = confidentEverywhere(c.withFields({}, { dob: '12-04-2003', cgpa: '9.1' }));
    const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, forged);
    assert.strictEqual(r.status, 'MISMATCH');
    assert.deepStrictEqual(r.fieldDiffs, [
        { field: 'payload.cgpa', anchored: '8.7', presented: '9.1' },
        { field: 'payload.dob', anchored: '2005-04-12', presented: '2003-04-12' },
    ]);
});

test('a differing field read with doubt makes the result inconclusive, never "tampered"', () => {
    const doubtful = confidentEverywhere(c.withFields({}, { dob: '12-04-2008' }));
    doubtful.confidences['payload.dob'] = MISMATCH_CONFIDENCE - 1;
    const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, doubtful);
    assert.strictEqual(r.status, 'INCONCLUSIVE');
    assert.deepStrictEqual(r.uncertainFields, ['payload.dob']);
    const sure = confidentEverywhere(c.withFields({}, { dob: '12-04-2008' }));
    sure.confidences['payload.dob'] = MISMATCH_CONFIDENCE;
    assert.strictEqual(compareToAnchor(ANCHOR.record, ANCHOR.hash, sure).status, 'MISMATCH', 'exactly at the threshold counts as sure');
});

test('one sure difference does not excuse a doubtful one: mixed is inconclusive', () => {
    const mixed = confidentEverywhere(c.withFields({ holder: 'Ravi Menon' }, { dob: '12-04-2008' }));
    mixed.confidences['payload.dob'] = 60;
    const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, mixed);
    assert.strictEqual(r.status, 'INCONCLUSIVE');
    assert.deepStrictEqual(r.uncertainFields, ['payload.dob']);
});

test('an unreadable document is inconclusive and says which fields', () => {
    const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, { status: 'UNREADABLE', problems: [{ field: 'holder', problem: 'missing' }, { field: 'payload.dob', problem: 'ambiguous' }] });
    assert.deepStrictEqual([r.status, r.uncertainFields], ['INCONCLUSIVE', ['holder', 'payload.dob']]);
});

test('a line removed from the anchored record shows up as a difference with null on the missing side', () => {
    const anchoredWithRemarks = contentHash(c.withFields({}, { remarks: 'With Distinction' }));
    const r = compareToAnchor(anchoredWithRemarks.record, anchoredWithRemarks.hash, confidentEverywhere(c.DEFAULT_FIELDS));
    assert.strictEqual(r.status, 'MISMATCH');
    assert.deepStrictEqual(r.fieldDiffs, [{ field: 'payload.remarks', anchored: 'WITH DISTINCTION', presented: null }]);
});

// ---------------------------------------------------------------- real OCR on rendered certificates
test('the OCR language data is local and the OCR needs no network', async () => {
    const file = path.join(LANG_PATH, 'eng.traineddata');
    assert.ok(fs.statSync(file).size > 1024 * 1024, 'the committed language data is present');
    const before = fs.readdirSync(process.cwd()).filter((f) => f.endsWith('.traineddata'));
    const a = await analyseImage(await c.render());
    assert.strictEqual(a.status, 'READ');
    assert.deepStrictEqual(fs.readdirSync(process.cwd()).filter((f) => f.endsWith('.traineddata')), before, 'nothing was downloaded next to the code');
});

test('a clean certificate reads back to exactly the hash the issuer would anchor', async () => {
    const a = await analyseImage(await c.render());
    assert.strictEqual(a.status, 'READ');
    assert.strictEqual(a.contentHash, ANCHOR.hash);
    assert.strictEqual(a.lookupKey, lookupKey(c.DEFAULT_FIELDS));
    assert.ok(Object.values(a.confidences).every((x) => x >= 85), 'clean print reads with high confidence');
    assert.deepStrictEqual(compareToAnchor(ANCHOR.record, ANCHOR.hash, a), { status: 'MATCH', fieldDiffs: [] });
});

const tampered = [
    ['date of birth changed (re-rendered)', () => c.render(c.withFields({}, { dob: '12-04-2003' })), [{ field: 'payload.dob', anchored: '2005-04-12', presented: '2003-04-12' }]],
    ['date of birth painted over in an image editor', async () => c.paintOver(await c.render(), 'dob', 'DOB: 12-04-2003'), [{ field: 'payload.dob', anchored: '2005-04-12', presented: '2003-04-12' }]],
    ['CGPA raised', () => c.render(c.withFields({}, { cgpa: '9.7' })), [{ field: 'payload.cgpa', anchored: '8.7', presented: '9.7' }]],
    ['holder name changed', () => c.render(c.withFields({ holder: 'Ravi Menon' })), [{ field: 'holder', anchored: 'ASHA RAO', presented: 'RAVI MENON' }]],
    ['issue date moved', () => c.render(c.withFields({ issuedOn: '15-06-2024' })), [{ field: 'issuedOn', anchored: '2026-06-15', presented: '2024-06-15' }]],
    ['CONTROL, nothing changed (painted over with identical text)', async () => c.paintOver(await c.render(), 'issuedOn', 'Issued On: 15-06-2026'), []],
    ['an extra claim line added', () => c.render(c.DEFAULT_FIELDS, { extra: ['Remarks: With Distinction'] }), [{ field: 'payload.remarks', anchored: null, presented: 'WITH DISTINCTION' }]],
];
for (const [name, make, expectedDiffs] of tampered) {
    test(`tampering is caught and the changed field is named / control: ${name}`, async () => {
        const a = await analyseImage(await make());
        const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, a);
        if (expectedDiffs.length === 0) { assert.strictEqual(r.status, 'MATCH', 'the control is not tampered'); return; }
        assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(a.problems || a.weak));
        assert.deepStrictEqual(r.fieldDiffs, expectedDiffs);
    });
}

test('a different person\'s certificate on the same template is a mismatch in several named fields, with a different lookup key', async () => {
    const other = c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' }, { dob: '03-09-2004', cgpa: '7.9' });
    const a = await analyseImage(await c.render(other));
    const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, a);
    assert.strictEqual(r.status, 'MISMATCH');
    assert.deepStrictEqual(r.fieldDiffs.map((d) => d.field), ['holder', 'idNumber', 'payload.cgpa', 'payload.dob']);
    assert.notStrictEqual(a.lookupKey, lookupKey(c.DEFAULT_FIELDS));
});

test('tampering survives a bad copy: an altered document that is also compressed and photographed is never accepted', async () => {
    const forged = await c.paintOver(await c.render(), 'dob', 'DOB: 12-04-2003');
    for (const make of [c.jpeg(40), c.pipe(c.shrink(0.6), c.jpeg(50)), c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]])]) {
        const r = compareToAnchor(ANCHOR.record, ANCHOR.hash, await analyseImage(await make(forged)));
        assert.notStrictEqual(r.status, 'MATCH');
        if (r.status === 'MISMATCH') assert.deepStrictEqual(r.fieldDiffs.map((d) => d.field), ['payload.dob']);
    }
});

test('a certificate with a field line missing is inconclusive (missing), never a verdict', async () => {
    const svgText = c.svg(c.DEFAULT_FIELDS).replace(/<text[^>]*>CGPA: 8\.7<\/text>/, '');
    const a = await analyseImage(await sharp(Buffer.from(svgText)).png().toBuffer());
    assert.strictEqual(a.status, 'UNREADABLE');
    assert.deepStrictEqual(a.problems, [{ field: 'payload.cgpa', problem: 'missing' }]);
    assert.strictEqual(compareToAnchor(ANCHOR.record, ANCHOR.hash, a).status, 'INCONCLUSIVE');
});

test('pictures that are not certificates, and broken images, are handled without a verdict or a crash', async () => {
    const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
    const speck = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer();
    const noiseOnly = await sharp({ create: { width: 800, height: 600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
    for (const img of [blank, speck, noiseOnly]) {
        const a = await analyseImage(img);
        assert.strictEqual(a.status, 'UNREADABLE');
        assert.strictEqual(compareToAnchor(ANCHOR.record, ANCHOR.hash, a).status, 'INCONCLUSIVE');
    }
    await assert.rejects(() => analyseImage(Buffer.from('not an image at all')));
});

test('ROBUSTNESS: the same certificate in 22 damaged forms is recognised, with no false alarms (the evidence table)', async (t) => {
    const rows = await runRobustness();
    t.diagnostic('\n' + toMarkdown(rows));
    assert.ok(rows.filter((r) => !r.control).every((r) => r.bytesDiffer), 'every damaged copy really has different bytes (Tier 1 would fail them all)');
    assert.strictEqual(rows.filter((r) => r.outcome === 'FALSE_ALARM').length, 0, 'no genuine copy is ever called altered');
    assert.ok(rows.filter((r) => r.kind === 'supported').every((r) => r.outcome === 'MATCH'), 'every ordinary copy matches');
    assert.ok(rows.filter((r) => r.kind === 'extreme').every((r) => r.outcome !== 'FALSE_ALARM'));
    assert.strictEqual(verdict(rows), true);
    assert.ok(rows.length >= 22);
});
