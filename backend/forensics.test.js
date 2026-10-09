// Run: node --test backend/forensics.test.js   (or: npm test in backend/)
// The seven adversarial cases from the issue, expressed as the tier signals each would produce.
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('./forensics');

const anchor = { issuer: 'NITC Registrar', issuedAt: '2026-01-01T00:00:00Z', txHash: '0xabc' };
const FIELDS = { name: 'Asha Rao', dob: '2005-04-12', roll: 'B210123CS' };
const calm = [[2, 3, 2, 4], [3, 2, 3, 3], [3, 2, 4, 3], [2, 3, 3, 2]];     // small distances everywhere

const base = (over = {}) => ({
  registered: true, revoked: false, anchor, byte: { match: false },
  content: { anchored: FIELDS, presented: { ...FIELDS }, ocrConfidence: 0.97 },
  visual: { distance: 3, cellDistances: calm }, ...over,
});

test('1. genuine original -> AUTHENTIC_ORIGINAL', () => {
  const r = f.verify(base({ byte: { match: true } }));
  assert.equal(r.verdict, 'AUTHENTIC_ORIGINAL');
  assert.equal(r.confidence, 'HIGH');
  assert.deepEqual(r.anchor, anchor);
});

test('2. WhatsApp round trip (bytes differ, content and look intact) -> AUTHENTIC_COPY', () => {
  const r = f.verify(base({ visual: { distance: 2, cellDistances: calm } }));
  assert.equal(r.verdict, 'AUTHENTIC_COPY');
  assert.equal(r.tiers.byte.match, false);
  assert.equal(r.tiers.content.match, true);
});

test('3. photographed printout on another phone, noisier but within threshold -> AUTHENTIC_COPY', () => {
  const noisy = [[6, 7, 5, 8], [7, 6, 9, 7], [8, 5, 6, 7], [6, 8, 7, 6]];
  const r = f.verify(base({ content: { anchored: FIELDS, presented: { ...FIELDS }, ocrConfidence: 0.85 },
                            visual: { distance: 9, cellDistances: noisy } }));
  assert.equal(r.verdict, 'AUTHENTIC_COPY');
  assert.equal(r.confidence, 'MEDIUM');
});

test('4. one field edited -> TAMPERED_CONTENT naming exactly that field', () => {
  const r = f.verify(base({ content: { anchored: FIELDS, presented: { ...FIELDS, dob: '2003-04-12' }, ocrConfidence: 0.97 } }));
  assert.equal(r.verdict, 'TAMPERED_CONTENT');
  assert.equal(r.confidence, 'HIGH');
  assert.deepEqual(r.tiers.content.fieldDiffs, [{ field: 'dob', anchored: '2005-04-12', presented: '2003-04-12' }]);
  assert.match(r.reason, /dob/);
});

test('5. photo region replaced -> TAMPERED_VISUAL with the right cell flagged', () => {
  const cells = calm.map((row) => [...row]);
  cells[1][0] = 18;
  const r = f.verify(base({ visual: { distance: 6, cellDistances: cells } }));
  assert.equal(r.verdict, 'TAMPERED_VISUAL');
  assert.deepEqual(r.tiers.visual.divergedCells, [[1, 0]]);
  assert.equal(r.tiers.visual.regions[1][0], 18);
});

test('6. a different person on the same template -> NOT_REGISTERED, never rescued by pHash', () => {
  const r = f.verify(base({ registered: false, anchor: null, visual: { distance: 0, cellDistances: calm } }));
  assert.equal(r.verdict, 'NOT_REGISTERED');
  assert.equal(r.anchor, null);
});

test('7. blurred or dark capture -> INCONCLUSIVE, not a false verdict', () => {
  const garbled = { anchored: FIELDS, presented: { name: 'A$ha R?o', dob: null, roll: 'B2?0' }, ocrConfidence: 0.31 };
  const r = f.verify(base({ content: garbled }));
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.equal(r.confidence, 'LOW');
});

test('revoked anchor -> REVOKED, even when the file is the exact original', () => {
  assert.equal(f.verify(base({ revoked: true, byte: { match: true } })).verdict, 'REVOKED');
  assert.equal(f.verify(base({ revoked: true })).verdict, 'REVOKED');
});

test('content change wins over a clean-looking image (TAMPERED_CONTENT, not COPY)', () => {
  const r = f.verify(base({ content: { anchored: FIELDS, presented: { ...FIELDS, name: 'Ravi Rao' }, ocrConfidence: 0.95 },
                            visual: { distance: 1, cellDistances: calm } }));
  assert.equal(r.verdict, 'TAMPERED_CONTENT');
});

test('content matches but no visual evidence -> INCONCLUSIVE (fails safe, never certifies a copy)', () => {
  assert.equal(f.verify(base({ visual: null })).verdict, 'INCONCLUSIVE');
});

test('missing or added fields are reported as diffs with null on the missing side', () => {
  const d = f.fieldDiffs({ a: '1', b: '2' }, { a: '1', c: '3' });
  assert.deepEqual(d, [{ field: 'b', anchored: '2', presented: null }, { field: 'c', anchored: null, presented: '3' }]);
  assert.deepEqual(f.fieldDiffs(FIELDS, { ...FIELDS }), []);
});

test('verdict is always one of the seven and the report always has the documented shape', () => {
  const cases = [base(), base({ byte: { match: true } }), base({ registered: false }), base({ revoked: true }),
    base({ visual: null }), base({ content: undefined })];
  for (const c of cases) {
    const r = f.verify(c);
    assert.ok(f.VERDICTS.includes(r.verdict));
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(r.confidence));
    assert.ok('tiers' in r && 'anchor' in r && typeof r.reason === 'string');
  }
});

test('verify is pure: it does not modify its input', () => {
  const input = base();
  const copy = JSON.parse(JSON.stringify(input));
  f.verify(input);
  assert.deepEqual(input, copy);
});

test('hammingHex and compareGrids', () => {
  assert.equal(f.hammingHex('ff', '00'), 8);
  assert.equal(f.hammingHex('a5', 'a5'), 0);
  assert.equal(f.hammingHex('0f', '0e'), 1);
  assert.throws(() => f.hammingHex('ab', 'abc'));
  assert.throws(() => f.hammingHex('zz', 'ab'));
  assert.deepEqual(f.compareGrids([['00', 'ff'], ['0f', 'f0']], [['01', 'ff'], ['00', 'f0']]), [[1, 0], [4, 0]]);
  assert.throws(() => f.compareGrids([['00']], [['00'], ['00']]));
});
