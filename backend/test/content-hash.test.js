// Issue #52, Tier 2: the canonical content hash. Pure functions, no OCR here.
const test = require('node:test');
const assert = require('node:assert');
const { canonicalRecord, contentHash, lookupKey, diffRecords, stableStringify, toISODate, normValue, FieldError, VERSION_TAG } = require('../content-hash');

const BASE = {
    docType: 'Degree Certificate', issuer: 'NITC Registrar', holder: 'Asha Rao', idNumber: 'B210123CS', issuedOn: '15-06-2026',
    payload: { dob: '12-04-2005', programme: 'B.Tech Computer Science', cgpa: '8.7' },
};
const h = (over = {}, payload) => contentHash({ ...BASE, ...over, payload: { ...BASE.payload, ...(payload || {}) } }).hash;

test('the hash is a stable 64-hex value with a version tag', () => {
    assert.match(h(), /^[a-f0-9]{64}$/);
    assert.strictEqual(h(), h());
    assert.ok(VERSION_TAG.startsWith('mindforge:content:v'));
});

test('harmless differences do NOT change the hash: case, spacing, Unicode form, ID punctuation, date style, number style', () => {
    const same = [
        { holder: 'ASHA RAO' }, { holder: 'asha rao' }, { holder: '  Asha   Rao  ' }, { holder: 'Asha Rao' }, { holder: 'Asha\tRao\n' },
        { holder: 'Ａｓｈａ Ｒａｏ' },                                               // full-width letters
        { holder: 'Rénée' === 'x' ? '' : 'Asha Rao' },                    // (identity: keeps the list honest)
        { idNumber: 'b210123cs' }, { idNumber: 'B-210 123 CS' }, { idNumber: 'B210123/CS' },
        { issuedOn: '2026-06-15' }, { issuedOn: '15/06/2026' }, { issuedOn: '15.06.2026' }, { issuedOn: '15 Jun 2026' },
        { issuedOn: '15 June 2026' }, { issuedOn: 'June 15, 2026' }, { issuedOn: '5-6-2026'.replace('5-6', '15-06') },
        { issuer: 'nitc   registrar' }, { docType: 'degree CERTIFICATE' },
    ];
    for (const over of same) assert.strictEqual(h(over), h(), JSON.stringify(over));
    for (const payload of [{ cgpa: '8.70' }, { cgpa: '08.7' }, { cgpa: 8.7 }, { dob: '2005-04-12' }, { dob: '12 April 2005' }, { programme: 'b.tech  computer science' }]) {
        assert.strictEqual(h({}, payload), h(), JSON.stringify(payload));
    }
});

test('the order of payload fields does not matter, and an empty extra field equals an absent one', () => {
    const a = contentHash({ ...BASE, payload: { cgpa: '8.7', dob: '12-04-2005', programme: 'B.Tech Computer Science' } }).hash;
    const b = contentHash({ ...BASE, payload: { programme: 'B.Tech Computer Science', dob: '12-04-2005', cgpa: '8.7' } }).hash;
    const c = contentHash({ ...BASE, payload: { ...BASE.payload, remarks: '   ', extra: null } }).hash;
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
});

test('real changes DO change the hash: every field, one character at a time', () => {
    const changed = [
        { holder: 'Asha Rau' }, { holder: 'Asha Rao Jr' }, { idNumber: 'B210124CS' }, { idNumber: 'B210123EE' }, { issuer: 'NITC Registrar Office' },
        { docType: 'Diploma Certificate' }, { issuedOn: '16-06-2026' }, { issuedOn: '15-07-2026' }, { issuedOn: '15-06-2025' },
    ];
    for (const over of changed) assert.notStrictEqual(h(over), h(), JSON.stringify(over));
    for (const payload of [{ dob: '12-04-2003' }, { cgpa: '9.7' }, { cgpa: '8.8' }, { programme: 'B.Tech Mechanical' }, { newfield: 'surprise' }]) {
        assert.notStrictEqual(h({}, payload), h(), JSON.stringify(payload));
    }
    const noDob = { ...BASE, payload: { programme: BASE.payload.programme, cgpa: '8.7' } };
    assert.notStrictEqual(contentHash(noDob).hash, h(), 'dropping a field changes the hash');
});

test('the encoding cannot be gamed: fields cannot slide into each other', () => {
    const a = contentHash({ ...BASE, holder: 'Asha', issuer: 'Rao NITC Registrar' }).hash;
    const b = contentHash({ ...BASE, holder: 'Asha Rao', issuer: 'NITC Registrar' }).hash;
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(contentHash({ ...BASE, payload: { 'a b': 'c' } }).hash, contentHash({ ...BASE, payload: { a: 'b c' } }).hash);
});

test('dates: day-first, real calendar dates only', () => {
    assert.strictEqual(toISODate('05/06/2026'), '2026-06-05', 'day first');
    assert.strictEqual(toISODate('29-02-2024'), '2024-02-29');
    for (const bad of ['31-02-2026', '29-02-2025', '32-01-2026', '00-01-2026', '15-13-2026', 'yesterday', '', '2026', '15 Foo 2026']) {
        assert.throws(() => toISODate(bad), FieldError, bad);
    }
});

test('numbers: trailing and leading zeros are not significant, but other text is left alone', () => {
    assert.strictEqual(normValue('8.70'), '8.7');
    assert.strictEqual(normValue('08.7'), '8.7');
    assert.strictEqual(normValue('8.00'), '8');
    assert.strictEqual(normValue('100'), '100');
    assert.strictEqual(normValue('0.5'), '0.5');
    assert.strictEqual(normValue('0'), '0');
    assert.strictEqual(normValue('B.Tech 8.70'), 'B.TECH 8.70');
    assert.strictEqual(normValue('12-04-2005'), '2005-04-12', 'a whole-date value is a date');
    assert.strictEqual(normValue('31-02-2005'), '31-02-2005', 'not a real date: left as text, not an error');
    assert.strictEqual(normValue('B210123CS'), 'B210123CS');
});

test('missing or unreadable fields throw FieldError naming the fields but never their values', () => {
    assert.throws(() => canonicalRecord({}), (e) => e instanceof FieldError && e.fields.length === 5);
    assert.throws(() => canonicalRecord({ ...BASE, holder: '   ' }), (e) => e.fields.join() === 'holder');
    assert.throws(() => canonicalRecord({ ...BASE, idNumber: '--- ---' }), (e) => e.fields.join() === 'idNumber');
    assert.throws(() => canonicalRecord({ ...BASE, issuedOn: '99-99-9999' }), (e) => e.fields.join() === 'issuedOn');
    assert.throws(() => canonicalRecord(undefined), FieldError);
    try { canonicalRecord({ ...BASE, issuedOn: 'SECRET-DATE-VALUE' }); } catch (e) { assert.ok(!e.message.includes('SECRET'), 'value leaked'); }
});

test('stableStringify sorts keys at every depth and is unambiguous', () => {
    assert.strictEqual(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
});

test('lookupKey finds the same person\'s document of the same type, ignoring formatting, and differs for anyone else', () => {
    const k = lookupKey(BASE);
    assert.match(k, /^[a-f0-9]{64}$/);
    assert.strictEqual(lookupKey({ ...BASE, idNumber: 'b-210123 cs', issuer: 'nitc  registrar' }), k);
    assert.notStrictEqual(lookupKey({ ...BASE, idNumber: 'B210124CS' }), k);
    assert.notStrictEqual(lookupKey({ ...BASE, issuer: 'Other University' }), k);
    assert.notStrictEqual(lookupKey({ ...BASE, docType: 'Marksheet' }), k);
    assert.ok(!k.includes('B210123'), 'the ID is not recoverable from the key');
});

test('diffRecords names exactly which fields changed, with old and new values (canonical form)', () => {
    const a = canonicalRecord(BASE);
    const p = canonicalRecord({ ...BASE, payload: { ...BASE.payload, dob: '12-04-2003', cgpa: '9.1' }, holder: 'Asha  Rao' });
    assert.deepStrictEqual(diffRecords(a, p), [
        { field: 'payload.cgpa', anchored: '8.7', presented: '9.1' },
        { field: 'payload.dob', anchored: '2005-04-12', presented: '2003-04-12' },
    ]);
    assert.deepStrictEqual(diffRecords(a, canonicalRecord(BASE)), []);
    const missing = canonicalRecord({ ...BASE, payload: { cgpa: '8.7', programme: 'B.Tech Computer Science' } });
    assert.deepStrictEqual(diffRecords(a, missing), [{ field: 'payload.dob', anchored: '2005-04-12', presented: null }]);
});
