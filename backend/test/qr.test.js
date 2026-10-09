// Issue #58: what a QR code carries, and the strict reader for it. The binding rules themselves are tested end to end in verify.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { buildQrPayload, parseQrPayload, pointsHere, MAX_LENGTH } = require('../qr');

const HASH = 'ab'.repeat(32);
const ADDR = '0x' + '12'.repeat(20);
const good = { contentHash: HASH, chainId: 80002, contractAddress: ADDR };

test('the payload is compact JSON of exactly four fields and round-trips', () => {
    const text = buildQrPayload(good);
    assert.deepStrictEqual(JSON.parse(text), { v: 1, contentHash: HASH, chainId: 80002, contractAddress: ADDR });
    assert.ok(text.length < MAX_LENGTH, `${text.length} characters: small enough for a QR code to stay easy to scan`);
    assert.deepStrictEqual(parseQrPayload(text), { ok: true, qr: { v: 1, contentHash: HASH, chainId: 80002, contractAddress: ADDR } });
});

test('it carries pointers only: nothing about the holder can be put in it', () => {
    assert.ok(!/name|holder|dob|birth|id|email|phone/i.test(Object.keys(JSON.parse(buildQrPayload(good))).join(' ').replace(/contentHash|chainId|contractAddress/g, '')));
    for (const extra of ['holder', 'name', 'dob', 'idNumber', 'note']) {
        const r = parseQrPayload(JSON.stringify({ v: 1, ...good, [extra]: 'Asha Rao' }));
        assert.strictEqual(r.ok, false, extra);
    }
    assert.strictEqual(parseQrPayload(JSON.stringify({ v: 1, contentHash: HASH, chainId: 80002 })).ok, false, 'a missing field is refused too');
});

test('the builder refuses anything that is not a proper hash, chain id or address', () => {
    for (const bad of [{ contentHash: 'abc' }, { contentHash: HASH.toUpperCase() }, { contentHash: '0x' + HASH }, { chainId: 0 }, { chainId: 1.5 }, { chainId: '80002' },
        { contractAddress: '0x12' }, { contractAddress: 'nope' }, { contractAddress: undefined }]) {
        assert.throws(() => buildQrPayload({ ...good, ...bad }), Error, JSON.stringify(bad));
    }
});

test('the reader refuses everything that is not exactly a MindForge code, with a reason a person can read', () => {
    const cases = [undefined, null, '', 5, {}, [], 'not json', '{}', '[]', 'null', '"string"', 'x'.repeat(MAX_LENGTH + 1),
        JSON.stringify({ v: 2, ...good }), JSON.stringify({ v: '1', ...good }), JSON.stringify({ v: 1, ...good, contentHash: 'zz' }),
        JSON.stringify({ v: 1, ...good, chainId: '80002' }), JSON.stringify({ v: 1, ...good, chainId: -1 }), JSON.stringify({ v: 1, ...good, contractAddress: 'x' }),
        JSON.stringify({ v: 1, ...good, contentHash: HASH.toUpperCase() })];
    for (const input of cases) {
        const r = parseQrPayload(input);
        assert.strictEqual(r.ok, false, String(input).slice(0, 40));
        assert.ok(typeof r.reason === 'string' && r.reason.length > 10 && !r.reason.includes('Asha'));
    }
});

test('pointsHere compares chain and contract (ignoring address case) and never matches when this system is not configured', () => {
    const qr = parseQrPayload(buildQrPayload(good)).qr;
    assert.strictEqual(pointsHere(qr, { chainId: 80002, contractAddress: ADDR }), true);
    assert.strictEqual(pointsHere(qr, { chainId: 80002, contractAddress: ADDR.toUpperCase().replace('0X', '0x') }), true);
    assert.strictEqual(pointsHere(qr, { chainId: 1, contractAddress: ADDR }), false);
    assert.strictEqual(pointsHere(qr, { chainId: 80002, contractAddress: '0x' + '99'.repeat(20) }), false);
    assert.strictEqual(pointsHere(qr, {}), false);
    assert.strictEqual(pointsHere(qr, { chainId: 80002 }), false);
});
