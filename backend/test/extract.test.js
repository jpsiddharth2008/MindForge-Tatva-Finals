// Issue #52: label-anchored field extraction. Hand-built OCR lines, so no real OCR runs here.
const test = require('node:test');
const assert = require('node:assert');
const { extractFields, repairId, matchLabel, TEMPLATE } = require('../extract');
const { canonicalRecord, contentHash } = require('../content-hash');

/** An OCR line from "Label: value" text with one confidence for every word. */
const line = (text, conf = 95) => ({ text, confidence: conf, words: text.split(/\s+/).map((t) => ({ text: t, confidence: conf })) });

const CLEAN = [
    'NATIONAL INSTITUTE OF TECHNOLOGY', 'CERTIFICATE OF GRADUATION',
    'Issuer: NITC Registrar', 'Document: Degree Certificate', 'Name: Asha Rao', 'Register No: B210123CS', 'DOB: 12-04-2005',
    'Programme: B.Tech Computer Science', 'CGPA: 8.7', 'Issued On: 15-06-2026',
].map((t) => line(t));

const ANCHORED = {
    docType: 'Degree Certificate', issuer: 'NITC Registrar', holder: 'Asha Rao', idNumber: 'B210123CS', issuedOn: '15-06-2026',
    payload: { dob: '12-04-2005', programme: 'B.Tech Computer Science', cgpa: '8.7' },
};

test('a clean certificate reads completely, and its canonical hash equals the issuer\'s own', () => {
    const r = extractFields(CLEAN);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(contentHash(r.fields).hash, contentHash(ANCHORED).hash);
    assert.strictEqual(r.fields.holder, 'Asha Rao');
    assert.strictEqual(r.fields.payload.cgpa, '8.7');
    assert.strictEqual(r.confidences['payload.dob'], 95);
});

test('fields are found by label, not position: shuffled order, extra spacing and ragged layout read the same', () => {
    const shuffled = [...CLEAN].reverse().map((l) => line(l.text.replace(': ', ' :   ')));
    const r = extractFields(shuffled);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(contentHash(r.fields).hash, contentHash(ANCHORED).hash);
});

test('header lines without a colon are ignored', () => {
    assert.strictEqual(extractFields([line('Name: Asha Rao'), line('SOMETHING: ELSE', 95), ...CLEAN.slice(2)]).fields.holder, 'Asha Rao');
    assert.strictEqual(extractFields(CLEAN).fields.payload.something, undefined);
});

test('a label with one OCR slip is still recognised; a short label with a slip is not guessed at', () => {
    assert.strictEqual(matchLabel('Reg1ster No', TEMPLATE).key, 'idNumber');
    assert.strictEqual(matchLabel('Programne', TEMPLATE).key, 'payload.programme');
    assert.strictEqual(matchLabel('Nane', TEMPLATE), null, '"Nane" could be anything: not guessed');
    assert.strictEqual(matchLabel('DOB', TEMPLATE).key, 'payload.dob');
    assert.strictEqual(matchLabel('Date of Birth', TEMPLATE).key, 'payload.dob');
    assert.strictEqual(matchLabel('Remarks', TEMPLATE), null);
    assert.strictEqual(matchLabel('', TEMPLATE), null);
});

test('a misread short label leaves its field missing, so the result is INCONCLUSIVE rather than wrong', () => {
    const r = extractFields(CLEAN.map((l) => (l.text.startsWith('Name') ? line('Nane: Asha Rao') : l)));
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.field === 'holder' && p.problem === 'missing'));
});

test('ID repair fixes letter/digit slips only where the format says what belongs there', () => {
    assert.strictEqual(repairId('B21O123C5', 'LDDDDDDLL'), 'B210123CS');       // O -> 0 in a digit slot, 5 -> S in a letter slot
    assert.strictEqual(repairId('821 0123 CS', 'LDDDDDDLL'), 'B210123CS');     // 8 -> B in a letter slot, spaces dropped
    assert.strictEqual(repairId('B210123CS', 'LDDDDDDLL'), 'B210123CS');
    assert.strictEqual(repairId('B210123CS5', 'LDDDDDDLL'), 'B210123CS5', 'wrong length: left alone, never forced to fit');
    assert.strictEqual(repairId('b-210123-cs', undefined), 'B210123CS');
    assert.notStrictEqual(repairId('B210124CS', 'LDDDDDDLL'), 'B210123CS', 'a real digit is never "repaired" into another');
});

test('the ID is repaired during extraction', () => {
    const r = extractFields(CLEAN.map((l) => (l.text.startsWith('Register') ? line('Register No: B21O123C5') : l)));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fields.idNumber, 'B210123CS');
});

test('a low-confidence field makes the whole read inconclusive and names the field', () => {
    const r = extractFields(CLEAN.map((l) => (l.text.startsWith('DOB') ? line('DOB: 12-04-2005', 40) : l)));
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.problems, [{ field: 'payload.dob', problem: 'low_confidence' }]);
    assert.strictEqual(r.fields.payload.dob, undefined, 'a doubtful value is not passed on');
});

test('the weakest word decides a field\'s confidence', () => {
    const mixed = { text: 'Name: Asha Rao', words: [{ text: 'Name:', confidence: 99 }, { text: 'Asha', confidence: 96 }, { text: 'Rao', confidence: 30 }] };
    const r = extractFields([mixed, ...CLEAN.filter((l) => !l.text.startsWith('Name'))]);
    assert.strictEqual(r.confidences.holder, 30);
    assert.deepStrictEqual(r.problems, [{ field: 'holder', problem: 'low_confidence' }]);
});

test('the confidence threshold is adjustable', () => {
    const lines = CLEAN.map((l) => (l.text.startsWith('CGPA') ? line('CGPA: 8.7', 70) : l));
    assert.strictEqual(extractFields(lines).ok, false);
    assert.strictEqual(extractFields(lines, { minConfidence: 60 }).ok, true);
});

test('missing fields are reported one by one', () => {
    const r = extractFields(CLEAN.filter((l) => !/^(CGPA|DOB)/.test(l.text)));
    assert.deepStrictEqual(r.problems.map((p) => `${p.field}:${p.problem}`).sort(), ['payload.cgpa:missing', 'payload.dob:missing']);
    assert.strictEqual(extractFields([]).problems.length, TEMPLATE.fields.length);
});

test('an empty value is unreadable, not blank', () => {
    const r = extractFields(CLEAN.map((l) => (l.text.startsWith('Name') ? line('Name:') : l)));
    assert.ok(r.problems.some((p) => p.field === 'holder' && p.problem === 'unreadable'));
});

test('the same label twice: harmless if the values agree, ambiguous if they differ', () => {
    const agree = extractFields([...CLEAN, line('Name: ASHA  RAO')]);
    assert.strictEqual(agree.ok, true);
    const differ = extractFields([...CLEAN, line('Name: Ravi Menon')]);
    assert.deepStrictEqual(differ.problems, [{ field: 'holder', problem: 'ambiguous' }]);
});

test('an extra labelled line is part of what the document says: it changes the hash, so an added claim is caught', () => {
    const r = extractFields([...CLEAN, line('Remarks: With Distinction')]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fields.payload.remarks, 'With Distinction');
    assert.notStrictEqual(contentHash(r.fields).hash, contentHash(ANCHORED).hash);
});

test('an unreadable extra line is inconclusive, not ignored (a forger cannot hide a claim by blurring it)', () => {
    const r = extractFields([...CLEAN, line('Remarks: W1th D1st1nct10n', 35)]);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.problems, [{ field: 'payload.remarks', problem: 'low_confidence' }]);
});

test('every extracted field set can be canonicalised; an unreadable date surfaces as a field problem later, not a crash', () => {
    const r = extractFields(CLEAN);
    assert.doesNotThrow(() => canonicalRecord(r.fields));
    const bad = extractFields(CLEAN.map((l) => (l.text.startsWith('Issued') ? line('Issued On: 15-13-2026') : l)));
    assert.throws(() => canonicalRecord(bad.fields), (e) => e.fields.join() === 'issuedOn');
});
